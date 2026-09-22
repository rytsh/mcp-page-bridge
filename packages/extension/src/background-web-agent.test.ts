import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("discovers live chats, routes page tools only to the selected chat, and never falls back to a daemon", async () => {
  const local: Record<string, unknown> = { webAgentOrigins: ["https://old.example"] };
  const session: Record<string, unknown> = {};
  const storage = (data: Record<string, unknown>) => ({
    get: vi.fn(async () => ({ ...data })),
    set: vi.fn(async (patch) => { Object.assign(data, patch); }),
  });
  const onMessage = { addListener: vi.fn() };
  const onConnect = { addListener: vi.fn() };
  const webSocket = vi.fn();
  vi.stubGlobal("WebSocket", webSocket);
  const openTabs = [
    { id: 1, url: "https://page.example", title: "Page" },
    { id: 7, url: "https://at.example/playground/a", title: "Chat A" },
    { id: 8, url: "https://at.example/playground/b", title: "Chat B" },
    { id: 9, url: "https://old.example", title: "Remembered site, no agent" },
  ];
  const live = new Set([7, 8]);
  vi.stubGlobal("chrome", {
    runtime: { id: "test", onMessage, onConnect },
    storage: { local: storage(local), session: storage(session) },
    tabs: {
      query: vi.fn(async () => openTabs),
      get: vi.fn(async (id) => openTabs.find((tab) => tab.id === id)),
      sendMessage: vi.fn(async (id, req) => req.type === "discoverWebAgent" ? { name: live.has(id) ? "AT Chat" : "" } : undefined),
      onRemoved: { addListener: vi.fn() },
    },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  });
  await import("./background.js");
  const message = (req: object, sender: object = { id: "test" }) => new Promise<any>((resolve) => {
    onMessage.addListener.mock.calls[0]![0](req, sender, resolve);
  });
  const status = await message({ type: "getStatus", tabId: 1 });
  expect(status.webAgents.map((agent: { tabId: number }) => agent.tabId)).toEqual([7, 8]);
  const portMessages = { addListener: vi.fn() };
  const port = {
    name: "mcp-page-bridge", sender: { tab: { id: 1 } },
    onMessage: portMessages, onDisconnect: { addListener: vi.fn() },
    postMessage: vi.fn((envelope) => {
      if (envelope.kind !== "rpc" || envelope.payload.id === undefined) return;
      const { id, method } = envelope.payload;
      const result = method === "tools/list" ? { tools: [{ name: "take_snapshot", inputSchema: { type: "object" } }] }
        : method === "tools/call" ? { content: [{ type: "text", text: "real page result" }] } : {};
      portMessages.addListener.mock.calls[0]![0]({ ...envelope, dir: "up", payload: { jsonrpc: "2.0", id, result } });
    }),
  };
  onConnect.addListener.mock.calls[0]![0](port);
  expect(await message({ type: "setEnabled", tabId: 1, enabled: true, mode: "webAgent", origin: "https://at.example", agentTabId: 7 })).toMatchObject({ ok: true });
  portMessages.addListener.mock.calls[0]![0]({ __mcpPageBridge: true, dir: "up", kind: "open", providerId: "page", payload: { title: "Page", url: "https://page.example" } });
  const agentRequest = (tabId: number, method: string, params?: unknown) => message({ type: "webAgent", method, params }, { id: "test", tab: { id: tabId }, origin: "https://at.example" });
  await vi.waitFor(async () => {
    const catalog = await agentRequest(7, "tools/list");
    expect(catalog.result.tools.some((tool: { name: string }) => tool.name === "page__take_snapshot")).toBe(true);
  });
  const other = await agentRequest(8, "tools/list");
  expect(other.result.tools.some((tool: { name: string }) => tool.name === "page__take_snapshot")).toBe(false);
  expect(await agentRequest(7, "tools/call", { name: "page__take_snapshot", arguments: {} })).toMatchObject({ result: { content: [{ text: "real page result" }] } });
  // A live switch between chats must move the catalog as well as the selector.
  expect(await message({ type: "setTabMode", tabId: 1, mode: "webAgent", origin: "https://at.example", agentTabId: 8 })).toMatchObject({ ok: true });
  expect(session.tabModes).toMatchObject({ "1": { agentTabId: 8 } });
  live.delete(8);
  expect(await message({ type: "setEnabled", tabId: 1, enabled: true, mode: "webAgent", origin: "https://at.example", agentTabId: 8 })).toMatchObject({ ok: false });
  expect(await message({ type: "setEnabled", tabId: 1, enabled: true, mode: "webAgent", origin: "" })).toMatchObject({ ok: false });
  expect(await message({ type: "setWebAgentOrigin", tabId: 7, connected: false })).toMatchObject({ ok: true });
  expect(session.enabledTabs).toEqual([]);
  expect(webSocket).not.toHaveBeenCalled();
});
