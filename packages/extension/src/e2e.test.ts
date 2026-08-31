import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { EmbeddedMcpServer, type MinimalTransport } from "./embedded-server.js";
import { startGoBridge, type GoBridge } from "./go-bridge.test-helper.js";

/**
 * Full integration against the REAL (Go) bridge: the EmbeddedMcpServer (what
 * inject.ts builds out of `document.modelContext`) talks raw MCP JSON-RPC over a
 * real WebSocket to a spawned bridge daemon, exactly as the service worker pipes
 * it. Proves an agent can discover + call a tool a page registered with
 * document.modelContext.registerTool().
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

describe("WebMCP wire (EmbeddedMcpServer over WebSocket)", () => {
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

describe("bridge hardening against a malformed provider", () => {
  it("one bad inputSchema does not take down every other tab's tools", async () => {
    bridge = await startGoBridge();
    const agent = await connectAgent(bridge.port);

    // A well-behaved page.
    const good = new EmbeddedMcpServer({ name: "good-app", version: "1.0.0" });
    good.registerTool({ name: "ping", description: "Ping" }, () => "pong");
    await good.connect(
      new WebSocketClientTransport(new URL(`ws://127.0.0.1:${bridge.port}`)) as unknown as MinimalTransport,
    );
    cleanups.push(() => good.close());

    // A page whose schema violates MCP (root must be `{"type":"object"}`). The
    // agent parses the MERGED tools/list in one shot, so without the bridge
    // repairing this, `good-app__ping` disappears too.
    const bad = new EmbeddedMcpServer({ name: "bad-app", version: "1.0.0" });
    bad.registerTool(
      { name: "broken", description: "Bad schema", inputSchema: { type: "string" } },
      () => "still works",
    );
    await bad.connect(
      new WebSocketClientTransport(new URL(`ws://127.0.0.1:${bridge.port}`)) as unknown as MinimalTransport,
    );
    cleanups.push(() => bad.close());

    const listed = await waitFor(
      () => agent.listTools(),
      (r) => r.tools.some((t) => t.name === "bad-app__broken"),
    );
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain("good-app__ping");
    expect(names).toContain("bad-app__broken");

    // The repaired tool is still callable, and its schema now satisfies MCP.
    const repaired = listed.tools.find((t) => t.name === "bad-app__broken")!;
    expect(repaired.inputSchema.type).toBe("object");
    expect(textOf(await agent.callTool({ name: "bad-app__broken", arguments: {} }))).toBe(
      "still works",
    );
  });

  it("clamps a namespaced tool name past the 64-char limit and still routes it", async () => {
    bridge = await startGoBridge();
    const agent = await connectAgent(bridge.port);

    const longName = "a".repeat(120);
    const server = new EmbeddedMcpServer({ name: "long-app", version: "1.0.0" });
    server.registerTool({ name: longName, description: "Long" }, () => "reached");
    await server.connect(
      new WebSocketClientTransport(new URL(`ws://127.0.0.1:${bridge.port}`)) as unknown as MinimalTransport,
    );
    cleanups.push(() => server.close());

    const listed = await waitFor(
      () => agent.listTools(),
      (r) => r.tools.some((t) => t.name.startsWith("long-app__")),
    );
    const exposed = listed.tools.find((t) => t.name.startsWith("long-app__"))!;
    expect(exposed.name.length).toBeLessThanOrEqual(64);

    // The routing table is built from the same clamped name, so it resolves.
    expect(textOf(await agent.callTool({ name: exposed.name, arguments: {} }))).toBe("reached");
  });
});
