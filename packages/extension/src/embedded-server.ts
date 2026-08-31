/**
 * A tiny, dependency-free MCP server implementation.
 *
 * It powers the WebMCP authoring path (`document.modelContext.registerTool()`) so that
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
export type ToolHandlerReturn = ToolResult | string | number | boolean | null | undefined | object;

/**
 * MCP tool behavior hints. Mirrors WebMCP's `ToolAnnotations`, which is a subset
 * of MCP's — extra keys pass through to `tools/list` untouched.
 */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema for arguments. Defaults to an open object. */
  inputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  /**
   * MCP's reserved extension bag. Unlike `annotations` — whose shape MCP fixes,
   * so unknown hints are stripped by a validating client — `_meta` is
   * `Record<string, unknown>` in the spec and survives passthrough.
   */
  _meta?: Record<string, unknown>;
}

/** Second argument handed to every tool handler, mirroring WebMCP's execute(). */
export interface ToolCallOptions {
  /**
   * Aborted when the agent sends `notifications/cancelled` for this request, or
   * when the transport goes away.
   */
  signal: AbortSignal;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  options: ToolCallOptions,
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
  /** In-flight tools/call controllers, keyed by JSON-RPC request id so
   *  `notifications/cancelled` can find them. */
  private readonly pendingCalls = new Map<string, AbortController>();
  private transport?: MinimalTransport;
  private initialized = false;
  private toolListChangeQueued = false;

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
    // Detach the previous transport: without this a late message on a dead
    // socket is still handled, and its response is written to the NEW one.
    const previous = this.transport;
    if (previous && previous !== transport) {
      previous.onmessage = undefined;
      previous.onclose = undefined;
    }

    this.transport = transport;
    transport.onmessage = (message) => {
      if (this.transport !== transport) return; // stale socket
      void this.handle(message as JsonRpcMessage);
    };
    transport.onclose = () => {
      // A late close for an OLD transport must not tear down the live one.
      if (this.transport !== transport) return;
      this.transport = undefined;
      this.initialized = false;
      this.abortPendingCalls();
    };
    await transport.start?.();
  }

  async close(): Promise<void> {
    const t = this.transport;
    this.transport = undefined;
    this.initialized = false;
    this.abortPendingCalls();
    await t?.close?.();
  }

  private abortPendingCalls(): void {
    for (const controller of this.pendingCalls.values()) controller.abort();
    this.pendingCalls.clear();
  }

  private post(message: JsonRpcMessage): void {
    void this.transport?.send({ jsonrpc: "2.0", ...message });
  }

  /**
   * Coalesce list_changed into one notification per microtask.
   *
   * A page registering N tools in a loop otherwise emits N notifications, each
   * of which makes the bridge issue a tools/list round-trip. The MCP semantics
   * are unchanged — the notification carries no payload, it only says "re-read".
   */
  private sendToolListChanged(): void {
    if (this.toolListChangeQueued) return;
    this.toolListChangeQueued = true;
    queueMicrotask(() => {
      this.toolListChangeQueued = false;
      if (this.transport && this.initialized) {
        this.post({ method: "notifications/tools/list_changed" });
      }
    });
  }

  private async handle(message: JsonRpcMessage): Promise<void> {
    // Responses (no method) are ignored — we never issue requests.
    if (typeof message.method !== "string") return;

    const isNotification = message.id === undefined || message.id === null;
    try {
      const result = await this.dispatch(message.method, message.params, message.id);
      if (!isNotification) this.post({ id: message.id, result });
    } catch (error) {
      if (isNotification) return;
      const code = error instanceof RpcError ? error.code : -32603;
      const errMessage = error instanceof Error ? error.message : String(error);
      this.post({ id: message.id, error: { code, message: errMessage } });
    }
  }

  private async dispatch(
    method: string,
    params: any,
    requestId?: string | number | null,
  ): Promise<unknown> {
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
      case "notifications/cancelled": {
        // MCP request cancellation -> the WebMCP execute() AbortSignal.
        this.pendingCalls.get(String(params?.requestId))?.abort(
          new Error(params?.reason ? String(params.reason) : "Request cancelled"),
        );
        return undefined;
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [...this.tools.values()].map(({ def }) => ({
            name: def.name,
            title: def.title,
            description: def.description,
            inputSchema: def.inputSchema ?? { type: "object", additionalProperties: true },
            ...(def.annotations ? { annotations: def.annotations } : {}),
            ...(def._meta ? { _meta: def._meta } : {}),
          })),
        };
      case "tools/call": {
        const entry = this.tools.get(params?.name);
        if (!entry) throw new RpcError(-32602, `Tool not found: ${params?.name}`);
        const controller = new AbortController();
        const callId = String(requestId);
        this.pendingCalls.set(callId, controller);
        try {
          const out = await entry.handler((params?.arguments ?? {}) as Record<string, unknown>, {
            signal: controller.signal,
          });
          return coerceResult(out);
        } catch (error) {
          // Tool execution errors are returned as a tool result, not a protocol error.
          return {
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
            isError: true,
          } satisfies ToolResult;
        } finally {
          this.pendingCalls.delete(callId);
        }
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }
}
