/**
 * Content script (ISOLATED world). Pure relay between the page's MAIN-world
 * WebMCP tunnel and the service worker's per-tab Port. It parses nothing
 * — it just shuttles ChannelMessages in both directions.
 *
 * Guarded against double-injection for the current script generation: the
 * manifest content_script and a runtime chrome.scripting injection (for
 * already-open tabs) share this ISOLATED world. The versioned key lets a freshly
 * reloaded extension recover from stale content scripts left in an open tab.
 */
import { EXTENSION_MARK_ATTRIBUTE, MCP_PAGE_BRIDGE_VERSION, type ChannelMessage } from "mcp-page-bridge-protocol";
import {
  WEB_AGENT_CHANNEL,
  createWebAgentResponder,
  type WebAgentBackendReply,
  type WebAgentEventName,
  type WebAgentRequest,
} from "./web-agent.js";

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

  // ---- web agents -------------------------------------------------------
  //
  // An agent running in this page asks for tools directly, with no daemon and
  // no socket. This script only relays: every decision — whether this origin
  // was ever connected, and what it may see — is made in the service worker,
  // which is the only context that knows. See web-agent.ts.
  const webAgent = createWebAgentResponder({
    origin: location.origin,
    self: window,
    post: (message, targetOrigin) => window.postMessage(message, targetOrigin),
    ask: (request: WebAgentRequest, origin: string) =>
      new Promise<WebAgentBackendReply>((resolve) => {
        chrome.runtime.sendMessage(
          { type: "webAgent", method: request.method, params: request.params, origin },
          (reply?: WebAgentBackendReply) => {
            // A recycled service worker answers `undefined` with
            // lastError set. Staying silent is right for both cases: an
            // unapproved origin learns nothing either way, and the agent's
            // own deadline reports the failure it can act on.
            void chrome.runtime.lastError;
            resolve(reply ?? { silent: true });
          },
        );
      }),
  });

  window.addEventListener("message", (event: MessageEvent) => {
    // Cheap synchronous discriminator. This listener runs on every page, and
    // a busy one posts messages constantly; without it each unrelated message
    // would allocate a promise. `handle` re-checks everything, so this can
    // only ever skip traffic that is not ours.
    const data = event.data as { channel?: unknown } | null;
    if (!data || typeof data !== "object" || data.channel !== WEB_AGENT_CHANNEL) return;
    void webAgent.handle(event);
  });

  // The worker pushes these when the person connects or disconnects this
  // origin from the popup, so an open tab updates without a reload.
  chrome.runtime.onMessage.addListener((message: { type?: string; event?: WebAgentEventName }) => {
    if (message?.type === "webAgentEvent" && message.event) webAgent.emit(message.event);
  });

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
