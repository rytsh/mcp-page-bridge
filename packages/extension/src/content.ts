/**
 * Content script (ISOLATED world). Pure relay between the page's MAIN-world
 * `window.mcp` tunnel and the service worker's per-tab Port. It parses nothing
 * — it just shuttles ChannelMessages in both directions.
 *
 * Guarded against double-injection: the manifest content_script and a runtime
 * chrome.scripting injection (for already-open tabs) share this ISOLATED world.
 */
import type { ChannelMessage } from "@r-mcp/protocol";

const guard = window as unknown as { __rmcpContent?: boolean };

if (!guard.__rmcpContent) {
  guard.__rmcpContent = true;

  const isChannelMessage = (value: unknown): value is ChannelMessage =>
    !!value && typeof value === "object" && (value as { __rmcp?: unknown }).__rmcp === true;

  const helloMsg: ChannelMessage = {
    __rmcp: true,
    dir: "up",
    providerId: "*",
    kind: "control",
    payload: { action: "hello", url: location.href, title: document.title },
  };

  let port: chrome.runtime.Port | undefined;

  const connect = (): void => {
    port = chrome.runtime.connect({ name: "rmcp" });

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
          __rmcp: true,
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
    if (event.source !== window) return;
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
