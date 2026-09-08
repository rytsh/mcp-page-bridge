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
  MCP_PAGE_BRIDGE_DASHBOARD_ACTIVATE_TAB,
  MCP_PAGE_BRIDGE_DASHBOARD_CLOSE_TAB,
  MCP_PAGE_BRIDGE_READ_FILE,
  type ChannelMessage,
  type ControlAction,
  type ControlPayload,
  type ExtCallPayload,
} from "mcp-page-bridge-protocol";
import { BrowserProvider } from "./browser-provider.js";
import { extensionApi, hasDebuggerPermission } from "./extension-api.js";
import {
  parseProfiles,
  profileLabel,
  sameBridge,
  sortProfiles,
  tabGroupColor,
  upsertProfile,
  type BridgeConfig,
  type BridgeProfile,
} from "./bridge-profiles.js";

const chrome = extensionApi();

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
const DEFAULT_HOST = "127.0.0.1";

// ---- bridge profiles ----------------------------------------------------------
// A profile is one daemon's identity: (host, port, token). Profiles are deduped
// on that triple (bridge-profiles.ts), so everything pointing at the same
// daemon automatically shares the same profile ("group"). The default profile
// serves every tab without an override; tabs can pin a different profile.

let bridgeProfiles: BridgeProfile[] = [];
let defaultProfileId = "";
/** tabId -> profileId override; mirrors chrome.storage.session "tabBridges". */
const tabBridgeOverrides = new Map<number, string>();
/** Opt-in: visually group enabled tabs by bridge profile via chrome.tabGroups. */
let tabGroupsEnabled = false;

let browserControl = false;
// Core built-in page tools (DOM/query/click/screenshot/etc.). On by default;
// exposed as a popup toggle so users can keep only page-declared tools if wanted.
let coreTools = true;
// Opt-in design/selection built-in tools. Off by default to keep the per-tab
// built-in catalog (and the agent's token cost) small. Forwarded to the page on
// the activate control message.
let designTools = false;
// Opt-in Playwright-like automation helpers. Also gated to keep the default
// catalog small and the permission surface explicit in the popup.
let automationTools = false;
// Optional Chrome DevTools Protocol tools. Requires the optional "debugger"
// permission and is kept off by default because Chrome shows a debugging banner.
let cdpTools = false;
// Optional trusted input: click/type_text/press_key dispatch real Input.* events
// through CDP instead of synthetic DOM events. Also requires the optional
// "debugger" permission; the page falls back to synthetic events when it fails.
let trustedInput = false;

interface CdpEventEntry {
  method: string;
  params: unknown;
  time: string;
}

interface CdpSession {
  attached: boolean;
  domains: Set<string>;
  events: CdpEventEntry[];
}

const CDP_MAX_EVENTS = 500;
const CDP_ENABLEABLE_DOMAINS = new Set(["CSS", "DOM", "Log", "Network", "Page", "Performance", "Runtime"]);
const cdpSessions = new Map<number, CdpSession>();

/** Bracket bare IPv6 addresses so they are valid inside a URL authority. */
function urlHost(host: string): string {
  const h = host.trim() || DEFAULT_HOST;
  return h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
}

async function wsUrl(cfg: BridgeConfig, meta: Record<string, string | number | undefined> = {}): Promise<string> {
  const url = new URL(`${cfg.secure ? "wss" : "ws"}://${urlHost(cfg.host)}:${cfg.port}`);
  if (cfg.token) url.searchParams.set("token", cfg.token);
  // The raw profile secret is sent (like the token); the daemon hashes it into
  // the partition key, so the same value works for the extension, the stdio
  // proxy, and a hand-written remote /mcp URL.
  if (cfg.profileKey) url.searchParams.set("profile", cfg.profileKey);
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function profileById(id: string | undefined): BridgeProfile | undefined {
  return id ? bridgeProfiles.find((p) => p.id === id) : undefined;
}

/** The default profile; self-heals so a valid default always exists. */
function defaultBridgeProfile(): BridgeProfile {
  const existing = profileById(defaultProfileId);
  if (existing) return existing;
  const result = upsertProfile(bridgeProfiles, undefined, inUseProfileIds());
  bridgeProfiles = result.profiles;
  defaultProfileId = result.profile.id;
  void persistProfiles();
  return result.profile;
}

/** Effective bridge for a tab: its override profile, or the default. */
function bridgeConfigFor(tabId: number): BridgeProfile {
  return profileById(tabBridgeOverrides.get(tabId)) ?? defaultBridgeProfile();
}

/** Profile ids that must never be LRU-evicted. */
function inUseProfileIds(): Set<string> {
  const ids = new Set<string>();
  if (defaultProfileId) ids.add(defaultProfileId);
  for (const id of tabBridgeOverrides.values()) ids.add(id);
  return ids;
}

async function persistProfiles(): Promise<void> {
  await chrome.storage.local.set({ bridgeProfiles, defaultProfileId });
}

async function persistTabOverrides(): Promise<void> {
  await chrome.storage.session.set({ tabBridges: Object.fromEntries(tabBridgeOverrides) });
}

/** Force a tab's provider sockets to redial (after its bridge changed). */
function bounceTabSockets(state: TabState): void {
  for (const entry of state.sockets.values()) {
    try {
      entry.ws?.close();
    } catch {
      // already closing
    }
  }
}

// Optional, opt-in "browser" provider (controls all tabs, not just one page).
// It is not tab-scoped, so it always talks to the default profile's daemon.
const browserProvider = new BrowserProvider(() => wsUrl(defaultBridgeProfile()), {
  enableTab: async (tabId) => {
    const state = await ensureEnabledTab(tabId);
    if (!state) {
      // Restricted page: don't leave a tab marked enabled that can never connect.
      await setEnabled(tabId, false);
      void updateActionIcon(tabId, false);
      return false;
    }
    void syncTabGroups();
    return true;
  },
  isTabEnabled: (tabId) => isEnabled(tabId),
  trackAgentTab: async (tabId) => {
    const set = await getAgentTabs();
    set.add(tabId);
    await saveAgentTabs(set);
  },
  listAgentTabs: async () => [...(await getAgentTabs())],
  forgetAgentTabs: async (tabIds) => {
    const set = await getAgentTabs();
    for (const tabId of tabIds) set.delete(tabId);
    await saveAgentTabs(set);
  },
});

void (async () => {
  const v = await chrome.storage.local.get([
    "bridgeProfiles", "defaultProfileId", "host", "port", "token", "secure",
    "browserControl", "coreTools", "designTools", "automationTools", "cdpTools", "trustedInput", "tabGroups",
  ]);
  bridgeProfiles = parseProfiles(v.bridgeProfiles);
  defaultProfileId = typeof v.defaultProfileId === "string" ? v.defaultProfileId : "";
  if (!profileById(defaultProfileId)) {
    // First run, or migration from the legacy flat host/port/token keys.
    const result = upsertProfile(bridgeProfiles, {
      host: typeof v.host === "string" ? v.host : undefined,
      port: v.port !== undefined ? Number(v.port) : undefined,
      token: typeof v.token === "string" ? v.token : undefined,
      secure: v.secure === true,
    });
    bridgeProfiles = result.profiles;
    defaultProfileId = result.profile.id;
    await persistProfiles();
  }
  const session = await chrome.storage.session.get("tabBridges");
  for (const [key, value] of Object.entries((session.tabBridges as Record<string, string> | undefined) ?? {})) {
    const tabId = Number(key);
    if (Number.isInteger(tabId) && typeof value === "string") tabBridgeOverrides.set(tabId, value);
  }
  browserControl = !!v.browserControl;
  coreTools = v.coreTools !== false;
  designTools = !!v.designTools;
  automationTools = !!v.automationTools;
  tabGroupsEnabled = !!v.tabGroups;
  cdpTools = !!v.cdpTools && (await hasDebuggerPermission());
  trustedInput = !!v.trustedInput && (await hasDebuggerPermission());
  if (cdpTools || trustedInput) ensureCdpListeners();
  if (browserControl) browserProvider.start();
})();

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

// Tabs opened by the agent through the browser provider's open_tab. Tracked so
// close_agent_tabs can clean up a session without touching the user's own tabs.

async function getAgentTabs(): Promise<Set<number>> {
  const v = await chrome.storage.session.get("agentTabs");
  return new Set<number>((v.agentTabs as number[] | undefined) ?? []);
}

async function saveAgentTabs(set: Set<number>): Promise<void> {
  await chrome.storage.session.set({ agentTabs: [...set] });
}

// ---- visual tab groups (opt-in switch) ----------------------------------------
// Groups enabled tabs by bridge profile using chrome.tabGroups. Groups cannot
// span windows, so the unit is (profileId, windowId). The group ids we create
// are remembered in storage.session so we only ever touch our own groups.

const TAB_GROUP_NONE = -1;

async function loadGroupMap(): Promise<Record<string, number>> {
  const v = await chrome.storage.session.get("bridgeTabGroups");
  return (v.bridgeTabGroups as Record<string, number> | undefined) ?? {};
}

async function saveGroupMap(map: Record<string, number>): Promise<void> {
  await chrome.storage.session.set({ bridgeTabGroups: map });
}

/** Release one tab from a group we manage (on disable). Best effort. */
async function ungroupManagedTab(tabId: number): Promise<void> {
  if (!chrome.tabs?.ungroup || !chrome.tabGroups) return;
  try {
    const managed = new Set(Object.values(await loadGroupMap()));
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab && tab.groupId !== TAB_GROUP_NONE && managed.has(tab.groupId)) {
      await chrome.tabs.ungroup(tabId);
    }
  } catch {
    // best effort
  }
}

/** Reconcile Chrome tab groups with the enabled tabs' bridge profiles. */
async function syncTabGroups(): Promise<void> {
  if (!chrome.tabs?.group || !chrome.tabGroups) return; // API guard
  try {
    const enabledSet = await getEnabledSet();
    const groupMap = await loadGroupMap();
    const managed = new Set(Object.values(groupMap));

    // Collect live tab info once.
    const liveTabs: Array<{ tabId: number; windowId: number; groupId: number; profile: BridgeProfile }> = [];
    for (const tabId of enabledSet) {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab || tab.windowId === undefined || tab.pinned) continue; // grouping would unpin
      liveTabs.push({ tabId, windowId: tab.windowId, groupId: tab.groupId ?? TAB_GROUP_NONE, profile: bridgeConfigFor(tabId) });
    }

    if (!tabGroupsEnabled) {
      const toUngroup = liveTabs.filter((t) => t.groupId !== TAB_GROUP_NONE && managed.has(t.groupId)).map((t) => t.tabId);
      if (toUngroup.length) await chrome.tabs.ungroup(toUngroup).catch(() => undefined);
      await saveGroupMap({});
      return;
    }

    const buckets = new Map<string, typeof liveTabs>();
    for (const entry of liveTabs) {
      const key = `${entry.profile.id}|${entry.windowId}`;
      buckets.set(key, [...(buckets.get(key) ?? []), entry]);
    }

    const nextMap: Record<string, number> = {};
    for (const [key, entries] of buckets) {
      const profile = entries[0]!.profile;
      let groupId: number | undefined = groupMap[key];
      if (groupId !== undefined && !(await chrome.tabGroups.get(groupId).catch(() => undefined))) {
        groupId = undefined; // group was dissolved by the user
      }
      const strays = entries.filter((e) => e.groupId !== groupId).map((e) => e.tabId);
      if (groupId === undefined) {
        groupId = await chrome.tabs.group({ tabIds: entries.map((e) => e.tabId) as [number, ...number[]] });
      } else if (strays.length) {
        await chrome.tabs.group({ tabIds: strays as [number, ...number[]], groupId }).catch(() => undefined);
      }
      nextMap[key] = groupId;
      await chrome.tabGroups
        .update(groupId, { title: profileLabel(profile), color: tabGroupColor(profile.id) })
        .catch(() => undefined);
    }
    await saveGroupMap(nextMap);
  } catch {
    // Visual grouping is cosmetic; never let it break the bridge.
  }
}

// ---- optional CDP / chrome.debugger tools ------------------------------------

function cdpTarget(tabId: number): chrome.debugger.Debuggee {
  return { tabId };
}

function cdpSession(tabId: number): CdpSession {
  let session = cdpSessions.get(tabId);
  if (!session) {
    session = { attached: false, domains: new Set(), events: [] };
    cdpSessions.set(tabId, session);
  }
  return session;
}

async function sendCdpCommand<T = unknown>(tabId: number, command: string, params?: Record<string, unknown>): Promise<T> {
  return chrome.debugger.sendCommand(cdpTarget(tabId), command, params) as Promise<T>;
}

async function enableCdpDomain(tabId: number, domain: string): Promise<void> {
  const session = cdpSession(tabId);
  if (session.domains.has(domain)) return;
  if (!CDP_ENABLEABLE_DOMAINS.has(domain)) return;
  await sendCdpCommand(tabId, `${domain}.enable`);
  session.domains.add(domain);
}

async function ensureCdpAttached(tabId: number, domains: string[] = []): Promise<CdpSession> {
  if (!(await hasDebuggerPermission())) {
    throw new Error("CDP tools require the optional debugger permission. Enable Advanced CDP tools in the popup.");
  }
  ensureCdpListeners();
  const session = cdpSession(tabId);
  if (!session.attached) {
    await chrome.debugger.attach(cdpTarget(tabId), "1.3");
    session.attached = true;
  }
  for (const domain of domains) await enableCdpDomain(tabId, domain);
  return session;
}

async function detachCdp(tabId: number): Promise<void> {
  const session = cdpSessions.get(tabId);
  if (!session?.attached) {
    cdpSessions.delete(tabId);
    return;
  }
  try {
    await chrome.debugger.detach(cdpTarget(tabId));
  } catch {
    // Already detached, tab gone, or another debugger took over.
  }
  cdpSessions.delete(tabId);
}

async function detachAllCdp(): Promise<void> {
  await Promise.all([...cdpSessions.keys()].map((tabId) => detachCdp(tabId)));
}

function pushCdpEvent(tabId: number, method: string, params: unknown): void {
  const session = cdpSession(tabId);
  session.events.push({ method, params, time: new Date().toISOString() });
  if (session.events.length > CDP_MAX_EVENTS) session.events.splice(0, session.events.length - CDP_MAX_EVENTS);
}

// `debugger` is an OPTIONAL permission, so `chrome.debugger` may be undefined
// until the user grants it. Registering these listeners at module load would
// throw and break the whole service worker, so wire them lazily once the API is
// available (after the permission is granted) and only once.
let cdpListenersReady = false;
function ensureCdpListeners(): void {
  if (cdpListenersReady || !chrome.debugger?.onEvent) return;
  cdpListenersReady = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    pushCdpEvent(source.tabId, method, params);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === undefined) return;
    cdpSessions.delete(source.tabId);
  });
}

function boolArg(value: unknown, fallback = false): boolean {
  return value === undefined ? fallback : value === true;
}

function strArg(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numArg(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ---- cross-frame snapshot / actions -------------------------------------------
//
// Page tools only see the top document, so a page assembled from cross-origin
// iframes (payment widgets, embedded editors, ad frames) was invisible. Here we
// inject `frame-agent.js` into every frame, ask each one for its snapshot lines,
// and stitch them into a single tree whose uids carry the frame index (`f2e7`).
// Actions on such a uid are routed back to the owning frame.

const FRAME_AGENT_FILE = "frame-agent.js";

interface FrameSection {
  index: number;
  frameId: number;
  url: string;
  title: string;
  lines: string[];
  truncated: boolean;
}

/** Frame index (as used in `f2e7` uids) → frameId, from the latest snapshot. */
const frameIdsByTab = new Map<number, Map<number, number>>();

async function injectFrameAgent(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: [FRAME_AGENT_FILE],
    world: "MAIN",
    injectImmediately: true,
  });
}

/** Frame ids that answered, main frame first. */
async function listAgentFrames(tabId: number): Promise<number[]> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: () => (window as unknown as Record<string, unknown>).__mcpPageBridgeFrame !== undefined,
  });
  const ids = results.filter((r) => r.result === true).map((r) => r.frameId);
  return ids.sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b));
}

async function snapshotFrame(
  tabId: number,
  frameId: number,
  req: { maxNodes: number; maxDepth: number; includeHidden: boolean; uidPrefix: string },
): Promise<{ lines: string[]; truncated: boolean; url: string; title: string } | undefined> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    args: [req],
    func: (payload: { maxNodes: number; maxDepth: number; includeHidden: boolean; uidPrefix: string }) => {
      const api = (window as unknown as Record<string, any>).__mcpPageBridgeFrame;
      if (!api) return undefined;
      try {
        return api.snapshot(payload);
      } catch {
        return undefined;
      }
    },
  });
  return result?.result as { lines: string[]; truncated: boolean; url: string; title: string } | undefined;
}

async function runFrameSnapshot(tabId: number, args: Record<string, unknown>): Promise<unknown> {
  const maxNodes = Math.max(10, Math.min(2000, Math.floor(numArg(args.maxNodes, 400))));
  const maxDepth = Math.max(1, Math.min(40, Math.floor(numArg(args.maxDepth, 15))));
  const includeHidden = boolArg(args.includeHidden);

  await injectFrameAgent(tabId);
  const frameIds = await listAgentFrames(tabId);
  if (!frameIds.length) throw new Error("No frame answered the snapshot request.");

  const mapping = new Map<number, number>();
  const sections: FrameSection[] = [];

  for (const frameId of frameIds) {
    const index = sections.length;
    // The top frame keeps bare uids (e1, e2, …); sub-frames get an f<index> prefix.
    const uidPrefix = index === 0 ? "" : `f${index}`;
    const rendered = await snapshotFrame(tabId, frameId, { maxNodes, maxDepth, includeHidden, uidPrefix });
    if (!rendered) continue;
    // Empty sub-frames (trackers, spacer iframes) only add noise.
    if (!rendered.lines.length && index !== 0) continue;
    mapping.set(index, frameId);
    sections.push({ index, frameId, url: rendered.url, title: rendered.title, lines: rendered.lines, truncated: rendered.truncated });
  }

  frameIdsByTab.set(tabId, mapping);

  const blocks = sections.map((section) => {
    const title = section.title ? `"${section.title.slice(0, 80)}" — ` : "";
    if (section.index === 0) {
      return `Page snapshot — ${title}${section.url}\n${section.lines.join("\n") || "(no interactive or structural elements found)"}`;
    }
    return `iframe f${section.index} — ${title}${section.url}\n${section.lines.map((line) => `  ${line}`).join("\n")}`;
  });
  const truncated = sections.some((section) => section.truncated);
  const footer = truncated ? `\n[truncated at ${maxNodes} nodes per frame — pass a larger maxNodes to see more]` : "";
  return { text: `${blocks.join("\n\n")}${footer}`, frames: sections.length };
}

/** Route an action to the frame that owns a `f<index>e<n>` uid. */
async function runFrameAct(tabId: number, args: Record<string, unknown>): Promise<unknown> {
  const uid = strArg(args.uid);
  const match = /^f(\d+)e\d+$/.exec(uid);
  if (!match) throw new Error(`Not a frame uid: ${uid || "(missing)"}`);
  const index = Number(match[1]);
  const frameId = frameIdsByTab.get(tabId)?.get(index);
  if (frameId === undefined) throw new Error(`Unknown frame f${index}; call take_snapshot again.`);

  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    args: [args],
    func: async (req: Record<string, unknown>) => {
      const api = (window as unknown as Record<string, any>).__mcpPageBridgeFrame;
      if (!api) return { ok: false, error: "frame agent missing; call take_snapshot again" };
      try {
        return { ok: true, result: await api.act(req) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  const value = result?.result as { ok?: boolean; result?: unknown; error?: string } | undefined;
  if (!value?.ok) throw new Error(value?.error ?? "frame action failed");
  return value.result;
}

// ---- trusted input (CDP Input.*) ----------------------------------------------
//
// Synthetic DOM events carry `isTrusted: false`, which a fair number of pages
// (canvas apps, bot-protected forms, some component libraries) ignore. With the
// popup's "Trusted input" switch on, the page asks the service worker to
// dispatch real events through CDP instead.
//
// Two details make this behave like a human:
//   - **Focus hop**: CDP input is delivered to the *focused* tab, so we activate
//     the target tab (and its window) for the duration of the action and put the
//     previous tab/window back afterwards.
//   - **Attach/detach**: when the CDP toolset isn't otherwise in use we detach
//     right after the action, so Chrome's debugging banner only shows while we
//     are actually typing/clicking.

interface FocusState {
  restoreTabId?: number;
  restoreWindowId?: number;
}

async function focusTabForInput(tabId: number): Promise<FocusState> {
  const state: FocusState = {};
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId === undefined) return state;
    const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    const focusedWindow = await chrome.windows.getLastFocused().catch(() => undefined);
    if (!tab.active) {
      if (previous?.id !== undefined && previous.id !== tabId) state.restoreTabId = previous.id;
      await chrome.tabs.update(tabId, { active: true });
    }
    if (focusedWindow?.id !== undefined && focusedWindow.id !== tab.windowId) {
      state.restoreWindowId = focusedWindow.id;
    }
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  } catch {
    // Tab or window vanished; the caller still gets a best-effort dispatch.
  }
  return state;
}

async function restoreFocusAfterInput(state: FocusState): Promise<void> {
  if (state.restoreTabId !== undefined) {
    await chrome.tabs.update(state.restoreTabId, { active: true }).catch(() => undefined);
  }
  if (state.restoreWindowId !== undefined) {
    await chrome.windows.update(state.restoreWindowId, { focused: true }).catch(() => undefined);
  }
}

/** Attach (if needed), run the CDP work with the tab focused, then clean up. */
async function withTrustedInputSession<T>(tabId: number, run: () => Promise<T>): Promise<T> {
  if (!(await hasDebuggerPermission())) {
    throw new Error("Trusted input requires the optional debugger permission. Re-enable it in the popup.");
  }
  const wasAttached = cdpSessions.get(tabId)?.attached === true;
  await ensureCdpAttached(tabId);
  const focus = await focusTabForInput(tabId);
  try {
    return await run();
  } finally {
    await restoreFocusAfterInput(focus);
    // Only tear down what we set up: a session the CDP toolset owns stays.
    if (!wasAttached && !cdpTools) await detachCdp(tabId);
  }
}

/** Debugger-backed features (trusted input, full-page capture) are available. */
function canUseDebugger(): boolean {
  return cdpTools || trustedInput;
}

/**
 * Capture the whole scrollable page via CDP. Attaches only if nothing else has,
 * and detaches again so the debugging banner doesn't linger.
 */
async function captureFullPage(tabId: number): Promise<string> {
  if (!(await hasDebuggerPermission())) {
    throw new Error("Full-page capture requires the optional debugger permission.");
  }
  const wasAttached = cdpSessions.get(tabId)?.attached === true;
  await ensureCdpAttached(tabId, ["Page"]);
  try {
    const result = await sendCdpCommand<{ data?: string }>(tabId, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      fromSurface: true,
    });
    if (!result?.data) throw new Error("Page.captureScreenshot returned no data.");
    return `data:image/png;base64,${result.data}`;
  } finally {
    if (!wasAttached && !cdpTools) await detachCdp(tabId);
  }
}

// ---- image post-processing (zoom / downscale) ---------------------------------
//
// `chrome.tabs.captureVisibleTab` only ever returns the full viewport at the
// display's pixel ratio. Cropping a region (zoom) and shrinking an oversized
// capture both happen here, in the service worker, with OffscreenCanvas — the
// page has no access to the captured bitmap.

interface ProcessedImage {
  dataUrl: string;
  width: number;
  height: number;
  scale: number;
}

async function processCapture(
  dataUrl: string,
  opts: { region?: { x: number; y: number; width: number; height: number }; devicePixelRatio?: number; scale?: number; maxWidth?: number },
): Promise<ProcessedImage> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const dpr = Math.max(0.1, numArg(opts.devicePixelRatio, 1));

  // The capture is in device pixels; regions arrive in CSS pixels.
  let sx = 0;
  let sy = 0;
  let sw = bitmap.width;
  let sh = bitmap.height;
  if (opts.region) {
    sx = Math.max(0, Math.round(opts.region.x * dpr));
    sy = Math.max(0, Math.round(opts.region.y * dpr));
    sw = Math.max(1, Math.min(Math.round(opts.region.width * dpr), bitmap.width - sx));
    sh = Math.max(1, Math.min(Math.round(opts.region.height * dpr), bitmap.height - sy));
  }

  let scale = 1;
  if (opts.scale !== undefined) {
    scale = Math.max(1, Math.min(6, opts.scale));
  } else if (opts.region) {
    // Default zoom: enlarge the crop to roughly 800px wide so small text reads.
    scale = Math.max(1, Math.min(6, 800 / sw));
  }
  let dw = Math.round(sw * scale);
  let dh = Math.round(sh * scale);

  const maxWidth = opts.maxWidth !== undefined ? Math.max(64, Math.min(8192, Math.round(opts.maxWidth))) : undefined;
  if (maxWidth && dw > maxWidth) {
    const shrink = maxWidth / dw;
    dw = Math.round(dw * shrink);
    dh = Math.round(dh * shrink);
    scale *= shrink;
  }

  const canvas = new OffscreenCanvas(dw, dh);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("OffscreenCanvas 2d context unavailable.");
  }
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
  bitmap.close();

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const buffer = new Uint8Array(await outBlob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i += 0x8000) {
    binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  }
  return { dataUrl: `data:image/png;base64,${btoa(binary)}`, width: dw, height: dh, scale };
}

/** Pixel size of a PNG data URL, without decoding it into a canvas. */
async function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

// ---- download tracking --------------------------------------------------------
//
// A page action that produces a file (export CSV, download invoice) was a dead
// end for the agent: something landed in ~/Downloads and it had no way to learn
// the path. We keep a small ring of download events so `list_downloads` and
// `wait_for_download` can report the finished file — including the on-disk path,
// which the agent's own filesystem tools can then read.

const DOWNLOAD_MAX_ENTRIES = 100;

interface DownloadRecord {
  id: number;
  url: string;
  filename: string;
  path: string;
  state: "in_progress" | "complete" | "interrupted";
  bytesReceived: number;
  totalBytes: number;
  mime: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
}

const downloadRecords = new Map<number, DownloadRecord>();

function recordDownload(item: chrome.downloads.DownloadItem | chrome.downloads.DownloadDelta): void {
  const id = item.id;
  const existing = downloadRecords.get(id);
  const asItem = item as Partial<chrome.downloads.DownloadItem>;
  const asDelta = item as Partial<chrome.downloads.DownloadDelta>;
  const pick = <T>(direct: T | undefined, delta: { current?: string } | undefined, fallback: T): T =>
    direct !== undefined ? direct : ((delta?.current as T | undefined) ?? fallback);

  const record: DownloadRecord = {
    id,
    url: pick(asItem.finalUrl ?? asItem.url, asDelta.finalUrl ?? asDelta.url, existing?.url ?? ""),
    path: pick(asItem.filename, asDelta.filename, existing?.path ?? ""),
    filename: "",
    state: pick(asItem.state as DownloadRecord["state"] | undefined, asDelta.state, existing?.state ?? "in_progress"),
    bytesReceived: asItem.bytesReceived ?? existing?.bytesReceived ?? 0,
    totalBytes: asItem.totalBytes ?? existing?.totalBytes ?? 0,
    mime: pick(asItem.mime, asDelta.mime, existing?.mime ?? ""),
    error: pick(asItem.error, asDelta.error, existing?.error) || undefined,
    startedAt: existing?.startedAt ?? asItem.startTime ?? new Date().toISOString(),
    endedAt: existing?.endedAt,
  };
  record.filename = record.path.split(/[\\/]/).pop() ?? "";
  if (record.state !== "in_progress" && !record.endedAt) record.endedAt = new Date().toISOString();

  downloadRecords.set(id, record);
  if (downloadRecords.size > DOWNLOAD_MAX_ENTRIES) {
    const oldest = [...downloadRecords.keys()].slice(0, downloadRecords.size - DOWNLOAD_MAX_ENTRIES);
    for (const key of oldest) downloadRecords.delete(key);
  }
}

if (chrome.downloads?.onCreated) {
  chrome.downloads.onCreated.addListener((item) => recordDownload(item));
  chrome.downloads.onChanged.addListener((delta) => {
    // A delta only carries what changed; re-query so the size/path stay accurate.
    recordDownload(delta);
    void chrome.downloads.search({ id: delta.id }).then((items) => {
      for (const item of items) recordDownload(item);
    }).catch(() => undefined); // The download may have been removed meanwhile.
  });
}

function downloadList(limit: number, state?: string): DownloadRecord[] {
  let entries = [...downloadRecords.values()].sort((a, b) => b.id - a.id);
  if (state) entries = entries.filter((entry) => entry.state === state);
  return entries.slice(0, limit);
}

async function runDownloads(args: Record<string, unknown>): Promise<unknown> {
  const action = strArg(args.action, "list");
  if (action === "list") {
    // Seed from Chrome's own list so downloads from before the SW woke up show.
    const items = await chrome.downloads.search({ limit: DOWNLOAD_MAX_ENTRIES, orderBy: ["-startTime"] });
    for (const item of items) recordDownload(item);
    const entries = downloadList(Math.max(1, Math.min(100, Math.floor(numArg(args.limit, 10)))), strArg(args.state) || undefined);
    return { count: entries.length, downloads: entries };
  }

  if (action !== "wait") throw new Error(`unknown downloads action: ${action}`);

  const timeoutMs = Math.max(0, Math.min(300000, numArg(args.timeoutMs, 30000)));
  const filename = strArg(args.filename).toLowerCase();
  const url = strArg(args.url).toLowerCase();
  const onlyNew = args.since !== false;
  const knownIds = onlyNew ? new Set(downloadRecords.keys()) : new Set<number>();
  const started = Date.now();

  for (;;) {
    const items = await chrome.downloads.search({ limit: DOWNLOAD_MAX_ENTRIES, orderBy: ["-startTime"] });
    for (const item of items) recordDownload(item);
    const match = [...downloadRecords.values()]
      .sort((a, b) => b.id - a.id)
      .find(
        (entry) =>
          (!onlyNew || !knownIds.has(entry.id)) &&
          entry.state === "complete" &&
          (!filename || entry.filename.toLowerCase().includes(filename)) &&
          (!url || entry.url.toLowerCase().includes(url)),
      );
    if (match) return { ...match, note: "path is on the machine running the browser; read it with your filesystem tools." };
    if (Date.now() - started > timeoutMs) {
      const pending = downloadList(5).filter((entry) => entry.state === "in_progress");
      throw new Error(
        `No matching download completed within ${timeoutMs}ms.` +
          (pending.length ? ` Still in progress: ${pending.map((entry) => entry.filename || entry.url).join(", ")}` : ""),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// ---- tab context --------------------------------------------------------------
//
// An agent that clicks a link which opens a new tab has, so far, no way to know
// it happened — it keeps talking to the old tab and wonders why nothing moved.
// We track tabs opened *by* an enabled tab and report them (plus this tab's own
// url/title) alongside action results. Deliberately scoped to the acting tab's
// own offspring: dumping the user's whole tab list into the agent's context on
// every click would be a privacy leak, not a feature.

interface OpenedTabRecord {
  id: number;
  url: string;
  title: string;
  at: number;
}

const openedByTab = new Map<number, OpenedTabRecord[]>();

if (chrome.tabs?.onCreated) {
  chrome.tabs.onCreated.addListener((tab) => {
    const opener = tab.openerTabId;
    if (opener === undefined || tab.id === undefined) return;
    const list = openedByTab.get(opener) ?? [];
    list.push({ id: tab.id, url: tab.pendingUrl ?? tab.url ?? "", title: tab.title ?? "", at: Date.now() });
    // Only the recent ones matter; the agent is told about each exactly once.
    openedByTab.set(opener, list.slice(-10));
  });
}

/**
 * Compact "what changed around this tab" report. Newly opened child tabs are
 * drained on read, so the agent is told about each one once and repeated
 * actions don't re-append the same noise.
 */
async function tabContextFor(tabId: number): Promise<unknown> {
  let self: { id: number; url: string; title: string } | undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    self = { id: tabId, url: tab.url ?? "", title: tab.title ?? "" };
  } catch {
    self = undefined;
  }

  const pending = openedByTab.get(tabId) ?? [];
  openedByTab.delete(tabId);
  const opened = await Promise.all(
    pending.map(async (record) => {
      try {
        const tab = await chrome.tabs.get(record.id);
        return { id: record.id, url: tab.url ?? record.url, title: tab.title ?? record.title, enabled: await isEnabled(record.id) };
      } catch {
        return { id: record.id, url: record.url, title: record.title, closed: true };
      }
    }),
  );

  return { self, opened };
}

// ---- bridge-hosted file reads (upload_file path form) -------------------------
//
// The extension cannot read the filesystem, but the bridge daemon runs on the
// same machine as the agent. `upload_file { path }` therefore asks the daemon,
// over the tab's own provider socket, to hand back the bytes. The daemon
// refuses unless it was started with --upload-dir, and only serves files inside
// that directory — this extension side deliberately adds no path handling of
// its own, so there is exactly one place enforcing the boundary.

const BRIDGE_RPC_TIMEOUT_MS = 20000;
let bridgeRpcSeq = 0;
const pendingBridgeRpc = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function isBridgeRpcResponse(value: unknown): value is { id: string; result?: unknown; error?: { message?: string } } {
  if (!value || typeof value !== "object") return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.startsWith("mpb-sw-") && pendingBridgeRpc.has(id);
}

function settleBridgeRpc(payload: { id: string; result?: unknown; error?: { message?: string } }): void {
  const pending = pendingBridgeRpc.get(payload.id);
  if (!pending) return;
  pendingBridgeRpc.delete(payload.id);
  clearTimeout(pending.timer);
  if (payload.error) pending.reject(new Error(payload.error.message ?? "bridge request failed"));
  else pending.resolve(payload.result);
}

/** Send a JSON-RPC request up the tab's provider socket and await the reply. */
function callBridge(tabId: number, method: string, params: Record<string, unknown>): Promise<unknown> {
  const state = tabs.get(tabId);
  const entry = state ? [...state.sockets.values()].find((socket) => socket.ws?.readyState === WebSocket.OPEN) : undefined;
  if (!entry?.ws) return Promise.reject(new Error("No open bridge connection for this tab."));

  const id = `mpb-sw-${++bridgeRpcSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBridgeRpc.delete(id);
      reject(new Error(`Bridge did not answer ${method} within ${BRIDGE_RPC_TIMEOUT_MS}ms.`));
    }, BRIDGE_RPC_TIMEOUT_MS);
    pendingBridgeRpc.set(id, { resolve, reject, timer });
    try {
      entry.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    } catch (error) {
      pendingBridgeRpc.delete(id);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function readBridgeFile(tabId: number, args: Record<string, unknown>): Promise<unknown> {
  const path = strArg(args.path);
  if (!path) throw new Error("readFile needs a path.");
  const result = (await callBridge(tabId, MCP_PAGE_BRIDGE_READ_FILE, { path })) as {
    base64?: string;
    name?: string;
    mimeType?: string;
    size?: number;
  };
  if (typeof result?.base64 !== "string") throw new Error("Bridge returned no file content.");
  return { base64: result.base64, name: result.name ?? path.split(/[\\/]/).pop() ?? "file", mimeType: result.mimeType, size: result.size ?? 0 };
}

const INPUT_MAX_KEYS = 2000;

interface TrustedKeyDescriptor {
  key: string;
  code: string;
  text: string;
  modifiers: number;
  windowsVirtualKeyCode: number;
}

function trustedKeyDescriptors(value: unknown): TrustedKeyDescriptor[] {
  if (!Array.isArray(value)) throw new Error("keys must be an array of key descriptors.");
  if (value.length > INPUT_MAX_KEYS) throw new Error(`Too many keys in one call (max ${INPUT_MAX_KEYS}).`);
  return value.map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const key = strArg(item.key);
    if (!key) throw new Error("Every key descriptor needs a key.");
    return {
      key,
      code: strArg(item.code, key),
      text: strArg(item.text),
      modifiers: Math.max(0, Math.floor(numArg(item.modifiers, 0))),
      windowsVirtualKeyCode: Math.max(0, Math.floor(numArg(item.windowsVirtualKeyCode, 0))),
    };
  });
}

async function dispatchTrustedKeys(tabId: number, keys: TrustedKeyDescriptor[], delayMs: number, holdMs = 0): Promise<void> {
  for (const key of keys) {
    const base = {
      key: key.key,
      code: key.code,
      modifiers: key.modifiers,
      windowsVirtualKeyCode: key.windowsVirtualKeyCode,
      nativeVirtualKeyCode: key.windowsVirtualKeyCode,
    };
    // `keyDown` with text produces the character; without text Chrome wants
    // `rawKeyDown` so the key doesn't also insert a stray glyph.
    await sendCdpCommand(tabId, "Input.dispatchKeyEvent", {
      ...base,
      type: key.text ? "keyDown" : "rawKeyDown",
      text: key.text || undefined,
      unmodifiedText: key.text || undefined,
    });
    if (holdMs > 0) {
      // Chrome auto-repeats a physically held key; mirror that so press-and-hold
      // handlers see the same event stream a real user produces.
      const deadline = Date.now() + holdMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(33, Math.max(0, deadline - Date.now()))));
        if (Date.now() >= deadline) break;
        await sendCdpCommand(tabId, "Input.dispatchKeyEvent", {
          ...base,
          type: key.text ? "keyDown" : "rawKeyDown",
          text: key.text || undefined,
          unmodifiedText: key.text || undefined,
          autoRepeat: true,
        });
      }
    }
    await sendCdpCommand(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/** `MouseEvent.buttons` bitmask CDP expects, per button name. */
const CDP_BUTTON_MASKS: Record<string, number> = { left: 1, right: 2, middle: 4, none: 0 };

function mouseButtonArg(value: unknown, fallback = "left"): string {
  const name = strArg(value, fallback).toLowerCase();
  return name in CDP_BUTTON_MASKS ? name : fallback;
}

async function dispatchTrustedClick(
  tabId: number,
  x: number,
  y: number,
  opts: { clickCount: number; button: string; modifiers: number },
): Promise<void> {
  const common = { x, y, button: opts.button, modifiers: opts.modifiers };
  const mask = CDP_BUTTON_MASKS[opts.button] ?? 1;
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", { ...common, type: "mouseMoved", button: "none", clickCount: 0, buttons: 0 });
  for (let i = 1; i <= opts.clickCount; i += 1) {
    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", { ...common, type: "mousePressed", clickCount: i, buttons: mask });
    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", { ...common, type: "mouseReleased", clickCount: i, buttons: 0 });
  }
}

/**
 * Trusted pointer drag: press, glide, release.
 *
 * Real `Input.dispatchMouseEvent` moves are what pages using pointer capture or
 * bot-protected drag widgets accept; the synthetic path in the page can't
 * produce `isTrusted` events.
 */
async function dispatchTrustedDrag(
  tabId: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps: number; holdMs: number; settleMs: number; button: string; modifiers: number },
): Promise<void> {
  const mask = CDP_BUTTON_MASKS[opts.button] ?? 1;
  const common = { button: opts.button, modifiers: opts.modifiers };
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", { ...common, type: "mouseMoved", button: "none", x: from.x, y: from.y, clickCount: 0, buttons: 0 });
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", { ...common, type: "mousePressed", x: from.x, y: from.y, clickCount: 1, buttons: mask });
  if (opts.holdMs > 0) await new Promise((resolve) => setTimeout(resolve, opts.holdMs));
  for (let step = 1; step <= opts.steps; step += 1) {
    const progress = step / opts.steps;
    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
      ...common,
      type: "mouseMoved",
      x: Math.round(from.x + (to.x - from.x) * progress),
      y: Math.round(from.y + (to.y - from.y) * progress),
      clickCount: 0,
      buttons: mask,
    });
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  if (opts.settleMs > 0) await new Promise((resolve) => setTimeout(resolve, opts.settleMs));
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", { ...common, type: "mouseReleased", x: to.x, y: to.y, clickCount: 1, buttons: 0 });
}

async function runTrustedInput(tabId: number, args: Record<string, unknown>): Promise<unknown> {
  const kind = strArg(args.kind);
  const delayMs = Math.max(0, Math.min(1000, numArg(args.delayMs, 0)));
  const modifiers = Math.max(0, Math.floor(numArg(args.modifiers, 0)));

  switch (kind) {
    case "click": {
      const x = Math.round(numArg(args.x, -1));
      const y = Math.round(numArg(args.y, -1));
      if (x < 0 || y < 0) throw new Error("click needs viewport x/y coordinates.");
      const clickCount = Math.max(1, Math.min(3, Math.floor(numArg(args.clickCount, 1))));
      const button = mouseButtonArg(args.button);
      await withTrustedInputSession(tabId, () => dispatchTrustedClick(tabId, x, y, { clickCount, button, modifiers }));
      return { ok: true, via: "cdp", x, y, clickCount, button };
    }
    case "keys": {
      const keys = trustedKeyDescriptors(args.keys);
      const holdMs = Math.max(0, Math.min(30000, numArg(args.holdMs, 0)));
      await withTrustedInputSession(tabId, () => dispatchTrustedKeys(tabId, keys, delayMs, holdMs));
      return { ok: true, via: "cdp", keys: keys.length, holdMs: holdMs || undefined };
    }
    case "drag": {
      const from = pointArg(args.from, "from");
      const to = pointArg(args.to, "to");
      const options = {
        steps: Math.max(1, Math.min(60, Math.floor(numArg(args.steps, 12)))),
        holdMs: Math.max(0, Math.min(5000, numArg(args.holdMs, 60))),
        settleMs: Math.max(0, Math.min(5000, numArg(args.settleMs, 60))),
        button: mouseButtonArg(args.button),
        modifiers,
      };
      await withTrustedInputSession(tabId, () => dispatchTrustedDrag(tabId, from, to, options));
      return { ok: true, via: "cdp", from, to, steps: options.steps, button: options.button };
    }
    case "wheel": {
      const x = Math.round(numArg(args.x, -1));
      const y = Math.round(numArg(args.y, -1));
      if (x < 0 || y < 0) throw new Error("wheel needs viewport x/y coordinates.");
      const deltaX = numArg(args.deltaX, 0);
      const deltaY = numArg(args.deltaY, 0);
      await withTrustedInputSession(tabId, () =>
        sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          button: "none",
          buttons: 0,
          clickCount: 0,
          deltaX,
          deltaY,
          modifiers,
        }),
      );
      return { ok: true, via: "cdp", x, y, deltaX, deltaY };
    }
    default:
      throw new Error(`unknown input kind: ${kind}`);
  }
}

function pointArg(value: unknown, what: string): { x: number; y: number } {
  const point = (value ?? {}) as Record<string, unknown>;
  const x = Math.round(numArg(point.x, Number.NaN));
  const y = Math.round(numArg(point.y, Number.NaN));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${what} needs {x, y} viewport coordinates.`);
  return { x, y };
}

async function runCdp(tabId: number, args: Record<string, unknown>): Promise<unknown> {
  const action = strArg(args.action);
  switch (action) {
    case "status": {
      const session = cdpSessions.get(tabId);
      return {
        permission: await hasDebuggerPermission(),
        attached: !!session?.attached,
        enabledDomains: [...(session?.domains ?? [])],
        bufferedEvents: session?.events.length ?? 0,
      };
    }
    case "attach": {
      const domains = Array.isArray(args.domains) ? args.domains.map(String) : ["Network", "Page", "Runtime"];
      const session = await ensureCdpAttached(tabId, domains);
      return { attached: true, enabledDomains: [...session.domains] };
    }
    case "detach":
      await detachCdp(tabId);
      return { attached: false };
    case "send": {
      await ensureCdpAttached(tabId);
      const command = strArg(args.command);
      if (!command) throw new Error("CDP command is required.");
      const params = args.params && typeof args.params === "object" ? args.params as Record<string, unknown> : undefined;
      return sendCdpCommand(tabId, command, params);
    }
    case "events": {
      await ensureCdpAttached(tabId);
      const limit = Math.max(1, Math.min(CDP_MAX_EVENTS, numArg(args.limit, 100)));
      const method = strArg(args.method);
      const domain = strArg(args.domain);
      let events = cdpSession(tabId).events;
      if (method) events = events.filter((event) => event.method === method);
      if (domain) events = events.filter((event) => event.method.startsWith(`${domain}.`));
      return events.slice(-limit);
    }
    case "clearEvents": {
      const session = cdpSession(tabId);
      const count = session.events.length;
      session.events.length = 0;
      return { cleared: count };
    }
    case "getResponseBody":
      await ensureCdpAttached(tabId, ["Network"]);
      return sendCdpCommand(tabId, "Network.getResponseBody", { requestId: String(args.requestId ?? "") });
    case "emulateViewport":
      await ensureCdpAttached(tabId);
      await sendCdpCommand(tabId, "Emulation.setDeviceMetricsOverride", {
        width: Math.max(1, Math.floor(numArg(args.width, 1280))),
        height: Math.max(1, Math.floor(numArg(args.height, 720))),
        deviceScaleFactor: Math.max(0, numArg(args.deviceScaleFactor, 1)),
        mobile: boolArg(args.mobile),
      });
      return { ok: true };
    case "clearEmulation":
      await ensureCdpAttached(tabId);
      await sendCdpCommand(tabId, "Emulation.clearDeviceMetricsOverride");
      await sendCdpCommand(tabId, "Emulation.clearGeolocationOverride").catch(() => undefined);
      await sendCdpCommand(tabId, "Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => undefined);
      return { ok: true };
    case "dispatchMouse": {
      await ensureCdpAttached(tabId);
      const type = strArg(args.type, "mousePressed");
      // A mouseWheel without deltas is a no-op in Chrome, which made the wheel
      // branch of this tool silently useless before deltaX/deltaY existed.
      const wheel = type === "mouseWheel";
      return sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
        type,
        x: numArg(args.x, 0),
        y: numArg(args.y, 0),
        button: strArg(args.button, wheel ? "none" : "left"),
        buttons: args.buttons === undefined ? undefined : Math.max(0, Math.floor(numArg(args.buttons, 0))),
        clickCount: wheel ? 0 : Math.max(0, Math.floor(numArg(args.clickCount, 1))),
        deltaX: wheel ? numArg(args.deltaX, 0) : undefined,
        deltaY: wheel ? numArg(args.deltaY, 0) : undefined,
        modifiers: Math.max(0, Math.floor(numArg(args.modifiers, 0))),
      });
    }
    case "dispatchKey": {
      await ensureCdpAttached(tabId);
      const key = strArg(args.key);
      const code = strArg(args.code, key);
      const textValue = strArg(args.text, key.length === 1 ? key : "");
      const windowsVirtualKeyCode = Math.floor(numArg(args.windowsVirtualKeyCode, key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0));
      await sendCdpCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key, code, text: textValue, windowsVirtualKeyCode });
      await sendCdpCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
      return { ok: true };
    }
    case "evaluate":
      await ensureCdpAttached(tabId, ["Runtime"]);
      return sendCdpCommand(tabId, "Runtime.evaluate", {
        expression: String(args.expression ?? ""),
        awaitPromise: args.awaitPromise !== false,
        returnByValue: args.returnByValue !== false,
      });
    case "screenshot":
      await ensureCdpAttached(tabId, ["Page"]);
      return sendCdpCommand(tabId, "Page.captureScreenshot", {
        format: strArg(args.format, "png"),
        quality: args.quality === undefined ? undefined : Math.max(0, Math.min(100, Math.floor(numArg(args.quality, 90)))),
        captureBeyondViewport: boolArg(args.captureBeyondViewport),
      });
    case "performanceMetrics":
      await ensureCdpAttached(tabId, ["Performance"]);
      return sendCdpCommand(tabId, "Performance.getMetrics");
    case "setNetworkConditions":
      await ensureCdpAttached(tabId, ["Network"]);
      await sendCdpCommand(tabId, "Network.emulateNetworkConditions", {
        offline: boolArg(args.offline),
        latency: Math.max(0, numArg(args.latency, 0)),
        downloadThroughput: numArg(args.downloadThroughput, -1),
        uploadThroughput: numArg(args.uploadThroughput, -1),
      });
      return { ok: true };
    case "setUserAgent":
      await ensureCdpAttached(tabId, ["Network"]);
      await sendCdpCommand(tabId, "Network.setUserAgentOverride", { userAgent: String(args.userAgent ?? "") });
      return { ok: true };
    case "setGeolocation":
      await ensureCdpAttached(tabId);
      await sendCdpCommand(tabId, "Emulation.setGeolocationOverride", {
        latitude: numArg(args.latitude, 0),
        longitude: numArg(args.longitude, 0),
        accuracy: Math.max(0, numArg(args.accuracy, 100)),
      });
      return { ok: true };
    default:
      throw new Error(`unknown cdp action: ${action}`);
  }
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

  void (async () => {
    let url: string;
    try {
      url = await wsUrl(bridgeConfigFor(state.tabId), { tabId: state.tabId, providerId });
    } catch {
      scheduleReconnect(state, providerId);
      return;
    }
    // The async hash leaves a gap; re-validate before claiming the socket slot
    // so a concurrent dial/teardown isn't clobbered.
    if (state.sockets.get(providerId) !== entry || !entry.wantOpen || entry.ws) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, "mcp");
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
      // Answers to requests the service worker itself made (readFile) never
      // belong to the page's MCP server; settle them here.
      if (isBridgeRpcResponse(payload)) {
        settleBridgeRpc(payload);
        return;
      }
      downRpc(state, providerId, payload);
    });
    ws.addEventListener("close", () => {
      entry.ws = undefined;
      // The bridge re-runs `initialize` on the next socket, so any backlog queued
      // against this dead session is stale; drop it to avoid replaying old RPCs
      // (responses to defunct request ids, half-sent batches) onto a fresh session.
      entry.outbuf.length = 0;
      if (entry.wantOpen) scheduleReconnect(state, providerId); // bridge down/restarting
    });
    ws.addEventListener("error", () => {
      // 'close' fires next; reconnect handled there.
    });
  })();
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
 * The scripts guard against double-injection. inject.js first so document.modelContext
 * exists before content.js triggers activation.
 */
async function injectIntoTab(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["inject.js"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch (error) {
    console.warn("[mcp-page-bridge] could not inject into tab", tabId, error);
    return false;
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
      sendControl(state, "activate", { coreTools, designTools, automationTools, cdpTools, trustedInput });
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
      if (on) sendControl(state, "activate", { coreTools, designTools, automationTools, cdpTools, trustedInput });
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
    // ext actions (screenshot/navigate/reload) are privileged; only run them on
    // a tab the user has explicitly enabled, so an arbitrary page script can't
    // drive them via a forged channel message.
    if (!(await isEnabled(state.tabId))) return;
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
      // Full page needs CDP (captureVisibleTab only ever returns the viewport),
      // so it rides on the same optional debugger permission as trusted input.
      let dataUrl: string | undefined;
      let fullPage = false;
      let fullPageError: string | undefined;
      if (args.fullPage === true) {
        if (canUseDebugger()) {
          try {
            dataUrl = await captureFullPage(tabId);
            fullPage = true;
          } catch (error) {
            fullPageError = error instanceof Error ? error.message : String(error);
          }
        } else {
          fullPageError = "fullPage needs the optional debugger permission — enable Trusted input or Advanced CDP tools in the popup.";
        }
      }
      if (!dataUrl) {
        const tab = await chrome.tabs.get(tabId);
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      }

      // Crop (zoom) and/or downscale before the image ever reaches the agent, so
      // a 4K retina capture doesn't blow past the model's image size limits.
      const region = args.region as { x: number; y: number; width: number; height: number } | undefined;
      let width = 0;
      let height = 0;
      let scale = 1;
      if (region || args.maxWidth !== undefined || args.scale !== undefined) {
        try {
          const processed = await processCapture(dataUrl, {
            region,
            devicePixelRatio: numArg(args.devicePixelRatio, 1),
            scale: args.scale === undefined ? undefined : numArg(args.scale, 1),
            maxWidth: args.maxWidth === undefined ? undefined : numArg(args.maxWidth, 0),
          });
          dataUrl = processed.dataUrl;
          width = processed.width;
          height = processed.height;
          scale = processed.scale;
        } catch (error) {
          if (region) throw error; // a zoom that can't crop has no useful fallback
        }
      }
      if (!width) {
        const size = await imageSize(dataUrl);
        width = size.width;
        height = size.height;
      }

      let savedAs: string | undefined;
      if (args.download) {
        const filename = (args.filename as string) || `mcp-page-bridge-${Date.now()}.png`;
        await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
        savedAs = filename;
      }
      return { dataUrl, savedAs, fullPage, fullPageError, width, height, scale };
    }
    case "frameOverlay": {
      const show = args.show === true;
      await injectFrameAgent(tabId).catch(() => undefined);
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        args: [show],
        func: async (visible: boolean) => {
          const api = (window as unknown as Record<string, any>).__mcpPageBridgeFrame;
          if (!api) return 0;
          const out = await api.act({ kind: visible ? "overlay_show" : "overlay_hide" });
          return typeof out?.markers === "number" ? out.markers : 0;
        },
      });
      return { markers: results.reduce((sum, r) => sum + (typeof r.result === "number" ? r.result : 0), 0) };
    }
    case "navigate":
      await chrome.tabs.update(tabId, { url: String(args.url) });
      return { ok: true };
    case "reload":
      await chrome.tabs.reload(tabId);
      return { ok: true };
    case "resizeWindow": {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId === undefined) throw new Error("tab has no windowId");
      const width = Math.max(320, Math.min(4096, Number(args.width) || 0));
      const height = Math.max(240, Math.min(4096, Number(args.height) || 0));
      const win = await chrome.windows.update(tab.windowId, { width, height });
      return { ok: true, window: { id: win?.id, width: win?.width, height: win?.height } };
    }
    case "downloads":
      return runDownloads(args);
    case "tabContext":
      return tabContextFor(tabId);
    case "readFile":
      return readBridgeFile(tabId, args);
    case "cdp":
      if (!cdpTools) throw new Error("Advanced CDP tools are not enabled in the extension popup.");
      return runCdp(tabId, args);
    case "input":
      if (!trustedInput) throw new Error("Trusted input is not enabled in the extension popup.");
      return runTrustedInput(tabId, args);
    case "frameSnapshot":
      return runFrameSnapshot(tabId, args);
    case "frameAct":
      return runFrameAct(tabId, args);
    default:
      throw new Error(`unknown ext action: ${action}`);
  }
}

// ---- popup messaging ---------------------------------------------------------

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  // Only the extension's own pages (popup) may drive these privileged commands.
  // Reject anything originating from a tab/content script or another extension.
  if (sender.id !== chrome.runtime.id || sender.tab) {
    sendResponse({ ok: false, error: "unauthorized sender" });
    return false;
  }
  void (async () => {
    if (req?.type === "getStatus") {
      const tabId = req.tabId as number;
      const state = tabs.get(tabId);
      // Only probe page selection/CSS-patch state when design tools are on; with
      // them off the popup hides those panels, so skip the per-poll injection.
      const design = designTools
        ? await readPageDesignState(tabId)
        : { selection: { items: [], markersVisible: true }, cssPatches: [] };
      const cdpPermission = await hasDebuggerPermission();
      const providers = state
        ? [...state.sockets.entries()].map(([id, e]) => ({
            id,
            url: e.meta.url,
            title: e.meta.title,
            open: e.ws?.readyState === WebSocket.OPEN,
          }))
        : [];
      // Enabled-tab counts per profile so the popup can show the groups.
      const enabledSet = await getEnabledSet();
      const tabCounts = new Map<string, number>();
      for (const id of enabledSet) {
        const cfg = bridgeConfigFor(id);
        tabCounts.set(cfg.id, (tabCounts.get(cfg.id) ?? 0) + 1);
      }
      const effective = bridgeConfigFor(tabId);
      sendResponse({
        enabled: enabledSet.has(tabId),
        connected: !!state,
        providers,
        host: effective.host,
        port: effective.port,
        token: effective.token,
        secure: effective.secure,
        profileKey: effective.profileKey,
        profiles: sortProfiles(bridgeProfiles).map((p) => ({
          id: p.id,
          host: p.host,
          port: p.port,
          token: p.token,
          secure: p.secure,
          profileKey: p.profileKey,
          isDefault: p.id === defaultProfileId,
          tabs: tabCounts.get(p.id) ?? 0,
        })),
        activeProfileId: effective.id,
        tabGroups: tabGroupsEnabled,
        browserControl,
        coreTools,
        designTools,
        automationTools,
        cdpTools: cdpTools && cdpPermission,
        trustedInput: trustedInput && cdpPermission,
        cdpDebuggerPermission: cdpPermission,
        cdpAttached: !!cdpSessions.get(tabId)?.attached,
        selectedElements: design.selection.items,
        selectionMarkersVisible: design.selection.markersVisible,
        cssPatches: design.cssPatches,
      });
      return;
    }

    if (req?.type === "setEnabled") {
      const tabId = req.tabId as number;
      if (req.enabled) {
        const state = await ensureEnabledTab(tabId);
        if (!state) {
          // Restricted page (chrome://, Web Store, etc.): don't leave it enabled
          // or keep the icon green — it can never connect.
          await setEnabled(tabId, false);
          void updateActionIcon(tabId, false);
          sendResponse({
            ok: false,
            error: "This page does not allow extensions (e.g. chrome://, the Web Store, or PDF viewer).",
          });
          return;
        }
        void syncTabGroups();
        sendResponse({ ok: true });
        return;
      }

      await setEnabled(tabId, false);
      void updateActionIcon(tabId, false);
      const state = tabs.get(tabId);
      if (state) {
        sendControl(state, "deactivate");
        closeAllSockets(state);
      }
      await detachCdp(tabId);
      void ungroupManagedTab(tabId);
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
      // Global toolset flags only — the bridge identity is per-tab (setTabBridge).
      browserControl = !!req.browserControl;
      const prevCoreTools = coreTools;
      const prevDesignTools = designTools;
      const prevAutomationTools = automationTools;
      const prevCdpTools = cdpTools;
      const prevTrustedInput = trustedInput;
      coreTools = req.coreTools !== false;
      designTools = !!req.designTools;
      automationTools = !!req.automationTools;
      cdpTools = !!req.cdpTools && (await hasDebuggerPermission());
      trustedInput = !!req.trustedInput && (await hasDebuggerPermission());
      if (cdpTools || trustedInput) ensureCdpListeners();
      if (req.tabGroups !== undefined) tabGroupsEnabled = !!req.tabGroups;
      await chrome.storage.local.set({ browserControl, coreTools, designTools, automationTools, cdpTools, trustedInput, tabGroups: tabGroupsEnabled });
      if (browserControl) browserProvider.restart();
      else browserProvider.stop();
      if (prevCdpTools && !cdpTools && !trustedInput) await detachAllCdp();
      if (prevTrustedInput && !trustedInput && !cdpTools) await detachAllCdp();
      // Re-apply opt-in toolset settings to already-enabled tabs so the
      // built-in catalog updates live (the page rebuilds its embedded server).
      if (coreTools !== prevCoreTools || designTools !== prevDesignTools || automationTools !== prevAutomationTools || cdpTools !== prevCdpTools || trustedInput !== prevTrustedInput) {
        for (const state of tabs.values()) {
          if (await isEnabled(state.tabId)) sendControl(state, "activate", { coreTools, designTools, automationTools, cdpTools, trustedInput });
        }
      }
      void syncTabGroups();
      sendResponse({ ok: true, browserControl, coreTools, designTools, automationTools, cdpTools, trustedInput, tabGroups: tabGroupsEnabled });
      return;
    }

    if (req?.type === "setTabBridge") {
      // Set THIS tab's bridge. A bridge is just (host, port, token, secure,
      // profileKey); identical configs auto-group (one profile). The most
      // recently configured bridge also becomes the default new tabs inherit.
      const tabId = req.tabId as number;
      const before = bridgeConfigFor(tabId);
      const result = upsertProfile(
        bridgeProfiles,
        {
          host: req.host as string | undefined,
          port: req.port as number | undefined,
          token: req.token as string | undefined,
          secure: req.secure === true,
          profileKey: req.profileKey as string | undefined,
        },
        inUseProfileIds(),
      );
      bridgeProfiles = result.profiles;
      tabBridgeOverrides.set(tabId, result.profile.id);
      defaultProfileId = result.profile.id; // new/unconfigured tabs inherit this
      await persistProfiles();
      await persistTabOverrides();
      const after = bridgeConfigFor(tabId);
      const state = tabs.get(tabId);
      if (state && !sameBridge(before, after)) bounceTabSockets(state);
      void syncTabGroups();
      sendResponse({ ok: true, host: after.host, port: after.port, hasToken: !!after.token, secure: after.secure, profileKey: after.profileKey });
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
  void detachCdp(tabId);
  frameIdsByTab.delete(tabId);
  void getAgentTabs().then((set) => (set.delete(tabId) ? saveAgentTabs(set) : undefined));
  if (tabBridgeOverrides.delete(tabId)) void persistTabOverrides();
});

// MV3 service workers are recycled after ~30s idle. An open WebSocket only
// keeps the SW alive while bytes actually flow, so we run a periodic alarm
// (< 30s) that (a) wakes the SW and (b) does real work: touch a chrome API and
// reconnect any socket that should be open but isn't. This shrinks the window
// where a recycled SW has dropped sockets without noticing.
chrome.alarms.create("mcp-page-bridge-keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "mcp-page-bridge-keepalive") return;
  // Touching a chrome API in the handler resets the idle timer for another cycle.
  void chrome.runtime.getPlatformInfo().catch(() => {
    // ignore
  });
  for (const state of tabs.values()) {
    for (const [providerId, entry] of state.sockets) {
      if (entry.wantOpen && !entry.ws) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = undefined;
        connectSocket(state, providerId);
      }
    }
  }
  if (browserControl && !browserProvider.active) browserProvider.start();
});
