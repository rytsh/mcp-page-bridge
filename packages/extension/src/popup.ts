/** Popup UI: enable/disable r-mcp for the active tab and show provider status. */

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
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

async function refresh(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === undefined) return;
  render(await getStatus(tabId));
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
    await chrome.runtime.sendMessage({ type: "setSettings", port, token, browserControl });
    await refresh();
  }

  el<HTMLButtonElement>("saveSettings").addEventListener("click", saveSettings);
  el<HTMLInputElement>("browserControl").addEventListener("change", saveSettings);

  el<HTMLButtonElement>("openDashboard").addEventListener("click", async () => {
    const port = Number(el<HTMLInputElement>("port").value) || 8787;
    await chrome.tabs.create({ url: `http://127.0.0.1:${port}/` });
  });

  await refresh();
  setInterval(refresh, 1500);
}

void main();
