/**
 * Tab navigation that waits for the result.
 *
 * `chrome.tabs.update({url})` resolves as soon as the navigation is *requested*,
 * so a tool built on it alone answers "navigating…" and leaves the agent to
 * guess when the next page is usable. These helpers start a navigation (or
 * history step / reload) and then follow the tab until it settles, reporting
 * where it ended up and whether it got there in time.
 *
 * Only `chrome.tabs` is used — no `webNavigation` permission — and the API is
 * passed in, so the logic is unit-testable without a browser.
 */

export type NavigationKind = "navigate" | "back" | "forward" | "reload";

export interface NavigationRequest {
  kind: NavigationKind;
  url?: string;
  bypassCache?: boolean;
}

/** The slice of `chrome.tabs` these helpers use. */
export interface NavigationTabsApi {
  get(tabId: number): Promise<{ url?: string; pendingUrl?: string; title?: string; status?: string }>;
  update(tabId: number, props: { url: string }): Promise<unknown>;
  goBack(tabId: number): Promise<void>;
  goForward(tabId: number): Promise<void>;
  reload(tabId: number, props?: { bypassCache?: boolean }): Promise<void>;
}

export const NAVIGATION_DEFAULT_TIMEOUT_MS = 15000;
/**
 * Stays below the page client's 30s call deadline and the bridge's 60s one,
 * leaving room for the snapshot of the new page.
 */
export const NAVIGATION_MAX_TIMEOUT_MS = 25000;
/**
 * How long to wait for any sign that a navigation began before concluding that
 * none will (a history step with nothing to go back to, a same-URL hash).
 */
export const NAVIGATION_START_GRACE_MS = 1500;
const POLL_MS = 100;

export function navigationTimeout(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return NAVIGATION_DEFAULT_TIMEOUT_MS;
  return Math.max(0, Math.min(NAVIGATION_MAX_TIMEOUT_MS, Math.floor(n)));
}

/**
 * Accept what a person would type into the address bar: a bare host gets
 * `https://`. Script URLs are refused — they would run code in the page under
 * the guise of a navigation.
 */
export function normalizeNavigationUrl(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error("navigate needs a url.");
  if (/^javascript:/i.test(value)) throw new Error("javascript: URLs cannot be navigated to; use eval to run code in the page.");
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  return `https://${value}`;
}

/** Issue the navigation itself. Throws when the browser refuses it. */
export async function startNavigation(tabs: NavigationTabsApi, tabId: number, req: NavigationRequest): Promise<void> {
  switch (req.kind) {
    case "navigate":
      await tabs.update(tabId, { url: normalizeNavigationUrl(req.url) });
      return;
    case "back":
      await tabs.goBack(tabId);
      return;
    case "forward":
      await tabs.goForward(tabId);
      return;
    case "reload":
      await tabs.reload(tabId, { bypassCache: req.bypassCache === true });
      return;
  }
}

export interface NavigationWait {
  url: string;
  title: string;
  /** The tab showed any sign of moving (loading state, new URL, or unload). */
  navigated: boolean;
  /** Still loading when the timeout ran out. */
  timedOut: boolean;
  elapsedMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Follow a tab until the navigation that was just started settles.
 *
 * `status === "complete"` alone is not enough: right after the request the tab
 * still reports the *previous* page as complete. So completion only counts
 * once the navigation was seen to start — the tab went to `loading`, its URL
 * changed, or `unloaded()` reports the old document is gone. If nothing starts
 * within the grace period, there was nothing to wait for.
 */
export async function waitForNavigation(
  tabs: NavigationTabsApi,
  tabId: number,
  opts: { fromUrl: string; timeoutMs: number; unloaded?: () => boolean; startGraceMs?: number },
): Promise<NavigationWait> {
  const started = Date.now();
  const grace = Math.min(opts.startGraceMs ?? NAVIGATION_START_GRACE_MS, opts.timeoutMs);
  let navigated = false;
  for (;;) {
    const tab = await tabs.get(tabId);
    const url = tab.url ?? "";
    const elapsedMs = Date.now() - started;
    if (!navigated && (tab.status === "loading" || !!tab.pendingUrl || url !== opts.fromUrl || opts.unloaded?.() === true)) {
      navigated = true;
    }
    const result = { url, title: tab.title ?? "", navigated, elapsedMs };
    if (navigated && tab.status === "complete") return { ...result, timedOut: false };
    if (!navigated && elapsedMs >= grace) return { ...result, timedOut: false };
    if (elapsedMs >= opts.timeoutMs) return { ...result, timedOut: true };
    await sleep(POLL_MS);
  }
}

export interface NavigationReport extends NavigationWait {
  kind: NavigationKind;
  fromUrl: string;
  requestedUrl?: string;
  /** The old document was replaced (as opposed to a same-document change). */
  newDocument: boolean;
  /** The browser is showing its own error page (DNS failure, refused, offline…). */
  errorPage?: boolean;
  /** The extension may not run on the new page (chrome://, the Web Store, …). */
  restricted?: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const VERBS: Record<NavigationKind, string> = {
  navigate: "Navigated",
  back: "Went back",
  forward: "Went forward",
  reload: "Reloaded",
};

/** One short paragraph telling the agent what happened and what it can do next. */
export function describeNavigation(report: NavigationReport): string {
  const seconds = (report.elapsedMs / 1000).toFixed(1);
  const where = `${report.url}${report.title ? ` — "${report.title}"` : ""}`;
  const lines: string[] = [];

  if (!report.navigated) {
    lines.push(
      report.kind === "back" || report.kind === "forward"
        ? `Nothing happened: there is no page to go ${report.kind} to in this tab's history. Still on ${where}.`
        : `The tab did not navigate; it is still on ${where}.`,
    );
    return lines.join("\n");
  }

  if (report.errorPage) {
    lines.push(
      `Navigation failed: the browser is showing an error page for ${report.requestedUrl ?? report.url} ` +
        "(the site could not be reached — DNS failure, refused connection, or offline).",
    );
  } else if (report.timedOut) {
    lines.push(`${VERBS[report.kind]} — still loading after ${seconds}s; now at ${where}. Use wait_for or take_snapshot once it settles.`);
  } else {
    lines.push(`${VERBS[report.kind]} to ${where} (${seconds}s).`);
  }

  if (report.restricted) {
    lines.push("The bridge cannot run on this page (browser-internal or store page), so its page tools are unavailable here.");
  } else if (report.newDocument && !report.errorPage) {
    const moved = hostOf(report.fromUrl) !== hostOf(report.url);
    lines.push(
      moved
        ? "This tab's page tools re-registered for the new site under a new name prefix; mcp_page_bridge_list_clients shows it."
        : "This tab's page tools re-registered for the new page; uids from earlier snapshots are stale.",
    );
  }
  return lines.join("\n");
}
