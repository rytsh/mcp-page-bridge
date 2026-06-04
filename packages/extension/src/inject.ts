/**
 * MAIN-world script injected at document_start on every page. Defines/reads
 * `window.mcp` so a page can expose its own MCP tools to the agent:
 *
 *   // declarative (no dependency, no timing requirement):
 *   window.mcp = { label: "checkout", tools: { getCart: () => store.cart } };
 *
 *   // imperative API (available after extension injection):
 *   window.mcp.tool({ name: "getCart", description: "..." }, () => store.cart);
 *
 *   // full MCP SDK:
 *   await window.mcp.connect(myMcpServer);
 *   // or:  await myMcpServer.connect(window.mcp.transport());
 *
 * The extension also exposes built-in tools (eval, DOM, console, screenshot,
 * navigate, …) on the same provider once the tab is enabled. Nothing connects
 * to the bridge until the tab is activated via the popup.
 */
import {
  sanitizeLabel,
  type ChannelMessage,
  type ControlPayload,
  type ExtResultPayload,
} from "@r-mcp/protocol";
import {
  EmbeddedMcpServer,
  type ToolDefinition,
  type ToolHandler,
} from "./embedded-server.js";
import { TunnelTransport, allTransports, getTransport } from "./tunnel.js";
import { installConsoleCapture, registerBuiltins, type ExtCall } from "./builtins.js";
import { normalizeDeclarativeTools } from "./declarative.js";

interface SdkLikeServer {
  connect(transport: unknown): Promise<void>;
}

let activated = false;
let builtinsEnabled = true;
let label = sanitizeLabel(location.host || document.title || "browser");

let embedded: EmbeddedMcpServer | undefined;
let reconnectingEmbedded = false;

// Capture console output from the very start so console_logs has history.
// Reuse the buffer across (re-)injections so we don't double-hook console.
const consoleWin = window as unknown as {
  __rmcpConsole?: ReturnType<typeof installConsoleCapture>;
};
const consoleBuffer =
  consoleWin.__rmcpConsole ?? (consoleWin.__rmcpConsole = installConsoleCapture());

// ---- extension RPC (page -> SW for screenshot/navigate/reload) ---------------

let extSeq = 0;
const pendingExt = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const extCall: ExtCall = (action, args) =>
  new Promise((resolve, reject) => {
    const id = ++extSeq;
    pendingExt.set(id, { resolve, reject });
    const msg: ChannelMessage = {
      __rmcp: true,
      dir: "up",
      providerId: "*",
      kind: "ext",
      payload: { id, action, args },
    };
    window.postMessage(msg, "*");
    setTimeout(() => {
      if (pendingExt.delete(id)) reject(new Error(`ext "${action}" timed out`));
    }, 20000);
  });

// ---- providers ---------------------------------------------------------------

function onStarted(transport: TunnelTransport): void {
  if (activated) transport.open();
}

function newTransport(): TunnelTransport {
  return new TunnelTransport({ onStarted });
}

/**
 * Get the embedded server, creating it (with built-ins) on first use and
 * (re)connecting it whenever the tab is active but the transport is down — so it
 * recovers after the service worker is recycled.
 */
function embeddedServer(): EmbeddedMcpServer {
  if (!embedded) {
    embedded = new EmbeddedMcpServer({
      name: label,
      version: "0.1.0",
      title: document.title,
      websiteUrl: location.href,
    });
    if (builtinsEnabled) registerBuiltins(embedded, { extCall, console: consoleBuffer });
  }
  if (activated && !embedded.connected && !reconnectingEmbedded) void embedded.connect(newTransport());
  return embedded;
}

function activateAll(): void {
  syncGlobalLabel();
  activated = true;
  embeddedServer(); // built-ins are available even if the page registered nothing
  for (const t of allTransports()) {
    if (t.started) t.open();
  }
  startGlobalToolScan();
}

function deactivateAll(): void {
  activated = false;
  stopGlobalToolScan();
  for (const t of allTransports()) void t.close();
}

// ---- declarative tools: read tools the page puts on `window` ------------------
//
// Instead of calling our API, a page can expose tools as plain data and we read
// + register them ourselves (no timing dependency — works even if the value was
// set before our extension injected):
//
//   window.mcp = { label: "checkout", tools: { getCart: () => store.cart } };
//   window.mcp = { tools: { addItem: { description, inputSchema, handler } } };
//   window.mcp.tools = [{ name, description?, inputSchema?, handler }];
//
// Updates are picked up by re-reassigning the value, by in-place mutation (we
// poll while active), or instantly via window.mcp.refresh() when the injected API
// is available.

const globalTools = new Map<string, ToolHandler>();
let scanTimer: ReturnType<typeof setInterval> | undefined;
let syncQueued = false;

function readGlobalTools(): Array<{ def: ToolDefinition; handler: ToolHandler }> {
  const raw = (window as unknown as { mcp?: unknown }).mcp;
  if (!raw || typeof raw !== "object") return [];
  const mcp = raw as Record<string, unknown>;
  if ("tools" in mcp) return normalizeDeclarativeTools(mcp.tools);

  const directTools = Object.fromEntries(
    Object.entries(mcp).filter(([key]) => !RESERVED_MCP_KEYS.has(key)),
  );
  return normalizeDeclarativeTools(directTools);
}

const RESERVED_MCP_KEYS = new Set([
  "label",
  "name",
  "tools",
  "connected",
  "setLabel",
  "builtins",
  "tool",
  "registerTool",
  "refresh",
  "transport",
  "connect",
]);

function syncGlobalLabel(): boolean {
  const raw = (window as unknown as { mcp?: unknown }).mcp;
  if (!raw || typeof raw !== "object") return false;
  const mcp = raw as { label?: unknown; name?: unknown };
  const value = typeof mcp.label === "string" ? mcp.label : typeof mcp.name === "string" ? mcp.name : "";
  if (!value.trim()) return false;
  const next = sanitizeLabel(value);
  if (!next || next === label) return false;
  label = next;
  embedded?.setServerInfo({ name: label });
  return true;
}

function reconnectEmbedded(): void {
  const server = embedded;
  if (!server || !activated || !server.connected || reconnectingEmbedded) return;
  reconnectingEmbedded = true;
  void server
    .close()
    .then(() => {
      if (activated && embedded === server) return server.connect(newTransport());
      return undefined;
    })
    .finally(() => {
      reconnectingEmbedded = false;
    });
}

function scheduleGlobalSync(): void {
  if (!activated || syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    syncGlobalTools();
  });
}

function syncGlobalTools(): void {
  if (!activated) return;
  const wasConnected = !!embedded?.connected;
  const labelChanged = syncGlobalLabel();
  const server = embeddedServer();
  const current = readGlobalTools();
  const names = new Set(current.map((t) => t.def.name));
  for (const name of [...globalTools.keys()]) {
    if (!names.has(name)) {
      server.removeTool(name);
      globalTools.delete(name);
    }
  }
  for (const { def, handler } of current) {
    if (globalTools.get(def.name) !== handler) {
      server.registerTool(def, handler);
      globalTools.set(def.name, handler);
    }
  }
  if (labelChanged && wasConnected) reconnectEmbedded();
}

function startGlobalToolScan(): void {
  syncGlobalTools();
  scanTimer ??= setInterval(syncGlobalTools, 1000);
}

function stopGlobalToolScan(): void {
  if (scanTimer !== undefined) {
    clearInterval(scanTimer);
    scanTimer = undefined;
  }
}

// ---- window.mcp API ----------------------------------------------------------

const api = {
  get connected(): boolean {
    return activated;
  },

  setLabel(value: string): void {
    const next = sanitizeLabel(value);
    const changed = next !== label;
    label = next;
    embedded?.setServerInfo({ name: label });
    if (changed) reconnectEmbedded();
  },

  /** Enable/disable the built-in tools (call before the tab is enabled). */
  builtins(enabled: boolean): void {
    builtinsEnabled = enabled;
  },

  tool(def: ToolDefinition, handler: ToolHandler): () => void {
    return embeddedServer().registerTool(def, handler);
  },

  registerTool(def: ToolDefinition, handler: ToolHandler): () => void {
    return api.tool(def, handler);
  },

  /** Re-read tools the page declared on window.mcp / window.mcp.tools. */
  refresh(): void {
    syncGlobalTools();
  },

  transport(): TunnelTransport {
    return newTransport();
  },

  async connect(server: SdkLikeServer): Promise<void> {
    await server.connect(newTransport());
  },
};

function withMcpApi(value: unknown): Record<string, unknown> {
  const target = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.assign(target, api);
}

function installWindowMcp(initialValue: unknown): void {
  let current = withMcpApi(initialValue);
  try {
    Object.defineProperty(window, "mcp", {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value: unknown) => {
        current = withMcpApi(value);
        scheduleGlobalSync();
      },
    });
  } catch {
    (window as unknown as { mcp: Record<string, unknown> }).mcp = current;
  }
}

// Guard against double-injection (manifest content_script + runtime
// chrome.scripting injection into an already-open tab share this MAIN world).
const globalWin = window as unknown as { mcp?: unknown; __mcpReady?: boolean };
if (!globalWin.__mcpReady) {
  globalWin.__mcpReady = true;
  installWindowMcp(globalWin.mcp);

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as ChannelMessage | undefined;
    if (!data || data.__rmcp !== true || data.dir !== "down") return;

    switch (data.kind) {
      case "rpc":
        getTransport(data.providerId)?.deliver(data.payload);
        break;
      case "close":
        getTransport(data.providerId)?.remoteClosed();
        break;
      case "ext": {
        const { id, result, error } = data.payload as ExtResultPayload;
        const pending = pendingExt.get(id);
        if (pending) {
          pendingExt.delete(id);
          if (error) pending.reject(new Error(error));
          else pending.resolve(result);
        }
        break;
      }
      case "control": {
        const action = (data.payload as ControlPayload | undefined)?.action;
        if (action === "activate") activateAll();
        else if (action === "deactivate") deactivateAll();
        break;
      }
    }
  });

  // Notify page code that loaded before us (it can listen for "mcp:ready").
  window.dispatchEvent(new Event("mcp:ready"));
}
