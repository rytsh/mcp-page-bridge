/**
 * Browser-level tools (control the *browser*, not a single page). These run in
 * the service worker with direct access to chrome.* APIs, exposed as a separate
 * opt-in "browser" provider. They are more powerful than page tools (can open/
 * close/navigate any tab), so they're gated behind a popup toggle.
 */
import type { EmbeddedMcpServer, ToolResult } from "./embedded-server.js";

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}
function json(v: unknown): ToolResult {
  return text(JSON.stringify(v, null, 2));
}

export function registerBrowserTools(server: EmbeddedMcpServer): void {
  server.registerTool(
    {
      name: "list_tabs",
      description: "List all open browser tabs (id, title, url, active, windowId).",
      inputSchema: { type: "object", properties: {} },
    },
    async () => {
      const tabs = await chrome.tabs.query({});
      return json(
        tabs.map((t) => ({
          id: t.id,
          title: t.title,
          url: t.url,
          active: t.active,
          windowId: t.windowId,
        })),
      );
    },
  );

  server.registerTool(
    {
      name: "open_tab",
      description: "Open a new browser tab.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" }, active: { type: "boolean" } },
        required: ["url"],
      },
    },
    async (args) => {
      const tab = await chrome.tabs.create({
        url: String(args.url),
        active: args.active !== false,
      });
      return json({ id: tab.id, url: tab.url });
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
      name: "close_tab",
      description: "Close a tab by id.",
      inputSchema: {
        type: "object",
        properties: { tabId: { type: "number" } },
        required: ["tabId"],
      },
    },
    async (args) => {
      await chrome.tabs.remove(Number(args.tabId));
      return text(`closed tab ${args.tabId}`);
    },
  );
}
