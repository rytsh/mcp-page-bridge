import type { ProvidersResponse } from "./types";

// The bridge requires the shared token (if configured) on HTTP requests too.
// Operators open the dashboard as http://127.0.0.1:<port>/?token=<secret>.
// On a shared/multi-user daemon, add &profile=<secret> to scope the view to
// one profile's tabs; the secret is hashed locally and never sent in the clear.
const TOKEN_HEADER = "x-mcp-page-bridge-token";
const DASHBOARD_HEADER = "x-mcp-page-bridge-dashboard";

const params = new URLSearchParams(location.search);

// Credentials persist in sessionStorage so a page refresh doesn't re-prompt.
// sessionStorage is per-tab and cleared when the tab closes; "Log out" wipes it.
const STORE_TOKEN = "mpb_token";
const STORE_PROFILE = "mpb_profile";

function readStore(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStore(key: string, value: string): void {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // sessionStorage unavailable (private mode / sandboxed): non-fatal.
  }
}

/**
 * Initial token / profile: URL query wins, then a value persisted from a
 * previous login in this tab. Both are overridable at runtime.
 */
const urlToken = params.get("token") || "";
const urlProfile = params.get("profile") || "";
export const INITIAL_TOKEN = urlToken || readStore(STORE_TOKEN);
export const INITIAL_PROFILE = urlProfile || readStore(STORE_PROFILE);
// Persist URL-provided credentials so a later refresh (without the query
// string) keeps the session instead of re-prompting.
if (urlToken) writeStore(STORE_TOKEN, urlToken);
if (urlProfile) writeStore(STORE_PROFILE, urlProfile);

let currentToken = INITIAL_TOKEN;
let currentProfileSecret = INITIAL_PROFILE;

/** Set the shared token used for all requests (multi-user / remote daemons). */
export function setToken(token: string): void {
  currentToken = token;
  writeStore(STORE_TOKEN, token);
}

/** Switch the partition the dashboard views (empty = the default partition). */
export function setProfileSecret(secret: string): void {
  writeStore(STORE_PROFILE, secret);
  currentProfileSecret = secret;
}

/** Forget the token and profile (log out): clears them from sessionStorage. */
export function clearCredentials(): void {
  currentToken = "";
  currentProfileSecret = "";
  writeStore(STORE_TOKEN, "");
  writeStore(STORE_PROFILE, "");
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers = { ...(extra ?? {}) };
  if (currentToken) headers[TOKEN_HEADER] = currentToken;
  return headers;
}

/** Append the token and the raw profile secret (daemon hashes it) to a path. */
async function withAuth(path: string): Promise<string> {
  const sp = new URLSearchParams();
  if (currentToken) sp.set("token", currentToken);
  if (currentProfileSecret.trim()) sp.set("profile", currentProfileSecret.trim());
  const qs = sp.toString();
  if (!qs) return path;
  return path + (path.includes("?") ? "&" : "?") + qs;
}

function withToken(path: string): string {
  if (!currentToken) return path;
  return path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(currentToken);
}

/** HTTP-status-carrying error so callers can tell auth failures apart. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Health {
  service?: string;
  version: string;
  port: number;
  requiresToken: boolean;
  requiresProfile: boolean;
}

/** /api/health is unauthenticated; it tells the UI what credentials to ask for. */
export async function fetchHealth(): Promise<Health> {
  const res = await fetch("/api/health", { cache: "no-store" });
  if (!res.ok) throw new ApiError(res.status, "health request failed: " + res.status);
  return res.json();
}

export async function fetchProviders(): Promise<ProvidersResponse> {
  const res = await fetch(await withAuth("/api/providers"), { cache: "no-store", headers: authHeaders() });
  if (!res.ok) throw new ApiError(res.status, "providers request failed: " + res.status);
  return res.json();
}

export async function providerAction(provider: string, action: "activate" | "close"): Promise<void> {
  const res = await fetch(await withAuth("/api/providers/" + encodeURIComponent(provider) + "/" + action), {
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
