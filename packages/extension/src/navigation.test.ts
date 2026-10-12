import { describe, expect, it } from "vitest";
import {
  NAVIGATION_DEFAULT_TIMEOUT_MS,
  NAVIGATION_MAX_TIMEOUT_MS,
  describeNavigation,
  navigationTimeout,
  normalizeNavigationUrl,
  startNavigation,
  waitForNavigation,
  type NavigationReport,
  type NavigationTabsApi,
} from "./navigation.js";

type TabSnapshot = { url?: string; pendingUrl?: string; title?: string; status?: string };

/** A tab whose state advances one step per `get` call. */
function scriptedTabs(steps: TabSnapshot[]): NavigationTabsApi & { calls: string[] } {
  let i = 0;
  const calls: string[] = [];
  return {
    calls,
    get: async () => steps[Math.min(i++, steps.length - 1)]!,
    update: async (_id, props) => {
      calls.push(`update ${props.url}`);
    },
    goBack: async () => {
      calls.push("back");
    },
    goForward: async () => {
      calls.push("forward");
    },
    reload: async (_id, props) => {
      calls.push(`reload ${props?.bypassCache === true}`);
    },
  };
}

describe("normalizeNavigationUrl", () => {
  it("keeps absolute URLs and fills in https for bare hosts", () => {
    expect(normalizeNavigationUrl("https://a.test/x")).toBe("https://a.test/x");
    expect(normalizeNavigationUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeNavigationUrl("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeNavigationUrl("//cdn.test/a")).toBe("https://cdn.test/a");
    expect(normalizeNavigationUrl("about:blank")).toBe("about:blank");
  });

  it("refuses empty and script URLs", () => {
    expect(() => normalizeNavigationUrl("  ")).toThrow(/needs a url/);
    expect(() => normalizeNavigationUrl("JavaScript:alert(1)")).toThrow(/javascript:/);
  });
});

describe("navigationTimeout", () => {
  it("defaults and clamps", () => {
    expect(navigationTimeout(undefined)).toBe(NAVIGATION_DEFAULT_TIMEOUT_MS);
    expect(navigationTimeout(-5)).toBe(0);
    expect(navigationTimeout(10 ** 9)).toBe(NAVIGATION_MAX_TIMEOUT_MS);
  });
});

describe("startNavigation", () => {
  it("issues the matching chrome.tabs call", async () => {
    const tabs = scriptedTabs([{}]);
    await startNavigation(tabs, 1, { kind: "navigate", url: "a.test" });
    await startNavigation(tabs, 1, { kind: "back" });
    await startNavigation(tabs, 1, { kind: "forward" });
    await startNavigation(tabs, 1, { kind: "reload", bypassCache: true });
    expect(tabs.calls).toEqual(["update https://a.test", "back", "forward", "reload true"]);
  });
});

describe("waitForNavigation", () => {
  it("does not mistake the old page's 'complete' for the new page loading", async () => {
    const tabs = scriptedTabs([
      { url: "https://a.test/", status: "complete" }, // navigation requested, nothing visible yet
      { url: "https://a.test/", status: "loading", pendingUrl: "https://b.test/" },
      { url: "https://b.test/", status: "loading" },
      { url: "https://b.test/home", title: "B", status: "complete" },
    ]);
    const result = await waitForNavigation(tabs, 1, { fromUrl: "https://a.test/", timeoutMs: 5000 });
    expect(result).toMatchObject({ url: "https://b.test/home", title: "B", navigated: true, timedOut: false });
  });

  it("counts an unloaded document as a started navigation (reload keeps the URL)", async () => {
    let unloaded = false;
    const steps: TabSnapshot[] = [{ url: "https://a.test/", status: "complete" }];
    const tabs = scriptedTabs(steps);
    setTimeout(() => {
      unloaded = true;
    }, 20);
    const result = await waitForNavigation(tabs, 1, { fromUrl: "https://a.test/", timeoutMs: 5000, unloaded: () => unloaded });
    expect(result).toMatchObject({ navigated: true, timedOut: false, url: "https://a.test/" });
  });

  it("gives up quickly when nothing starts", async () => {
    const tabs = scriptedTabs([{ url: "https://a.test/", status: "complete" }]);
    const result = await waitForNavigation(tabs, 1, { fromUrl: "https://a.test/", timeoutMs: 5000, startGraceMs: 150 });
    expect(result.navigated).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.elapsedMs).toBeLessThan(1000);
  });

  it("reports a page that is still loading at the deadline", async () => {
    const tabs = scriptedTabs([{ url: "https://slow.test/", status: "loading" }]);
    const result = await waitForNavigation(tabs, 1, { fromUrl: "https://a.test/", timeoutMs: 250 });
    expect(result).toMatchObject({ navigated: true, timedOut: true });
  });
});

describe("describeNavigation", () => {
  const base: NavigationReport = {
    kind: "navigate",
    fromUrl: "https://a.test/",
    url: "https://b.test/",
    title: "B",
    navigated: true,
    timedOut: false,
    elapsedMs: 1234,
    newDocument: true,
  };

  it("reports the landing page and that tools moved to a new prefix", () => {
    const text = describeNavigation(base);
    expect(text).toContain('Navigated to https://b.test/ — "B" (1.2s)');
    expect(text).toContain("mcp_page_bridge_list_clients");
  });

  it("explains an empty history instead of claiming success", () => {
    const text = describeNavigation({ ...base, kind: "back", navigated: false, url: "https://a.test/" });
    expect(text).toMatch(/no page to go back to/);
  });

  it("flags error pages and restricted pages", () => {
    expect(describeNavigation({ ...base, errorPage: true, requestedUrl: "https://nope.invalid/" })).toMatch(/Navigation failed.*nope\.invalid/);
    expect(describeNavigation({ ...base, restricted: true })).toMatch(/cannot run on this page/);
  });

  it("mentions the timeout", () => {
    expect(describeNavigation({ ...base, timedOut: true })).toMatch(/still loading after 1\.2s/);
  });
});
