/**
 * MAIN-world script injected at document_start on every page. It wires the
 * standard WebMCP API (`document.modelContext`) to the bridge, so a page exposes
 * tools the way the web platform specifies:
 *
 *   await document.modelContext.registerTool({
 *     name: "get-cart",
 *     description: "Return the current shopping cart",
 *     inputSchema: { type: "object", properties: {} },
 *     execute: () => store.cart,
 *   });
 *
 * If the browser has no native `document.modelContext` (outside the Chrome 149 /
 * Edge 150 origin trials) we install a spec-shaped polyfill here, at
 * document_start, so the same code works everywhere. See ./webmcp.ts.
 *
 * Bridge-specific knobs that WebMCP does not cover live on `window.mcpPageBridge`
 * (provider label, built-in toolset, full MCP SDK transport):
 *
 *   window.mcpPageBridge.setLabel("checkout");
 *   await window.mcpPageBridge.connect(myMcpSdkServer);
 *   // or:  await myMcpSdkServer.connect(window.mcpPageBridge.transport());
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
import { EmbeddedMcpServer } from "./embedded-server.js";
import { TunnelTransport, allTransports, getTransport } from "./tunnel.js";
import { teardownAutomationTools } from "./automation-tools.js";
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
import { bindModelContext, type ModelContextBinding } from "./webmcp.js";
import { ToolMirror } from "./tool-mirror.js";

interface SdkLikeServer {
  connect(transport: unknown): Promise<void>;
}

let activated = false;
let builtinsEnabled = true;
let evalEnabled = true;
let coreToolsEnabled = true;
// Opt-in design/selection built-ins (popup "Design tools"). Off by default to
// keep the built-in tool catalog small. Set from the activate control message.
let designToolsEnabled = false;
let automationToolsEnabled = false;
let cdpToolsEnabled = false;
let trustedInputEnabled = false;
let label = sanitizeLabel(location.host || document.title || "browser");

let embedded: EmbeddedMcpServer | undefined;
/**
 * Bumped every time the embedded server is torn down or replaced. Async work
 * started against an older generation (a reconnect, a tool sync) must not touch
 * the current server. Replaces the old `reconnectingEmbedded` flag, which
 * `embeddedServer()` also read as a connect guard — so a rebuild landing inside
 * a reconnect window left the new server permanently unconnected.
 */
let embeddedGeneration = 0;

// Install (or adopt) `document.modelContext` before any page script can run, so
// a page never has to feature-detect or wait for us.
const modelContext: ModelContextBinding = bindModelContext(document, window);

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
        coreTools: coreToolsEnabled,
        designTools: designToolsEnabled,
        automationTools: automationToolsEnabled,
        cdpTools: cdpToolsEnabled,
        trustedInput: trustedInputEnabled,
      });
    }
  }
  if (activated && !embedded.connected) void embedded.connect(newTransport());
  return embedded;
}

/**
 * Tear down the current embedded server and invalidate in-flight work on it.
 * Bumping the generation is what tells ToolMirror that anything it thinks is
 * registered belongs to a server that no longer exists.
 */
function retireEmbedded(): EmbeddedMcpServer | undefined {
  const server = embedded;
  embedded = undefined;
  embeddedGeneration += 1;
  return server;
}

function activateAll(): void {
  activated = true;
  embeddedServer(); // built-ins are available even if the page registered nothing
  for (const t of allTransports()) {
    if (t.started) t.open();
  }
  void toolMirror.sync();
}

function deactivateAll(): void {
  activated = false;
  // Restore any page patches the automation tools installed (fetch/XHR hooks,
  // alert/confirm/prompt overrides) so a disabled tab no longer affects the page.
  teardownAutomationTools();
  for (const t of allTransports()) void t.close();
}

// ---- WebMCP: mirror document.modelContext into the embedded server -----------
//
// The page registers tools through the standard API and we reflect the result
// into the embedded MCP server the bridge talks to:
//
//   await document.modelContext.registerTool({ name, description, inputSchema, execute });
//
// `toolchange` tells us when the set changed (both natively and in our
// polyfill), so there is no polling and no timing requirement — the polyfill is
// installed at document_start, before any page script runs.

/**
 * Mirrors document.modelContext into the embedded server. The generation makes
 * it safe for a sync to be in flight while the server is rebuilt.
 */
const toolMirror = new ToolMirror({
  target: () =>
    activated ? { server: embeddedServer(), generation: embeddedGeneration } : undefined,
  read: () => modelContext.readTools(),
  onError: (error) =>
    console.warn("[mcp-page-bridge] could not read document.modelContext:", error),
});

/**
 * Toggle opt-in built-ins. Rebuilds the embedded server so its registered tool
 * set matches, and re-registers the page's WebMCP tools onto the new one.
 */
function rebuildEmbeddedForToolset(): void {
  const server = retireEmbedded();
  if (!server) {
    if (activated) toolMirror.schedule();
    return;
  }
  // `embedded` is already undefined and the generation already bumped, so a
  // sync that resumes mid-close targets the new server, not the doomed one.
  void server.close().finally(() => {
    if (activated) void toolMirror.sync();
  });
}

function reconnectEmbedded(): void {
  const server = embedded;
  if (!server || !activated || !server.connected) return;
  const generation = embeddedGeneration;
  void server.close().then(() => {
    // Bail if the server was retired or replaced while we were closing.
    if (!activated || embeddedGeneration !== generation || embedded !== server) return;
    return server.connect(newTransport());
  });
}

// ---- window.mcpPageBridge: bridge knobs WebMCP does not cover ----------------

const bridgeApi = {
  /** True once the tab has been enabled from the popup. */
  get connected(): boolean {
    return activated;
  },

  /** The provider label the agent sees tools namespaced under (`label__tool`). */
  get label(): string {
    return label;
  },

  /** True when the browser has a native WebMCP implementation (not our polyfill). */
  get nativeWebMcp(): boolean {
    return modelContext.native;
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

  /** Force a re-read of document.modelContext (normally driven by `toolchange`). */
  refresh(): void {
    void toolMirror.sync();
  },

  transport(): TunnelTransport {
    return newTransport();
  },

  async connect(server: SdkLikeServer): Promise<void> {
    await server.connect(newTransport());
  },
};

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
  mcpPageBridge?: typeof bridgeApi;
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

// Guard against double-injection: the manifest content_script and the runtime
// chrome.scripting injection (for tabs that were already open) share this MAIN
// world, so this module can be evaluated twice.
//
// EVERYTHING that touches a global must sit inside this guard. The second
// evaluation gets its own module scope — including builtins.ts's selected
// elements and CSS patches — so overwriting the globals would point the popup
// at instance #2's stores while the agent's tools still read instance #1's.
const globalWin = window as unknown as McpPageBridgeWindow;

if (!globalWin.__mcpPageBridgeReadyV2) {
  globalWin.__mcpPageBridgeReadyV2 = true;
  globalWin.__mcpReady = true;
  globalWin.mcpPageBridge = bridgeApi;

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

  modelContext.subscribe(() => toolMirror.schedule());

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
          const wantCore = payload?.coreTools !== false;
          const wantDesign = payload?.designTools === true;
          const wantAutomation = payload?.automationTools === true;
          const wantCdp = payload?.cdpTools === true;
          const wantTrustedInput = payload?.trustedInput === true;
          const changed =
            wantCore !== coreToolsEnabled ||
            wantDesign !== designToolsEnabled ||
            wantAutomation !== automationToolsEnabled ||
            wantCdp !== cdpToolsEnabled ||
            wantTrustedInput !== trustedInputEnabled;
          // Turning automation off must restore the page patches it installed.
          if (automationToolsEnabled && !wantAutomation) teardownAutomationTools();
          coreToolsEnabled = wantCore;
          designToolsEnabled = wantDesign;
          automationToolsEnabled = wantAutomation;
          cdpToolsEnabled = wantCdp;
          trustedInputEnabled = wantTrustedInput;
          if (activated && changed) rebuildEmbeddedForToolset();
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

  // Signals that `window.mcpPageBridge` is available. Page tools do NOT need
  // this: `document.modelContext` is installed at document_start, before any
  // page script runs.
  window.dispatchEvent(new Event("mcp-page-bridge:ready"));
}
