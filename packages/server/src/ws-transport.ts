import type { RawData, WebSocket } from "ws";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

function rawToString(data: RawData, isBinary: boolean): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

/**
 * MCP Transport that wraps an already-connected (server-accepted) `ws`
 * WebSocket. The bridge runs an MCP *Client* over this transport to talk to a
 * browser-hosted MCP *Server*.
 *
 * Messages that arrive before `start()` is called are buffered and flushed,
 * which avoids dropping anything during the connect handshake.
 */
export class WebSocketServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  sessionId?: string;

  private started = false;
  private buffer: JSONRPCMessage[] = [];
  private _onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly socket: WebSocket) {
    this.socket.on("message", (data: RawData, isBinary: boolean) => {
      let message: JSONRPCMessage;
      try {
        message = JSONRPCMessageSchema.parse(JSON.parse(rawToString(data, isBinary)));
      } catch (error) {
        this.onerror?.(error as Error);
        return;
      }
      if (!this.started || !this._onmessage) {
        this.buffer.push(message);
        return;
      }
      this._onmessage(message);
    });

    this.socket.on("close", () => this.onclose?.());
    this.socket.on("error", (error: Error) => this.onerror?.(error));
  }

  /** Flush any buffered messages as soon as both started and a consumer exist. */
  get onmessage(): ((message: JSONRPCMessage) => void) | undefined {
    return this._onmessage;
  }

  set onmessage(handler: ((message: JSONRPCMessage) => void) | undefined) {
    this._onmessage = handler;
    if (handler && this.started) this.flush();
  }

  async start(): Promise<void> {
    this.started = true;
    this.flush();
  }

  private flush(): void {
    // Don't drain until a consumer is attached, otherwise buffered messages
    // would be silently dropped.
    if (!this._onmessage) return;
    const pending = this.buffer;
    this.buffer = [];
    for (const message of pending) this._onmessage(message);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.socket.readyState !== this.socket.OPEN) {
      throw new Error("cannot send on a non-open WebSocket");
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.send(JSON.stringify(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    try {
      this.socket.close();
    } catch {
      // fall through to terminate
    }
    // If the close handshake hangs, force the socket down so we don't leak it.
    setTimeout(() => {
      try {
        this.socket.terminate();
      } catch {
        // already gone
      }
    }, 1000).unref?.();
  }
}
