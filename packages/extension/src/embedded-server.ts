/**
 * A tiny, dependency-free MCP server implementation.
 *
 * It powers the *lightweight* authoring path (`window.mcp.tool(...)`) so that
 * pages can expose tools to the agent without bundling the full MCP SDK. It
 * speaks the exact same MCP JSON-RPC wire format the SDK does, which means the
 * mcp-page-bridge can run a standard MCP `Client` against it just like it does
 * against a real SDK-based page server.
 *
 * This module has NO browser dependencies and is unit-tested in Node against
 * the real `@modelcontextprotocol/sdk` Client over an in-memory transport.
 */

/** The most recent protocol version we understand; we otherwise echo the client's. */
export const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** What a tool handler may return. Anything non-ToolResult is coerced to text. */
export type ToolHandlerReturn = ToolResult | string | number | boolean | null | object;

export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema for arguments. Defaults to an open object. */
  inputSchema?: Record<string, unknown>;
}

export type ToolHandler = (
  args: Record<string, unknown>,
) => ToolHandlerReturn | Promise<ToolHandlerReturn>;

/** Minimal transport contract — structurally compatible with the SDK's Transport. */
export interface MinimalTransport {
  start?(): void | Promise<void>;
  send(message: unknown): void | Promise<void>;
  close?(): void | Promise<void>;
  onmessage?: (message: any) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

export interface ServerInfo {
  name: string;
  version: string;
  title?: string;
  websiteUrl?: string;
}

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: unknown;
  error?: unknown;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function coerceResult(value: ToolHandlerReturn): ToolResult {
  if (value && typeof value === "object" && Array.isArray((value as ToolResult).content)) {
    return value as ToolResult;
  }
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }] };
}

export class EmbeddedMcpServer {
  private readonly tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();
  private transport?: MinimalTransport;
  private initialized = false;

  constructor(public serverInfo: ServerInfo) {}

  get toolCount(): number {
    return this.tools.size;
  }

  /** True while attached to a live transport. */
  get connected(): boolean {
    return this.transport !== undefined;
  }

  setServerInfo(info: Partial<ServerInfo>): void {
    this.serverInfo = { ...this.serverInfo, ...info };
  }

  /** Register (or replace) a tool. Returns an unregister function. */
  registerTool(def: ToolDefinition, handler: ToolHandler): () => void {
    this.tools.set(def.name, { def, handler });
    this.sendToolListChanged();
    return () => this.removeTool(def.name);
  }

  removeTool(name: string): void {
    if (this.tools.delete(name)) this.sendToolListChanged();
  }

  async connect(transport: MinimalTransport): Promise<void> {
    this.transport = transport;
    transport.onmessage = (message) => {
      void this.handle(message as JsonRpcMessage);
    };
    transport.onclose = () => {
      this.transport = undefined;
      this.initialized = false;
    };
    await transport.start?.();
  }

  async close(): Promise<void> {
    const t = this.transport;
    this.transport = undefined;
    this.initialized = false;
    await t?.close?.();
  }

  private post(message: JsonRpcMessage): void {
    void this.transport?.send({ jsonrpc: "2.0", ...message });
  }

  private sendToolListChanged(): void {
    if (this.transport && this.initialized) {
      this.post({ method: "notifications/tools/list_changed" });
    }
  }

  private async handle(message: JsonRpcMessage): Promise<void> {
    // Responses (no method) are ignored — we never issue requests.
    if (typeof message.method !== "string") return;

    const isNotification = message.id === undefined || message.id === null;
    try {
      const result = await this.dispatch(message.method, message.params);
      if (!isNotification) this.post({ id: message.id, result });
    } catch (error) {
      if (isNotification) return;
      const code = error instanceof RpcError ? error.code : -32603;
      const errMessage = error instanceof Error ? error.message : String(error);
      this.post({ id: message.id, error: { code, message: errMessage } });
    }
  }

  private async dispatch(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "initialize": {
        this.initialized = true;
        return {
          protocolVersion: params?.protocolVersion ?? FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: this.serverInfo,
        };
      }
      case "notifications/initialized":
        return undefined;
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [...this.tools.values()].map(({ def }) => ({
            name: def.name,
            title: def.title,
            description: def.description,
            inputSchema: def.inputSchema ?? { type: "object", additionalProperties: true },
          })),
        };
      case "tools/call": {
        const entry = this.tools.get(params?.name);
        if (!entry) throw new RpcError(-32602, `Tool not found: ${params?.name}`);
        try {
          const out = await entry.handler((params?.arguments ?? {}) as Record<string, unknown>);
          return coerceResult(out);
        } catch (error) {
          // Tool execution errors are returned as a tool result, not a protocol error.
          return {
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
            isError: true,
          } satisfies ToolResult;
        }
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }
}
