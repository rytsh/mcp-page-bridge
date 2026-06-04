import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EmbeddedMcpServer, type MinimalTransport } from "./embedded-server.js";
import { registerBrowserTools } from "./browser-tools.js";

const created: Array<{ url?: string }> = [];
const removed: number[] = [];

beforeEach(() => {
  created.length = 0;
  removed.length = 0;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      query: async () => [
        { id: 1, title: "A", url: "https://a.test", active: true, windowId: 10 },
        { id: 2, title: "B", url: "https://b.test", active: false, windowId: 10 },
      ],
      create: async (o: { url?: string }) => {
        created.push(o);
        return { id: 99, url: o.url };
      },
      update: async (id: number, o: object) => ({ id, windowId: 10, ...o }),
      remove: async (id: number) => {
        removed.push(id);
      },
    },
    windows: { update: async () => undefined },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

async function setup() {
  const server = new EmbeddedMcpServer({ name: "browser", version: "1.0.0" });
  registerBrowserTools(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st as unknown as MinimalTransport);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(ct);
  return client;
}

function textOf(r: unknown): string {
  const content = (r as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
}

describe("browser-level tools", () => {
  it("registers the browser toolset", async () => {
    const client = await setup();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["list_tabs", "open_tab", "activate_tab", "navigate_tab", "close_tab"]) {
      expect(names).toContain(n);
    }
  });

  it("list_tabs returns all tabs", async () => {
    const client = await setup();
    const res = await client.callTool({ name: "list_tabs", arguments: {} });
    const tabs = JSON.parse(textOf(res));
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toMatchObject({ id: 1, url: "https://a.test", active: true });
  });

  it("open_tab creates a tab", async () => {
    const client = await setup();
    await client.callTool({ name: "open_tab", arguments: { url: "https://new.test" } });
    expect(created).toContainEqual({ url: "https://new.test", active: true });
  });

  it("close_tab removes a tab", async () => {
    const client = await setup();
    await client.callTool({ name: "close_tab", arguments: { tabId: 2 } });
    expect(removed).toContain(2);
  });
});
