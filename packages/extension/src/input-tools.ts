/**
 * Core input tools: click, type_text, press_key, clear_value.
 *
 * These are the primitives an agent needs to drive any page, so they are part
 * of the always-available core toolset (they are also registered when only the
 * opt-in automation toolset is on). Every target can be given as a uid from
 * `take_snapshot`, a CSS selector, visible text, a role/name pair, a form label
 * — or, for `click`, raw viewport coordinates.
 *
 * Two dispatch paths:
 *   - **synthetic** (default): DOM events built in the page. Works everywhere,
 *     no extra permission, but `event.isTrusted` is false.
 *   - **trusted** (popup switch "Trusted input"): real `Input.dispatch*` events
 *     through CDP in the service worker. Needed by pages that ignore untrusted
 *     events. Every trusted attempt falls back to the synthetic path on error,
 *     so a tool call never fails just because CDP was unavailable.
 */
import type { EmbeddedMcpServer } from "./embedded-server.js";
import {
  actionabilityFor,
  briefSummary,
  charChords,
  cdpKeyDescriptor,
  clickPoint,
  clickElement,
  clearElementValue,
  dispatchMouseLike,
  focusElement,
  hasLocatorArgs,
  isFrameUid,
  isPointInViewport,
  json,
  type KeyChord,
  numberArg,
  parseKeySequence,
  parseTypeSegments,
  pressKeys,
  renderPageSnapshot,
  sleep,
  text,
  typeText,
  viewportPointFor,
  waitForLocator,
} from "./dom-core.js";
import { OBSERVE_PROPERTY, observeMode, observeProperty, withObservation } from "./observe.js";

type ExtCall = (action: string, args?: Record<string, unknown>) => Promise<any>;

export interface InputToolOptions {
  extCall: ExtCall;
  /** Route input through CDP (popup switch); falls back to synthetic events. */
  trustedInput?: boolean;
}

const LOCATOR_PROPERTIES = {
  uid: { type: "string", description: "element uid from take_snapshot (preferred when available)" },
  selector: { type: "string", description: "CSS selector" },
  text: { type: "string", description: "visible text of the element" },
  role: { type: "string", description: "ARIA/implicit role, e.g. button, link, textbox" },
  name: { type: "string", description: "accessible name filter" },
  label: { type: "string", description: "form label, aria-label, or placeholder" },
  testId: { type: "string", description: "data-testid / data-test / data-cy value" },
  nth: { type: "number", description: "index when several elements match" },
} as const;

/** Resolve the target element for an action, or the focused element when no locator is given. */
async function resolveTarget(
  args: Record<string, unknown>,
  opts: { actionable?: boolean; required?: boolean } = {},
): Promise<Element | undefined> {
  if (!hasLocatorArgs(args)) {
    if (opts.required) throw new Error("Provide uid, selector, text, role, label, or testId to target an element.");
    return undefined;
  }
  return waitForLocator(args, { actionable: opts.actionable === true && args.force !== true, strict: args.strict === true });
}

function activeElement(): Element {
  return (document.activeElement as Element | null) ?? document.body;
}

/**
 * Sub-frame uids (`f2e7`) belong to another document, so the action is executed
 * by the frame agent inside that frame instead of here.
 */
async function actInFrame(extCall: ExtCall, kind: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await extCall("frameAct", { ...args, kind })) as Record<string, unknown>;
  return { ...result, frame: String(args.uid).replace(/e\d+$/, "") };
}

/** Send trusted mouse events for an element's center point. */
async function trustedClick(extCall: ExtCall, element: Element, clickCount: number): Promise<void> {
  element.scrollIntoView({ block: "center", inline: "center" });
  await sleep(30);
  const point = viewportPointFor(element);
  if (!isPointInViewport(point)) throw new Error("Element center is outside the viewport.");
  await extCall("input", { kind: "click", x: point.x, y: point.y, clickCount });
}

/** Send trusted key events for a chord list. */
async function trustedKeys(extCall: ExtCall, chords: KeyChord[], delayMs: number): Promise<void> {
  if (!chords.length) return;
  await extCall("input", { kind: "keys", keys: chords.map(cdpKeyDescriptor), delayMs });
}

/** Flatten typed text (with `<kbd>` markup) into a single chord stream. */
function chordsForText(value: string): KeyChord[] {
  const chords: KeyChord[] = [];
  for (const segment of parseTypeSegments(value)) {
    if (segment.kind === "keys") chords.push(...parseKeySequence(segment.value));
    else chords.push(...charChords(segment.value));
  }
  return chords;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerInputTools(server: EmbeddedMcpServer, opts: InputToolOptions): void {
  const trusted = opts.trustedInput === true;

  server.registerTool(
    {
      name: "take_snapshot",
      description:
        "Compact text snapshot of the page's interactive/structural elements with stable uids. " +
        "Pass a uid to click / type_text / press_key instead of guessing CSS selectors. " +
        "Covers cross-origin iframes too: their uids carry the frame index (f2e7). " +
        "Action tools already return a shortened snapshot; call this for the full tree or after uids went stale " +
        "(navigation and DOM changes invalidate them).",
      inputSchema: {
        type: "object",
        properties: {
          maxNodes: { type: "number", description: "max elements per frame (default 400)" },
          includeHidden: { type: "boolean", description: "include elements that are not visible (default false)" },
          allFrames: { type: "boolean", description: "include iframes (default true); false snapshots only the top document" },
        },
      },
    },
    async (args) => {
      const maxNodes = numberArg(args.maxNodes, 400, 10, 2000);
      const includeHidden = args.includeHidden === true;
      if (args.allFrames !== false) {
        try {
          const result = (await opts.extCall("frameSnapshot", { maxNodes, includeHidden })) as { text?: string };
          if (result?.text) return text(result.text);
        } catch {
          // Frame injection can be blocked (restricted pages, no host access);
          // the top-document snapshot below still works.
        }
      }
      return text(renderPageSnapshot({ maxNodes, includeHidden }));
    },
  );

  server.registerTool(
    {
      name: "click",
      description:
        "Click an element. Target it with uid (from take_snapshot), selector, text, role+name, testId — or viewport x/y coordinates. " +
        "Waits until the element is visible, enabled, stable and not covered before clicking (force:true skips the checks).",
      inputSchema: {
        type: "object",
        properties: {
          ...LOCATOR_PROPERTIES,
          x: { type: "number", description: "viewport x coordinate (use with y instead of a locator)" },
          y: { type: "number", description: "viewport y coordinate" },
          clickCount: { type: "number", description: "1 (default) or 2 for a double click" },
          timeoutMs: { type: "number", description: "how long to wait for the element (default 5000)" },
          force: { type: "boolean", description: "skip the actionability checks" },
          strict: { type: "boolean", description: "fail when the locator matches more than one element" },
          observe: OBSERVE_PROPERTY,
        },
      },
    },
    async (args) => {
      const clickCount = numberArg(args.clickCount, 1, 1, 2);
      const observe = observeMode(args);
      const done = (payload: Record<string, unknown>) => withObservation(json(payload), observe, { extCall: opts.extCall });

      if (isFrameUid(args.uid)) {
        return done(await actInFrame(opts.extCall, "click", { uid: args.uid, clickCount, timeoutMs: args.timeoutMs }));
      }

      if (!hasLocatorArgs(args) && args.x !== undefined && args.y !== undefined) {
        const x = Number(args.x);
        const y = Number(args.y);
        if (trusted) {
          try {
            await opts.extCall("input", { kind: "click", x, y, clickCount });
            return done({ clicked: { at: { x, y } }, clickCount, via: "cdp" });
          } catch (error) {
            const target = clickPoint(x, y, clickCount);
            return done({ clicked: briefSummary(target), at: { x, y }, clickCount, via: "js", trustedError: errorMessage(error) });
          }
        }
        const target = clickPoint(x, y, clickCount);
        return done({ clicked: briefSummary(target), at: { x, y }, clickCount, via: "js" });
      }

      const element = await resolveTarget(args, { actionable: true, required: true });
      if (!element) throw new Error("No element resolved.");
      const actionability = await actionabilityFor(element);

      if (trusted) {
        try {
          await trustedClick(opts.extCall, element, clickCount);
          return done({ clicked: briefSummary(element), clickCount, via: "cdp", actionability });
        } catch (error) {
          clickElement(element);
          if (clickCount === 2) {
            clickElement(element);
            dispatchMouseLike(element, "dblclick", { detail: 2 });
          }
          return done({ clicked: briefSummary(element), clickCount, via: "js", trustedError: errorMessage(error), actionability });
        }
      }

      clickElement(element);
      if (clickCount === 2) {
        clickElement(element);
        dispatchMouseLike(element, "dblclick", { detail: 2 });
      }
      return done({ clicked: briefSummary(element), clickCount, via: "js", actionability });
    },
  );

  server.registerTool(
    {
      name: "type_text",
      description:
        "Type into an input, textarea, or contenteditable the way a user does: real keydown/beforeinput/input/keyup per character, " +
        "so search-as-you-type and controlled (React/Vue) inputs react. Embed key presses with <kbd>…</kbd>, e.g. \"hello <kbd>Enter</kbd>\". " +
        "Without a locator it types into the focused element. Clears the field first unless clear:false or append:true.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "text to type; may contain <kbd>Enter</kbd>-style key presses" },
          uid: LOCATOR_PROPERTIES.uid,
          selector: LOCATOR_PROPERTIES.selector,
          label: LOCATOR_PROPERTIES.label,
          role: LOCATOR_PROPERTIES.role,
          name: LOCATOR_PROPERTIES.name,
          testId: LOCATOR_PROPERTIES.testId,
          nth: LOCATOR_PROPERTIES.nth,
          clear: { type: "boolean", description: "clear the current value first (default true)" },
          append: { type: "boolean", description: "keep the current value and append (same as clear:false)" },
          submit: { type: "boolean", description: "press Enter after typing (submits the form / runs the search)" },
          delayMs: { type: "number", description: "per-character delay in ms (default 0)" },
          timeoutMs: { type: "number", description: "how long to wait for the element (default 5000)" },
          observe: OBSERVE_PROPERTY,
        },
        required: ["text"],
      },
    },
    async (args) => {
      const value = String(args.text ?? "");
      const clear = args.append === true ? false : args.clear !== false;
      const delayMs = numberArg(args.delayMs, 0, 0, 1000);
      const observe = observeMode(args);
      const done = (payload: Record<string, unknown>) => withObservation(json(payload), observe, { extCall: opts.extCall });

      if (isFrameUid(args.uid)) {
        return done(await actInFrame(opts.extCall, "type_text", { uid: args.uid, text: value, clear, submit: args.submit === true, delayMs, timeoutMs: args.timeoutMs }));
      }

      const element = (await resolveTarget(args)) ?? activeElement();

      if (trusted) {
        try {
          focusElement(element);
          let cleared = false;
          if (clear) {
            try {
              cleared = clearElementValue(element);
            } catch {
              cleared = false;
            }
          }
          const chords = chordsForText(value);
          if (args.submit === true) chords.push(...parseKeySequence("Enter"));
          await trustedKeys(opts.extCall, chords, delayMs);
          return done({ target: briefSummary(element), typed: value.length, cleared, submitted: args.submit === true, via: "cdp" });
        } catch (error) {
          const result = await typeText(element, value, { clear, submit: args.submit === true, delayMs });
          return done({
            target: briefSummary(element),
            typed: result.typed,
            cleared: result.cleared,
            submitted: result.submitted,
            via: "js",
            trustedError: errorMessage(error),
          });
        }
      }

      const result = await typeText(element, value, { clear, submit: args.submit === true, delayMs });
      return done({
        target: briefSummary(element),
        typed: result.typed,
        cleared: result.cleared,
        submitted: result.submitted,
        via: "js",
        keys: result.keys.length ? result.keys : undefined,
      });
    },
  );

  server.registerTool(
    {
      name: "press_key",
      description:
        "Press keys / shortcuts on an element (or the focused element). Space-separate a sequence: \"Meta+A Backspace\", \"Enter\", \"Shift+Tab\", \"Escape\". " +
        "Meta and Mod are platform-aware (Cmd on macOS, Ctrl elsewhere); Cmd and Ctrl are literal. " +
        "Enter submits a form from a single-line input, Backspace/Delete edit the value — like a real keypress.",
      inputSchema: {
        type: "object",
        properties: {
          keys: { type: "string", description: "key or chord sequence, e.g. Enter, Meta+A, Control+Shift+K, ArrowDown ArrowDown Enter" },
          uid: LOCATOR_PROPERTIES.uid,
          selector: LOCATOR_PROPERTIES.selector,
          label: LOCATOR_PROPERTIES.label,
          role: LOCATOR_PROPERTIES.role,
          name: LOCATOR_PROPERTIES.name,
          testId: LOCATOR_PROPERTIES.testId,
          nth: LOCATOR_PROPERTIES.nth,
          repeat: { type: "number", description: "repeat the whole sequence n times (default 1)" },
          delayMs: { type: "number", description: "delay between key presses in ms (default 0)" },
          timeoutMs: { type: "number", description: "how long to wait for the element (default 5000)" },
          observe: OBSERVE_PROPERTY,
        },
        required: ["keys"],
      },
    },
    async (args) => {
      const keys = String(args.keys ?? "");
      const repeat = numberArg(args.repeat, 1, 1, 50);
      const delayMs = numberArg(args.delayMs, 0, 0, 1000);
      const observe = observeMode(args);
      const done = (payload: Record<string, unknown>) => withObservation(json(payload), observe, { extCall: opts.extCall });

      if (isFrameUid(args.uid)) {
        return done(await actInFrame(opts.extCall, "press_key", { uid: args.uid, keys, repeat, delayMs, timeoutMs: args.timeoutMs }));
      }

      const element = await resolveTarget(args);

      // Without a locator the keys go to whatever has focus; don't touch the DOM
      // just to describe it.
      const target = element ? briefSummary(element) : "(focused element)";

      if (trusted) {
        try {
          if (element) focusElement(element);
          const chords: KeyChord[] = [];
          for (let round = 0; round < repeat; round += 1) chords.push(...parseKeySequence(keys));
          await trustedKeys(opts.extCall, chords, delayMs);
          return done({ target, pressed: chords.length, via: "cdp" });
        } catch (error) {
          const pressed = await pressKeys(element, keys, { repeat, delayMs });
          return done({ target, pressed, via: "js", trustedError: errorMessage(error) });
        }
      }

      const pressed = await pressKeys(element, keys, { repeat, delayMs });
      return done({ target, pressed, via: "js" });
    },
  );

  server.registerTool(
    {
      name: "clear_value",
      description: "Clear an input/textarea/contenteditable (fires the same events a user-driven clear does).",
      inputSchema: {
        type: "object",
        properties: {
          uid: LOCATOR_PROPERTIES.uid,
          selector: LOCATOR_PROPERTIES.selector,
          label: LOCATOR_PROPERTIES.label,
          testId: LOCATOR_PROPERTIES.testId,
          nth: LOCATOR_PROPERTIES.nth,
          timeoutMs: { type: "number", description: "how long to wait for the element (default 5000)" },
          observe: observeProperty("none"),
        },
      },
    },
    async (args) => {
      if (isFrameUid(args.uid)) {
        const result = await actInFrame(opts.extCall, "clear_value", { uid: args.uid, timeoutMs: args.timeoutMs });
        return withObservation(json(result), observeMode(args, "none"), { extCall: opts.extCall });
      }
      const element = (await resolveTarget(args)) ?? activeElement();
      const cleared = clearElementValue(element);
      return withObservation(json({ cleared, target: briefSummary(element) }), observeMode(args, "none"), { extCall: opts.extCall });
    },
  );
}
