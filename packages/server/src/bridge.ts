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
  DASHBOARD_HEADER,
  DASHBOARD_HEADER_VALUE,
  DEFAULT_PORT,
  MCP_PAGE_BRIDGE_DASHBOARD_ACTIVATE_TAB,
  MCP_PAGE_BRIDGE_DASHBOARD_CLOSE_TAB,
  MCP_PAGE_BRIDGE_VERSION,
  SERVICE_ID,
  TOKEN_HEADER,
  WS_SUBPROTOCOL,
  namespaceName,
  sanitizeLabel,
} from "mcp-page-bridge-protocol";
import { DASHBOARD_HTML, FAVICON_SVG } from "./dashboard.js";
import { WebSocketServerTransport } from "./ws-transport.js";

const META_LIST_CLIENTS = "mcp_page_bridge_list_clients";

interface ProviderMeta {
  url?: string;
  title?: string;
  userAgent?: string;
  tabId?: number;
  providerId?: string;
}

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
  /**
   * If set (> 0), the bridge shuts itself down after this many ms with no
   * connected browser providers AND no attached `/agent` connections.
   */
  idleTimeoutMs?: number;
  /** Invoked after an idle-triggered shutdown completes (e.g. to exit a daemon). */
  onIdleShutdown?: () => void;
}

const MAX_LABEL_RESERVATIONS = 1000;

export async function createBridge(opts: BridgeOptions = {}): Promise<Bridge> {
  const host = opts.host ?? "127.0.0.1";
  const providers = new Map<string, Provider>();
  const labelReservations = new Map<string, string>();
  /** Count of live `/agent` WebSocket connections (excludes the standalone server). */
  let agentConnections = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  /** Arm/disarm idle auto-shutdown based on current providers + agent connections. */
  function checkIdle(): void {
    const idleMs = opts.idleTimeoutMs ?? 0;
    if (idleMs <= 0) return;
    const idle = providers.size === 0 && agentConnections === 0;
    if (idle) {
      if (idleTimer) return;
      idleTimer = setTimeout(() => {
        void closeBridge().then(() => opts.onIdleShutdown?.());
      }, idleMs);
      idleTimer.unref?.();
    } else if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  // Routing tables, rebuilt whenever any provider's catalog changes.
  const toolRoutes = new Map<string, NameRoute>();
  const promptRoutes = new Map<string, NameRoute>();
  const resourceRoutes = new Map<string, string>(); // uri -> providerId (first wins)

  const agentServers = new Set<Server>();

  // ---- catalogs exposed to the agent ----------------------------------------

  function metaTools(): Tool[] {
    return [
      {
        name: META_LIST_CLIENTS,
        description:
          "List browser MCP providers connected to mcp-page-bridge (label, source page, tool/prompt/resource counts).",
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
        ? (s: Server) => s.sendToolListChanged()
        : kind === "prompts"
          ? (s: Server) => s.sendPromptListChanged()
          : (s: Server) => s.sendResourceListChanged();
    for (const agentServer of agentServers) {
      void Promise.resolve()
        .then(() => send(agentServer))
        .catch(() => {
          /* no agent connected yet/anymore */
        });
    }
  }

  function uniqueLabel(base: string, used: Set<string>): string {
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(`${base}-${i}`)) i += 1;
    return `${base}-${i}`;
  }

  function reservationKeys(base: string, meta: ProviderMeta): { exact: string[]; fallback: string[] } {
    const exact: string[] = [];
    const fallback: string[] = [];
    if (meta.tabId !== undefined && meta.providerId) {
      exact.push(`tab:${meta.tabId}:provider:${meta.providerId}:name:${base}`);
    } else if (meta.providerId) {
      exact.push(`provider:${meta.providerId}:name:${base}`);
    }
    if (meta.tabId !== undefined) fallback.push(`tab:${meta.tabId}:name:${base}`);
    if (meta.url) fallback.push(`url:${meta.url}:name:${base}`);
    return { exact, fallback };
  }

  /** Set/refresh a reservation, keeping Map order as recency for LRU eviction. */
  function touchReservation(key: string, label: string): void {
    if (labelReservations.has(key)) labelReservations.delete(key);
    labelReservations.set(key, label);
  }

  /**
   * Bound the reservations map so a long-lived daemon that visits many distinct
   * URLs/tabs doesn't grow without limit. Reservations for currently-connected
   * providers are never evicted (they must keep their namespace).
   */
  function pruneReservations(): void {
    if (labelReservations.size <= MAX_LABEL_RESERVATIONS) return;
    const inUse = new Set([...providers.values()].map((p) => p.label));
    for (const [key, label] of labelReservations) {
      if (labelReservations.size <= MAX_LABEL_RESERVATIONS) break;
      if (inUse.has(label)) continue;
      labelReservations.delete(key);
    }
  }

  function rememberLabel(keys: { exact: string[]; fallback: string[] }, label: string): void {
    for (const key of keys.exact) touchReservation(key, label);
    for (const key of keys.fallback) {
      touchReservation(key, labelReservations.get(key) ?? label);
    }
    pruneReservations();
  }

  function assignLabel(rawName: string, meta: ProviderMeta): string {
    const base = sanitizeLabel(rawName);
    const keys = reservationKeys(base, meta);
    const used = new Set([...providers.values()].map((p) => p.label));

    for (const key of [...keys.exact, ...keys.fallback]) {
      const reserved = labelReservations.get(key);
      if (reserved && !used.has(reserved)) {
        rememberLabel(keys, reserved);
        return reserved;
      }
    }

    const label = uniqueLabel(base, used);
    rememberLabel(keys, label);
    return label;
  }

  // ---- agent-facing request handlers ----------------------------------------

  function createAgentServer(): Server {
    const agentServer = new Server(
      { name: "mcp-page-bridge", version: MCP_PAGE_BRIDGE_VERSION },
      {
        capabilities: {
          tools: { listChanged: true },
          prompts: { listChanged: true },
          resources: { listChanged: true },
          logging: {},
        },
      },
    );

    agentServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposedTools() }));

    agentServer.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
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

    agentServer.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: exposedPrompts() }));

    agentServer.setRequestHandler(GetPromptRequestSchema, async (req): Promise<GetPromptResult> => {
      const route = promptRoutes.get(req.params.name);
      const provider = route && providers.get(route.providerId);
      if (!route || !provider) throw new Error(`Unknown or disconnected prompt: ${req.params.name}`);
      return provider.client.getPrompt({
        name: route.originalName,
        arguments: req.params.arguments as Record<string, string> | undefined,
      });
    });

    agentServer.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: exposedResources(),
    }));

    agentServer.setRequestHandler(ReadResourceRequestSchema, async (req): Promise<ReadResourceResult> => {
      const providerId = resourceRoutes.get(req.params.uri);
      const provider = providerId ? providers.get(providerId) : undefined;
      if (!provider) throw new Error(`Unknown or disconnected resource: ${req.params.uri}`);
      return provider.client.readResource({ uri: req.params.uri });
    });

    agentServers.add(agentServer);
    return agentServer;
  }

  const server = createAgentServer();
  let closing: Promise<void> | undefined;

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

  /** Allowed Host/Origin authorities for local HTTP requests. */
  function localAuthorities(): Set<string> {
    return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  }

  /**
   * Reject HTTP requests whose Host/Origin is not the local bridge. This is the
   * primary defense against DNS-rebinding and cross-origin web pages reaching
   * the JSON API; same-origin dashboard fetches and header-less local clients
   * (curl, the extension) still pass.
   */
  function hostAllowed(req: IncomingMessage): boolean {
    const allowed = localAuthorities();
    const hostHeader = req.headers.host;
    if (!hostHeader || !allowed.has(hostHeader)) return false;
    const origin = req.headers.origin;
    if (origin && origin !== "null") {
      try {
        if (!allowed.has(new URL(origin).host)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /** When a token is configured, require it on HTTP requests (header or query). */
  function tokenOk(req: IncomingMessage): boolean {
    if (!token) return true;
    if (req.headers[TOKEN_HEADER] === token) return true;
    try {
      return new URL(req.url ?? "/", "http://localhost").searchParams.get("token") === token;
    } catch {
      return false;
    }
  }

  function denyJson(res: ServerResponse, status: number, error: string): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: false, error }));
  }

  /** Authorize a state-changing POST (shutdown / provider action). */
  function authorizeStateChange(req: IncomingMessage, res: ServerResponse): boolean {
    if (!hostAllowed(req)) {
      denyJson(res, 403, "request is not local (bad Host/Origin)");
      return false;
    }
    if (req.headers[DASHBOARD_HEADER] !== DASHBOARD_HEADER_VALUE) {
      denyJson(res, 403, "missing dashboard header");
      return false;
    }
    if (!tokenOk(req)) {
      denyJson(res, 401, "missing or invalid token");
      return false;
    }
    return true;
  }

  async function handleProviderAction(
    req: IncomingMessage,
    res: ServerResponse,
    label: string,
    action: "activate" | "close",
  ): Promise<void> {
    if (!authorizeStateChange(req, res)) return;

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

    const method = action === "activate" ? MCP_PAGE_BRIDGE_DASHBOARD_ACTIVATE_TAB : MCP_PAGE_BRIDGE_DASHBOARD_CLOSE_TAB;
    try {
      await provider.client.request({ method }, EmptyResultSchema, { timeout: 5000 });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    }
  }

  async function handleShutdown(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorizeStateChange(req, res)) return;

    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
    res.end(JSON.stringify({ ok: true }));
    setImmediate(() => {
      void closeBridge().catch((error) => {
        console.error(`[mcp-page-bridge] shutdown failed: ${(error as Error).message}`);
      });
    });
  }

  async function closeBridge(): Promise<void> {
    if (closing) return closing;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    closing = (async () => {
      for (const p of providers.values()) {
        try {
          await p.client.close();
        } catch {
          // ignore
        }
      }
      for (const agentServer of [...agentServers]) {
        agentServers.delete(agentServer);
        try {
          await agentServer.close();
        } catch {
          // ignore
        }
      }
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    })();
    return closing;
  }

  // ---- HTTP + WebSocket server (browsers connect here) ----------------------
  //
  // A single Node HTTP server hosts BOTH the WebSocket endpoint (for browsers)
  // and a status dashboard + JSON API (for humans opening the port in a tab).

  const token = opts.token;

  const httpServer = createHttpServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const actionMatch = path.match(/^\/api\/providers\/([^/]+)\/(activate|close)$/);
    if (req.method === "POST" && path === "/api/shutdown") {
      void handleShutdown(req, res);
      return;
    }
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
      if (!hostAllowed(req)) {
        denyJson(res, 403, "request is not local (bad Host/Origin)");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (req.method === "GET" && path === "/favicon.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
      res.end(FAVICON_SVG);
      return;
    }
    // Lightweight identity probe: lets a CLI confirm a *real* bridge owns the
    // port (not a foreign HTTP server) and learn whether a token is required,
    // without leaking provider data. Not token-gated; still Host-validated.
    if (req.method === "GET" && path === "/api/health") {
      if (!hostAllowed(req)) {
        denyJson(res, 403, "request is not local (bad Host/Origin)");
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          service: SERVICE_ID,
          version: MCP_PAGE_BRIDGE_VERSION,
          requiresToken: !!token,
          port,
        }),
      );
      return;
    }
    if (req.method === "GET" && (path === "/api/providers" || path === "/providers.json")) {
      if (!hostAllowed(req)) {
        denyJson(res, 403, "request is not local (bad Host/Origin)");
        return;
      }
      if (!tokenOk(req)) {
        denyJson(res, 401, "missing or invalid token");
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          service: SERVICE_ID,
          version: MCP_PAGE_BRIDGE_VERSION,
          port,
          providers: providerSummary(),
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? DEFAULT_PORT, host);
  });

  // After startup, keep a permanent error handler so a stray socket/upgrade
  // error can't crash the daemon via an unhandled 'error' event.
  httpServer.on("error", (error) => {
    console.error(`[mcp-page-bridge] http server error: ${(error as Error).message}`);
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? DEFAULT_PORT);

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

  wss.on("error", (error) => {
    console.error(`[mcp-page-bridge] websocket server error: ${(error as Error).message}`);
  });

  wss.on("connection", async (ws: WebSocket, req) => {
    const path = (() => {
      try {
        return new URL(req.url ?? "/", "ws://localhost").pathname;
      } catch {
        return "/";
      }
    })();

    if (path === "/agent") {
      const agentServer = createAgentServer();
      const transport = new WebSocketServerTransport(ws);
      agentConnections += 1;
      checkIdle();
      let counted = true;
      const cleanupAgent = (): void => {
        if (counted) {
          counted = false;
          agentConnections -= 1;
          checkIdle();
        }
        if (!agentServers.delete(agentServer)) return;
        void agentServer.close().catch(() => {
          // ignore
        });
      };
      ws.on("close", cleanupAgent);
      try {
        await agentServer.connect(transport);
      } catch {
        cleanupAgent();
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      return;
    }

    const transport = new WebSocketServerTransport(ws);
    const client = new Client({ name: "mcp-page-bridge", version: MCP_PAGE_BRIDGE_VERSION }, { capabilities: {} });
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
    const meta: ProviderMeta = {
      title: (info as { title?: string } | undefined)?.title,
      url: (info as { websiteUrl?: string } | undefined)?.websiteUrl,
      ...requestMeta(req.url),
    };

    const provider: Provider = {
      id,
      label: assignLabel(rawName, meta),
      rawName,
      version: info?.version ?? "0.0.0",
      client,
      tools: [],
      prompts: [],
      resources: [],
      meta,
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
        for (const agentServer of agentServers) {
          void Promise.resolve()
            .then(() =>
              agentServer.sendLoggingMessage({
                ...note.params,
                logger: `${provider.label}/${note.params.logger ?? "page"}`,
              }),
            )
            .catch(() => {
              /* agent not listening */
            });
        }
      });
    }

    const cleanup = (): void => {
      if (providers.delete(id)) {
        rebuildRoutes();
        notifyChanged("tools");
        notifyChanged("prompts");
        notifyChanged("resources");
        checkIdle();
      }
    };
    client.onclose = cleanup;
    ws.on("close", cleanup);

    checkIdle();
    await Promise.all([refreshTools(), refreshPrompts(), refreshResources()]);
  });

  // Arm idle auto-shutdown immediately: a daemon started for a single session
  // that never sees a connection still tears itself down after the timeout.
  checkIdle();

  return {
    server,
    wss,
    port,
    listProviders() {
      return [...providers.values()].map(({ client: _client, ...rest }) => rest);
    },
    async close() {
      await closeBridge();
    },
  };
}
