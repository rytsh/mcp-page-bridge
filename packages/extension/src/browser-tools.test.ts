import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EmbeddedMcpServer, type MinimalTransport } from "./embedded-server.js";
import { registerBrowserTools } from "./browser-tools.js";

const created: Array<{ url?: string }> = [];
const removed: number[] = [];
const enabled: number[] = [];
let agentTabs: number[] = [];

beforeEach(() => {
  created.length = 0;
  removed.length = 0;
  enabled.length = 0;
  agentTabs = [];
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

const deps = {
  enableTab: async (tabId: number) => {
    enabled.push(tabId);
    return tabId !== 3; // tab 3 stands in for a restricted page
  },
  isTabEnabled: async (tabId: number) => enabled.includes(tabId),
  trackAgentTab: async (tabId: number) => {
    agentTabs.push(tabId);
  },
  listAgentTabs: async () => [...agentTabs],
  forgetAgentTabs: async (ids: number[]) => {
    agentTabs = agentTabs.filter((id) => !ids.includes(id));
  },
};

async function setup() {
  const server = new EmbeddedMcpServer({ name: "browser", version: "1.0.0" });
  registerBrowserTools(server, deps);
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
    for (const n of ["list_tabs", "open_tab", "activate_tab", "navigate_tab", "enable_tab", "close_tab", "close_agent_tabs"]) {
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

  it("open_tab creates a tab and enables the bridge on it", async () => {
    const client = await setup();
    const res = await client.callTool({ name: "open_tab", arguments: { url: "https://new.test" } });
    expect(created).toContainEqual({ url: "https://new.test", active: true });
    expect(enabled).toContain(99);
    expect(JSON.parse(textOf(res))).toMatchObject({ id: 99, enabled: true, openedByAgent: true });
  });

  it("open_tab can skip enabling", async () => {
    const client = await setup();
    const res = await client.callTool({ name: "open_tab", arguments: { url: "https://new.test", enable: false } });
    expect(enabled).not.toContain(99);
    expect(JSON.parse(textOf(res))).toMatchObject({ enabled: false });
  });

  it("enable_tab reports restricted pages instead of pretending", async () => {
    const client = await setup();
    const res = await client.callTool({ name: "enable_tab", arguments: { tabId: 3 } });
    const payload = JSON.parse(textOf(res));
    expect(payload.enabled).toBe(false);
    expect(payload.note).toContain("restricted page");
  });

  it("close_agent_tabs only closes tabs the agent opened", async () => {
    const client = await setup();
    await client.callTool({ name: "open_tab", arguments: { url: "https://new.test" } });
    const res = await client.callTool({ name: "close_agent_tabs", arguments: {} });
    expect(removed).toEqual([99]);
    expect(JSON.parse(textOf(res))).toMatchObject({ closed: [99], requested: 1 });

    const again = await client.callTool({ name: "close_agent_tabs", arguments: {} });
    expect(textOf(again)).toContain("no agent-opened tabs");
  });

  it("close_tab removes a tab", async () => {
    const client = await setup();
    await client.callTool({ name: "close_tab", arguments: { tabId: 2 } });
    expect(removed).toContain(2);
  });
});
