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
  MCP_PAGE_BRIDGE_VERSION,
  sanitizeLabel,
  type ChannelMessage,
  type ControlPayload,
  type ExtResultPayload,
} from "mcp-page-bridge-protocol";
import {
  EmbeddedMcpServer,
  type ToolDefinition,
  type ToolHandler,
} from "./embedded-server.js";
import { TunnelTransport, allTransports, getTransport } from "./tunnel.js";
import {
  clearCssPatches,
  clearSelectedElements,
  exportCssPatches,
  getCssPatches,
  getSelectedElementSnapshots,
  getSelectedMarkersVisible,
  installConsoleCapture,
  removeCssPatch,
  removeSelectedElement,
  registerBuiltins,
  setSelectedElement,
  setSelectedElementMeta,
  setSelectedMarkersVisible,
  type ExtCall,
} from "./builtins.js";
import { normalizeDeclarativeTools } from "./declarative.js";

interface SdkLikeServer {
  connect(transport: unknown): Promise<void>;
}

let activated = false;
let builtinsEnabled = true;
let evalEnabled = true;
// Opt-in design/selection built-ins (popup "Design tools"). Off by default to
// keep the built-in tool catalog small. Set from the activate control message.
let designToolsEnabled = false;
let label = sanitizeLabel(location.host || document.title || "browser");

let embedded: EmbeddedMcpServer | undefined;
let reconnectingEmbedded = false;

// Capture console output from the very start so console_logs has history.
// Reuse the buffer across (re-)injections so we don't double-hook console.
const consoleWin = window as unknown as {
  __mcpPageBridgeConsole?: ReturnType<typeof installConsoleCapture>;
};
const consoleBuffer =
  consoleWin.__mcpPageBridgeConsole ?? (consoleWin.__mcpPageBridgeConsole = installConsoleCapture());

// ---- extension RPC (page -> SW for screenshot/navigate/reload) ---------------

let extSeq = 0;
const pendingExt = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const extCall: ExtCall = (action, args) =>
  new Promise((resolve, reject) => {
    const id = ++extSeq;
    pendingExt.set(id, { resolve, reject });
    const msg: ChannelMessage = {
      __mcpPageBridge: true,
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
      version: MCP_PAGE_BRIDGE_VERSION,
      title: document.title,
      websiteUrl: location.href,
    });
    if (builtinsEnabled) {
      registerBuiltins(embedded, {
        extCall,
        console: consoleBuffer,
        includeEval: evalEnabled,
        designTools: designToolsEnabled,
      });
    }
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
  "allowEval",
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

/**
 * Toggle the opt-in design/selection built-ins. Rebuilds the embedded server so
 * its registered tool set matches, and re-registers any page-declared tools.
 */
function rebuildEmbeddedForDesignTools(): void {
  const server = embedded;
  if (!server) {
    if (activated) embeddedServer();
    return;
  }
  globalTools.clear(); // force page-declared tools to re-register on the fresh server
  void server.close().then(() => {
    if (embedded === server) embedded = undefined;
    if (activated) {
      embeddedServer(); // recreate with built-ins per the new flag (+ reconnect)
      syncGlobalTools(); // re-register page-declared tools
    }
  });
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

  /** Enable/disable just the `eval` built-in (call before the tab is enabled). */
  allowEval(enabled: boolean): void {
    evalEnabled = enabled;
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

// ---- element picker ----------------------------------------------------------

let stopElementPicker: (() => void) | undefined;

function showPickerToast(message: string, timeoutMs = 1800): void {
  const toast = document.createElement("div");
  toast.textContent = message;
  Object.assign(toast.style, {
    position: "fixed",
    left: "50%",
    bottom: "20px",
    transform: "translateX(-50%)",
    zIndex: "2147483647",
    padding: "10px 12px",
    borderRadius: "999px",
    background: "rgba(15, 23, 42, 0.94)",
    color: "#fff",
    font: "12px system-ui, -apple-system, Segoe UI, sans-serif",
    boxShadow: "0 12px 32px rgba(15, 23, 42, 0.35)",
    pointerEvents: "none",
  });
  document.documentElement.append(toast);
  setTimeout(() => toast.remove(), timeoutMs);
}

function startElementPicker(opts: { append?: boolean } = {}): void {
  stopElementPicker?.();

  const overlay = document.createElement("div");
  const label = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed",
    zIndex: "2147483647",
    pointerEvents: "none",
    border: "2px solid #2563eb",
    borderRadius: "8px",
    background: "rgba(37, 99, 235, 0.12)",
    boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.12)",
    display: "none",
  });
  Object.assign(label.style, {
    position: "fixed",
    zIndex: "2147483647",
    pointerEvents: "none",
    padding: "7px 9px",
    borderRadius: "8px",
    background: "#2563eb",
    color: "#fff",
    font: "12px system-ui, -apple-system, Segoe UI, sans-serif",
    boxShadow: "0 8px 24px rgba(37, 99, 235, 0.35)",
  });
  label.textContent = opts.append
    ? "Click another element to add it. Esc cancels."
    : "Click an element to select it. Esc cancels.";
  document.documentElement.append(overlay, label);

  const elementFromEvent = (event: Event): Element | undefined => {
    for (const node of event.composedPath()) {
      if (node instanceof Element && node !== overlay && node !== label) return node;
    }
    return undefined;
  };

  const update = (element: Element): void => {
    const rect = element.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    label.style.left = `${Math.min(Math.max(8, rect.left), Math.max(8, innerWidth - 290))}px`;
    label.style.top = `${Math.max(8, rect.top - 38)}px`;
  };

  const blockPostPickClick = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
    window.removeEventListener("click", blockPostPickClick, true);
  };

  const cleanup = (): void => {
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
    label.remove();
    if (stopElementPicker === cleanup) stopElementPicker = undefined;
  };

  function finish(element: Element): void {
    window.addEventListener("click", blockPostPickClick, true);
    setTimeout(() => window.removeEventListener("click", blockPostPickClick, true), 500);
    const snapshot = setSelectedElement(element, { append: opts.append });
    cleanup();
    if (snapshot) {
      showPickerToast(`${opts.append ? "Added" : "Selected"} ${snapshot.selector}`, 2200);
      window.dispatchEvent(new CustomEvent("mcp:element-picked", { detail: snapshot }));
    }
  }

  function onPointerMove(event: PointerEvent): void {
    const element = elementFromEvent(event);
    if (element) update(element);
  }

  function onPointerDown(event: PointerEvent): void {
    const element = elementFromEvent(event);
    if (!element) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finish(element);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cleanup();
    showPickerToast("Element pick cancelled");
  }

  stopElementPicker = cleanup;
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  showPickerToast(opts.append ? "Add another element. Click a page element." : "Element picker active. Click a page element.");
}

interface McpPageBridgeWindow {
  mcp?: unknown;
  __mcpReady?: boolean;
  __mcpPageBridgeReadyV2?: boolean;
  __mcpPageBridgeStartElementPicker?: (opts?: { append?: boolean }) => void;
  __mcpPageBridgeCancelElementPicker?: () => void;
  __mcpPageBridgeClearSelectedElements?: () => void;
  __mcpPageBridgeGetSelectedElements?: () => unknown[];
  __mcpPageBridgeRemoveSelectedElement?: (id: string) => boolean;
  __mcpPageBridgeSetSelectedElementMeta?: (id: string, meta: { name?: string; group?: string }) => boolean;
  __mcpPageBridgeSetSelectedMarkersVisible?: (visible: boolean) => void;
  __mcpPageBridgeGetSelectedMarkersVisible?: () => boolean;
  __mcpPageBridgeGetCssPatches?: () => unknown[];
  __mcpPageBridgeRemoveCssPatch?: (id: string) => boolean;
  __mcpPageBridgeClearCssPatches?: () => number;
  __mcpPageBridgeExportCssPatches?: () => string;
}

// Guard against double-injection (manifest content_script + runtime
// chrome.scripting injection into an already-open tab share this MAIN world).
const globalWin = window as unknown as McpPageBridgeWindow;
globalWin.__mcpPageBridgeStartElementPicker = startElementPicker;
globalWin.__mcpPageBridgeCancelElementPicker = () => stopElementPicker?.();
globalWin.__mcpPageBridgeClearSelectedElements = clearSelectedElements;
globalWin.__mcpPageBridgeGetSelectedElements = getSelectedElementSnapshots;
globalWin.__mcpPageBridgeRemoveSelectedElement = removeSelectedElement;
globalWin.__mcpPageBridgeSetSelectedElementMeta = setSelectedElementMeta;
globalWin.__mcpPageBridgeSetSelectedMarkersVisible = setSelectedMarkersVisible;
globalWin.__mcpPageBridgeGetSelectedMarkersVisible = getSelectedMarkersVisible;
globalWin.__mcpPageBridgeGetCssPatches = getCssPatches;
globalWin.__mcpPageBridgeRemoveCssPatch = removeCssPatch;
globalWin.__mcpPageBridgeClearCssPatches = clearCssPatches;
globalWin.__mcpPageBridgeExportCssPatches = exportCssPatches;

if (!globalWin.__mcpPageBridgeReadyV2) {
  globalWin.__mcpPageBridgeReadyV2 = true;
  globalWin.__mcpReady = true;
  installWindowMcp(globalWin.mcp);

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as ChannelMessage | undefined;
    if (!data || data.__mcpPageBridge !== true || data.dir !== "down") return;

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
        const payload = data.payload as
          | (ControlPayload & { append?: boolean; selectionId?: string; visible?: boolean; name?: string; group?: string })
          | undefined;
        const action = payload?.action;
        if (action === "activate") {
          const wantDesign = payload?.designTools === true;
          const changed = wantDesign !== designToolsEnabled;
          designToolsEnabled = wantDesign;
          if (activated && changed) rebuildEmbeddedForDesignTools();
          else activateAll();
        } else if (action === "deactivate") {
          stopElementPicker?.();
          deactivateAll();
        } else if (action === "startElementPicker") startElementPicker({ append: !!payload?.append });
        else if (action === "cancelElementPicker") stopElementPicker?.();
        else if (action === "clearSelectedElements") clearSelectedElements();
        else if (action === "removeSelectedElement") removeSelectedElement(String(payload?.selectionId ?? ""));
        else if (action === "setSelectedElementMeta") {
          setSelectedElementMeta(String(payload?.selectionId ?? ""), { name: payload?.name, group: payload?.group });
        }
        else if (action === "setSelectedMarkersVisible") setSelectedMarkersVisible(payload?.visible !== false);
        break;
      }
    }
  });

  // Notify page code that loaded before us (it can listen for "mcp:ready").
  window.dispatchEvent(new Event("mcp:ready"));
}
