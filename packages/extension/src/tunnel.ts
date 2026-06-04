/**
 * MAIN-world transport that tunnels MCP JSON-RPC from a page's MCP server
 * (embedded or full-SDK) out to the service worker via window.postMessage, and
 * from there over a WebSocket to the r-mcp bridge.
 *
 * Lives in the page (MAIN) world. The content script (ISOLATED) relays these
 * postMessages to/from the SW. `start()` opens the upstream socket lazily (only
 * once the tab is activated), so a page can register tools before connecting.
 */
import type { ChannelMessage } from "@r-mcp/protocol";
import type { MinimalTransport } from "./embedded-server.js";

let counter = 0;
function newProviderId(): string {
  counter += 1;
  return `p-${Date.now().toString(36)}-${counter}`;
}

const registry = new Map<string, TunnelTransport>();

export function getTransport(id: string): TunnelTransport | undefined {
  return registry.get(id);
}

export function allTransports(): TunnelTransport[] {
  return [...registry.values()];
}

function postUp(message: Omit<ChannelMessage, "__rmcp" | "dir">): void {
  const full: ChannelMessage = { __rmcp: true, dir: "up", ...message };
  window.postMessage(full, "*");
}

export interface TunnelOptions {
  /** Called after the owning MCP server has wired its handlers and started. */
  onStarted?: (transport: TunnelTransport) => void;
}

export class TunnelTransport implements MinimalTransport {
  readonly providerId: string;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  started = false;
  private opened = false;

  constructor(private readonly options: TunnelOptions = {}) {
    this.providerId = newProviderId();
    registry.set(this.providerId, this);
  }

  async start(): Promise<void> {
    this.started = true;
    this.options.onStarted?.(this);
  }

  /** Ask the SW to open a WebSocket to the bridge for this provider. */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    postUp({
      providerId: this.providerId,
      kind: "open",
      payload: { url: location.href, title: document.title },
    });
  }

  async send(message: unknown): Promise<void> {
    postUp({ providerId: this.providerId, kind: "rpc", payload: message });
  }

  async close(): Promise<void> {
    if (this.opened) {
      postUp({ providerId: this.providerId, kind: "close" });
      this.opened = false;
    }
    registry.delete(this.providerId);
    this.onclose?.();
  }

  /** Dispatch a down-bound JSON-RPC message into the owning server. */
  deliver(message: unknown): void {
    this.onmessage?.(message);
  }

  /** The SW reported the socket closed remotely. */
  remoteClosed(): void {
    this.opened = false;
    this.onclose?.();
  }
}
