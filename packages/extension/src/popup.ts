/** Popup UI: enable/disable mcp-page-bridge for the active tab and show provider status. */
import { extensionApi, supportsDebugger } from "./extension-api.js";

const chrome = extensionApi();

interface ProviderStatus {
  id: string;
  url?: string;
  title?: string;
  open: boolean;
}
interface ProfileStatus {
  id: string;
  host: string;
  port: number;
  token: string;
  secure: boolean;
  profileKey: string;
  isDefault: boolean;
  tabs: number;
}

interface Status {
  enabled: boolean;
  connected: boolean;
  providers: ProviderStatus[];
  host?: string;
  port: number;
  token: string;
  /** Per-user profile secret partitioning the bridge (multi-user). */
  profileKey?: string;
  /** Bridge is dialed with wss:// (TLS). */
  secure?: boolean;
  profiles?: ProfileStatus[];
  activeProfileId?: string;
  tabGroups?: boolean;
  browserControl: boolean;
  coreTools: boolean;
  designTools: boolean;
  automationTools: boolean;
  cdpTools: boolean;
  trustedInput: boolean;
  cdpDebuggerPermission: boolean;
  cdpAttached: boolean;
  selectedElements?: SelectedElementStatus[];
  selectionMarkersVisible?: boolean;
  cssPatches?: CssPatchStatus[];
  /** Origin of the active tab, or "" for a page that cannot have one. */
  webAgentOrigin?: string;
  /** Whether an agent on that origin may ask this extension for tools. */
  webAgentConnected?: boolean;
  /** Which consumer this tab's page tools are served to. */
  tabMode?: "daemon" | "webAgent";
  /** For a webAgent tab, the connected site it serves. */
  tabWebAgentOrigin?: string;
  tabWebAgentTabId?: number;
  /** Sites connected for web agents, with how many tabs each already serves. */
  webAgents?: WebAgentStatus[];
}

interface WebAgentStatus {
  tabId: number;
  name: string;
  title: string;
  origin: string;
  tabs: number;
}

interface SelectedElementStatus {
  selectionId?: string;
  index?: number;
  primary?: boolean;
  selector?: string;
  tag?: string;
  text?: string;
  name?: string;
  group?: string;
  marker?: { visible?: boolean };
}

interface CssPatchStatus {
  id: string;
  selector?: string;
  css?: string;
  renderedCss?: string;
  reason?: string;
  createdAt?: string;
}

interface RuntimeResponse {
  ok?: boolean;
  error?: string;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// The popup refreshes its status every 1.5s; while the user is editing the
// connection settings (host/port/token) the periodic render must not clobber
// the in-progress input. Dirty is set on first keystroke and cleared on save.
let settingsDirty = false;

/** Latest profile list from getStatus; backs the recent-servers dropdown. */
let knownProfiles: ProfileStatus[] = [];

/** Draft connection, applied explicitly so polling cannot undo a user's choice. */
let pendingTabMode: "daemon" | "webAgent" = "daemon";
let routeInitialized = false;
let pendingAgentTabId = "";
let knownWebAgents: WebAgentStatus[] = [];
let connectionBusy = false;

/** Origin of the selected live chat. */
let pendingWebAgentOrigin = "";

function setSettingsInput(id: "host" | "port" | "token" | "profileKey", value: string): void {
  const input = el<HTMLInputElement>(id);
  if (settingsDirty || document.activeElement === input) return;
  input.value = value;
}

function profileOptionLabel(profile: ProfileStatus): string {
  let label = `${profile.secure ? "wss://" : ""}${profile.host}:${profile.port}`;
  if (profile.token) label += " \u{1F511}"; // key emoji marks token-protected bridges
  if (profile.profileKey) label += " \u{1F464}"; // bust = profile-scoped (per-user) bridge
  if (profile.isDefault) label += " · default";
  if (profile.tabs > 0) label += ` · ${profile.tabs} tab${profile.tabs === 1 ? "" : "s"}`;
  return label;
}

function renderRecentServers(status: Status): void {
  const row = el<HTMLDivElement>("recentRow");
  const select = el<HTMLSelectElement>("recentServers");
  knownProfiles = status.profiles ?? [];
  if (knownProfiles.length < 2) {
    // With zero/one known bridge a picker adds nothing; keep the popup lean.
    row.style.display = "none";
    return;
  }
  row.style.display = "";
  if (settingsDirty || document.activeElement === select) return;
  const desired = knownProfiles.map((p) => `${p.id}\u0000${profileOptionLabel(p)}`).join("\u0001");
  if (select.dataset.rendered === desired) {
    select.value = status.activeProfileId ?? "";
    return;
  }
  select.dataset.rendered = desired;
  select.innerHTML = "";
  for (const profile of knownProfiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profileOptionLabel(profile);
    select.append(option);
  }
  select.value = status.activeProfileId ?? "";
}

function renderBridgeSummary(status: Status): void {
  const summary = el<HTMLParagraphElement>("bridgeSummary");
  // A web-agent tab has no bridge. Reporting one it is not using — and could
  // not be reached on — is the kind of detail that reads as a live connection.
  if (!status.enabled || status.tabMode === "webAgent" || pendingTabMode !== "daemon") {
    summary.style.display = "none";
    return;
  }
  const active = (status.profiles ?? []).find((p) => p.id === status.activeProfileId);
  const tabCount = active?.tabs ?? 0;
  const profile = status.profileKey ? "profile ✓ (isolated)" : "no profile (shared)";
  summary.style.display = "";
  summary.textContent =
    `Bridge: ${status.secure ? "wss://" : ""}${status.host ?? "127.0.0.1"}:${status.port} — ${profile}` +
    (tabCount > 1 ? ` · ${tabCount} tabs here` : "");
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function getStatus(tabId: number): Promise<Status> {
  return chrome.runtime.sendMessage({ type: "getStatus", tabId });
}

/** Connect the current site independently of assigning page tools to a chat. */
function renderWebAgent(status: Status): void {
  const origin = status.webAgentOrigin ?? "";
  const connected = !!status.webAgentConnected;
  const pill = el<HTMLSpanElement>("webAgentPill");
  const button = el<HTMLButtonElement>("webAgentToggle");

  el<HTMLParagraphElement>("webAgentOrigin").textContent = origin || "This page has no site to connect.";
  pill.textContent = origin ? (connected ? "connected" : "not connected") : "unavailable";
  pill.className = `pill ${connected ? "on" : ""}`;
  button.disabled = !origin;
  button.textContent = connected ? "Disconnect this site" : "Connect this site";
  button.className = connected ? "full" : "full primary";
  el<HTMLParagraphElement>("webAgentHint").textContent = connected
    ? "An agent on this site can list this extension and call its browser tools. It still asks you to approve the tools on its own side."
    : "Connect a site whose agent should use this browser — an AT Chats tab, for example. No daemon is needed, and other sites are not told this extension exists.";
}

/**
 * Which consumer this tab's page tools are served to.
 *
 * Shown whether or not the tab is enabled, because it is the choice the enable
 * button acts on. While the tab is off this is a pending intent and nothing has
 * happened yet; once it is on, changing it moves a live tab and the wording
 * says so.
 *
 * The hint names the consequence rather than the mechanism, because the failure
 * it prevents is the quiet one — a tab switched on for an in-browser agent that
 * instead sits retrying a local port nobody is listening on.
 */
function renderTabMode(status: Status): void {
  const select = el<HTMLSelectElement>("tabMode");
  const target = el<HTMLSelectElement>("webAgentTarget");
  const mode = pendingTabMode;
  const sites = status.webAgents ?? [];
  knownWebAgents = sites;
  const chosen = pendingAgentTabId;

  el<HTMLLabelElement>("tabModeLabel").textContent = "Connect";
  // Never clobber a selection mid-interaction: the 1.5s poll would otherwise
  // snap a dropdown back while it is open.
  if (document.activeElement !== select) select.value = mode;

  // The site picker only exists for the web-agent mode; in daemon mode the
  // destination is the bridge configured in Settings.
  el<HTMLDivElement>("webAgentTargetRow").style.display = mode === "webAgent" ? "" : "none";

  if (mode === "webAgent" && document.activeElement !== target) {
    const options = sites.length
      ? sites.map((site) => {
          const label = `${site.title} — ${shortUrl(site.origin)} (tab ${site.tabId})`;
          const suffix = site.tabs ? ` · ${site.tabs} tab${site.tabs > 1 ? "s" : ""}` : "";
          return `<option value="${site.tabId}">${escapeHtml(label + suffix)}</option>`;
        })
      : [];
    target.innerHTML = `<option value="">${sites.length ? "Choose an agent…" : "No agents with Web connection enabled"}</option>` + options.join("");
    // A disappeared chat must not silently select another destination.
    target.value = sites.some((s) => String(s.tabId) === chosen) ? chosen : "";
    target.disabled = sites.length === 0;
    pendingAgentTabId = target.value;
    pendingWebAgentOrigin = sites.find((site) => String(site.tabId) === target.value)?.origin ?? "";
  }

  el<HTMLParagraphElement>("tabModeHint").textContent = mode === "webAgent"
    ? "Open AT Chat and turn on Web connection, then select that chat here. No daemon is needed."
    : "Connect to a bridge daemon using the settings below.";
}

function render(status: Status): void {
  if (!routeInitialized) {
    pendingTabMode = status.enabled ? status.tabMode ?? "daemon" : "daemon";
    pendingAgentTabId = status.tabWebAgentTabId === undefined ? "" : String(status.tabWebAgentTabId);
    pendingWebAgentOrigin = status.tabWebAgentOrigin ?? "";
    routeInitialized = true;
  }
  const conn = el<HTMLSpanElement>("conn");
  conn.textContent = status.enabled ? "enabled" : "disabled";
  conn.className = `pill ${status.enabled ? "on" : ""}`;

  el<HTMLButtonElement>("toggle").textContent = status.enabled ? "Apply connection" : "Connect this tab";
  el<HTMLButtonElement>("disconnect").style.display = status.enabled ? "" : "none";

  setSettingsInput("host", status.host ?? "127.0.0.1");
  setSettingsInput("port", String(status.port));
  setSettingsInput("token", status.token ?? "");
  setSettingsInput("profileKey", status.profileKey ?? "");
  if (!settingsDirty) el<HTMLInputElement>("secure").checked = !!status.secure;
  renderRecentServers(status);
  renderBridgeSummary(status);
  el<HTMLInputElement>("tabGroups").checked = !!status.tabGroups;
  el<HTMLInputElement>("browserControl").checked = !!status.browserControl;
  el<HTMLInputElement>("coreTools").checked = status.coreTools !== false;
  el<HTMLInputElement>("designTools").checked = !!status.designTools;
  el<HTMLInputElement>("automationTools").checked = !!status.automationTools;
  const debuggerSupported = supportsDebugger();
  el<HTMLInputElement>("cdpTools").disabled = !debuggerSupported;
  el<HTMLInputElement>("trustedInput").disabled = !debuggerSupported;
  el<HTMLInputElement>("cdpTools").checked = debuggerSupported && !!status.cdpTools;
  el<HTMLInputElement>("trustedInput").checked = debuggerSupported && !!status.trustedInput;
  el<HTMLParagraphElement>("trustedInputHint").textContent = status.trustedInput
    ? "click / type_text / press_key dispatch real events via the debugger. The tab is focused briefly for each action."
    : "Off: input uses synthetic DOM events (isTrusted:false). Turn on for pages that ignore them; needs the debugger permission.";
  el<HTMLParagraphElement>("cdpHint").textContent = status.cdpTools
    ? `Advanced CDP tools enabled${status.cdpAttached ? " and attached" : ""}. Chrome shows a debugging banner while attached.`
    : status.cdpDebuggerPermission
      ? "Debugger permission granted. Enable only when you need CDP-level control."
      : "Requires optional debugger permission. Chrome shows a debugging banner while attached.";
  if (!debuggerSupported) {
    el<HTMLParagraphElement>("cdpHint").textContent = "Unavailable in Firefox: this browser does not support the debugger API.";
    el<HTMLParagraphElement>("trustedInputHint").textContent = "Unavailable in Firefox: trusted input requires the debugger API. Input uses synthetic DOM events (isTrusted:false).";
  }
  renderWebAgent(status);
  renderTabMode(status);
  el<HTMLButtonElement>("toggle").disabled = connectionBusy || !pendingTabMode || (pendingTabMode === "webAgent" && !pendingAgentTabId);
  // The picker + CSS-patch panels only matter when the design/selection tools
  // are enabled (otherwise the agent can't act on a selection), so hide them.
  el<HTMLDivElement>("designPanel").style.display = status.designTools ? "" : "none";
  el<HTMLDetailsElement>("cssPanel").style.display = status.designTools ? "" : "none";
  // Host/port/token configure a daemon connection. A tab set to serve the web
  // agent will not make one, so the fields are not merely unused — filling them
  // in would have no effect, and offering them says otherwise.
  const daemonSettings = pendingTabMode === "daemon";
  el<HTMLDivElement>("settings").style.display = daemonSettings ? "flex" : "none";
  el<HTMLButtonElement>("openDashboard").style.display = daemonSettings ? "" : "none";
  el<HTMLElement>("daemonHint").style.display = daemonSettings ? "" : "none";
  el<HTMLElement>("daemonOptions").style.display = daemonSettings ? "" : "none";
  el<HTMLElement>("webAgentPanel").style.display = pendingTabMode === "webAgent" && status.webAgentConnected ? "" : "none";
  el<HTMLInputElement>("viewSelection").checked = status.selectionMarkersVisible !== false;

  const list = status.providers.map(renderProvider).join("");

  el<HTMLDivElement>("providers").innerHTML = status.enabled
    ? status.providers.length
      ? `<ul>${list}</ul>`
      : `<p class="muted">No MCP providers on this page yet. The page can register tools with <code>document.modelContext.registerTool()</code> or connect an MCP server.</p>`
    : "";

  const selected = status.selectedElements ?? [];
  el<HTMLDivElement>("selectedElements").innerHTML = selected.length
    ? `<ul>${selected.map(renderSelection).join("")}</ul>`
    : `<p class="muted">No selected elements.</p>`;

  const patches = status.cssPatches ?? [];
  el<HTMLButtonElement>("clearCssPatches").disabled = patches.length === 0;
  el<HTMLDivElement>("cssPatches").innerHTML = patches.length
    ? `<ul>${patches.map(renderCssPatch).join("")}</ul>`
    : `<p class="muted">No temporary CSS patches.</p>`;
}

/**
 * Shortens a URL to what identifies the page in a 320px popup.
 *
 * The host is the part that says *where* this provider is, and it is the part a
 * long URL pushes out of view, so it leads. The path is kept only if it fits,
 * elided from the middle when it does not: the tail of a path is usually the
 * page (`/pull/1423`), while the middle is usually scaffolding.
 */
const URL_BUDGET = 42;

function shortUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  let host = url.host.replace(/^www\./, "");
  // A deep corporate subdomain can exhaust the budget on its own. The right end
  // is the registrable part that says which service this is, so that is what
  // survives.
  if (host.length > URL_BUDGET) host = `…${host.slice(-(URL_BUDGET - 1))}`;

  const path = `${url.pathname}${url.search}`.replace(/\/$/, "");
  if (!path) return host;

  const room = URL_BUDGET - host.length;
  if (path.length <= room) return host + path;
  // Too little room left to say anything useful about the path, and a two-
  // character stub reads as truncation damage rather than as information.
  if (room < 12) return host;
  const head = Math.ceil((room - 1) / 2);
  return `${host}${path.slice(0, head)}…${path.slice(-(room - 1 - head))}`;
}

/**
 * One provider row: what it is, then how it is doing.
 *
 * The URL is the fallback identity, not a second line to repeat — a page with
 * no title would otherwise print the same long string twice and push the status
 * off the edge. So the second line carries the status and only adds the URL
 * when the first line is not already showing it.
 */
function renderProvider(p: ProviderStatus): string {
  const short = p.url ? shortUrl(p.url) : "";
  const title = p.title || short || p.id;
  const status = p.open ? "● connected" : "○ connecting";
  const detail = short && p.title ? `${status} — ${short}` : status;
  // `title` attributes give back the full text the elision drops, on hover.
  return `<li>
    <div class="title"${p.url ? ` title="${escapeHtml(p.url)}"` : ""}>${escapeHtml(title)}</div>
    <div class="muted title"${p.url ? ` title="${escapeHtml(p.url)}"` : ""}>${escapeHtml(detail)}</div>
  </li>`;
}

function renderSelection(item: SelectedElementStatus): string {
  const id = item.selectionId ?? "";
  const label = item.name ? `${item.name} · ${item.tag ?? "element"}` : item.tag ?? "element";
  const title = `${item.index ?? "?"}. ${label}${item.primary ? " (primary)" : ""}`;
  const detail = item.text || item.selector || id;
  return `<li class="selection-item">
    <div class="selection-meta">
      <div class="title">${escapeHtml(title)}</div>
      <div class="muted">${escapeHtml(item.group ? `${item.group} · ${detail}` : detail)}</div>
    </div>
    <button data-remove-selection="${escapeHtml(id)}" title="Unselect">×</button>
    <div class="selection-edit">
      <input data-selection-name="${escapeHtml(id)}" type="text" placeholder="Name" value="${escapeHtml(item.name ?? "")}" />
      <input data-selection-group="${escapeHtml(id)}" type="text" placeholder="Group" value="${escapeHtml(item.group ?? "")}" />
      <button data-save-selection="${escapeHtml(id)}">Save</button>
    </div>
  </li>`;
}

function renderCssPatch(patch: CssPatchStatus): string {
  const title = patch.reason || patch.selector || patch.id;
  const detail = patch.selector ? `${patch.id} · ${patch.selector}` : patch.id;
  const css = patch.renderedCss || patch.css || "";
  return `<li class="patch-item">
    <div class="patch-meta">
      <div class="title">${escapeHtml(title)}</div>
      <div class="muted">${escapeHtml(detail)}</div>
      <pre>${escapeHtml(css.slice(0, 260))}</pre>
    </div>
    <button data-remove-css-patch="${escapeHtml(patch.id)}" title="Undo CSS patch">Undo</button>
  </li>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function selectionEditFocused(): boolean {
  const active = document.activeElement as HTMLElement | null;
  return !!active?.closest("#selectedElements .selection-edit");
}

async function ensureDebuggerPermission(): Promise<boolean> {
  if (!supportsDebugger()) return false;
  const request = { permissions: ["debugger"] };
  if (await chrome.permissions.contains(request)) return true;
  return chrome.permissions.request(request);
}

async function refresh(opts: { skipSelectionEdit?: boolean } = {}): Promise<void> {
  if (opts.skipSelectionEdit && selectionEditFocused()) return;
  const tabId = await activeTabId();
  if (tabId === undefined) return;
  const status = await getStatus(tabId);
  if (opts.skipSelectionEdit && selectionEditFocused()) return;
  render(status);
}

async function main(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === undefined) return;

  el<HTMLButtonElement>("toggle").addEventListener("click", async () => {
    if (connectionBusy || !pendingTabMode) return;
    connectionBusy = true;
    el<HTMLButtonElement>("toggle").disabled = true;
    el<HTMLParagraphElement>("connectionError").textContent = "";
    try {
      if (pendingTabMode === "daemon") await saveBridge();
      const reply: RuntimeResponse = await chrome.runtime.sendMessage({
        type: "setEnabled", tabId, enabled: true, mode: pendingTabMode,
        origin: pendingWebAgentOrigin,
        agentTabId: pendingTabMode === "webAgent" && pendingAgentTabId ? Number(pendingAgentTabId) : undefined,
      });
      if (!reply?.ok) throw new Error(reply?.error || "Could not connect this tab.");
    } catch (error) {
      el<HTMLParagraphElement>("connectionError").textContent = (error as Error).message;
    } finally {
      connectionBusy = false;
      await refresh();
    }
  });

  el<HTMLButtonElement>("disconnect").addEventListener("click", async () => {
    const reply: RuntimeResponse = await chrome.runtime.sendMessage({ type: "setEnabled", tabId, enabled: false });
    el<HTMLParagraphElement>("connectionError").textContent = reply?.error ?? "";
    await refresh();
  });

  /**
   * Both selects write the same route; only the field they change differs.
   *
   * An arrow const rather than a declaration: a hoisted function would be
   * visible before the `tabId === undefined` guard above, so TypeScript widens
   * the captured `tabId` back to `number | undefined`.
   */
  const applyRoute = async (patch: { mode?: "daemon" | "webAgent"; agentTabId?: string }): Promise<void> => {
    if (patch.mode !== undefined) pendingTabMode = patch.mode;
    if (patch.agentTabId !== undefined) {
      pendingAgentTabId = patch.agentTabId;
      pendingWebAgentOrigin = knownWebAgents.find((agent) => String(agent.tabId) === patch.agentTabId)?.origin ?? "";
    }
    el<HTMLParagraphElement>("connectionError").textContent = "";
    render(await getStatus(tabId));
  };

  el<HTMLSelectElement>("tabMode").addEventListener("change", (event) => {
    void applyRoute({ mode: (event.target as HTMLSelectElement).value as "daemon" | "webAgent" });
  });

  el<HTMLSelectElement>("webAgentTarget").addEventListener("change", (event) => {
    void applyRoute({ agentTabId: (event.target as HTMLSelectElement).value });
  });

  el<HTMLButtonElement>("webAgentToggle").addEventListener("click", async () => {
    const status = await getStatus(tabId);
    const reply: RuntimeResponse = await chrome.runtime.sendMessage({
      type: "setWebAgentOrigin",
      tabId,
      connected: !status.webAgentConnected,
    });
    el<HTMLParagraphElement>("connectionError").textContent = reply?.error ?? "";
    await refresh();
  });

  function readBridge(): { host: string; port: number; token: string; profileKey: string; secure: boolean } {
    return {
      host: el<HTMLInputElement>("host").value.trim() || "127.0.0.1",
      port: Number(el<HTMLInputElement>("port").value) || 8787,
      token: el<HTMLInputElement>("token").value.trim(),
      profileKey: el<HTMLInputElement>("profileKey").value.trim(),
      secure: el<HTMLInputElement>("secure").checked,
    };
  }

  async function readFlags(): Promise<Record<string, boolean>> {
    const browserControl = el<HTMLInputElement>("browserControl").checked;
    const coreTools = el<HTMLInputElement>("coreTools").checked;
    const designTools = el<HTMLInputElement>("designTools").checked;
    const automationTools = el<HTMLInputElement>("automationTools").checked;
    const tabGroups = el<HTMLInputElement>("tabGroups").checked;
    let cdpTools = el<HTMLInputElement>("cdpTools").checked;
    let trustedInput = el<HTMLInputElement>("trustedInput").checked;
    if ((cdpTools || trustedInput) && !(await ensureDebuggerPermission())) {
      if (cdpTools) {
        cdpTools = false;
        el<HTMLInputElement>("cdpTools").checked = false;
        el<HTMLParagraphElement>("cdpHint").textContent = "Debugger permission was not granted; Advanced CDP tools stayed off.";
      }
      if (trustedInput) {
        trustedInput = false;
        el<HTMLInputElement>("trustedInput").checked = false;
        el<HTMLParagraphElement>("trustedInputHint").textContent = "Debugger permission was not granted; trusted input stayed off.";
      }
    }
    return { browserControl, coreTools, designTools, automationTools, cdpTools, trustedInput, tabGroups };
  }

  // The bridge identity (host, port, token, secure, profileKey) is per-tab.
  // Identical configs auto-group into one bridge; the most recent one becomes
  // the default new tabs inherit. No manual "custom bridge" toggle needed.
  async function saveBridge(): Promise<void> {
    const reply: RuntimeResponse = await chrome.runtime.sendMessage({ type: "setTabBridge", tabId, ...readBridge() });
    if (reply?.error) throw new Error(reply.error);
    settingsDirty = false;
    await refresh();
  }

  // Toolset flags are global (not tied to a tab or bridge).
  async function saveFlags(): Promise<void> {
    await chrome.runtime.sendMessage({ type: "setSettings", ...(await readFlags()) });
    await refresh();
  }

  // Track edits so the periodic refresh leaves the inputs alone, and save on
  // Enter or blur so a typed host/port/token/profile sticks automatically.
  for (const id of ["host", "port", "token", "profileKey"] as const) {
    const input = el<HTMLInputElement>(id);
    input.addEventListener("input", () => {
      settingsDirty = true;
    });
    input.addEventListener("change", () => void saveBridge());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void saveBridge();
    });
  }

  // Bridge dropdown: picking a saved bridge fills the fields and applies it to
  // this tab. Identical bridges are one entry; profiled ones are marked.
  el<HTMLSelectElement>("recentServers").addEventListener("change", () => {
    const profile = knownProfiles.find((p) => p.id === el<HTMLSelectElement>("recentServers").value);
    if (!profile) return;
    settingsDirty = true;
    el<HTMLInputElement>("host").value = profile.host;
    el<HTMLInputElement>("port").value = String(profile.port);
    el<HTMLInputElement>("token").value = profile.token;
    el<HTMLInputElement>("profileKey").value = profile.profileKey;
    el<HTMLInputElement>("secure").checked = !!profile.secure;
    void saveBridge();
  });

  // Secure is part of the bridge identity.
  el<HTMLInputElement>("secure").addEventListener("change", () => {
    settingsDirty = true;
    void saveBridge();
  });

  // Show/hide toggles for the masked secret inputs (token, profile key).
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-reveal]")) {
    button.addEventListener("click", () => {
      const input = el<HTMLInputElement>(button.dataset.reveal ?? "");
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      button.textContent = reveal ? "🙈" : "👁";
      button.setAttribute("aria-pressed", String(reveal));
    });
  }

  el<HTMLInputElement>("tabGroups").addEventListener("change", () => void saveFlags());
  el<HTMLInputElement>("browserControl").addEventListener("change", () => void saveFlags());
  el<HTMLInputElement>("coreTools").addEventListener("change", () => void saveFlags());
  el<HTMLInputElement>("designTools").addEventListener("change", () => void saveFlags());
  el<HTMLInputElement>("automationTools").addEventListener("change", () => void saveFlags());
  el<HTMLInputElement>("cdpTools").addEventListener("change", () => void saveFlags());
  el<HTMLInputElement>("trustedInput").addEventListener("change", () => void saveFlags());

  el<HTMLInputElement>("viewSelection").addEventListener("change", async () => {
    const visible = el<HTMLInputElement>("viewSelection").checked;
    await chrome.runtime.sendMessage({ type: "setSelectionMarkersVisible", tabId, visible });
    await refresh();
  });

  el<HTMLButtonElement>("openDashboard").addEventListener("click", async () => {
    let rawHost = el<HTMLInputElement>("host").value.trim() || "127.0.0.1";
    // 0.0.0.0 / :: are bind addresses, not browsable hosts, and the dashboard's
    // Host check only accepts loopback names — open such daemons at localhost.
    if (rawHost === "0.0.0.0" || rawHost === "::" || rawHost === "[::]" || rawHost === "") {
      rawHost = "127.0.0.1";
    }
    const host = rawHost.includes(":") && !rawHost.startsWith("[") ? `[${rawHost}]` : rawHost;
    const port = Number(el<HTMLInputElement>("port").value) || 8787;
    const token = el<HTMLInputElement>("token").value.trim();
    const profileKey = el<HTMLInputElement>("profileKey").value.trim();
    const scheme = el<HTMLInputElement>("secure").checked ? "https" : "http";
    const params = new URLSearchParams();
    if (token) params.set("token", token);
    if (profileKey) params.set("profile", profileKey); // dashboard hashes it locally
    const query = params.toString();
    await chrome.tabs.create({ url: `${scheme}://${host}:${port}/${query ? `?${query}` : ""}` });
  });

  async function startPicker(append: boolean): Promise<void> {
    const hint = el<HTMLParagraphElement>("pickerHint");
    hint.textContent = append ? "Starting add-another picker..." : "Starting picker...";
    const res = (await chrome.runtime.sendMessage({ type: "startElementPicker", tabId, append })) as RuntimeResponse;
    if (res?.ok) {
      window.close();
      return;
    }
    hint.textContent = res?.error ?? "Could not start picker on this tab.";
  }

  el<HTMLButtonElement>("pickElement").addEventListener("click", () => {
    void startPicker(false);
  });

  el<HTMLButtonElement>("addElement").addEventListener("click", () => {
    void startPicker(true);
  });

  el<HTMLButtonElement>("clearSelection").addEventListener("click", async () => {
    const hint = el<HTMLParagraphElement>("pickerHint");
    hint.textContent = "Clearing selected elements...";
    const res = (await chrome.runtime.sendMessage({ type: "clearSelectedElements", tabId })) as RuntimeResponse;
    hint.textContent = res?.ok ? "Selection cleared." : res?.error ?? "Could not clear selection.";
    await refresh();
  });

  el<HTMLDivElement>("selectedElements").addEventListener("click", async (event) => {
    const target = event.target as HTMLElement | null;
    const removeButton = target?.closest<HTMLButtonElement>("[data-remove-selection]");
    if (removeButton) {
      const selectionId = removeButton.dataset.removeSelection;
      if (!selectionId) return;
      await chrome.runtime.sendMessage({ type: "removeSelectedElement", tabId, selectionId });
      await refresh();
      return;
    }
    const saveButton = target?.closest<HTMLButtonElement>("[data-save-selection]");
    if (!saveButton) return;
    const selectionId = saveButton.dataset.saveSelection;
    if (!selectionId) return;
    const name = document.querySelector<HTMLInputElement>(`[data-selection-name="${cssEscape(selectionId)}"]`)?.value ?? "";
    const group = document.querySelector<HTMLInputElement>(`[data-selection-group="${cssEscape(selectionId)}"]`)?.value ?? "";
    await chrome.runtime.sendMessage({ type: "setSelectedElementMeta", tabId, selectionId, name, group });
    await refresh();
  });

  el<HTMLDivElement>("cssPatches").addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-remove-css-patch]");
    if (!button) return;
    const patchId = button.dataset.removeCssPatch;
    if (!patchId) return;
    await chrome.runtime.sendMessage({ type: "removeCssPatch", tabId, patchId });
    await refresh();
  });

  el<HTMLButtonElement>("clearCssPatches").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "clearCssPatches", tabId });
    await refresh();
  });

  await refresh();
  setInterval(() => void refresh({ skipSelectionEdit: true }), 1500);
}

function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

void main();
