import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { startGoBridge, type GoBridge } from "./go-bridge.test-helper.js";

/**
 * The bridge merges every provider in a partition into ONE tools/list,
 * prompts/list and resources/list, and the agent validates each response as a
 * whole. These tests drive the REAL Go daemon with a deliberately malformed
 * provider and assert it cannot take a healthy provider's catalog down with it.
 *
 * They use a raw WebSocket provider rather than EmbeddedMcpServer so the wire
 * payload can be arbitrary — that is the whole point.
 */

interface RawProvider {
  close(): void;
}

/** A provider that answers list requests with whatever JSON the test supplies. */
function startRawProvider(
  port: number,
  name: string,
  catalogs: {
    tools?: unknown[];
    prompts?: unknown[];
    resources?: unknown[];
    /** Second page, returned when the request carries a cursor. */
    toolsPage2?: unknown[];
  },
): Promise<RawProvider> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, "mcp");
    const send = (message: unknown): void => socket.send(JSON.stringify(message));

    socket.onerror = () => reject(new Error(`provider ${name} failed to connect`));
    socket.onopen = () => resolve({ close: () => socket.close() });

    socket.onmessage = (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number | string;
        method?: string;
        params?: { cursor?: string };
      };
      if (msg.method === undefined || msg.id === undefined) return;

      const reply = (result: unknown): void => send({ jsonrpc: "2.0", id: msg.id, result });

      switch (msg.method) {
        case "initialize":
          reply({
            protocolVersion: "2025-06-18",
            capabilities: {
              tools: { listChanged: true },
              prompts: { listChanged: true },
              resources: { listChanged: true },
            },
            serverInfo: { name, version: "1.0.0" },
          });
          break;
        case "tools/list":
          if (catalogs.toolsPage2 && !msg.params?.cursor) {
            reply({ tools: catalogs.tools ?? [], nextCursor: "page-2" });
          } else if (catalogs.toolsPage2) {
            reply({ tools: catalogs.toolsPage2 });
          } else {
            reply({ tools: catalogs.tools ?? [] });
          }
          break;
        case "prompts/list":
          reply({ prompts: catalogs.prompts ?? [] });
          break;
        case "resources/list":
          reply({ resources: catalogs.resources ?? [] });
          break;
        default:
          reply({});
      }
    };
  });
}

async function waitFor<T>(
  fn: () => T | Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
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

async function provider(name: string, catalogs: Parameters<typeof startRawProvider>[2]) {
  const p = await startRawProvider(bridge!.port, name, catalogs);
  cleanups.push(() => p.close());
  return p;
}

describe("catalog blast radius", () => {
  it("a malformed prompt does not hide a healthy provider's prompts", async () => {
    bridge = await startGoBridge();
    const agent = await connectAgent(bridge.port);

    await provider("good", { prompts: [{ name: "greet", description: "Say hi" }] });
    await provider("bad", {
      prompts: [
        { name: "broken", arguments: { notAnArray: true } }, // arguments must be an array
        { description: "no name at all" }, // unroutable -> dropped
        { name: "argless", arguments: [{ description: "arg without a name" }] },
      ],
    });

    const listed = await waitFor(
      () => agent.listPrompts(),
      (r) => r.prompts.some((p) => p.name.startsWith("bad__")),
    );
    const names = listed.prompts.map((p) => p.name);

    expect(names).toContain("good__greet");
    expect(names).toContain("bad__broken");
    expect(names).toContain("bad__argless");
    // The nameless one cannot be routed, so it is dropped rather than shipped.
    expect(names).toHaveLength(3);
    expect(listed.prompts.find((p) => p.name === "bad__broken")?.arguments).toBeUndefined();
    expect(listed.prompts.find((p) => p.name === "bad__argless")?.arguments).toEqual([]);
  });

  it("a malformed resource does not hide a healthy provider's resources", async () => {
    bridge = await startGoBridge();
    const agent = await connectAgent(bridge.port);

    await provider("good", { resources: [{ uri: "app://good", name: "Good" }] });
    await provider("bad", {
      resources: [
        { name: "no uri here" }, // uri is required AND the routing key -> dropped
        { uri: "app://sized", name: "Sized", size: "big" }, // size must be a number
        { uri: "app://mime", mimeType: 123 },
      ],
    });

    const listed = await waitFor(
      () => agent.listResources(),
      (r) => r.resources.some((res) => res.uri === "app://sized"),
    );
    const uris = listed.resources.map((r) => r.uri);

    expect(uris).toContain("app://good");
    expect(uris).toContain("app://sized");
    expect(uris).toContain("app://mime");
    expect(uris).toHaveLength(3);
    expect(listed.resources.find((r) => r.uri === "app://sized")?.size).toBeUndefined();
  });

  it("repairs inner inputSchema fields, not just the root type", async () => {
    bridge = await startGoBridge();
    const agent = await connectAgent(bridge.port);

    await provider("good", {
      tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    });
    await provider("bad", {
      tools: [
        {
          name: "wrong-required",
          description: "required is a bare string",
          inputSchema: { type: "object", required: "name", properties: { name: { type: "string" } } },
        },
        {
          name: "wrong-properties",
          description: "properties is an array",
          inputSchema: { type: "object", properties: [] },
        },
      ],
    });

    const listed = await waitFor(
      () => agent.listTools(),
      (r) => r.tools.some((t) => t.name === "bad__wrong-properties"),
    );
    const names = listed.tools.map((t) => t.name);

    expect(names).toContain("good__ping");
    expect(names).toContain("bad__wrong-required");
    // A bare string is promoted rather than discarded, so the author's intent survives.
    expect(listed.tools.find((t) => t.name === "bad__wrong-required")?.inputSchema.required).toEqual(
      ["name"],
    );
  });

  it("a single unparseable entry does not wipe the provider's whole catalog", async () => {
    bridge = await startGoBridge();
    const agent = await connectAgent(bridge.port);

    await provider("mixed", {
      tools: [
        { name: "keep-me", description: "Fine", inputSchema: { type: "object" } },
        "not an object at all",
        42,
      ],
    });

    const listed = await waitFor(
      () => agent.listTools(),
      (r) => r.tools.some((t) => t.name === "mixed__keep-me"),
    );
    expect(listed.tools.map((t) => t.name)).toContain("mixed__keep-me");
  });

  it("follows nextCursor instead of truncating at page one", async () => {
    bridge = await startGoBridge();
    const agent = await connectAgent(bridge.port);

    await provider("paged", {
      tools: [{ name: "first", description: "Page 1", inputSchema: { type: "object" } }],
      toolsPage2: [{ name: "second", description: "Page 2", inputSchema: { type: "object" } }],
    });

    const listed = await waitFor(
      () => agent.listTools(),
      (r) => r.tools.some((t) => t.name === "paged__second"),
    );
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain("paged__first");
    expect(names).toContain("paged__second");
  });
});
