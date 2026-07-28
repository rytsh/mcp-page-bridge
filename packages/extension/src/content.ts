/**
 * Content script (ISOLATED world). Pure relay between the page's MAIN-world
 * `window.mcp` tunnel and the service worker's per-tab Port. It parses nothing
 * — it just shuttles ChannelMessages in both directions.
 *
 * Guarded against double-injection for the current script generation: the
 * manifest content_script and a runtime chrome.scripting injection (for
 * already-open tabs) share this ISOLATED world. The versioned key lets a freshly
 * reloaded extension recover from stale content scripts left in an open tab.
 */
import { EXTENSION_MARK_ATTRIBUTE, MCP_PAGE_BRIDGE_VERSION, type ChannelMessage } from "mcp-page-bridge-protocol";

const CONTENT_GUARD_KEY = "__mcpPageBridgeContentV2";
const guard = window as unknown as Record<string, unknown>;

/**
 * Let the bridge dashboard know the extension is installed (it otherwise has no
 * way to tell "no tabs connected" from "extension missing"). Only loopback
 * origins are marked, so this never becomes a fingerprinting signal for ordinary
 * websites.
 */
function markExtensionForDashboard(): void {
  const host = location.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return;
  const apply = (): void => document.documentElement?.setAttribute(EXTENSION_MARK_ATTRIBUTE, MCP_PAGE_BRIDGE_VERSION);
  apply();
  if (!document.documentElement) document.addEventListener("DOMContentLoaded", apply, { once: true });
}

markExtensionForDashboard();

if (!guard[CONTENT_GUARD_KEY]) {
  guard[CONTENT_GUARD_KEY] = true;

  const isChannelMessage = (value: unknown): value is ChannelMessage =>
    !!value && typeof value === "object" && (value as { __mcpPageBridge?: unknown }).__mcpPageBridge === true;

  const helloMsg: ChannelMessage = {
    __mcpPageBridge: true,
    dir: "up",
    providerId: "*",
    kind: "control",
    payload: { action: "hello", url: location.href, title: document.title },
  };

  let port: chrome.runtime.Port | undefined;

  const connect = (): void => {
    port = chrome.runtime.connect({ name: "mcp-page-bridge" });

    // SW -> page (MAIN)
    port.onMessage.addListener((data: unknown) => {
      if (!isChannelMessage(data) || data.dir !== "down") return;
      window.postMessage(data, "*");
    });

    port.onDisconnect.addListener(() => {
      port = undefined;
      // Tell the page to deactivate, then try to reconnect (e.g. SW recycled).
      window.postMessage(
        {
          __mcpPageBridge: true,
          dir: "down",
          providerId: "*",
          kind: "control",
          payload: { action: "deactivate" },
        } satisfies ChannelMessage,
        "*",
      );
      setTimeout(connect, 1000);
    });

    // Announce this tab so the SW can map it and auto-activate if enabled.
    port.postMessage(helloMsg);
  };

  // page (MAIN) -> SW
  window.addEventListener("message", (event: MessageEvent) => {
    // Only accept envelopes posted by this same document's MAIN world. The
    // source check rejects cross-frame posts; the origin check rejects messages
    // forged with a spoofed origin (defense-in-depth alongside SW-side gating).
    if (event.source !== window) return;
    if (event.origin !== location.origin && event.origin !== "null") return;
    const data = event.data;
    if (!isChannelMessage(data) || data.dir !== "up") return;
    try {
      port?.postMessage(data);
    } catch {
      // SW disconnected; onDisconnect handles teardown + reconnect.
    }
  });

  connect();
}
