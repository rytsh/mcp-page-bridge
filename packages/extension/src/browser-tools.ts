/**
 * Browser-level tools (control the *browser*, not a single page). These run in
 * the service worker with direct access to chrome.* APIs, exposed as a separate
 * opt-in "browser" provider. They are more powerful than page tools (can open/
 * close/navigate any tab), so they're gated behind a popup toggle.
 *
 * Tabs the agent opens are **enabled automatically** — otherwise the agent would
 * open a tab it cannot touch until a human clicks "Enable on this tab" in the
 * popup. Those tabs are tracked so `close_agent_tabs` can clean up the session
 * without going near the user's own tabs.
 */
import type { EmbeddedMcpServer, ToolResult } from "./embedded-server.js";
import { clampToolText } from "./dom-core.js";
import { extensionApi } from "./extension-api.js";

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: clampToolText(t) }] };
}
function json(v: unknown): ToolResult {
  return text(JSON.stringify(v, null, 2));
}

export interface BrowserToolDeps {
  /** Enable the bridge on a tab (same path as the popup's toggle). */
  enableTab(tabId: number): Promise<boolean>;
  /** Is the bridge enabled on this tab? */
  isTabEnabled(tabId: number): Promise<boolean>;
  /** Remember/forget/list tabs this agent opened. */
  trackAgentTab(tabId: number): Promise<void>;
  listAgentTabs(): Promise<number[]>;
  forgetAgentTabs(tabIds: number[]): Promise<void>;
}

export function registerBrowserTools(server: EmbeddedMcpServer, deps: BrowserToolDeps): void {
  const chrome = extensionApi();
  server.registerTool(
    {
      name: "list_tabs",
      description: "List all open browser tabs (id, title, url, active, windowId, whether the bridge is enabled on them).",
      inputSchema: { type: "object", properties: {} },
    },
    async () => {
      const tabs = await chrome.tabs.query({});
      const agentTabs = new Set(await deps.listAgentTabs());
      return json(
        await Promise.all(
          tabs.map(async (t) => ({
            id: t.id,
            title: t.title,
            url: t.url,
            active: t.active,
            windowId: t.windowId,
            enabled: t.id === undefined ? false : await deps.isTabEnabled(t.id),
            openedByAgent: t.id !== undefined && agentTabs.has(t.id),
          })),
        ),
      );
    },
  );

  server.registerTool(
    {
      name: "open_tab",
      description:
        "Open a new browser tab and (by default) enable the bridge on it, so its page tools are immediately usable. " +
        "Tabs opened this way are tracked and can be closed together with close_agent_tabs.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          active: { type: "boolean", description: "focus the new tab (default true)" },
          enable: { type: "boolean", description: "enable the bridge on the new tab (default true)" },
        },
        required: ["url"],
      },
    },
    async (args) => {
      const tab = await chrome.tabs.create({
        url: String(args.url),
        active: args.active !== false,
      });
      const tabId = tab.id;
      if (tabId === undefined) return json({ id: tab.id, url: tab.url, enabled: false });

      await deps.trackAgentTab(tabId);
      if (args.enable === false) return json({ id: tabId, url: tab.url, enabled: false, openedByAgent: true });

      const enabled = await deps.enableTab(tabId);
      return json({
        id: tabId,
        url: tab.url,
        enabled,
        openedByAgent: true,
        note: enabled
          ? "Page tools for this tab are namespaced by its label; call mcp_page_bridge_list_clients to see it."
          : "Could not enable the bridge on this tab (restricted page, or it is still loading).",
      });
    },
  );

  server.registerTool(
    {
      name: "activate_tab",
      description: "Focus/switch to a tab by id.",
      inputSchema: {
        type: "object",
        properties: { tabId: { type: "number" } },
        required: ["tabId"],
      },
    },
    async (args) => {
      const tab = await chrome.tabs.update(Number(args.tabId), { active: true });
      if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      return text(`activated tab ${args.tabId}`);
    },
  );

  server.registerTool(
    {
      name: "navigate_tab",
      description: "Navigate a specific tab to a URL.",
      inputSchema: {
        type: "object",
        properties: { tabId: { type: "number" }, url: { type: "string" } },
        required: ["tabId", "url"],
      },
    },
    async (args) => {
      await chrome.tabs.update(Number(args.tabId), { url: String(args.url) });
      return text(`navigating tab ${args.tabId} to ${args.url}`);
    },
  );

  server.registerTool(
    {
      name: "enable_tab",
      description:
        "Enable the bridge on an existing tab so its page tools appear, without the user opening the popup. " +
        "Use it on a tab the user already has open (get ids from list_tabs).",
      inputSchema: {
        type: "object",
        properties: { tabId: { type: "number" } },
        required: ["tabId"],
      },
    },
    async (args) => {
      const tabId = Number(args.tabId);
      const enabled = await deps.enableTab(tabId);
      return json({
        tabId,
        enabled,
        note: enabled ? undefined : "Could not enable the bridge (restricted page such as chrome:// or the Web Store).",
      });
    },
  );

  server.registerTool(
    {
      name: "close_tab",
      description: "Close a tab by id.",
      inputSchema: {
        type: "object",
        properties: { tabId: { type: "number" } },
        required: ["tabId"],
      },
    },
    async (args) => {
      const tabId = Number(args.tabId);
      await chrome.tabs.remove(tabId);
      await deps.forgetAgentTabs([tabId]);
      return text(`closed tab ${tabId}`);
    },
  );

  server.registerTool(
    {
      name: "close_agent_tabs",
      description: "Close every tab this agent opened with open_tab (leaves the user's own tabs alone).",
      inputSchema: { type: "object", properties: {} },
    },
    async () => {
      const tabIds = await deps.listAgentTabs();
      if (!tabIds.length) return text("no agent-opened tabs to close");
      const closed: number[] = [];
      for (const tabId of tabIds) {
        try {
          await chrome.tabs.remove(tabId);
          closed.push(tabId);
        } catch {
          // Already gone.
        }
      }
      await deps.forgetAgentTabs(tabIds);
      return json({ closed, requested: tabIds.length });
    },
  );
}
