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

async function connectAgentOverBridgeWebSocket(port: number): Promise<Client> {
  const transport = new WebSocketClientTransport(new URL(`ws://127.0.0.1:${port}/agent`));
  const agent = new Client({ name: "test-agent-ws", version: "0.0.0" }, { capabilities: {} });
  await agent.connect(transport);
  cleanups.push(() => agent.close());
  return agent;
}

async function connectBrowser(
  port: number,
  name: string,
  build: (server: McpServer) => void,
  meta: { tabId?: number; providerId?: string } = {},
): Promise<McpServer> {
  const server = new McpServer({ name, version: "1.0.0" });
  build(server);
  const url = new URL(`ws://127.0.0.1:${port}`);
  if (meta.tabId !== undefined) url.searchParams.set("tabId", String(meta.tabId));
  if (meta.providerId) url.searchParams.set("providerId", meta.providerId);
  const transport = new WebSocketClientTransport(url);
  await server.connect(transport);
  cleanups.push(() => server.close());
  return server;
}

async function bridgeReachable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/providers`);
    return res.ok;
  } catch {
    return false;
  }
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

  it("accepts multiple agent connections via the /agent websocket", async () => {
    bridge = await createBridge({ port: 0 });
    const localAgent = await connectAgent(bridge);
    const wsAgent = await connectAgentOverBridgeWebSocket(bridge.port);

    await connectBrowser(bridge.port, "shared-app", (s) => {
      s.registerTool(
        "echo",
        { description: "Echo a message", inputSchema: { msg: z.string() } },
        async ({ msg }) => ({ content: [{ type: "text", text: `shared:${msg}` }] }),
      );
    });

    await waitFor(() => localAgent.listTools(), (r) => r.tools.some((t) => t.name === "shared-app__echo"));
    await waitFor(() => wsAgent.listTools(), (r) => r.tools.some((t) => t.name === "shared-app__echo"));

    const result = await wsAgent.callTool({ name: "shared-app__echo", arguments: { msg: "hi" } });
    expect(textOf(result)).toBe("shared:hi");
  });

  it("rejects cleanly when the requested port is already in use", async () => {
    bridge = await createBridge({ port: 0 });

    await expect(createBridge({ port: bridge.port })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("lets the dashboard shut down the bridge", async () => {
    bridge = await createBridge({ port: 0 });

    const forbidden = await fetch(`http://127.0.0.1:${bridge.port}/api/shutdown`, { method: "POST" });
    expect(forbidden.status).toBe(403);
    expect(await bridgeReachable(bridge.port)).toBe(true);

    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/shutdown`, {
      method: "POST",
      headers: { "x-mcp-page-bridge-dashboard": "1" },
    });
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ ok: true });
    await waitFor(() => bridgeReachable(bridge!.port), (reachable) => !reachable);
  });

  it("rejects HTTP requests from a foreign Origin", async () => {
    bridge = await createBridge({ port: 0 });

    const read = await fetch(`http://127.0.0.1:${bridge.port}/api/providers`, {
      headers: { origin: "http://evil.example" },
    });
    expect(read.status).toBe(403);

    const shutdown = await fetch(`http://127.0.0.1:${bridge.port}/api/shutdown`, {
      method: "POST",
      headers: { origin: "http://evil.example", "x-mcp-page-bridge-dashboard": "1" },
    });
    expect(shutdown.status).toBe(403);
    expect(await bridgeReachable(bridge.port)).toBe(true);
  });

  it("does not advertise permissive CORS on the JSON API", async () => {
    bridge = await createBridge({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/providers`);
    expect(res.ok).toBe(true);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves dashboard HTML without browser caching", async () => {
    bridge = await createBridge({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${bridge.port}/`);
    expect(res.ok).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("exposes an identity health endpoint without a token", async () => {
    bridge = await createBridge({ port: 0, token: "secret" });
    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { service: string; requiresToken: boolean };
    expect(body.service).toBe("mcp-page-bridge");
    expect(body.requiresToken).toBe(true);
  });

  it("requires the token on the HTTP API when configured", async () => {
    bridge = await createBridge({ port: 0, token: "secret" });

    const noToken = await fetch(`http://127.0.0.1:${bridge.port}/api/providers`);
    expect(noToken.status).toBe(401);

    const badShutdown = await fetch(`http://127.0.0.1:${bridge.port}/api/shutdown`, {
      method: "POST",
      headers: { "x-mcp-page-bridge-dashboard": "1" },
    });
    expect(badShutdown.status).toBe(401);

    const withToken = await fetch(`http://127.0.0.1:${bridge.port}/api/providers`, {
      headers: { "x-mcp-page-bridge-token": "secret" },
    });
    expect(withToken.ok).toBe(true);
  });

  it("shuts down with a valid token (header + dashboard header)", async () => {
    bridge = await createBridge({ port: 0, token: "secret" });
    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/shutdown`, {
      method: "POST",
      headers: { "x-mcp-page-bridge-dashboard": "1", "x-mcp-page-bridge-token": "secret" },
    });
    expect(res.ok).toBe(true);
    await waitFor(
      async () => {
        try {
          await fetch(`http://127.0.0.1:${bridge!.port}/api/health`);
          return true;
        } catch {
          return false;
        }
      },
      (reachable) => !reachable,
    );
  });

  it("triggers idle auto-shutdown when no agents or providers connect", async () => {
    let idleClosed = false;
    bridge = await createBridge({ port: 0, idleTimeoutMs: 150, onIdleShutdown: () => (idleClosed = true) });
    await waitFor(() => idleClosed, (v) => v, 3000);
    expect(idleClosed).toBe(true);
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

  it("keeps duplicate provider labels stable across reconnect order changes", async () => {
    bridge = await createBridge({ port: 0 });
    const agent = await connectAgent(bridge);

    const first = await connectBrowser(
      bridge.port,
      "dup",
      (s) =>
        s.registerTool("first", { description: "first" }, async () => ({
          content: [{ type: "text", text: "first" }],
        })),
      { tabId: 101, providerId: "provider-a" },
    );
    const second = await connectBrowser(
      bridge.port,
      "dup",
      (s) =>
        s.registerTool("second", { description: "second" }, async () => ({
          content: [{ type: "text", text: "second" }],
        })),
      { tabId: 102, providerId: "provider-b" },
    );

    await waitFor(
      () => agent.listTools(),
      (r) => r.tools.some((t) => t.name === "dup__first") && r.tools.some((t) => t.name === "dup-2__second"),
    );

    await first.close();
    await second.close();
    await waitFor(() => bridge!.listProviders().length, (n) => n === 0);

    await connectBrowser(
      bridge.port,
      "dup",
      (s) =>
        s.registerTool("secondAgain", { description: "second again" }, async () => ({
          content: [{ type: "text", text: "second again" }],
        })),
      { tabId: 102, providerId: "provider-b" },
    );
    await waitFor(() => agent.listTools(), (r) => r.tools.some((t) => t.name === "dup-2__secondAgain"));

    await connectBrowser(
      bridge.port,
      "dup",
      (s) =>
        s.registerTool("firstAgain", { description: "first again" }, async () => ({
          content: [{ type: "text", text: "first again" }],
        })),
      { tabId: 101, providerId: "provider-a" },
    );
    const listed = await waitFor(
      () => agent.listTools(),
      (r) => r.tools.some((t) => t.name === "dup__firstAgain") && r.tools.some((t) => t.name === "dup-2__secondAgain"),
    );
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain("dup__firstAgain");
    expect(names).toContain("dup-2__secondAgain");
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
