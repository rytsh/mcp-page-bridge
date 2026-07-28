/**
 * Per-frame agent, injected on demand into **every** frame of a tab.
 *
 * The page-level tools only see the top document, so cross-origin iframes used
 * to be invisible (a page built from embedded widgets was unreachable). The
 * service worker injects this bundle into all frames with
 * `chrome.scripting.executeScript`, then asks each frame for its snapshot lines
 * and stitches them into one tree with frame-prefixed uids (`f2e7`).
 *
 * Actions on a sub-frame uid are routed back to the owning frame and executed
 * here, against that frame's own uid registry.
 */
import {
  briefSummary,
  clearElementValue,
  clickElement,
  dispatchMouseLike,
  hideUidOverlay,
  isPointInViewport,
  pressKeys,
  renderSnapshotLines,
  resolveUid,
  showUidOverlay,
  typeText,
  viewportPointFor,
  waitForLocator,
} from "./dom-core.js";

export interface FrameSnapshotRequest {
  maxNodes?: number;
  includeHidden?: boolean;
  uidPrefix?: string;
}

export interface FrameSnapshotResult {
  ok: true;
  lines: string[];
  truncated: boolean;
  url: string;
  title: string;
}

export interface FrameActRequest {
  kind: "click" | "type_text" | "press_key" | "clear_value" | "describe" | "point" | "overlay_show" | "overlay_hide";
  uid?: string;
  selector?: string;
  text?: string;
  keys?: string;
  clear?: boolean;
  submit?: boolean;
  delayMs?: number;
  repeat?: number;
  clickCount?: number;
  timeoutMs?: number;
}

export interface FrameApi {
  version: number;
  snapshot(req: FrameSnapshotRequest): FrameSnapshotResult;
  act(req: FrameActRequest): Promise<Record<string, unknown>>;
}

/** Global name the service worker calls into. Bump `version` on API changes. */
export const FRAME_API_KEY = "__mcpPageBridgeFrame";

async function resolveTarget(req: FrameActRequest): Promise<Element> {
  if (req.uid) return resolveUid(req.uid);
  if (req.selector) return waitForLocator({ selector: req.selector, timeoutMs: req.timeoutMs });
  throw new Error("Frame action needs a uid or selector.");
}

const api: FrameApi = {
  version: 1,

  snapshot(req) {
    const snapshot = renderSnapshotLines(req);
    return { ok: true, ...snapshot };
  },

  async act(req) {
    switch (req.kind) {
      case "click": {
        const element = await resolveTarget(req);
        element.scrollIntoView({ block: "center", inline: "center" });
        const clickCount = req.clickCount === 2 ? 2 : 1;
        clickElement(element);
        if (clickCount === 2) {
          clickElement(element);
          dispatchMouseLike(element, "dblclick", { detail: 2 });
        }
        return { clicked: briefSummary(element), clickCount, via: "js" };
      }
      case "type_text": {
        const element = await resolveTarget(req);
        const result = await typeText(element, String(req.text ?? ""), {
          clear: req.clear !== false,
          submit: req.submit === true,
          delayMs: req.delayMs ?? 0,
        });
        return { target: briefSummary(element), typed: result.typed, cleared: result.cleared, submitted: result.submitted, via: "js" };
      }
      case "press_key": {
        const element = req.uid || req.selector ? await resolveTarget(req) : undefined;
        const pressed = await pressKeys(element, String(req.keys ?? ""), { repeat: req.repeat ?? 1, delayMs: req.delayMs ?? 0 });
        return { target: element ? briefSummary(element) : "(focused element)", pressed, via: "js" };
      }
      case "clear_value": {
        const element = await resolveTarget(req);
        return { cleared: clearElementValue(element), target: briefSummary(element) };
      }
      case "overlay_show":
        return { markers: showUidOverlay() };
      case "overlay_hide":
        hideUidOverlay();
        return { ok: true };
      case "describe": {
        const element = await resolveTarget(req);
        return { element: briefSummary(element) };
      }
      case "point": {
        // Frame-local viewport point; only meaningful for the top frame, which
        // is why trusted input stays on the main document.
        const element = await resolveTarget(req);
        element.scrollIntoView({ block: "center", inline: "center" });
        const point = viewportPointFor(element);
        return { point, inViewport: isPointInViewport(point) };
      }
      default:
        throw new Error(`unknown frame action: ${String(req.kind)}`);
    }
  },
};

const host = window as unknown as Record<string, unknown>;
if (!host[FRAME_API_KEY]) host[FRAME_API_KEY] = api;
