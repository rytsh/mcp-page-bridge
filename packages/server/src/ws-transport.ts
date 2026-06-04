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
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  private started = false;
  private buffer: JSONRPCMessage[] = [];

  constructor(private readonly socket: WebSocket) {
    this.socket.on("message", (data: RawData, isBinary: boolean) => {
      let message: JSONRPCMessage;
      try {
        message = JSONRPCMessageSchema.parse(JSON.parse(rawToString(data, isBinary)));
      } catch (error) {
        this.onerror?.(error as Error);
        return;
      }
      if (!this.started || !this.onmessage) {
        this.buffer.push(message);
        return;
      }
      this.onmessage(message);
    });

    this.socket.on("close", () => this.onclose?.());
    this.socket.on("error", (error: Error) => this.onerror?.(error));
  }

  async start(): Promise<void> {
    this.started = true;
    const pending = this.buffer;
    this.buffer = [];
    for (const message of pending) this.onmessage?.(message);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.socket.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this.socket.close();
  }
}
