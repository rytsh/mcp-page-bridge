/**
 * MV3 service worker. Owns the WebSocket connections to the mcp-page-bridge bridge (the
 * page itself cannot reach ws://127.0.0.1 from an https origin due to
 * mixed-content/CSP — the SW is not subject to page CSP).
 *
 * One WebSocket per provider per tab. The SW terminates the internal
 * ChannelMessage envelope and forwards the raw MCP JSON-RPC `payload` onto the
 * socket, and vice-versa.
 */
import {
  DEFAULT_PORT,
  MCP_PAGE_BRIDGE_DASHBOARD_ACTIVATE_TAB,
  MCP_PAGE_BRIDGE_DASHBOARD_CLOSE_TAB,
  type ChannelMessage,
  type ControlAction,
  type ControlPayload,
  type ExtCallPayload,
} from "mcp-page-bridge-protocol";
import { BrowserProvider } from "./browser-provider.js";

interface SocketEntry {
  ws?: WebSocket;
  outbuf: string[];
  meta: { url?: string; title?: string };
  /** We want this socket connected (auto-reconnect until told otherwise). */
  wantOpen: boolean;
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_OUTBUF = 200;

interface TabState {
  tabId: number;
  port: chrome.runtime.Port;
  sockets: Map<string, SocketEntry>;
}

const tabs = new Map<number, TabState>();
let bridgePort = DEFAULT_PORT;
let bridgeToken = "";
let browserControl = false;

function wsUrl(meta: Record<string, string | number | undefined> = {}): string {
  const url = new URL(`ws://127.0.0.1:${bridgePort}`);
  if (bridgeToken) url.searchParams.set("token", bridgeToken);
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

// Optional, opt-in "browser" provider (controls all tabs, not just one page).
const browserProvider = new BrowserProvider(() => wsUrl());

void chrome.storage.local.get(["port", "token", "browserControl"]).then((v) => {
  if (v.port) bridgePort = Number(v.port) || DEFAULT_PORT;
  if (typeof v.token === "string") bridgeToken = v.token;
  browserControl = !!v.browserControl;
  if (browserControl) browserProvider.start();
});

// ---- enabled-tab persistence (survives SW restarts within a session) ---------

async function getEnabledSet(): Promise<Set<number>> {
  const v = await chrome.storage.session.get("enabledTabs");
  return new Set<number>((v.enabledTabs as number[] | undefined) ?? []);
}

async function isEnabled(tabId: number): Promise<boolean> {
  return (await getEnabledSet()).has(tabId);
}

async function setEnabled(tabId: number, on: boolean): Promise<void> {
  const set = await getEnabledSet();
  if (on) set.add(tabId);
  else set.delete(tabId);
  await chrome.storage.session.set({ enabledTabs: [...set] });
}

// ---- downstream helpers (SW -> content -> page) ------------------------------

function downRpc(state: TabState, providerId: string, payload: unknown): void {
  const msg: ChannelMessage = { __mcpPageBridge: true, dir: "down", providerId, kind: "rpc", payload };
  safePost(state, msg);
}

function downClose(state: TabState, providerId: string): void {
  const msg: ChannelMessage = { __mcpPageBridge: true, dir: "down", providerId, kind: "close" };
  safePost(state, msg);
}

function sendControl(state: TabState, action: ControlAction, extra: Partial<ControlPayload> = {}): void {
  const msg: ChannelMessage = {
    __mcpPageBridge: true,
    dir: "down",
    providerId: "*",
    kind: "control",
    payload: { ...extra, action } satisfies ControlPayload,
  };
  safePost(state, msg);
}

function safePost(state: TabState, msg: ChannelMessage): void {
  try {
    state.port.postMessage(msg);
  } catch {
    // port gone
  }
}

// ---- WebSocket management (with auto-reconnect) -----------------------------
//
// The page-side TunnelTransport stays "open" across socket bounces, so we must
// NOT notify the page on an unexpected close — we just reconnect underneath and
// the bridge re-runs `initialize` over the fresh socket. The page is only told
// to close on an *explicit* teardown (disable / page-initiated close).

function openSocket(state: TabState, providerId: string, meta: { url?: string; title?: string }): void {
  let entry = state.sockets.get(providerId);
  if (!entry) {
    entry = { outbuf: [], meta, wantOpen: true, attempts: 0 };
    state.sockets.set(providerId, entry);
  } else {
    entry.meta = meta;
    entry.wantOpen = true;
  }
  connectSocket(state, providerId);
}

function connectSocket(state: TabState, providerId: string): void {
  const entry = state.sockets.get(providerId);
  if (!entry || !entry.wantOpen || entry.ws) return;

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl({ tabId: state.tabId, providerId }), "mcp");
  } catch {
    scheduleReconnect(state, providerId);
    return;
  }
  entry.ws = ws;

  ws.addEventListener("open", () => {
    entry.attempts = 0;
    for (const data of entry.outbuf) ws.send(data);
    entry.outbuf.length = 0;
  });
  ws.addEventListener("message", (ev: MessageEvent) => {
    const raw = typeof ev.data === "string" ? ev.data : "";
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (isDashboardRpc(payload)) {
      void handleDashboardRpc(state, ws, payload);
      return;
    }
    downRpc(state, providerId, payload);
  });
  ws.addEventListener("close", () => {
    entry.ws = undefined;
    if (entry.wantOpen) scheduleReconnect(state, providerId); // bridge down/restarting
  });
  ws.addEventListener("error", () => {
    // 'close' fires next; reconnect handled there.
  });
}

function scheduleReconnect(state: TabState, providerId: string): void {
  const entry = state.sockets.get(providerId);
  if (!entry || !entry.wantOpen) return;
  entry.attempts += 1;
  const delay = Math.min(500 * 2 ** Math.min(entry.attempts, 4), 5000); // ~1s..5s
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => connectSocket(state, providerId), delay);
}

function sendToSocket(state: TabState, providerId: string, payload: unknown): void {
  const entry = state.sockets.get(providerId);
  if (!entry) return;
  const data = JSON.stringify(payload);
  if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
    entry.ws.send(data);
  } else {
    entry.outbuf.push(data);
    if (entry.outbuf.length > MAX_OUTBUF) entry.outbuf.splice(0, entry.outbuf.length - MAX_OUTBUF);
  }
}

interface DashboardRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
}

function isDashboardRpc(value: unknown): value is DashboardRpcRequest {
  if (!value || typeof value !== "object") return false;
  const method = (value as { method?: unknown }).method;
  return method === MCP_PAGE_BRIDGE_DASHBOARD_ACTIVATE_TAB || method === MCP_PAGE_BRIDGE_DASHBOARD_CLOSE_TAB;
}

function sendDashboardResult(ws: WebSocket, id: string | number | null | undefined): void {
  if (id === undefined || id === null) return;
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
}

function sendDashboardError(ws: WebSocket, id: string | number | null | undefined, error: unknown): void {
  if (id === undefined || id === null) return;
  const message = error instanceof Error ? error.message : String(error);
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
}

async function handleDashboardRpc(state: TabState, ws: WebSocket, req: DashboardRpcRequest): Promise<void> {
  try {
    if (req.method === MCP_PAGE_BRIDGE_DASHBOARD_ACTIVATE_TAB) {
      const tab = await chrome.tabs.update(state.tabId, { active: true });
      if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      sendDashboardResult(ws, req.id);
      return;
    }

    if (req.method === MCP_PAGE_BRIDGE_DASHBOARD_CLOSE_TAB) {
      sendDashboardResult(ws, req.id);
      setTimeout(() => {
        void chrome.tabs.remove(state.tabId).catch(() => {
          // tab may already be gone
        });
      }, 25);
    }
  } catch (error) {
    sendDashboardError(ws, req.id, error);
  }
}

/** Explicit teardown: stop reconnecting, close, and tell the page. */
function closeSocket(state: TabState, providerId: string): void {
  const entry = state.sockets.get(providerId);
  if (!entry) return;
  entry.wantOpen = false;
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.ws) {
    try {
      entry.ws.close();
    } catch {
      // ignore
    }
  }
  state.sockets.delete(providerId);
  downClose(state, providerId);
}

function closeAllSockets(state: TabState): void {
  for (const id of [...state.sockets.keys()]) closeSocket(state, id);
}

/**
 * Inject the content + MAIN-world scripts into a tab that was already open
 * before the extension loaded (manifest content_scripts only run on load/nav).
 * The scripts guard against double-injection. inject.js first so window.mcp
 * exists before content.js triggers activation.
 */
async function injectIntoTab(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["inject.js"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (error) {
    console.warn("[mcp-page-bridge] could not inject into tab", tabId, error);
  }
}

// ---- per-tab toolbar icon state ---------------------------------------------
// State-colored glyph on a transparent background; the bundled SVG has a filled
// hexagon, so we strip that fill before rendering the toolbar icon.

const ICON_RED = "#e63946";
const ICON_GREEN = "#2e9b4e";

async function renderIcon(color: string, size: number): Promise<ImageData> {
  const svg = (await (await fetch(chrome.runtime.getURL("icons/icon.svg"))).text())
    .replace('viewBox="0 0 24 24"', `width="${size}" height="${size}" viewBox="0 0 24 24"`)
    .replace(/<polygon([^>]*)fill="#[^"]+"\s*\/>/, '<polygon$1fill="transparent"/>')
    .replaceAll('stroke="#ffffff"', `stroke="${color}"`);
  const bitmap = await createImageBitmap(new Blob([svg], { type: "image/svg+xml" }));
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(bitmap, 0, 0, size, size);
  bitmap.close();
  return ctx.getImageData(0, 0, size, size);
}

async function updateActionIcon(tabId: number, enabled: boolean): Promise<void> {
  const color = enabled ? ICON_GREEN : ICON_RED;

  // Recolor the toolbar icon (best effort).
  try {
    const [icon16, icon32] = await Promise.all([renderIcon(color, 16), renderIcon(color, 32)]);
    await chrome.action.setIcon({ tabId, imageData: { 16: icon16, 32: icon32 } });
  } catch {
    // icon stays the default; the badge below still signals state.
  }

  // Lightning badge = "powered up / active on this tab".
  try {
    await chrome.action.setBadgeText({ tabId, text: enabled ? "⚡" : "" });
    if (enabled) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: [0, 0, 0, 0] });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ tabId, color: ICON_GREEN });
      }
    }
  } catch {
    // ignore
  }

  try {
    await chrome.action.setTitle({
      tabId,
      title: enabled ? "mcp-page-bridge — ⚡ enabled on this tab" : "mcp-page-bridge",
    });
  } catch {
    // ignore
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureEnabledTab(tabId: number): Promise<TabState | undefined> {
  await setEnabled(tabId, true);
  void updateActionIcon(tabId, true);

  let state = tabs.get(tabId);
  if (!state) await injectIntoTab(tabId);

  for (let i = 0; i < 6; i += 1) {
    state = tabs.get(tabId);
    if (state) {
      sendControl(state, "activate");
      return state;
    }
    await sleep(80);
  }

  return undefined;
}

async function runElementPickerScript(
  tabId: number,
  action:
    | "start"
    | "cancel"
    | "clear"
    | "get"
    | "remove"
    | "setMeta"
    | "setVisible"
    | "getCssPatches"
    | "removeCssPatch"
    | "clearCssPatches",
  opts: { append?: boolean; selectionId?: string; visible?: boolean; name?: string; group?: string; patchId?: string } = {},
): Promise<unknown> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [action, opts],
      func: (
        pickerAction:
          | "start"
          | "cancel"
          | "clear"
          | "get"
          | "remove"
          | "setMeta"
          | "setVisible"
          | "getCssPatches"
          | "removeCssPatch"
          | "clearCssPatches",
        pickerOpts: { append?: boolean; selectionId?: string; visible?: boolean; name?: string; group?: string; patchId?: string },
      ) => {
        const win = window as unknown as {
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
        };
        if (pickerAction === "get") {
          return {
            items: win.__mcpPageBridgeGetSelectedElements?.() ?? [],
            markersVisible: win.__mcpPageBridgeGetSelectedMarkersVisible?.() !== false,
          };
        }
        if (pickerAction === "remove") return win.__mcpPageBridgeRemoveSelectedElement?.(String(pickerOpts.selectionId ?? "")) === true;
        if (pickerAction === "setMeta") {
          return win.__mcpPageBridgeSetSelectedElementMeta?.(String(pickerOpts.selectionId ?? ""), {
            name: pickerOpts.name,
            group: pickerOpts.group,
          }) === true;
        }
        if (pickerAction === "setVisible") {
          win.__mcpPageBridgeSetSelectedMarkersVisible?.(pickerOpts.visible !== false);
          return true;
        }
        if (pickerAction === "getCssPatches") return win.__mcpPageBridgeGetCssPatches?.() ?? [];
        if (pickerAction === "removeCssPatch") return win.__mcpPageBridgeRemoveCssPatch?.(String(pickerOpts.patchId ?? "")) === true;
        if (pickerAction === "clearCssPatches") return win.__mcpPageBridgeClearCssPatches?.() ?? 0;
        const fn =
          pickerAction === "start"
            ? win.__mcpPageBridgeStartElementPicker
            : pickerAction === "cancel"
              ? win.__mcpPageBridgeCancelElementPicker
              : win.__mcpPageBridgeClearSelectedElements;
        if (!fn) return false;
        if (pickerAction === "start") win.__mcpPageBridgeStartElementPicker?.(pickerOpts);
        else fn();
        return true;
      },
    });
    return result?.result;
  } catch {
    return undefined;
  }
}

interface SelectionState {
  items: unknown[];
  markersVisible: boolean;
}

interface PageDesignState {
  selection: SelectionState;
  cssPatches: unknown[];
}

function normalizeSelectionState(value: unknown): SelectionState {
  if (Array.isArray(value)) return { items: value, markersVisible: true };
  if (value && typeof value === "object") {
    const data = value as { items?: unknown; markersVisible?: unknown };
    return {
      items: Array.isArray(data.items) ? data.items : [],
      markersVisible: data.markersVisible !== false,
    };
  }
  return { items: [], markersVisible: true };
}

async function readSelectionState(tabId: number): Promise<SelectionState> {
  const current = await runElementPickerScript(tabId, "get");
  if (current !== undefined) return normalizeSelectionState(current);
  await injectIntoTab(tabId);
  await sleep(50);
  return normalizeSelectionState(await runElementPickerScript(tabId, "get"));
}

async function readPageDesignState(tabId: number): Promise<PageDesignState> {
  const selection = await readSelectionState(tabId);
  let cssPatches = await runElementPickerScript(tabId, "getCssPatches");
  if (cssPatches === undefined) {
    await injectIntoTab(tabId);
    await sleep(50);
    cssPatches = await runElementPickerScript(tabId, "getCssPatches");
  }
  return { selection, cssPatches: Array.isArray(cssPatches) ? cssPatches : [] };
}

// ---- per-tab Port wiring -----------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "mcp-page-bridge") return;
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) return;

  // Replace any stale state for this tab.
  const existing = tabs.get(tabId);
  if (existing) closeAllSockets(existing);

  const state: TabState = { tabId, port, sockets: new Map() };
  tabs.set(tabId, state);

  port.onMessage.addListener((msg: ChannelMessage) => {
    void handleUp(state, msg);
  });
  port.onDisconnect.addListener(() => {
    closeAllSockets(state);
    if (tabs.get(tabId) === state) tabs.delete(tabId);
  });
});

async function handleUp(state: TabState, msg: ChannelMessage): Promise<void> {
  if (!msg || msg.__mcpPageBridge !== true || msg.dir !== "up") return;

  if (msg.kind === "control") {
    const action = (msg.payload as ControlPayload | undefined)?.action;
    if (action === "hello") {
      const on = await isEnabled(state.tabId);
      void updateActionIcon(state.tabId, on);
      if (on) sendControl(state, "activate");
    }
    return;
  }

  if (msg.kind === "open") {
    if (!(await isEnabled(state.tabId))) return;
    openSocket(state, msg.providerId, (msg.payload as { url?: string; title?: string }) ?? {});
    return;
  }

  if (msg.kind === "rpc") {
    sendToSocket(state, msg.providerId, msg.payload);
    return;
  }

  if (msg.kind === "ext") {
    await handleExt(state, msg.payload as ExtCallPayload);
    return;
  }

  if (msg.kind === "close") {
    closeSocket(state, msg.providerId);
  }
}

async function handleExt(state: TabState, req: ExtCallPayload): Promise<void> {
  const reply = (payload: { id: number; result?: unknown; error?: string }): void => {
    const msg: ChannelMessage = { __mcpPageBridge: true, dir: "down", providerId: "*", kind: "ext", payload };
    safePost(state, msg);
  };
  try {
    reply({ id: req.id, result: await runExt(state.tabId, req.action, req.args ?? {}) });
  } catch (error) {
    reply({ id: req.id, error: error instanceof Error ? error.message : String(error) });
  }
}

async function runExt(
  tabId: number,
  action: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "screenshot": {
      const tab = await chrome.tabs.get(tabId);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      let savedAs: string | undefined;
      if (args.download) {
        const filename = (args.filename as string) || `mcp-page-bridge-${Date.now()}.png`;
        await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
        savedAs = filename;
      }
      return { dataUrl, savedAs };
    }
    case "navigate":
      await chrome.tabs.update(tabId, { url: String(args.url) });
      return { ok: true };
    case "reload":
      await chrome.tabs.reload(tabId);
      return { ok: true };
    default:
      throw new Error(`unknown ext action: ${action}`);
  }
}

// ---- popup messaging ---------------------------------------------------------

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  void (async () => {
    if (req?.type === "getStatus") {
      const tabId = req.tabId as number;
      const state = tabs.get(tabId);
      const design = await readPageDesignState(tabId);
      const providers = state
        ? [...state.sockets.entries()].map(([id, e]) => ({
            id,
            url: e.meta.url,
            title: e.meta.title,
            open: e.ws?.readyState === WebSocket.OPEN,
          }))
        : [];
      sendResponse({
        enabled: await isEnabled(tabId),
        connected: !!state,
        providers,
        port: bridgePort,
        token: bridgeToken,
        browserControl,
        selectedElements: design.selection.items,
        selectionMarkersVisible: design.selection.markersVisible,
        cssPatches: design.cssPatches,
      });
      return;
    }

    if (req?.type === "setEnabled") {
      const tabId = req.tabId as number;
      await setEnabled(tabId, !!req.enabled);
      void updateActionIcon(tabId, !!req.enabled);
      const state = tabs.get(tabId);
      if (req.enabled) {
        if (state) sendControl(state, "activate");
        // Tab opened before the extension loaded → no content script yet.
        else await injectIntoTab(tabId);
      } else if (state) {
        sendControl(state, "deactivate");
        closeAllSockets(state);
      }
      sendResponse({ ok: true });
      return;
    }

    if (req?.type === "startElementPicker") {
      const tabId = req.tabId as number;
      const append = !!req.append;
      const state = await ensureEnabledTab(tabId);
      if (await runElementPickerScript(tabId, "start", { append })) {
        sendResponse({ ok: true });
        return;
      }
      await injectIntoTab(tabId);
      await sleep(100);
      if (await runElementPickerScript(tabId, "start", { append })) {
        sendResponse({ ok: true });
        return;
      }
      const connectedState = state ?? tabs.get(tabId);
      if (connectedState) {
        sendControl(connectedState, "startElementPicker", { append });
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: "could not start picker on this tab" });
      return;
    }

    if (req?.type === "cancelElementPicker") {
      const tabId = req.tabId as number;
      if (await runElementPickerScript(tabId, "cancel")) {
        sendResponse({ ok: true });
        return;
      }
      const state = tabs.get(tabId);
      if (state) sendControl(state, "cancelElementPicker");
      sendResponse({ ok: true });
      return;
    }

    if (req?.type === "clearSelectedElements") {
      const tabId = req.tabId as number;
      if (await runElementPickerScript(tabId, "clear")) {
        sendResponse({ ok: true });
        return;
      }
      await injectIntoTab(tabId);
      await sleep(100);
      if (await runElementPickerScript(tabId, "clear")) {
        sendResponse({ ok: true });
        return;
      }
      const state = tabs.get(tabId);
      if (state) sendControl(state, "clearSelectedElements");
      sendResponse({ ok: true });
      return;
    }

    if (req?.type === "removeSelectedElement") {
      const tabId = req.tabId as number;
      const selectionId = String(req.selectionId ?? "");
      if ((await runElementPickerScript(tabId, "remove", { selectionId })) === true) {
        sendResponse({ ok: true });
        return;
      }
      await injectIntoTab(tabId);
      await sleep(100);
      if ((await runElementPickerScript(tabId, "remove", { selectionId })) === true) {
        sendResponse({ ok: true });
        return;
      }
      const state = tabs.get(tabId);
      if (state) sendControl(state, "removeSelectedElement", { selectionId });
      sendResponse({ ok: true });
      return;
    }

    if (req?.type === "setSelectedElementMeta") {
      const tabId = req.tabId as number;
      const selectionId = String(req.selectionId ?? "");
      const name = typeof req.name === "string" ? req.name : undefined;
      const group = typeof req.group === "string" ? req.group : undefined;
      if ((await runElementPickerScript(tabId, "setMeta", { selectionId, name, group })) === true) {
        sendResponse({ ok: true });
        return;
      }
      await injectIntoTab(tabId);
      await sleep(100);
      if ((await runElementPickerScript(tabId, "setMeta", { selectionId, name, group })) === true) {
        sendResponse({ ok: true });
        return;
      }
      const state = tabs.get(tabId);
      if (state) sendControl(state, "setSelectedElementMeta", { selectionId, name, group });
      sendResponse({ ok: true });
      return;
    }

    if (req?.type === "setSelectionMarkersVisible") {
      const tabId = req.tabId as number;
      const visible = req.visible !== false;
      if ((await runElementPickerScript(tabId, "setVisible", { visible })) === true) {
        sendResponse({ ok: true });
        return;
      }
      await injectIntoTab(tabId);
      await sleep(100);
      if ((await runElementPickerScript(tabId, "setVisible", { visible })) === true) {
        sendResponse({ ok: true });
        return;
      }
      const state = tabs.get(tabId);
      if (state) sendControl(state, "setSelectedMarkersVisible", { visible });
      sendResponse({ ok: true });
      return;
    }

    if (req?.type === "removeCssPatch") {
      const tabId = req.tabId as number;
      const patchId = String(req.patchId ?? "");
      if ((await runElementPickerScript(tabId, "removeCssPatch", { patchId })) === true) {
        sendResponse({ ok: true });
        return;
      }
      await injectIntoTab(tabId);
      await sleep(100);
      sendResponse({ ok: (await runElementPickerScript(tabId, "removeCssPatch", { patchId })) === true });
      return;
    }

    if (req?.type === "clearCssPatches") {
      const tabId = req.tabId as number;
      const removed = await runElementPickerScript(tabId, "clearCssPatches");
      if (removed !== undefined) {
        sendResponse({ ok: true, removed });
        return;
      }
      await injectIntoTab(tabId);
      await sleep(100);
      sendResponse({ ok: true, removed: await runElementPickerScript(tabId, "clearCssPatches") });
      return;
    }

    if (req?.type === "setSettings") {
      bridgePort = Number(req.port) || DEFAULT_PORT;
      bridgeToken = typeof req.token === "string" ? req.token : "";
      browserControl = !!req.browserControl;
      await chrome.storage.local.set({ port: bridgePort, token: bridgeToken, browserControl });
      if (browserControl) browserProvider.restart();
      else browserProvider.stop();
      sendResponse({ ok: true, port: bridgePort, hasToken: !!bridgeToken, browserControl });
      return;
    }

    sendResponse({ ok: false, error: "unknown request" });
  })();
  return true; // keep the channel open for the async response
});

// ---- cleanup + keepalive -----------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  const state = tabs.get(tabId);
  if (state) {
    closeAllSockets(state);
    tabs.delete(tabId);
  }
  void setEnabled(tabId, false);
});

// A WebSocket keeps the SW alive while messages flow (Chrome 116+); the alarm
// nudges the SW awake periodically in case it went idle between bursts.
chrome.alarms.create("mcp-page-bridge-keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  // no-op: waking the SW is the point.
});
