import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServerTransport } from "./ws-transport.js";

/** Minimal stand-in for a `ws` WebSocket sufficient for the transport. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly sent: string[] = [];
  closed = false;
  terminated = false;

  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    cb?.();
  }
  close(): void {
    this.closed = true;
  }
  terminate(): void {
    this.terminated = true;
  }
}

const MSG: JSONRPCMessage = { jsonrpc: "2.0", id: 1, method: "ping" };

function emitMessage(sock: FakeSocket, message: JSONRPCMessage): void {
  sock.emit("message", Buffer.from(JSON.stringify(message)), false);
}

describe("WebSocketServerTransport", () => {
  it("buffers pre-start messages and flushes them on start", async () => {
    const sock = new FakeSocket();
    const transport = new WebSocketServerTransport(sock as never);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (m) => received.push(m);

    emitMessage(sock, MSG); // before start → buffered
    expect(received).toHaveLength(0);

    await transport.start();
    expect(received).toHaveLength(1);
  });

  it("flushes buffered messages when onmessage is set after start", async () => {
    const sock = new FakeSocket();
    const transport = new WebSocketServerTransport(sock as never);

    await transport.start();
    emitMessage(sock, MSG); // started but no consumer → buffered
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (m) => received.push(m); // setter triggers flush
    expect(received).toHaveLength(1);
  });

  it("rejects send when the socket is not open", async () => {
    const sock = new FakeSocket();
    sock.readyState = 3; // CLOSED
    const transport = new WebSocketServerTransport(sock as never);
    await expect(transport.send(MSG)).rejects.toThrow(/non-open/);
    expect(sock.sent).toHaveLength(0);
  });

  it("sends when the socket is open", async () => {
    const sock = new FakeSocket();
    const transport = new WebSocketServerTransport(sock as never);
    await transport.send(MSG);
    expect(sock.sent).toHaveLength(1);
    expect(JSON.parse(sock.sent[0]!)).toMatchObject({ method: "ping" });
  });

  it("surfaces parse errors via onerror without buffering garbage", async () => {
    const sock = new FakeSocket();
    const transport = new WebSocketServerTransport(sock as never);
    let errored = false;
    transport.onerror = () => (errored = true);
    transport.onmessage = () => {
      throw new Error("should not be called");
    };
    sock.emit("message", Buffer.from("not json"), false);
    expect(errored).toBe(true);
  });
});
