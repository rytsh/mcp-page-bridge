/** Popup UI: enable/disable mcp-page-bridge for the active tab and show provider status. */

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
  cdpDebuggerPermission: boolean;
  cdpAttached: boolean;
  selectedElements?: SelectedElementStatus[];
  selectionMarkersVisible?: boolean;
  cssPatches?: CssPatchStatus[];
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
  if (!status.enabled) {
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

function render(status: Status): void {
  const conn = el<HTMLSpanElement>("conn");
  conn.textContent = status.enabled ? "enabled" : "disabled";
  conn.className = `pill ${status.enabled ? "on" : ""}`;

  el<HTMLButtonElement>("toggle").textContent = status.enabled
    ? "Disable on this tab"
    : "Enable on this tab";

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
  el<HTMLInputElement>("cdpTools").checked = !!status.cdpTools;
  el<HTMLParagraphElement>("cdpHint").textContent = status.cdpTools
    ? `Advanced CDP tools enabled${status.cdpAttached ? " and attached" : ""}. Chrome shows a debugging banner while attached.`
    : status.cdpDebuggerPermission
      ? "Debugger permission granted. Enable only when you need CDP-level control."
      : "Requires optional debugger permission. Chrome shows a debugging banner while attached.";
  // The picker + CSS-patch panels only matter when the design/selection tools
  // are enabled (otherwise the agent can't act on a selection), so hide them.
  el<HTMLDivElement>("designPanel").style.display = status.designTools ? "" : "none";
  el<HTMLDivElement>("cssPanel").style.display = status.designTools ? "" : "none";
  el<HTMLDivElement>("settings").style.display = status.enabled ? "none" : "flex";
  el<HTMLInputElement>("viewSelection").checked = status.selectionMarkersVisible !== false;

  const list = status.providers
    .map(
      (p) => `<li>
        <div class="title">${escapeHtml(p.title || p.url || p.id)}</div>
        <div class="muted">${p.open ? "● connected" : "○ connecting"} — ${escapeHtml(p.url || "")}</div>
      </li>`,
    )
    .join("");

  el<HTMLDivElement>("providers").innerHTML = status.enabled
    ? status.providers.length
      ? `<ul>${list}</ul>`
      : `<p class="muted">No MCP providers on this page yet. The page can declare <code>window.mcp = { label, tools }</code> or connect an MCP server.</p>`
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
    const status = await getStatus(tabId);
    await chrome.runtime.sendMessage({ type: "setEnabled", tabId, enabled: !status.enabled });
    // Give the page a moment to (de)activate + connect, then refresh.
    setTimeout(refresh, 250);
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
    if (cdpTools && !(await ensureDebuggerPermission())) {
      cdpTools = false;
      el<HTMLInputElement>("cdpTools").checked = false;
      el<HTMLParagraphElement>("cdpHint").textContent = "Debugger permission was not granted; Advanced CDP tools stayed off.";
    }
    return { browserControl, coreTools, designTools, automationTools, cdpTools, tabGroups };
  }

  // The bridge identity (host, port, token, secure, profileKey) is per-tab.
  // Identical configs auto-group into one bridge; the most recent one becomes
  // the default new tabs inherit. No manual "custom bridge" toggle needed.
  async function saveBridge(): Promise<void> {
    await chrome.runtime.sendMessage({ type: "setTabBridge", tabId, ...readBridge() });
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

  el<HTMLInputElement>("tabGroups").addEventListener("change", () => void saveFlags());
  el<HTMLInputElement>("browserControl").addEventListener("change", () => void saveFlags());
  el<HTMLInputElement>("coreTools").addEventListener("change", () => void saveFlags());
  el<HTMLInputElement>("designTools").addEventListener("change", () => void saveFlags());
  el<HTMLInputElement>("automationTools").addEventListener("change", () => void saveFlags());
  el<HTMLInputElement>("cdpTools").addEventListener("change", () => void saveFlags());

  el<HTMLInputElement>("viewSelection").addEventListener("change", async () => {
    const visible = el<HTMLInputElement>("viewSelection").checked;
    await chrome.runtime.sendMessage({ type: "setSelectionMarkersVisible", tabId, visible });
    await refresh();
  });

  el<HTMLButtonElement>("openDashboard").addEventListener("click", async () => {
    const rawHost = el<HTMLInputElement>("host").value.trim() || "127.0.0.1";
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
