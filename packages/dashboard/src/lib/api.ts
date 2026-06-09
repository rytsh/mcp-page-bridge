import type { ProvidersResponse } from "./types";

// The bridge requires the shared token (if configured) on HTTP requests too.
// Operators open the dashboard as http://127.0.0.1:<port>/?token=<secret>.
const BRIDGE_TOKEN = new URLSearchParams(location.search).get("token") || "";
const TOKEN_HEADER = "x-mcp-page-bridge-token";
const DASHBOARD_HEADER = "x-mcp-page-bridge-dashboard";

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers = { ...(extra ?? {}) };
  if (BRIDGE_TOKEN) headers[TOKEN_HEADER] = BRIDGE_TOKEN;
  return headers;
}

function withToken(path: string): string {
  if (!BRIDGE_TOKEN) return path;
  return path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(BRIDGE_TOKEN);
}

export async function fetchProviders(): Promise<ProvidersResponse> {
  const res = await fetch(withToken("/api/providers"), { cache: "no-store", headers: authHeaders() });
  if (!res.ok) throw new Error("providers request failed: " + res.status);
  return res.json();
}

export async function providerAction(provider: string, action: "activate" | "close"): Promise<void> {
  const res = await fetch(withToken("/api/providers/" + encodeURIComponent(provider) + "/" + action), {
    method: "POST",
    headers: authHeaders({ [DASHBOARD_HEADER]: "1" }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) throw new Error(body.error || "action failed");
}

export async function shutdownBridge(): Promise<void> {
  const res = await fetch(withToken("/api/shutdown"), {
    method: "POST",
    headers: authHeaders({ [DASHBOARD_HEADER]: "1" }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) throw new Error(body.error || "shutdown failed");
}
