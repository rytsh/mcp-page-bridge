import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { EmbeddedMcpServer, type MinimalTransport } from "./embedded-server.js";
import { startGoBridge, type GoBridge } from "./go-bridge.test-helper.js";

/**
 * Full lightweight-path integration against the REAL (Go) bridge: the
 * EmbeddedMcpServer (what window.mcp builds) talks raw MCP JSON-RPC over a real
 * WebSocket to a spawned bridge daemon, exactly as the service worker pipes it.
 * Proves an agent can discover + call a tool a page registered with
 * window.mcp.tool().
 */

async function waitFor<T>(
  fn: () => T | Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 4000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
}

let bridge: GoBridge | undefined;
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch {
      // ignore
    }
  }
  if (bridge) {
    await bridge.stop();
    bridge = undefined;
  }
});

async function connectAgent(port: number): Promise<Client> {
  const agent = new Client({ name: "agent", version: "0.0.0" }, { capabilities: {} });
  await agent.connect(new WebSocketClientTransport(new URL(`ws://127.0.0.1:${port}/agent`)));
  cleanups.push(() => agent.close());
  return agent;
}

describe("lightweight window.mcp wire (EmbeddedMcpServer over WebSocket)", () => {
  it("agent discovers and calls a tool registered via the embedded server", async () => {
    bridge = await startGoBridge();
    const agent = await connectAgent(bridge.port);

    // "browser" side: embedded server over a real WS to the bridge
    const embedded = new EmbeddedMcpServer({ name: "lite-app", version: "1.0.0" });
    embedded.registerTool(
      {
        name: "sum",
        description: "Add two numbers",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
      (args) => String((args.a as number) + (args.b as number)),
    );
    const transport = new WebSocketClientTransport(new URL(`ws://127.0.0.1:${bridge.port}`));
    await embedded.connect(transport as unknown as MinimalTransport);
    cleanups.push(() => embedded.close());

    const listed = await waitFor(
      () => agent.listTools(),
      (r) => r.tools.some((t) => t.name === "lite-app__sum"),
    );
    expect(listed.tools.map((t) => t.name)).toContain("lite-app__sum");

    const res = await agent.callTool({ name: "lite-app__sum", arguments: { a: 2, b: 5 } });
    expect(textOf(res)).toBe("7");
  });

  it("dynamically reflects tools registered after connect", async () => {
    bridge = await startGoBridge();
    const agent = await connectAgent(bridge.port);

    const embedded = new EmbeddedMcpServer({ name: "live", version: "1.0.0" });
    const transport = new WebSocketClientTransport(new URL(`ws://127.0.0.1:${bridge.port}`));
    await embedded.connect(transport as unknown as MinimalTransport);
    cleanups.push(() => embedded.close());

    await waitFor(() => bridge!.listProviders(), (providers) => providers.length === 1);

    // Register AFTER the agent is already connected -> list_changed should flow.
    embedded.registerTool({ name: "now" }, () => new Date(0).toISOString());

    const listed = await waitFor(
      () => agent.listTools(),
      (r) => r.tools.some((t) => t.name === "live__now"),
    );
    expect(listed.tools.map((t) => t.name)).toContain("live__now");
  });
});
