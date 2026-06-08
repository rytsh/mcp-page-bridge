/** Popup UI: enable/disable mcp-page-bridge for the active tab and show provider status. */

interface ProviderStatus {
  id: string;
  url?: string;
  title?: string;
  open: boolean;
}
interface Status {
  enabled: boolean;
  connected: boolean;
  providers: ProviderStatus[];
  port: number;
  token: string;
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

  el<HTMLInputElement>("port").value = String(status.port);
  el<HTMLInputElement>("token").value = status.token ?? "";
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

  async function saveSettings(): Promise<void> {
    const port = Number(el<HTMLInputElement>("port").value) || 8787;
    const token = el<HTMLInputElement>("token").value.trim();
    const browserControl = el<HTMLInputElement>("browserControl").checked;
    const coreTools = el<HTMLInputElement>("coreTools").checked;
    const designTools = el<HTMLInputElement>("designTools").checked;
    const automationTools = el<HTMLInputElement>("automationTools").checked;
    let cdpTools = el<HTMLInputElement>("cdpTools").checked;
    if (cdpTools && !(await ensureDebuggerPermission())) {
      cdpTools = false;
      el<HTMLInputElement>("cdpTools").checked = false;
      el<HTMLParagraphElement>("cdpHint").textContent = "Debugger permission was not granted; Advanced CDP tools stayed off.";
    }
    await chrome.runtime.sendMessage({ type: "setSettings", port, token, browserControl, coreTools, designTools, automationTools, cdpTools });
    await refresh();
  }

  el<HTMLButtonElement>("saveSettings").addEventListener("click", saveSettings);
  el<HTMLInputElement>("browserControl").addEventListener("change", saveSettings);
  el<HTMLInputElement>("coreTools").addEventListener("change", saveSettings);
  el<HTMLInputElement>("designTools").addEventListener("change", saveSettings);
  el<HTMLInputElement>("automationTools").addEventListener("change", saveSettings);
  el<HTMLInputElement>("cdpTools").addEventListener("change", saveSettings);

  el<HTMLInputElement>("viewSelection").addEventListener("change", async () => {
    const visible = el<HTMLInputElement>("viewSelection").checked;
    await chrome.runtime.sendMessage({ type: "setSelectionMarkersVisible", tabId, visible });
    await refresh();
  });

  el<HTMLButtonElement>("openDashboard").addEventListener("click", async () => {
    const port = Number(el<HTMLInputElement>("port").value) || 8787;
    await chrome.tabs.create({ url: `http://127.0.0.1:${port}/` });
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
