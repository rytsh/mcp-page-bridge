import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolRequestSchema,
  EmptyResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type GetPromptResult,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_PORT,
  RMCP_DASHBOARD_ACTIVATE_TAB,
  RMCP_DASHBOARD_CLOSE_TAB,
  RMCP_VERSION,
  WS_SUBPROTOCOL,
  namespaceName,
  sanitizeLabel,
  type ProviderMeta,
} from "@r-mcp/protocol";
import { DASHBOARD_HTML, FAVICON_SVG } from "./dashboard.js";
import { WebSocketServerTransport } from "./ws-transport.js";

const META_LIST_CLIENTS = "rmcp_list_clients";

/** A connected browser MCP server (one per WebSocket connection). */
interface Provider {
  id: string;
  /** Unique, tool-name-safe namespace label. */
  label: string;
  /** Raw serverInfo.name reported by the browser. */
  rawName: string;
  version: string;
  client: Client;
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
  meta: ProviderMeta;
  connectedAt: number;
}

export type PublicProvider = Omit<Provider, "client">;

interface NameRoute {
  providerId: string;
  originalName: string;
}

export interface Bridge {
  /** Agent-facing MCP server (connect this to a stdio/http transport). */
  server: Server;
  wss: WebSocketServer;
  /** Actual port the WS server bound to (useful when port 0 is requested). */
  port: number;
  listProviders(): PublicProvider[];
  close(): Promise<void>;
}

export interface BridgeOptions {
  port?: number;
  host?: string;
  /** If set, browsers must connect with `?token=<token>` or they're rejected. */
  token?: string;
}

export async function createBridge(opts: BridgeOptions = {}): Promise<Bridge> {
  const host = opts.host ?? "127.0.0.1";
  const providers = new Map<string, Provider>();

  // Routing tables, rebuilt whenever any provider's catalog changes.
  const toolRoutes = new Map<string, NameRoute>();
  const promptRoutes = new Map<string, NameRoute>();
  const resourceRoutes = new Map<string, string>(); // uri -> providerId (first wins)

  const server = new Server(
    { name: "r-mcp", version: RMCP_VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true },
        logging: {},
      },
    },
  );

  // ---- catalogs exposed to the agent ----------------------------------------

  function metaTools(): Tool[] {
    return [
      {
        name: META_LIST_CLIENTS,
        description:
          "List browser MCP providers connected to r-mcp (label, source page, tool/prompt/resource counts).",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
  }

  /** Short, human/agent-friendly context for a provider: "label · title/host". */
  function providerContext(p: Provider): string {
    const bits = [p.label];
    if (p.meta.title) {
      bits.push(p.meta.title);
    } else if (p.meta.url) {
      try {
        bits.push(new URL(p.meta.url).host);
      } catch {
        // ignore bad url
      }
    }
    return bits.join(" · ");
  }

  function exposedTools(): Tool[] {
    const out: Tool[] = [...metaTools()];
    for (const p of providers.values()) {
      const ctx = providerContext(p);
      for (const t of p.tools) {
        out.push({
          ...t,
          name: namespaceName(p.label, t.name),
          title: `${p.label}: ${t.title ?? t.name}`,
          description: `[${ctx}] ${t.description ?? t.name}`,
        });
      }
    }
    return out;
  }

  function exposedPrompts(): Prompt[] {
    const out: Prompt[] = [];
    for (const p of providers.values()) {
      const ctx = providerContext(p);
      for (const pr of p.prompts) {
        out.push({
          ...pr,
          name: namespaceName(p.label, pr.name),
          description: `[${ctx}] ${pr.description ?? pr.name}`,
        });
      }
    }
    return out;
  }

  function exposedResources(): Resource[] {
    const out: Resource[] = [];
    const seen = new Set<string>();
    for (const p of providers.values()) {
      for (const r of p.resources) {
        if (seen.has(r.uri)) continue; // dedupe across providers (first wins)
        seen.add(r.uri);
        out.push({ ...r, name: r.name ? `[${p.label}] ${r.name}` : r.uri });
      }
    }
    return out;
  }

  function rebuildRoutes(): void {
    toolRoutes.clear();
    promptRoutes.clear();
    resourceRoutes.clear();
    for (const p of providers.values()) {
      for (const t of p.tools) {
        toolRoutes.set(namespaceName(p.label, t.name), { providerId: p.id, originalName: t.name });
      }
      for (const pr of p.prompts) {
        promptRoutes.set(namespaceName(p.label, pr.name), {
          providerId: p.id,
          originalName: pr.name,
        });
      }
      for (const r of p.resources) {
        if (!resourceRoutes.has(r.uri)) resourceRoutes.set(r.uri, p.id);
      }
    }
  }

  function notifyChanged(kind: "tools" | "prompts" | "resources"): void {
    rebuildRoutes();
    const send =
      kind === "tools"
        ? () => server.sendToolListChanged()
        : kind === "prompts"
          ? () => server.sendPromptListChanged()
          : () => server.sendResourceListChanged();
    void Promise.resolve().then(send).catch(() => {
      /* no agent connected yet/anymore */
    });
  }

  function uniqueLabel(base: string): string {
    const used = new Set([...providers.values()].map((p) => p.label));
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(`${base}-${i}`)) i += 1;
    return `${base}-${i}`;
  }

  // ---- agent-facing request handlers ----------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposedTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;

    if (name === META_LIST_CLIENTS) {
      return { content: [{ type: "text", text: JSON.stringify(providerSummary(), null, 2) }] };
    }

    const route = toolRoutes.get(name);
    const provider = route && providers.get(route.providerId);
    if (!route || !provider) {
      return { content: [{ type: "text", text: `Unknown or disconnected tool: ${name}` }], isError: true };
    }
    try {
      const result = await provider.client.callTool({
        name: route.originalName,
        arguments: req.params.arguments ?? {},
      });
      return result as CallToolResult;
    } catch (error) {
      return {
        content: [{ type: "text", text: `Tool call failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: exposedPrompts() }));

  server.setRequestHandler(GetPromptRequestSchema, async (req): Promise<GetPromptResult> => {
    const route = promptRoutes.get(req.params.name);
    const provider = route && providers.get(route.providerId);
    if (!route || !provider) throw new Error(`Unknown or disconnected prompt: ${req.params.name}`);
    return provider.client.getPrompt({
      name: route.originalName,
      arguments: req.params.arguments as Record<string, string> | undefined,
    });
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: exposedResources(),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req): Promise<ReadResourceResult> => {
    const providerId = resourceRoutes.get(req.params.uri);
    const provider = providerId ? providers.get(providerId) : undefined;
    if (!provider) throw new Error(`Unknown or disconnected resource: ${req.params.uri}`);
    return provider.client.readResource({ uri: req.params.uri });
  });

  function providerSummary() {
    return [...providers.values()].map((p) => ({
      label: p.label,
      name: p.rawName,
      version: p.version,
      url: p.meta.url,
      title: p.meta.title,
      tabId: p.meta.tabId,
      providerId: p.meta.providerId,
      tools: p.tools.map((t) => ({
        name: namespaceName(p.label, t.name),
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      prompts: p.prompts.map((pr) => ({
        name: namespaceName(p.label, pr.name),
        description: pr.description,
        arguments: pr.arguments,
      })),
      resources: p.resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        mimeType: r.mimeType,
      })),
      connectedAt: new Date(p.connectedAt).toISOString(),
    }));
  }

  function requestMeta(url: string | undefined): Pick<ProviderMeta, "tabId" | "providerId"> {
    try {
      const parsed = new URL(url ?? "/", "ws://localhost");
      const rawTabId = parsed.searchParams.get("tabId");
      const tabId = rawTabId ? Number(rawTabId) : undefined;
      return {
        tabId: Number.isFinite(tabId) ? tabId : undefined,
        providerId: parsed.searchParams.get("providerId") ?? undefined,
      };
    } catch {
      return {};
    }
  }

  async function handleProviderAction(
    req: IncomingMessage,
    res: ServerResponse,
    label: string,
    action: "activate" | "close",
  ): Promise<void> {
    if (req.headers["x-rmcp-dashboard"] !== "1") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "missing dashboard header" }));
      return;
    }

    const provider = [...providers.values()].find((p) => p.label === label);
    if (!provider) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `provider not found: ${label}` }));
      return;
    }
    if (provider.meta.tabId === undefined) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "provider is not attached to a browser tab" }));
      return;
    }

    const method = action === "activate" ? RMCP_DASHBOARD_ACTIVATE_TAB : RMCP_DASHBOARD_CLOSE_TAB;
    try {
      await provider.client.request({ method }, EmptyResultSchema);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    }
  }

  // ---- HTTP + WebSocket server (browsers connect here) ----------------------
  //
  // A single Node HTTP server hosts BOTH the WebSocket endpoint (for browsers)
  // and a status dashboard + JSON API (for humans opening the port in a tab).

  const token = opts.token;

  const httpServer = createHttpServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const actionMatch = path.match(/^\/api\/providers\/([^/]+)\/(activate|close)$/);
    if (req.method === "POST" && actionMatch) {
      void handleProviderAction(
        req,
        res,
        decodeURIComponent(actionMatch[1]!),
        actionMatch[2] as "activate" | "close",
      );
      return;
    }
    if (req.method === "GET" && (path === "/" || path === "/ui")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (req.method === "GET" && path === "/favicon.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
      res.end(FAVICON_SVG);
      return;
    }
    if (req.method === "GET" && (path === "/api/providers" || path === "/providers.json")) {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify({ version: RMCP_VERSION, port, providers: providerSummary() }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const wss = new WebSocketServer({
    server: httpServer,
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
    verifyClient: token
      ? (info: { req: { url?: string } }) => {
          try {
            const url = new URL(info.req.url ?? "/", "ws://localhost");
            return url.searchParams.get("token") === token;
          } catch {
            return false;
          }
        }
      : undefined,
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? DEFAULT_PORT, host);
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? DEFAULT_PORT);

  wss.on("connection", async (ws: WebSocket, req) => {
    const transport = new WebSocketServerTransport(ws);
    const client = new Client({ name: "r-mcp-bridge", version: RMCP_VERSION }, { capabilities: {} });
    const id = randomUUID();

    try {
      await client.connect(transport); // MCP initialize handshake
    } catch {
      try {
        ws.close();
      } catch {
        // ignore
      }
      return;
    }

    const info = client.getServerVersion();
    const caps = client.getServerCapabilities();
    const rawName = info?.name ?? "browser";

    const provider: Provider = {
      id,
      label: uniqueLabel(sanitizeLabel(rawName)),
      rawName,
      version: info?.version ?? "0.0.0",
      client,
      tools: [],
      prompts: [],
      resources: [],
      meta: {
        title: (info as { title?: string } | undefined)?.title,
        url: (info as { websiteUrl?: string } | undefined)?.websiteUrl,
        ...requestMeta(req.url),
      },
      connectedAt: Date.now(),
    };
    providers.set(id, provider);

    const refreshTools = async (): Promise<void> => {
      if (!caps?.tools) return;
      try {
        provider.tools = (await client.listTools()).tools;
      } catch {
        provider.tools = [];
      }
      notifyChanged("tools");
    };
    const refreshPrompts = async (): Promise<void> => {
      if (!caps?.prompts) return;
      try {
        provider.prompts = (await client.listPrompts()).prompts;
      } catch {
        provider.prompts = [];
      }
      notifyChanged("prompts");
    };
    const refreshResources = async (): Promise<void> => {
      if (!caps?.resources) return;
      try {
        provider.resources = (await client.listResources()).resources;
      } catch {
        provider.resources = [];
      }
      notifyChanged("resources");
    };

    if (caps?.tools?.listChanged) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => void refreshTools());
    }
    if (caps?.prompts?.listChanged) {
      client.setNotificationHandler(PromptListChangedNotificationSchema, () => void refreshPrompts());
    }
    if (caps?.resources?.listChanged) {
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () =>
        void refreshResources(),
      );
    }
    if (caps?.logging) {
      client.setNotificationHandler(LoggingMessageNotificationSchema, (note) => {
        void Promise.resolve()
          .then(() =>
            server.sendLoggingMessage({
              ...note.params,
              logger: `${provider.label}/${note.params.logger ?? "page"}`,
            }),
          )
          .catch(() => {
            /* agent not listening */
          });
      });
    }

    const cleanup = (): void => {
      if (providers.delete(id)) {
        rebuildRoutes();
        notifyChanged("tools");
        notifyChanged("prompts");
        notifyChanged("resources");
      }
    };
    client.onclose = cleanup;
    ws.on("close", cleanup);

    await Promise.all([refreshTools(), refreshPrompts(), refreshResources()]);
  });

  return {
    server,
    wss,
    port,
    listProviders() {
      return [...providers.values()].map(({ client: _client, ...rest }) => rest);
    },
    async close() {
      for (const p of providers.values()) {
        try {
          await p.client.close();
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      try {
        await server.close();
      } catch {
        // ignore
      }
    },
  };
}
