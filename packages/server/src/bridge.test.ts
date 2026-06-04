import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBridge, type Bridge } from "./bridge.js";

async function waitFor<T>(
  fn: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 4000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met before timeout");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function textOf(result: unknown): string {
  const content =
    (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
}

let bridge: Bridge | undefined;
let cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.reverse()) {
    try {
      await c();
    } catch {
      // ignore
    }
  }
  cleanups = [];
  if (bridge) {
    await bridge.close();
    bridge = undefined;
  }
});

async function connectAgent(b: Bridge): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await b.server.connect(serverTransport);
  const agent = new Client({ name: "test-agent", version: "0.0.0" }, { capabilities: {} });
  await agent.connect(clientTransport);
  cleanups.push(() => agent.close());
  return agent;
}

async function connectBrowser(
  port: number,
  name: string,
  build: (server: McpServer) => void,
): Promise<McpServer> {
  const server = new McpServer({ name, version: "1.0.0" });
  build(server);
  const transport = new WebSocketClientTransport(new URL(`ws://127.0.0.1:${port}`));
  await server.connect(transport);
  cleanups.push(() => server.close());
  return server;
}

describe("mcp-page-bridge bridge", () => {
  it("always exposes the mcp_page_bridge_list_clients meta tool", async () => {
    bridge = await createBridge({ port: 0 });
    const agent = await connectAgent(bridge);
    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name)).toContain("mcp_page_bridge_list_clients");
  });

  it("registers a browser tool (namespaced) and routes calls to it", async () => {
    bridge = await createBridge({ port: 0 });
    const agent = await connectAgent(bridge);

    await connectBrowser(bridge.port, "checkout-app", (s) => {
      s.registerTool(
        "echo",
        { description: "Echo a message", inputSchema: { msg: z.string() } },
        async ({ msg }) => ({ content: [{ type: "text", text: `echo:${msg}` }] }),
      );
    });

    const listed = await waitFor(
      () => agent.listTools(),
      (r) => r.tools.some((t) => t.name === "checkout-app__echo"),
    );
    expect(listed.tools.find((t) => t.name === "checkout-app__echo")?.description).toContain(
      "[checkout-app]",
    );

    const result = await agent.callTool({
      name: "checkout-app__echo",
      arguments: { msg: "hi" },
    });
    expect(textOf(result)).toBe("echo:hi");
  });

  it("reports providers via mcp_page_bridge_list_clients", async () => {
    bridge = await createBridge({ port: 0 });
    const agent = await connectAgent(bridge);
    await connectBrowser(bridge.port, "dashboard", (s) => {
      s.registerTool("noop", { description: "noop" }, async () => ({
        content: [{ type: "text", text: "ok" }],
      }));
    });
    await waitFor(() => bridge!.listProviders().length, (n) => n === 1);

    const result = await agent.callTool({ name: "mcp_page_bridge_list_clients", arguments: {} });
    const parsed = JSON.parse(textOf(result)) as Array<{
      label: string;
      tools: Array<{ name: string }>;
    }>;
    expect(parsed[0]?.label).toBe("dashboard");
    expect(parsed[0]?.tools.map((t) => t.name)).toContain("dashboard__noop");
  });

  it("removes a provider's tools when its browser disconnects", async () => {
    bridge = await createBridge({ port: 0 });
    const agent = await connectAgent(bridge);
    const browser = await connectBrowser(bridge.port, "appx", (s) => {
      s.registerTool("ping", { description: "ping" }, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));
    });
    await waitFor(() => agent.listTools(), (r) => r.tools.some((t) => t.name === "appx__ping"));

    await browser.close();

    await waitFor(() => agent.listTools(), (r) => !r.tools.some((t) => t.name === "appx__ping"));
  });

  it("disambiguates colliding labels", async () => {
    bridge = await createBridge({ port: 0 });
    const agent = await connectAgent(bridge);

    await connectBrowser(bridge.port, "dup", (s) =>
      s.registerTool("a", { description: "a" }, async () => ({
        content: [{ type: "text", text: "a" }],
      })),
    );
    await waitFor(() => bridge!.listProviders().length, (n) => n === 1);

    await connectBrowser(bridge.port, "dup", (s) =>
      s.registerTool("b", { description: "b" }, async () => ({
        content: [{ type: "text", text: "b" }],
      })),
    );
    await waitFor(() => bridge!.listProviders().length, (n) => n === 2);

    const listed = await waitFor(
      () => agent.listTools(),
      (r) =>
        r.tools.some((t) => t.name === "dup__a") && r.tools.some((t) => t.name === "dup-2__b"),
    );
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain("dup__a");
    expect(names).toContain("dup-2__b");
  });

  it("aggregates prompts (namespaced) and routes prompts/get", async () => {
    bridge = await createBridge({ port: 0 });
    const agent = await connectAgent(bridge);
    await connectBrowser(bridge.port, "promptapp", (s) => {
      s.registerPrompt(
        "welcome",
        { description: "Welcome message", argsSchema: { who: z.string() } },
        ({ who }) => ({
          messages: [{ role: "user", content: { type: "text", text: `Hi ${who}` } }],
        }),
      );
    });

    const listed = await waitFor(
      () => agent.listPrompts(),
      (r) => r.prompts.some((p) => p.name === "promptapp__welcome"),
    );
    expect(listed.prompts.map((p) => p.name)).toContain("promptapp__welcome");

    const got = await agent.getPrompt({ name: "promptapp__welcome", arguments: { who: "ray" } });
    expect(JSON.stringify(got)).toContain("Hi ray");
  });

  it("aggregates resources and routes resources/read", async () => {
    bridge = await createBridge({ port: 0 });
    const agent = await connectAgent(bridge);
    await connectBrowser(bridge.port, "resapp", (s) => {
      s.registerResource(
        "config",
        "https://app.local/config",
        { description: "app config" },
        async (uri) => ({
          contents: [{ uri: uri.href, mimeType: "application/json", text: '{"ok":true}' }],
        }),
      );
    });

    const listed = await waitFor(
      () => agent.listResources(),
      (r) => r.resources.some((x) => x.uri === "https://app.local/config"),
    );
    expect(listed.resources.map((r) => r.uri)).toContain("https://app.local/config");

    const read = await agent.readResource({ uri: "https://app.local/config" });
    expect((read.contents[0] as { text?: string }).text).toBe('{"ok":true}');
  });

  it("enforces the auth token when configured", async () => {
    bridge = await createBridge({ port: 0, token: "secret" });
    const agent = await connectAgent(bridge);

    // Wrong/missing token -> connection rejected.
    const bad = new McpServer({ name: "nope", version: "1.0.0" });
    const badTransport = new WebSocketClientTransport(new URL(`ws://127.0.0.1:${bridge.port}`));
    await expect(bad.connect(badTransport)).rejects.toBeTruthy();

    // Correct token -> connects and registers.
    const good = new McpServer({ name: "yes", version: "1.0.0" });
    good.registerTool("ok", { description: "ok" }, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const goodTransport = new WebSocketClientTransport(
      new URL(`ws://127.0.0.1:${bridge.port}/?token=secret`),
    );
    await good.connect(goodTransport);
    cleanups.push(() => good.close());

    await waitFor(() => agent.listTools(), (r) => r.tools.some((t) => t.name === "yes__ok"));
  });
});
