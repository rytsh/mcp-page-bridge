import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { EmbeddedMcpServer } from "./embedded-server.js";

/**
 * Validates the hand-rolled EmbeddedMcpServer against the REAL MCP SDK client.
 * If these pass, the bridge (which also uses the SDK client) will speak to it.
 */
async function setup(build: (s: EmbeddedMcpServer) => void) {
  const server = new EmbeddedMcpServer({ name: "demo-app", version: "1.0.0", title: "Demo" });
  build(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { server, client };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
}

describe("EmbeddedMcpServer", () => {
  it("completes the MCP initialize handshake and reports serverInfo", async () => {
    const { client } = await setup(() => {});
    expect(client.getServerVersion()?.name).toBe("demo-app");
    expect(client.getServerCapabilities()?.tools).toBeTruthy();
  });

  it("lists and calls a registered tool", async () => {
    const { client } = await setup((s) => {
      s.registerTool(
        { name: "greet", description: "Greet", inputSchema: { type: "object" } },
        (args) => `hello ${(args as { name?: string }).name ?? "world"}`,
      );
    });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("greet");

    const res = await client.callTool({ name: "greet", arguments: { name: "ray" } });
    expect(textOf(res)).toBe("hello ray");
  });

  it("coerces object return values into JSON text", async () => {
    const { client } = await setup((s) => {
      s.registerTool({ name: "state" }, () => ({ count: 3, ok: true }));
    });
    const res = await client.callTool({ name: "state", arguments: {} });
    expect(JSON.parse(textOf(res))).toEqual({ count: 3, ok: true });
  });

  it("returns isError for throwing handlers (not a protocol error)", async () => {
    const { client } = await setup((s) => {
      s.registerTool({ name: "boom" }, () => {
        throw new Error("kaboom");
      });
    });
    const res = await client.callTool({ name: "boom", arguments: {} });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toContain("kaboom");
  });

  it("emits tools/list_changed when a tool is added after init", async () => {
    const { server, client } = await setup(() => {});
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed += 1;
    });

    server.registerTool({ name: "late" }, () => "ok");
    await new Promise((r) => setTimeout(r, 30));
    expect(changed).toBeGreaterThanOrEqual(1);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("late");
  });

  it("responds to ping", async () => {
    const { client } = await setup(() => {});
    await expect(client.ping()).resolves.toBeDefined();
  });

  it("forwards WebMCP tool annotations to tools/list", async () => {
    const { client } = await setup((s) => {
      s.registerTool(
        { name: "read-cart", description: "Read", annotations: { readOnlyHint: true } },
        () => "ok",
      );
      s.registerTool({ name: "plain" }, () => "ok");
    });

    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "read-cart")?.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(tools.find((t) => t.name === "plain")?.annotations).toBeUndefined();
  });

  it("hands each tool call an AbortSignal, aborted when the transport closes", async () => {
    let signal: AbortSignal | undefined;
    const { server, client } = await setup((s) => {
      s.registerTool({ name: "hang" }, (_args, options) => {
        signal = options.signal;
        return new Promise((resolve) => {
          options.signal.addEventListener("abort", () => resolve("cancelled"));
        });
      });
    });

    // The call never gets a response (the transport dies under it); swallow it.
    client.callTool({ name: "hang", arguments: {} }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);

    await server.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(signal!.aborted).toBe(true);
  });
});
