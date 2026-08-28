/**
 * Act → observe in a single tool call.
 *
 * Without this, an agent needs three round trips to click a button and find out
 * what happened (click → take_snapshot → screenshot). Every action tool
 * therefore takes an `observe` argument and appends the requested view of the
 * page to its result.
 *
 * The default is the **compact uid snapshot only**: text is cheap, and the uids
 * it hands out are exactly what the next action needs. Screenshots stay opt-in
 * because they are expensive for coding agents that do not look at pixels.
 */
import type { ContentBlock, ToolResult } from "./embedded-server.js";
import { clampToolText, renderPageSnapshot, sleep } from "./dom-core.js";

export type ObserveMode = "none" | "snapshot" | "screenshot" | "both";

/** Node budget for the automatic post-action snapshot (take_snapshot allows more). */
export const OBSERVE_SNAPSHOT_NODES = 120;

/** How long to let the page react before observing it. */
const SETTLE_MS = 150;

/** Schema fragment for the `observe` argument, spelling out the tool's default. */
export function observeProperty(defaultMode: ObserveMode = "snapshot"): Record<string, unknown> {
  return {
    type: "string",
    enum: ["none", "snapshot", "screenshot", "both"],
    description:
      `what to return after the action (default "${defaultMode}"): "snapshot" appends a fresh compact uid tree, ` +
      `"screenshot" a PNG of the tab, "both" for both, "none" to skip`,
  };
}

export const OBSERVE_PROPERTY = observeProperty("snapshot");

export function observeMode(args: Record<string, unknown>, fallback: ObserveMode = "snapshot"): ObserveMode {
  const value = typeof args.observe === "string" ? args.observe.toLowerCase() : undefined;
  if (value === "none" || value === "snapshot" || value === "screenshot" || value === "both") return value;
  return fallback;
}

type ExtCall = (action: string, args?: Record<string, unknown>) => Promise<any>;

interface TabContext {
  self?: { id: number; url: string; title: string };
  opened?: { id: number; url: string; title: string; enabled?: boolean; closed?: boolean }[];
}

/** Last url/title we told the agent about, so we only report actual changes. */
let lastReportedLocation = "";

/**
 * Tell the agent when the action moved the ground under it: this tab navigated,
 * or the click opened a new tab.
 *
 * Without this an agent that clicks a `target="_blank"` link keeps driving the
 * old tab and cannot understand why nothing changed. Reported once per change
 * (the service worker drains the opened-tab list on read), so a loop of clicks
 * on a static page costs nothing.
 */
async function tabContextNote(extCall: ExtCall): Promise<string | undefined> {
  let context: TabContext;
  try {
    context = ((await extCall("tabContext")) ?? {}) as TabContext;
  } catch {
    return undefined;
  }

  const lines: string[] = [];
  const location = context.self ? `${context.self.url}\u0000${context.self.title}` : "";
  if (context.self && location !== lastReportedLocation) {
    // The very first observation establishes the baseline rather than reporting
    // a "change" the agent already knows about from its own navigate call.
    if (lastReportedLocation) {
      lines.push(`This tab is now on ${context.self.url}${context.self.title ? ` — "${context.self.title}"` : ""}.`);
    }
    lastReportedLocation = location;
  }

  for (const opened of context.opened ?? []) {
    if (opened.closed) continue;
    lines.push(
      `The action opened a new tab (id ${opened.id}): ${opened.url}${opened.title ? ` — "${opened.title}"` : ""}. ` +
        (opened.enabled
          ? "It is bridged: call mcp_page_bridge_list_clients to get its tool prefix."
          : "It is not bridged yet: enable it with browser__enable_tab, or the user's popup, before driving it."),
    );
  }

  return lines.length ? `Tab context:\n- ${lines.join("\n- ")}` : undefined;
}

/**
 * Append the observation blocks to an action result. Never throws: a page that
 * navigated away mid-action still returns the action outcome, with a note.
 */
export async function withObservation(
  result: ToolResult,
  mode: ObserveMode,
  opts: { extCall: ExtCall; settleMs?: number; maxNodes?: number },
): Promise<ToolResult> {
  if (mode === "none") return result;

  await sleep(Math.max(0, opts.settleMs ?? SETTLE_MS));
  const content: ContentBlock[] = [...result.content];

  const tabNote = await tabContextNote(opts.extCall);
  if (tabNote) content.push({ type: "text", text: tabNote });

  if (mode === "snapshot" || mode === "both") {
    try {
      content.push({
        type: "text",
        text: clampToolText(
          `Page after the action (fresh uids — earlier uids are now stale):\n${renderPageSnapshot({ maxNodes: opts.maxNodes ?? OBSERVE_SNAPSHOT_NODES })}`,
        ),
      });
    } catch (error) {
      content.push({ type: "text", text: `snapshot after the action failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  if (mode === "screenshot" || mode === "both") {
    try {
      const shot = (await opts.extCall("screenshot", { download: false })) as { dataUrl?: string };
      const dataUrl = shot?.dataUrl ?? "";
      const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
      if (base64) content.push({ type: "image", data: base64, mimeType: "image/png" });
    } catch (error) {
      content.push({ type: "text", text: `screenshot after the action failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  return { ...result, content };
}
