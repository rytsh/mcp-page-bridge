/**
 * Shared page-context DOM primitives: element lookup (locators), the uid
 * snapshot registry, actionability checks, and the synthetic input engine
 * (mouse + keyboard).
 *
 * This module is imported by both the core built-ins (builtins.ts) and the
 * opt-in automation toolset (automation-tools.ts) so a single locator/input
 * implementation backs every tool. It touches the DOM only inside functions,
 * which keeps it importable from Node unit tests.
 */
import type { ToolResult } from "./embedded-server.js";
import { safeSerialize } from "./serialize.js";

export interface ElementSnapshot {
  selector: string;
  tag: string;
  id?: string;
  classes?: string[];
  text?: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; top: number; right: number; bottom: number; left: number; width: number; height: number };
  pickedAt?: string;
}

// ---- tool result helpers ------------------------------------------------------

/**
 * Hard ceiling for a single tool's text output (~10k tokens). Individual tools
 * have their own limits; this is the backstop that keeps one `eval` returning a
 * huge object, or a chatty CDP payload, from eating the agent's whole context.
 */
export const MAX_TOOL_TEXT = 40000;

export function clampToolText(value: string, max = MAX_TOOL_TEXT): string {
  if (value.length <= max) return value;
  const dropped = value.length - max;
  return `${value.slice(0, max)}\n…[truncated ${dropped} more characters — narrow the query (selector, limit, maxNodes, …) to see the rest]`;
}

export function text(value: string): ToolResult {
  return { content: [{ type: "text", text: clampToolText(value) }] };
}

export function json(value: unknown): ToolResult {
  return text(JSON.stringify(safeSerialize(value), null, 2));
}

// ---- tiny helpers -------------------------------------------------------------

export function el(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`No element matches selector: ${selector}`);
  return found;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function numberArg(value: unknown, fallback: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function textMatches(value: string, query: unknown, exact: unknown): boolean {
  const needle = normalizeText(String(query ?? ""));
  if (!needle) return false;
  const haystack = normalizeText(value);
  return exact === true ? haystack === needle : haystack.toLowerCase().includes(needle.toLowerCase());
}

export function escapeSelectorPart(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (css?.escape) return css.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

export function selectorLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function queryCount(selector: string): number {
  try {
    return document.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

export function selectorFor(element: Element): string {
  if (element.id) return `#${escapeSelectorPart(element.id)}`;

  const parts: string[] = [];
  for (let node: Element | null = element; node && node !== document.documentElement; node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    const classes = [...node.classList].filter(Boolean).slice(0, 3);
    let part = tag;
    if (classes.length) {
      const classSelector = `${tag}.${classes.map(escapeSelectorPart).join(".")}`;
      if (queryCount(classSelector) <= 5) part = classSelector;
    }

    const parent = node.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }

    parts.unshift(part);
    const candidate = parts.join(" > ");
    if (queryCount(candidate) === 1) return candidate;
  }

  return parts.join(" > ") || element.tagName.toLowerCase();
}

export function elementText(element: Element): string {
  return normalizeText(element.textContent ?? "");
}

export function snapshotElement(element: Element): ElementSnapshot {
  const rect = element.getBoundingClientRect();
  return {
    selector: selectorFor(element),
    tag: element.tagName.toLowerCase(),
    id: element.id || undefined,
    classes: [...element.classList].filter(Boolean),
    text: elementText(element).slice(0, 300) || undefined,
    attributes: Object.fromEntries([...element.attributes].slice(0, 30).map((a) => [a.name, a.value])),
    rect: { x: rect.x, y: rect.y, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height },
    pickedAt: new Date().toISOString(),
  };
}

function labelTextForInput(element: Element): string {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return "";
  return "labels" in element ? [...(element.labels ?? [])].map(elementText).join(" ").trim() : "";
}

export function accessibleName(element: Element): string {
  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;
  const labelledBy = element.getAttribute("aria-labelledby")?.trim();
  if (labelledBy) {
    const labelledText = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (labelledText) return labelledText;
  }
  if (element instanceof HTMLImageElement) return element.alt.trim();
  if (element instanceof HTMLInputElement) {
    const label = labelTextForInput(element);
    if (label) return label;
    if (["button", "submit", "reset"].includes(element.type)) return element.value.trim();
    return element.placeholder.trim();
  }
  return elementText(element);
}

export function isVisibleElement(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
}

export function isDisabledElement(element: Element): boolean {
  if (element.getAttribute("aria-disabled") === "true") return true;
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement || element instanceof HTMLOptionElement) {
    return element.disabled;
  }
  return false;
}

export function isEditableElement(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    return !element.readOnly && !element.disabled && !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

function implicitRole(element: Element): string | undefined {
  const tag = element.tagName.toLowerCase();
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return element.hasAttribute("multiple") ? "listbox" : "combobox";
  if (tag === "img") return "img";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "form") return "form";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "header") return "banner";
  if (tag === "footer") return "contentinfo";
  if (tag === "input") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (["button", "submit", "reset"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (["email", "password", "search", "tel", "text", "url"].includes(type)) return type === "search" ? "searchbox" : "textbox";
  }
  return undefined;
}

export function elementRole(element: Element): string | undefined {
  return element.getAttribute("role")?.trim() || implicitRole(element);
}

export function allElements(root: ParentNode = document): Element[] {
  const base = root instanceof Document ? root.documentElement : root;
  if (base instanceof Element) return [base, ...base.querySelectorAll("*")];
  return [...root.querySelectorAll("*")];
}

export function inputLabels(element: Element): string[] {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return [];
  const out: string[] = [];
  if ("labels" in element) out.push(...[...(element.labels ?? [])].map(elementText));
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) out.push(ariaLabel);
  const placeholder = "placeholder" in element ? String(element.placeholder ?? "") : "";
  if (placeholder) out.push(placeholder);
  return out.map(normalizeText).filter(Boolean);
}

// ---- uid snapshot (take_snapshot) --------------------------------------------
//
// The snapshot walks the visible DOM, assigns short uids to interactive and
// structural elements, and returns a compact indented text tree. The uids
// resolve through this registry, so follow-up actions (click, type_text,
// check, ...) can target `uid` directly instead of guessing CSS selectors —
// the same interaction model as chrome-devtools-mcp's take_snapshot.

interface SnapshotEntry {
  element: Element;
  children: SnapshotEntry[];
}

interface UidRegistry {
  refs: Map<string, WeakRef<Element>>;
  generation: number;
  seq: number;
  prefix: string;
}

/**
 * The uid registry is shared through a window global on purpose: the page tools
 * (inject.js) and the per-frame agent (frame-agent.js) are separate bundles
 * running in the same realm, and a uid handed out by one must resolve in the
 * other.
 */
function uidRegistry(): UidRegistry {
  const host = globalThis as unknown as { __mcpPageBridgeUids?: UidRegistry };
  return (host.__mcpPageBridgeUids ??= { refs: new Map(), generation: 0, seq: 0, prefix: "" });
}

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox",
  "slider", "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
]);

const STRUCTURAL_ROLES = new Set([
  "heading", "navigation", "main", "banner", "contentinfo", "form", "dialog", "alertdialog",
  "alert", "img", "table", "list", "listitem", "tablist", "tabpanel", "region", "article", "search",
]);

function isSnapshotInteractive(element: Element): boolean {
  const role = elementRole(element);
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (isEditableElement(element)) return true;
  if (element.hasAttribute("onclick")) return true;
  const tabindex = element.getAttribute("tabindex");
  return tabindex !== null && Number(tabindex) >= 0;
}

function isSnapshotStructural(element: Element): boolean {
  const role = elementRole(element);
  return !!role && STRUCTURAL_ROLES.has(role);
}

function snapshotStates(element: Element): string[] {
  const states: string[] = [];
  if (isDisabledElement(element)) states.push("disabled");
  if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
    states.push(element.checked ? "checked" : "unchecked");
  }
  const expanded = element.getAttribute("aria-expanded");
  if (expanded === "true") states.push("expanded");
  else if (expanded === "false") states.push("collapsed");
  if (element.getAttribute("aria-selected") === "true") states.push("selected");
  if (element instanceof HTMLOptionElement && element.selected) states.push("selected");
  return states;
}

function snapshotLine(uid: string, element: Element): string {
  const role = elementRole(element) ?? element.tagName.toLowerCase();
  let line = `uid=${uid} ${role}`;
  if (role === "heading") {
    const level = element.getAttribute("aria-level") ?? element.tagName.match(/^H([1-6])$/i)?.[1];
    if (level) line += ` level=${level}`;
  }
  const name = normalizeText(accessibleName(element)).slice(0, 80);
  if (name) line += ` ${JSON.stringify(name)}`;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    const value = String(element.value ?? "");
    if (value && !(element instanceof HTMLInputElement && element.type === "password")) {
      line += ` value=${JSON.stringify(value.slice(0, 40))}`;
    }
  }
  if (element instanceof HTMLAnchorElement && element.getAttribute("href")) {
    line += ` href=${JSON.stringify(String(element.getAttribute("href")).slice(0, 80))}`;
  }
  const states = snapshotStates(element);
  if (states.length) line += ` [${states.join(", ")}]`;
  return line;
}

/** Collect interesting elements, lifting children of boring wrappers. */
function buildSnapshotEntries(element: Element, includeHidden: boolean): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  for (const child of element.children) {
    if (!includeHidden && !isVisibleElement(child)) continue;
    const sub = buildSnapshotEntries(child, includeHidden);
    if (isSnapshotInteractive(child) || isSnapshotStructural(child)) {
      entries.push({ element: child, children: sub });
    } else {
      entries.push(...sub);
    }
  }
  return entries;
}

function renderSnapshotEntries(
  entries: SnapshotEntry[],
  depth: number,
  lines: string[],
  budget: { left: number; truncated: boolean; maxDepth: number; depthClipped: boolean },
): void {
  const registry = uidRegistry();
  for (const entry of entries) {
    if (budget.left <= 0) {
      budget.truncated = true;
      return;
    }
    budget.left -= 1;
    const uid = `${registry.prefix}e${++registry.seq}`;
    registry.refs.set(uid, new WeakRef(entry.element));
    lines.push(`${"  ".repeat(depth)}${snapshotLine(uid, entry.element)}`);
    if (depth + 1 >= budget.maxDepth) {
      if (entry.children.length) budget.depthClipped = true;
      continue;
    }
    renderSnapshotEntries(entry.children, depth + 1, lines, budget);
  }
}

export interface SnapshotLines {
  lines: string[];
  truncated: boolean;
  depthClipped: boolean;
  url: string;
  title: string;
  /** Description of the subtree root, when the snapshot was scoped. */
  root?: string;
}

export interface SnapshotOptions {
  maxNodes?: number;
  includeHidden?: boolean;
  uidPrefix?: string;
  /** Cap the rendered tree depth (default 15, like read_page). */
  maxDepth?: number;
  /**
   * Scope the snapshot to a subtree. Resolve this *before* calling, because
   * rendering clears the uid registry that a `rootUid` would resolve through.
   */
  root?: Element;
}

/**
 * Render this document's snapshot lines, invalidating previous uids.
 * `uidPrefix` namespaces uids per frame (`f2e7`) when the service worker
 * stitches several frames into one tree.
 */
export function renderSnapshotLines(opts: SnapshotOptions = {}): SnapshotLines {
  const maxNodes = numberArg(opts.maxNodes, 400, 10, 2000);
  const maxDepth = numberArg(opts.maxDepth, 15, 1, 40);
  const root = opts.root ?? document.body;
  const rootLabel = opts.root ? `${selectorFor(opts.root)} (${elementRole(opts.root) ?? opts.root.tagName.toLowerCase()})` : undefined;
  const registry = uidRegistry();
  registry.generation += 1;
  registry.seq = 0;
  registry.prefix = opts.uidPrefix ?? "";
  registry.refs.clear();
  const budget = { left: maxNodes, truncated: false, maxDepth, depthClipped: false };
  const entries = root ? buildSnapshotEntries(root, opts.includeHidden === true) : [];
  const lines: string[] = [];
  renderSnapshotEntries(entries, 0, lines, budget);
  return {
    lines,
    truncated: budget.truncated,
    depthClipped: budget.depthClipped,
    url: location.href,
    title: document.title,
    root: rootLabel,
  };
}

/** Render a fresh uid snapshot of this document, invalidating previous uids. */
export function renderPageSnapshot(opts: SnapshotOptions = {}): string {
  const maxNodes = numberArg(opts.maxNodes, 400, 10, 2000);
  const snapshot = renderSnapshotLines(opts);
  const scope = snapshot.root ? ` — scoped to ${snapshot.root}` : "";
  const header = `Page snapshot — ${snapshot.title ? `"${normalizeText(snapshot.title)}" — ` : ""}${snapshot.url}${scope}`;
  const notes: string[] = [];
  if (snapshot.truncated) notes.push(`truncated at ${maxNodes} nodes — pass a larger maxNodes to see more`);
  if (snapshot.depthClipped) notes.push("depth-clipped — pass a larger maxDepth, or scope with rootUid, to go deeper");
  const footer = notes.length ? `\n[${notes.join("; ")}]` : "";
  return `${header}\n${snapshot.lines.join("\n") || "(no interactive or structural elements found)"}${footer}`;
}

/**
 * Add one element to the uid registry without invalidating the current
 * snapshot. `find` uses this so its results are immediately actionable while
 * uids handed out by the last `take_snapshot` stay valid.
 */
export function registerUid(element: Element): string {
  const registry = uidRegistry();
  for (const [uid, ref] of registry.refs) {
    if (ref.deref() === element) return uid;
  }
  const uid = `${registry.prefix}e${++registry.seq}`;
  registry.refs.set(uid, new WeakRef(element));
  return uid;
}

export function resolveUid(uid: string): Element {
  const registry = uidRegistry();
  const element = registry.refs.get(uid)?.deref();
  if (!element) {
    throw new Error(`Unknown or stale uid "${uid}" (current snapshot generation is ${registry.generation}); call take_snapshot for fresh uids.`);
  }
  if (!element.isConnected) {
    throw new Error(`Element for uid "${uid}" is no longer attached to the DOM; call take_snapshot again.`);
  }
  return element;
}

export function clearSnapshotRefs(): void {
  uidRegistry().refs.clear();
}

// ---- uid overlay (screenshot annotation) --------------------------------------
//
// A screenshot alone doesn't tell an agent which uid to act on. `screenshot`
// with `refs:true` paints each live uid onto the page, captures, and removes the
// markers again — the visual counterpart of the text snapshot.

const OVERLAY_ID = "__mcp-page-bridge-uid-overlay";
const OVERLAY_MAX_MARKERS = 250;

export function hideUidOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}

/** Paint the current snapshot's uids over their elements. Returns marker count. */
export function showUidOverlay(): number {
  hideUidOverlay();
  const registry = uidRegistry();
  if (!registry.refs.size || !document.body) return 0;

  const container = document.createElement("div");
  container.id = OVERLAY_ID;
  container.setAttribute("style", "position:fixed;inset:0;z-index:2147483646;pointer-events:none;");

  let painted = 0;
  for (const [uid, ref] of registry.refs) {
    if (painted >= OVERLAY_MAX_MARKERS) break;
    const element = ref.deref();
    if (!element?.isConnected) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;

    const box = document.createElement("div");
    box.setAttribute(
      "style",
      `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
        "outline:1px solid rgba(220,38,38,.9);background:rgba(220,38,38,.06);box-sizing:border-box;",
    );
    const label = document.createElement("span");
    label.textContent = uid;
    label.setAttribute(
      "style",
      "position:absolute;left:0;top:0;transform:translateY(-100%);background:#dc2626;color:#fff;" +
        "font:700 10px/1.2 ui-monospace,monospace;padding:1px 3px;border-radius:2px 2px 0 0;white-space:nowrap;",
    );
    box.appendChild(label);
    container.appendChild(box);
    painted += 1;
  }

  document.body.appendChild(container);
  return painted;
}

/** True for uids that belong to a sub-frame (`f2e7`) rather than this document. */
export function isFrameUid(uid: unknown): boolean {
  return typeof uid === "string" && /^f\d+e\d+$/.test(uid);
}

// ---- locators -----------------------------------------------------------------

export function locatorMatches(args: Record<string, unknown>, rootArg?: ParentNode, applyNth = true): Element[] {
  const selector = stringArg(args.selector);
  const exact = args.exact === true;
  let matches: Element[];

  if (args.uid !== undefined) {
    // Resolved through the snapshot registry; deliberately before any
    // `document` access so stale-uid errors stay cheap and precise.
    matches = [resolveUid(String(args.uid))];
    if (args.visible === true) matches = matches.filter(isVisibleElement);
    return matches;
  }

  const root = rootArg ?? document;
  if (selector) {
    matches = [...root.querySelectorAll(selector)];
  } else if (args.testId !== undefined) {
    const id = String(args.testId ?? "");
    matches = [...root.querySelectorAll(`[data-testid=${selectorLiteral(id)}], [data-test=${selectorLiteral(id)}], [data-cy=${selectorLiteral(id)}]`)];
  } else if (args.role !== undefined) {
    const role = String(args.role ?? "").toLowerCase();
    matches = allElements(root).filter((element) => elementRole(element)?.toLowerCase() === role);
  } else if (args.label !== undefined) {
    matches = allElements(root).filter((element) => inputLabels(element).some((label) => textMatches(label, args.label, exact)));
  } else if (args.placeholder !== undefined) {
    matches = allElements(root).filter((element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement).filter((element) => textMatches((element as HTMLInputElement | HTMLTextAreaElement).placeholder, args.placeholder, exact));
  } else if (args.text !== undefined) {
    const visibleMatches = allElements(root).filter((element) => isVisibleElement(element) && textMatches(elementText(element), args.text, exact));
    matches = visibleMatches.filter((element) => ![...element.children].some((child) => textMatches(elementText(child), args.text, exact)));
    if (!matches.length) matches = visibleMatches;
  } else {
    throw new Error("Provide uid (from take_snapshot), selector, text, role, label, testId, or placeholder.");
  }

  if (args.name !== undefined) matches = matches.filter((element) => textMatches(accessibleName(element), args.name, exact));
  if (args.visible === true) matches = matches.filter(isVisibleElement);

  if (applyNth && args.nth !== undefined) {
    const index = Number(args.nth);
    if (!Number.isInteger(index)) throw new Error("nth must be an integer.");
    matches = matches[index] ? [matches[index]!] : [];
  }

  return matches;
}

/** True when the args carry at least one locator field. */
export function hasLocatorArgs(args: Record<string, unknown>): boolean {
  return (
    args.uid !== undefined ||
    args.selector !== undefined ||
    args.text !== undefined ||
    args.role !== undefined ||
    args.name !== undefined ||
    args.label !== undefined ||
    args.testId !== undefined ||
    args.placeholder !== undefined
  );
}

// ---- natural-language element search (find) -----------------------------------
//
// `take_snapshot` is the complete but expensive view of a page. `find` is the
// cheap one: describe the control ("add to cart button", "email field") and get
// back a handful of ranked, uid-tagged candidates. Everything is local scoring —
// no model call, no network — so it stays a single fast round trip.

/** Words in a query that name a role, mapped to the roles they accept. */
const ROLE_HINTS: Record<string, string[]> = {
  button: ["button"],
  btn: ["button"],
  link: ["link"],
  anchor: ["link"],
  field: ["textbox", "searchbox", "spinbutton", "combobox"],
  input: ["textbox", "searchbox", "spinbutton"],
  textbox: ["textbox"],
  textarea: ["textbox"],
  box: ["textbox", "searchbox", "checkbox", "combobox"],
  search: ["searchbox", "textbox"],
  checkbox: ["checkbox"],
  check: ["checkbox"],
  radio: ["radio"],
  toggle: ["switch", "checkbox"],
  switch: ["switch", "checkbox"],
  dropdown: ["combobox", "listbox"],
  select: ["combobox", "listbox"],
  combobox: ["combobox"],
  option: ["option"],
  tab: ["tab"],
  menu: ["menuitem", "menuitemcheckbox", "menuitemradio"],
  menuitem: ["menuitem"],
  heading: ["heading"],
  title: ["heading"],
  header: ["heading", "banner"],
  image: ["img"],
  img: ["img"],
  icon: ["img", "button"],
  slider: ["slider"],
  list: ["list", "listbox"],
  row: ["listitem"],
  dialog: ["dialog", "alertdialog"],
  modal: ["dialog", "alertdialog"],
  form: ["form"],
};

/** Words that only describe intent, not the element; dropped before matching. */
const FILLER_WORDS = new Set(["the", "a", "an", "for", "with", "of", "to", "on", "in", "that", "says", "labeled", "labelled", "named", "called", "first", "any"]);

function queryTokens(query: string): { words: string[]; roles: Set<string> } {
  const roles = new Set<string>();
  const words: string[] = [];
  for (const raw of normalizeText(query).toLowerCase().split(/[\s,.\-_/]+/)) {
    const token = raw.trim();
    if (!token) continue;
    const hinted = ROLE_HINTS[token];
    if (hinted) {
      for (const role of hinted) roles.add(role);
      // A role word can also be part of the visible name ("Search"), so keep it
      // as a weak word too rather than dropping it outright.
      words.push(token);
      continue;
    }
    if (FILLER_WORDS.has(token)) continue;
    words.push(token);
  }
  return { words, roles };
}

/** Every string that could reasonably be "the name" of an element. */
function searchableText(element: Element): { name: string; extra: string[] } {
  const name = normalizeText(accessibleName(element)).toLowerCase();
  const extra: string[] = [];
  for (const attr of ["placeholder", "title", "name", "value", "alt", "aria-description", "data-testid", "data-test", "data-cy"]) {
    const value = element.getAttribute(attr);
    if (value) extra.push(normalizeText(value).toLowerCase());
  }
  if (element instanceof HTMLAnchorElement && element.getAttribute("href")) extra.push(String(element.getAttribute("href")).toLowerCase());
  return { name, extra };
}

function nameScore(haystack: string, words: string[]): number {
  if (!haystack || !words.length) return 0;
  const phrase = words.join(" ");
  if (haystack === phrase) return 100;
  if (haystack.startsWith(phrase)) return 78;
  if (haystack.includes(phrase)) return 66;
  const hit = words.filter((word) => haystack.includes(word)).length;
  if (!hit) return 0;
  // All words present but scattered still beats a single-word coincidence.
  return Math.round((hit / words.length) * 52) + (hit === words.length ? 8 : 0);
}

export interface FindMatch {
  uid: string;
  element: Element;
  score: number;
  line: string;
}

/**
 * Rank elements against a natural-language description.
 * Returns uid-tagged snapshot lines, so a match can be clicked straight away.
 */
export function findElements(query: string, opts: { limit?: number; includeHidden?: boolean; root?: ParentNode } = {}): FindMatch[] {
  const { words, roles } = queryTokens(String(query ?? ""));
  if (!words.length && !roles.size) throw new Error("find needs a description, e.g. \"add to cart button\" or \"email field\".");
  const limit = numberArg(opts.limit, 20, 1, 50);
  const includeHidden = opts.includeHidden === true;

  const scored: { element: Element; score: number }[] = [];
  for (const element of allElements(opts.root ?? document)) {
    if (element.tagName === "SCRIPT" || element.tagName === "STYLE" || element.tagName === "HEAD") continue;
    const interactive = isSnapshotInteractive(element);
    const structural = isSnapshotStructural(element);
    if (!interactive && !structural) continue;
    const visible = isVisibleElement(element);
    if (!visible && !includeHidden) continue;

    const role = elementRole(element)?.toLowerCase();
    // A role word in the query is a hard filter when it matches nothing else:
    // "email field" should not return the "Email" heading.
    const roleMatch = !roles.size || (role !== undefined && roles.has(role));
    const { name, extra } = searchableText(element);

    let score = nameScore(name, words);
    if (!score) {
      for (const value of extra) score = Math.max(score, Math.round(nameScore(value, words) * 0.8));
    }
    if (!score && roles.size && roleMatch) score = 12; // role-only query ("all buttons")
    if (!score) continue;

    if (roles.size) score += roleMatch ? 34 : -30;
    if (interactive) score += 8;
    const rect = element.getBoundingClientRect();
    if (rect.top >= 0 && rect.top < innerHeight) score += 6;
    // Prefer the smallest element carrying the name (the button, not its wrapper).
    if (rect.width * rect.height > innerWidth * innerHeight * 0.5) score -= 12;
    if (score > 0) scored.push({ element, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Equal scores: keep document order so results read top-to-bottom.
    return a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  // Drop ancestors whose only claim is a descendant's text.
  const kept: { element: Element; score: number }[] = [];
  for (const candidate of scored) {
    if (kept.some((other) => other.element !== candidate.element && candidate.element.contains(other.element) && other.score >= candidate.score)) continue;
    kept.push(candidate);
    if (kept.length >= limit) break;
  }

  return kept.map(({ element, score }) => {
    const uid = registerUid(element);
    return { uid, element, score, line: snapshotLine(uid, element) };
  });
}

// ---- readable page text -------------------------------------------------------

const TEXT_SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED", "VIDEO", "AUDIO", "HEAD"]);
const TEXT_BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "NAV", "UL", "OL", "LI", "DL", "DT", "DD",
  "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "BLOCKQUOTE", "PRE", "FIGURE", "FIGCAPTION", "FORM", "FIELDSET", "HR", "BR",
  "H1", "H2", "H3", "H4", "H5", "H6",
]);

/** Best guess at the element holding the actual article/content. */
function mainContentRoot(): Element {
  for (const selector of ["main", "[role=main]", "article", "#main", "#content", ".main-content"]) {
    const candidate = document.querySelector(selector);
    if (candidate && isVisibleElement(candidate) && normalizeText(candidate.textContent ?? "").length > 200) return candidate;
  }
  return document.body ?? document.documentElement;
}

/**
 * Extract the page's *rendered* text, the way a reader sees it.
 *
 * `get_html` is the raw-source alternative and costs several times the tokens
 * for the same information; this walks visible text nodes only, keeps block
 * structure as line breaks, and marks headings so the agent keeps the outline.
 */
export function extractPageText(opts: { root?: Element; includeHidden?: boolean; max?: number } = {}): { text: string; root: string; truncated: boolean } {
  const root = opts.root ?? mainContentRoot();
  const includeHidden = opts.includeHidden === true;
  const max = numberArg(opts.max, 20000, 200, MAX_TOOL_TEXT);
  const out: string[] = [];
  let line = "";

  const flush = (): void => {
    const value = normalizeText(line);
    if (value) out.push(value);
    line = "";
  };

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? "";
      if (value.trim()) line += `${line && !line.endsWith(" ") ? " " : ""}${value.replace(/\s+/g, " ")}`;
      return;
    }
    if (!(node instanceof Element)) return;
    if (TEXT_SKIP_TAGS.has(node.tagName)) return;
    if (node.getAttribute("aria-hidden") === "true") return;
    if (!includeHidden && !isVisibleElement(node)) return;

    const block = TEXT_BLOCK_TAGS.has(node.tagName);
    const heading = /^H[1-6]$/.test(node.tagName);
    if (block) flush();
    if (heading) line += `${"#".repeat(Number(node.tagName[1]))} `;
    for (const child of node.childNodes) {
      walk(child);
      if (out.join("\n").length > max) return;
    }
    if (block) flush();
    if (node.tagName === "LI") flush();
  };

  walk(root);
  flush();

  const joined = out.join("\n");
  const truncated = joined.length > max;
  return {
    text: truncated ? `${joined.slice(0, max)}\n…[truncated — raise max or pass a selector to scope the extraction]` : joined,
    root: opts.root ? selectorFor(root) : root === document.body ? "body" : selectorFor(root),
    truncated,
  };
}

export function locatorSummary(element: Element, opts: { includeHtml?: boolean } = {}): Record<string, unknown> {
  return {
    ...snapshotElement(element),
    role: elementRole(element),
    accessibleName: accessibleName(element) || undefined,
    visible: isVisibleElement(element),
    enabled: !isDisabledElement(element),
    editable: isEditableElement(element),
    html: opts.includeHtml ? element.outerHTML.slice(0, 1200) : undefined,
  };
}

/**
 * A short, token-cheap description of an element for action results
 * (locatorSummary is the verbose variant used by the inspection tools).
 */
export function briefSummary(element: Element): Record<string, unknown> {
  const name = normalizeText(accessibleName(element)).slice(0, 80);
  const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
    ? String(element.value ?? "")
    : undefined;
  return {
    selector: selectorFor(element),
    tag: element.tagName.toLowerCase(),
    role: elementRole(element),
    name: name || undefined,
    value: value && !(element instanceof HTMLInputElement && element.type === "password") ? value.slice(0, 200) : undefined,
  };
}

export function centerPoint(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function coveringElement(element: Element): Element | undefined {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  const point = centerPoint(element);
  if (point.x < 0 || point.y < 0 || point.x > innerWidth || point.y > innerHeight) return undefined;
  const top = document.elementFromPoint(point.x, point.y);
  if (!top || top === element || element.contains(top)) return undefined;
  return top;
}

export async function actionabilityFor(element: Element): Promise<Record<string, unknown>> {
  const before = element.getBoundingClientRect();
  await sleep(50);
  const after = element.getBoundingClientRect();
  const coveredBy = coveringElement(element);
  return {
    visible: isVisibleElement(element),
    enabled: !isDisabledElement(element),
    stable: Math.abs(before.x - after.x) < 0.5 && Math.abs(before.y - after.y) < 0.5 && Math.abs(before.width - after.width) < 0.5 && Math.abs(before.height - after.height) < 0.5,
    receivesPointerEvents: !coveredBy,
    coveredBy: coveredBy ? locatorSummary(coveredBy) : undefined,
    rect: snapshotElement(element).rect,
  };
}

export async function waitForLocator(args: Record<string, unknown>, opts: { timeoutMs?: number; actionable?: boolean; strict?: boolean } = {}): Promise<Element> {
  const timeoutMs = numberArg(opts.timeoutMs ?? args.timeoutMs, 5000, 0, 60000);
  const strict = opts.strict ?? args.strict === true;
  const start = Date.now();
  let lastCount = 0;
  for (;;) {
    const matches = locatorMatches(args);
    lastCount = matches.length;
    if (strict && matches.length > 1) throw new Error(`Locator matched ${matches.length} elements; pass nth or make it stricter.`);
    const element = matches[0];
    if (element) {
      if (!opts.actionable) return element;
      element.scrollIntoView({ block: "center", inline: "center" });
      await sleep(80);
      const state = await actionabilityFor(element);
      if (state.visible && state.enabled && state.stable && state.receivesPointerEvents) return element;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs}ms waiting for locator (${lastCount} match(es)).`);
    await sleep(100);
  }
}

// ---- mouse input --------------------------------------------------------------
//
// One engine backs every pointer interaction (click, right/middle click, hover,
// drag, wheel). It carries the three things a real pointer event has and the
// old implementation hardcoded away: a **button**, **modifier keys**, and a
// **viewport point**. Without those, context menus, ctrl/shift-click selection,
// and pointer-sensor drag-and-drop (dnd-kit, sliders, canvas) are unreachable.

export type MouseButtonName = "left" | "middle" | "right";

/** `MouseEvent.button` value per name. */
const MOUSE_BUTTON_IDS: Record<MouseButtonName, number> = { left: 0, middle: 1, right: 2 };
/** `MouseEvent.buttons` bitmask per name (differs from `button`!). */
const MOUSE_BUTTON_MASKS: Record<MouseButtonName, number> = { left: 1, middle: 4, right: 2 };

export function parseMouseButton(value: unknown, fallback: MouseButtonName = "left"): MouseButtonName {
  const name = String(value ?? "").trim().toLowerCase();
  if (name === "left" || name === "middle" || name === "right") return name;
  if (!name) return fallback;
  throw new Error(`Unknown mouse button "${value}"; use left, middle, or right.`);
}

export interface ModifierState {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export const NO_MODIFIERS: ModifierState = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

export function hasModifiers(state: ModifierState): boolean {
  return state.altKey || state.ctrlKey || state.metaKey || state.shiftKey;
}

/**
 * Parse a modifier chord like `"ctrl+shift"` or `"Mod"` into event flags.
 * Shares MODIFIER_ALIASES with the keyboard engine, so `Mod`/`Meta` stay
 * platform-aware (Cmd on macOS, Ctrl elsewhere) exactly like in `press_key`.
 */
export function parseModifiers(value: unknown, opts: { mac?: boolean } = {}): ModifierState {
  const raw = typeof value === "string" ? value.trim() : Array.isArray(value) ? value.join("+") : "";
  const state: ModifierState = { ...NO_MODIFIERS };
  if (!raw) return state;
  const mac = opts.mac ?? isMacPlatform();
  for (const part of raw.split("+")) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const modifier = MODIFIER_ALIASES[token];
    if (!modifier) throw new Error(`Unknown modifier "${part}" in "${raw}"; use alt, ctrl, meta/mod, cmd, or shift.`);
    if (modifier === "alt") state.altKey = true;
    else if (modifier === "ctrl") state.ctrlKey = true;
    else if (modifier === "shift") state.shiftKey = true;
    else if (modifier === "meta") state.metaKey = true;
    else if (mac) state.metaKey = true;
    else state.ctrlKey = true;
  }
  return state;
}

/** CDP `Input.dispatchMouseEvent` modifier bitmask (same encoding as keys). */
export function cdpModifierMask(state: ModifierState): number {
  return (state.altKey ? 1 : 0) | (state.ctrlKey ? 2 : 0) | (state.metaKey ? 4 : 0) | (state.shiftKey ? 8 : 0);
}

export function focusElement(element: Element): void {
  if (element instanceof HTMLElement || element instanceof SVGElement) element.focus();
}

export interface PointerOptions {
  /** Viewport point the event claims to happen at (defaults to the element center). */
  point?: { x: number; y: number };
  button?: MouseButtonName;
  /** Buttons currently held down, as a `MouseEvent.buttons` mask. */
  buttons?: number;
  modifiers?: ModifierState;
  detail?: number;
}

function mouseInit(point: { x: number; y: number }, opts: PointerOptions): MouseEventInit {
  const button = opts.button ?? "left";
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
    button: MOUSE_BUTTON_IDS[button],
    buttons: opts.buttons ?? 0,
    detail: opts.detail ?? 0,
    ...(opts.modifiers ?? NO_MODIFIERS),
  };
}

/** Dispatch one mouse-family event on an element. */
export function dispatchMouseLike(element: Element, type: string, init: MouseEventInit = {}): boolean {
  const point = centerPoint(element);
  const base = mouseInit(point, {
    buttons: type === "mouseup" || type === "click" || type === "dblclick" || type === "mouseover" || type === "mousemove" ? 0 : 1,
  });
  return element.dispatchEvent(new MouseEvent(type, { ...base, ...init }));
}

/** Dispatch one pointer-family event on an element (falls back to mouse events). */
export function dispatchPointerLike(element: Element, type: string, opts: PointerOptions = {}): boolean {
  const point = opts.point ?? centerPoint(element);
  const init: PointerEventInit = {
    ...mouseInit(point, { ...opts, buttons: opts.buttons ?? (type === "pointerup" || type === "pointerover" || type === "pointermove" ? 0 : 1) }),
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    width: 1,
    height: 1,
    pressure: type === "pointerdown" ? 0.5 : 0,
  };
  if (typeof PointerEvent === "function") return element.dispatchEvent(new PointerEvent(type, init));
  return element.dispatchEvent(new MouseEvent(type.replace(/^pointer/, "mouse"), init));
}

export interface ClickOptions {
  /** 1 = single, 2 = double, 3 = triple (selects a line/paragraph in text). */
  clickCount?: number;
  button?: MouseButtonName;
  modifiers?: ModifierState;
  /** Override the viewport point events claim to originate from. */
  point?: { x: number; y: number };
}

/**
 * Dispatch the full pointer/mouse sequence for a click on `target`.
 *
 * Shared by the element path (`clickElement`) and the coordinate path
 * (`clickPoint`), so both honour button and modifiers identically.
 *   - right button also emits `contextmenu` (the event a page listens to for a
 *     custom context menu),
 *   - middle button also emits `auxclick`,
 *   - clickCount 2/3 emits `dblclick` after the second press.
 */
function dispatchClickSequence(target: Element, point: { x: number; y: number }, opts: ClickOptions): void {
  const button = opts.button ?? "left";
  const modifiers = opts.modifiers ?? NO_MODIFIERS;
  const mask = MOUSE_BUTTON_MASKS[button];
  const clickCount = Math.max(1, Math.min(3, Math.floor(opts.clickCount ?? 1)));
  const base: PointerOptions = { point, button, modifiers };
  /** Dispatch one mouse-family event with this sequence's button/modifiers. */
  const fire = (type: string, detail: number, buttons: number): void => {
    target.dispatchEvent(new MouseEvent(type, mouseInit(point, { ...base, detail, buttons })));
  };

  dispatchPointerLike(target, "pointerover", { ...base, buttons: 0 });
  fire("mouseover", 0, 0);
  dispatchPointerLike(target, "pointermove", { ...base, buttons: 0 });
  fire("mousemove", 0, 0);

  for (let i = 1; i <= clickCount; i += 1) {
    dispatchPointerLike(target, "pointerdown", { ...base, detail: i, buttons: mask });
    fire("mousedown", i, mask);
    dispatchPointerLike(target, "pointerup", { ...base, detail: i, buttons: 0 });
    fire("mouseup", i, 0);
    if (button === "left") fire("click", i, 0);
    else if (button === "middle") fire("auxclick", i, 0);
    if (i === 2) fire("dblclick", 2, 0);
  }

  if (button === "right") {
    fire("auxclick", clickCount, 0);
    fire("contextmenu", clickCount, 0);
  }
}

/**
 * Click an element. A plain left single click still ends with the native
 * `element.click()` so default activation behaviour (links, labels, form
 * submits) runs; any other button/modifier/count goes through the synthetic
 * sequence only, because `element.click()` cannot express them.
 */
export function clickElement(element: Element, opts: ClickOptions | number = {}): void {
  const options: ClickOptions = typeof opts === "number" ? { clickCount: opts } : opts;
  const point = options.point ?? centerPoint(element);
  const button = options.button ?? "left";
  const clickCount = Math.max(1, Math.min(3, Math.floor(options.clickCount ?? 1)));
  const modifiers = options.modifiers ?? NO_MODIFIERS;
  const plain = button === "left" && clickCount === 1 && !hasModifiers(modifiers);

  focusElement(element);
  if (plain) {
    dispatchClickSequenceNativeTail(element, point);
    return;
  }
  dispatchClickSequence(element, point, { clickCount, button, modifiers, point });
}

/** Left single click that finishes with the element's native activation. */
function dispatchClickSequenceNativeTail(element: Element, point: { x: number; y: number }): void {
  const base: PointerOptions = { point, button: "left", modifiers: NO_MODIFIERS };
  dispatchPointerLike(element, "pointerover", { ...base, buttons: 0 });
  element.dispatchEvent(new MouseEvent("mouseover", mouseInit(point, { ...base, buttons: 0 })));
  dispatchPointerLike(element, "pointermove", { ...base, buttons: 0 });
  element.dispatchEvent(new MouseEvent("mousemove", mouseInit(point, { ...base, buttons: 0 })));
  dispatchPointerLike(element, "pointerdown", { ...base, detail: 1, buttons: 1 });
  element.dispatchEvent(new MouseEvent("mousedown", mouseInit(point, { ...base, detail: 1, buttons: 1 })));
  dispatchPointerLike(element, "pointerup", { ...base, detail: 1, buttons: 0 });
  element.dispatchEvent(new MouseEvent("mouseup", mouseInit(point, { ...base, detail: 1, buttons: 0 })));
  if (element instanceof HTMLElement) element.click();
  else element.dispatchEvent(new MouseEvent("click", mouseInit(point, { ...base, detail: 1, buttons: 0 })));
}

/**
 * Resolve what sits at a viewport point, descending into same-origin iframes so
 * a coordinate that lands inside an embedded document hits the real element
 * rather than the `<iframe>` box.
 */
export function elementAtPoint(x: number, y: number): { element: Element; localX: number; localY: number; framePath: string[] } {
  let element = document.elementFromPoint(x, y);
  if (!element) throw new Error(`No element at viewport point (${x}, ${y}).`);
  let localX = x;
  let localY = y;
  const framePath: string[] = [];

  for (let depth = 0; depth < 5 && element instanceof HTMLIFrameElement; depth += 1) {
    let inner: Document | null = null;
    try {
      inner = element.contentDocument;
    } catch {
      inner = null;
    }
    if (!inner) break; // cross-origin: the iframe box is the best we can do
    const rect = element.getBoundingClientRect();
    localX -= rect.left;
    localY -= rect.top;
    const next = inner.elementFromPoint(localX, localY);
    framePath.push(selectorFor(element));
    if (!next) break;
    element = next;
  }

  return { element, localX, localY, framePath };
}

/** Click whatever sits at viewport coordinates (no locator involved). */
export function clickPoint(x: number, y: number, opts: ClickOptions | number = {}): Element {
  const options: ClickOptions = typeof opts === "number" ? { clickCount: opts } : opts;
  const { element, localX, localY } = elementAtPoint(x, y);
  focusElement(element);
  dispatchClickSequence(element, { x: localX, y: localY }, { ...options, point: { x: localX, y: localY } });
  return element;
}

// ---- wheel / scrolling --------------------------------------------------------

/** Nearest ancestor that can actually scroll in the requested direction. */
function scrollableAncestor(element: Element | null, deltaX: number, deltaY: number): Element | undefined {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const canY = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
    const canX = /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
    if ((deltaY !== 0 && canY) || (deltaX !== 0 && canX)) return node;
  }
  return undefined;
}

export interface WheelResult {
  target: Record<string, unknown>;
  scrolled: { element: string; left: number; top: number } | { window: true; x: number; y: number };
  defaultPrevented: boolean;
}

/**
 * Dispatch a `wheel` event at a viewport point and apply the scroll ourselves.
 *
 * Synthetic wheel events never scroll anything (only trusted ones do), so after
 * dispatching we move the nearest scrollable ancestor — unless the page called
 * `preventDefault()`, which is exactly what wheel-driven UIs (maps, zoomable
 * canvases, virtualized lists) do. That makes this behave like a real wheel for
 * both kinds of page.
 */
export function wheelAt(x: number, y: number, deltaX: number, deltaY: number, modifiers: ModifierState = NO_MODIFIERS): WheelResult {
  const { element, localX, localY } = elementAtPoint(x, y);
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: localX,
    clientY: localY,
    deltaX,
    deltaY,
    deltaMode: 0,
    ...modifiers,
  });
  const notPrevented = element.dispatchEvent(event);

  if (!notPrevented) {
    return { target: briefSummary(element), scrolled: { window: true, x: scrollX, y: scrollY }, defaultPrevented: true };
  }

  const container = scrollableAncestor(element, deltaX, deltaY);
  if (container) {
    container.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" as ScrollBehavior });
    return {
      target: briefSummary(element),
      scrolled: { element: selectorFor(container), left: container.scrollLeft, top: container.scrollTop },
      defaultPrevented: false,
    };
  }

  window.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" as ScrollBehavior });
  return { target: briefSummary(element), scrolled: { window: true, x: scrollX, y: scrollY }, defaultPrevented: false };
}

// ---- pointer drag -------------------------------------------------------------

export interface DragOptions {
  steps?: number;
  /** Pause after pressing down, before moving (drag handles often need it). */
  holdMs?: number;
  /** Pause before releasing, so drop targets can register the hover. */
  settleMs?: number;
  button?: MouseButtonName;
  modifiers?: ModifierState;
}

/**
 * Press at `from`, move to `to` in steps, release.
 *
 * This is the pointer-based drag every modern DnD library (dnd-kit, sliders,
 * canvas editors, resizable panes) listens for. The HTML5 `DragEvent` path is
 * dispatched too when the source is `draggable`, so legacy drag targets keep
 * working from the same tool.
 */
export async function dragPointer(from: { x: number; y: number }, to: { x: number; y: number }, opts: DragOptions = {}): Promise<Record<string, unknown>> {
  const button = opts.button ?? "left";
  const modifiers = opts.modifiers ?? NO_MODIFIERS;
  const mask = MOUSE_BUTTON_MASKS[button];
  const steps = Math.max(1, Math.min(60, Math.floor(opts.steps ?? 12)));
  const holdMs = numberArg(opts.holdMs, 60, 0, 5000);
  const settleMs = numberArg(opts.settleMs, 60, 0, 5000);

  const source = elementAtPoint(from.x, from.y).element;
  const base: PointerOptions = { button, modifiers };

  focusElement(source);
  dispatchPointerLike(source, "pointerover", { ...base, point: from, buttons: 0 });
  source.dispatchEvent(new MouseEvent("mousemove", mouseInit(from, { ...base, buttons: 0 })));
  dispatchPointerLike(source, "pointerdown", { ...base, point: from, detail: 1, buttons: mask });
  source.dispatchEvent(new MouseEvent("mousedown", mouseInit(from, { ...base, detail: 1, buttons: mask })));
  if (holdMs) await sleep(holdMs);

  // HTML5 drag-and-drop targets need the DragEvent family; only start it when
  // the source actually opts into it, so we don't confuse pointer-only widgets.
  const html5 = source instanceof HTMLElement && source.draggable;
  const dataTransfer = html5 ? new DataTransfer() : undefined;
  if (html5 && dataTransfer) {
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, composed: true, clientX: from.x, clientY: from.y, dataTransfer }));
  }

  let last: Element = source;
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const point = { x: Math.round(from.x + (to.x - from.x) * progress), y: Math.round(from.y + (to.y - from.y) * progress) };
    let current: Element;
    try {
      current = elementAtPoint(point.x, point.y).element;
    } catch {
      current = last;
    }
    if (current !== last) {
      dispatchPointerLike(last, "pointerout", { ...base, point, buttons: mask });
      last.dispatchEvent(new MouseEvent("mouseout", mouseInit(point, { ...base, buttons: mask })));
      dispatchPointerLike(current, "pointerover", { ...base, point, buttons: mask });
      current.dispatchEvent(new MouseEvent("mouseover", mouseInit(point, { ...base, buttons: mask })));
      if (html5 && dataTransfer) {
        last.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y, dataTransfer }));
        current.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y, dataTransfer }));
      }
      last = current;
    }
    dispatchPointerLike(current, "pointermove", { ...base, point, buttons: mask });
    current.dispatchEvent(new MouseEvent("mousemove", mouseInit(point, { ...base, buttons: mask })));
    if (html5 && dataTransfer) {
      current.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y, dataTransfer }));
    }
    // A frame per step keeps requestAnimationFrame-driven drag handlers in sync.
    await sleep(steps > 1 ? 8 : 0);
  }

  if (settleMs) await sleep(settleMs);

  const target = last;
  dispatchPointerLike(target, "pointerup", { ...base, point: to, detail: 1, buttons: 0 });
  target.dispatchEvent(new MouseEvent("mouseup", mouseInit(to, { ...base, detail: 1, buttons: 0 })));
  if (html5 && dataTransfer) {
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, composed: true, clientX: to.x, clientY: to.y, dataTransfer }));
    source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, composed: true, clientX: to.x, clientY: to.y, dataTransfer }));
  }

  return {
    from: { point: from, element: briefSummary(source) },
    to: { point: to, element: briefSummary(target) },
    steps,
    button,
    html5DragEvents: html5,
    via: "js",
  };
}

/** Low-level single pointer action for custom gestures. */
export async function mouseAction(
  action: "down" | "up" | "move",
  x: number,
  y: number,
  opts: { button?: MouseButtonName; modifiers?: ModifierState; buttonHeld?: boolean } = {},
): Promise<Record<string, unknown>> {
  const button = opts.button ?? "left";
  const modifiers = opts.modifiers ?? NO_MODIFIERS;
  const mask = MOUSE_BUTTON_MASKS[button];
  const point = { x, y };
  const { element } = elementAtPoint(x, y);
  // A `move` in the middle of a drag must keep reporting the pressed button in
  // `buttons`, or drag handlers treat it as an idle hover and bail out.
  const held = action === "up" ? 0 : action === "down" ? mask : opts.buttonHeld ? mask : 0;
  const base: PointerOptions = { button, modifiers, point, buttons: held };

  if (action === "down") focusElement(element);
  const pointerType = action === "down" ? "pointerdown" : action === "up" ? "pointerup" : "pointermove";
  const mouseType = action === "down" ? "mousedown" : action === "up" ? "mouseup" : "mousemove";
  dispatchPointerLike(element, pointerType, { ...base, detail: action === "move" ? 0 : 1 });
  element.dispatchEvent(new MouseEvent(mouseType, mouseInit(point, { ...base, detail: action === "move" ? 0 : 1 })));
  return { action, point, button, target: briefSummary(element), via: "js" };
}

// ---- value setters ------------------------------------------------------------

function setNativeProperty(element: Element, prop: "value" | "checked", value: unknown): void {
  const proto = Object.getPrototypeOf(element) as object | null;
  const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, prop) : undefined;
  if (descriptor?.set) descriptor.set.call(element, value);
  else (element as unknown as Record<string, unknown>)[prop] = value;
}

export function inputEvents(element: Element): void {
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

export function setTextValue(element: Element, value: string, append = false): void {
  focusElement(element);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    setNativeProperty(element, "value", append ? `${element.value}${value}` : value);
    inputEvents(element);
    return;
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    if (!append) element.textContent = "";
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("insertText", false, value);
    inputEvents(element);
    return;
  }
  throw new Error("Target is not a text input, textarea, or contenteditable element.");
}

export function setCheckedValue(element: Element, checked: boolean): void {
  if (!(element instanceof HTMLInputElement) || !["checkbox", "radio"].includes(element.type)) throw new Error("Target is not a checkbox or radio input.");
  focusElement(element);
  if (element.checked !== checked) {
    setNativeProperty(element, "checked", checked);
    inputEvents(element);
  }
}

// ---- keyboard engine ----------------------------------------------------------
//
// Two entry points:
//   typeText(element, "Hello <kbd>Enter</kbd>") — realistic per-character typing
//     with keydown/keypress/beforeinput/input/keyup per char, so search-as-you-type
//     and controlled React inputs behave like they do for a real user.
//   pressKeys(element, "Meta+A Backspace")      — key chords / shortcuts.
//
// Both share the same chord parser, so `<kbd>…</kbd>` markup inside typed text
// and standalone key presses accept exactly the same key names.

export interface KeyChord {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type TypeSegment = { kind: "text"; value: string } | { kind: "keys"; value: string };

/** Named keys we accept in chords (case-insensitive), mapped to their KeyboardEvent.key. */
const NAMED_KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  space: " ",
  spacebar: " ",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
  contextmenu: "ContextMenu",
};

const MODIFIER_ALIASES: Record<string, "alt" | "ctrl" | "meta" | "shift" | "mod"> = {
  alt: "alt",
  option: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  meta: "mod",
  mod: "mod",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
  shift: "shift",
};

function isMacPlatform(): boolean {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  const hint = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(hint);
}

/** Windows virtual key codes CDP wants for non-printable keys. */
const VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, " ": 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46, Meta: 91, ContextMenu: 93,
};

/** CDP `Input.dispatchKeyEvent` modifier bitmask. */
export function cdpModifiers(chord: KeyChord): number {
  return (chord.altKey ? 1 : 0) | (chord.ctrlKey ? 2 : 0) | (chord.metaKey ? 4 : 0) | (chord.shiftKey ? 8 : 0);
}

export interface CdpKeyDescriptor {
  key: string;
  code: string;
  text: string;
  modifiers: number;
  windowsVirtualKeyCode: number;
}

/** Translate a parsed chord into the shape CDP's Input domain expects. */
export function cdpKeyDescriptor(chord: KeyChord): CdpKeyDescriptor {
  const printable = chord.key.length === 1 && !chord.ctrlKey && !chord.metaKey && !chord.altKey;
  const virtual = VIRTUAL_KEY_CODES[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase().charCodeAt(0) : 0);
  return {
    key: chord.key,
    code: chord.code || keyCodeFor(chord.key),
    // Enter must carry \r so it inserts a newline in multi-line editors.
    text: printable ? chord.key : chord.key === "Enter" ? "\r" : chord.key === "Tab" ? "\t" : "",
    modifiers: cdpModifiers(chord),
    windowsVirtualKeyCode: virtual,
  };
}

/** Chords for each character of a literal string (used by the typing engine). */
export function charChords(value: string): KeyChord[] {
  return [...value].map((char) => ({
    key: char,
    code: keyCodeFor(char),
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: /[A-Z]/.test(char),
  }));
}

/**
 * Viewport point to aim real mouse events at: the element's center, clamped
 * into the visible viewport (CDP coordinates are viewport-relative).
 */
export function viewportPointFor(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  const x = Math.min(Math.max(rect.left + rect.width / 2, 1), Math.max(innerWidth - 1, 1));
  const y = Math.min(Math.max(rect.top + rect.height / 2, 1), Math.max(innerHeight - 1, 1));
  return { x: Math.round(x), y: Math.round(y) };
}

/** True when the element's center is actually inside the viewport. */
export function isPointInViewport(point: { x: number; y: number }): boolean {
  return point.x >= 0 && point.y >= 0 && point.x <= innerWidth && point.y <= innerHeight;
}

export function keyCodeFor(key: string): string {
  if (key.length === 1) {
    if (/[a-zA-Z]/.test(key)) return `Key${key.toUpperCase()}`;
    if (/[0-9]/.test(key)) return `Digit${key}`;
    if (key === " ") return "Space";
    const punctuation: Record<string, string> = {
      "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash",
      ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", "`": "Backquote",
    };
    return punctuation[key] ?? "";
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
  return key;
}

/**
 * Parse a single chord like `Meta+A`, `Shift+Tab`, `Enter`, or `a`.
 * `Meta` and `Mod` are platform-aware (Cmd on macOS, Ctrl elsewhere) so an agent
 * can write `Meta+A` for select-all everywhere; `Cmd`/`Command` always map to the
 * meta key and `Ctrl`/`Control` always map to the control key.
 */
export function parseKeyChord(input: string, opts: { mac?: boolean } = {}): KeyChord {
  const raw = input.trim();
  if (!raw) throw new Error("Empty key chord.");
  const mac = opts.mac ?? isMacPlatform();

  // Split on "+" but keep a trailing literal "+" (e.g. "Shift++") working.
  const parts = raw.length === 1 ? [raw] : raw.split("+").filter((part, index, all) => part !== "" || index === all.length - 1);
  if (parts.length > 1 && parts[parts.length - 1] === "") parts[parts.length - 1] = "+";

  const chord: KeyChord = { key: "", code: "", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  const last = parts.pop() ?? "";
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.trim().toLowerCase()];
    if (!modifier) throw new Error(`Unknown modifier "${part}" in key chord "${raw}".`);
    if (modifier === "alt") chord.altKey = true;
    else if (modifier === "ctrl") chord.ctrlKey = true;
    else if (modifier === "shift") chord.shiftKey = true;
    else if (modifier === "meta") chord.metaKey = true;
    else if (mac) chord.metaKey = true;
    else chord.ctrlKey = true;
  }

  const named = NAMED_KEYS[last.trim().toLowerCase()];
  let key = named ?? last;
  if (!named && key.length === 1 && chord.shiftKey && /[a-z]/.test(key)) key = key.toUpperCase();
  if (!key) throw new Error(`Missing key in chord "${raw}".`);
  chord.key = key;
  chord.code = keyCodeFor(key);
  return chord;
}

/** Parse a whitespace-separated chord sequence, e.g. `Meta+A Backspace Enter`. */
export function parseKeySequence(input: string, opts: { mac?: boolean } = {}): KeyChord[] {
  const cleaned = String(input ?? "").replace(/<kbd>(.*?)<\/kbd>/gi, " $1 ").trim();
  if (!cleaned) throw new Error("No keys given.");
  return cleaned.split(/\s+/).filter(Boolean).map((chord) => parseKeyChord(chord, opts));
}

/**
 * Split typed text into literal runs and embedded `<kbd>…</kbd>` key presses:
 * `"jane <kbd>Tab</kbd>doe"` → text "jane ", keys "Tab", text "doe".
 */
export function parseTypeSegments(input: string): TypeSegment[] {
  const segments: TypeSegment[] = [];
  const pattern = /<kbd>(.*?)<\/kbd>/gis;
  let index = 0;
  for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
    if (match.index > index) segments.push({ kind: "text", value: input.slice(index, match.index) });
    const keys = (match[1] ?? "").trim();
    if (keys) segments.push({ kind: "keys", value: keys });
    index = match.index + match[0].length;
  }
  if (index < input.length) segments.push({ kind: "text", value: input.slice(index) });
  return segments;
}

function keyboardInit(chord: KeyChord): KeyboardEventInit {
  return {
    key: chord.key,
    code: chord.code || undefined,
    bubbles: true,
    cancelable: true,
    composed: true,
    altKey: chord.altKey,
    ctrlKey: chord.ctrlKey,
    metaKey: chord.metaKey,
    shiftKey: chord.shiftKey,
  };
}

function dispatchBeforeInput(element: Element, inputType: string, data: string | null): boolean {
  if (typeof InputEvent !== "function") return true;
  return element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType, data }));
}

function dispatchInput(element: Element, inputType: string, data: string | null): void {
  if (typeof InputEvent === "function") {
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data }));
    return;
  }
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function selectionRange(element: HTMLInputElement | HTMLTextAreaElement): { start: number; end: number } {
  const length = element.value.length;
  const start = element.selectionStart ?? length;
  const end = element.selectionEnd ?? length;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function replaceRange(element: HTMLInputElement | HTMLTextAreaElement, start: number, end: number, insert: string): void {
  const next = `${element.value.slice(0, start)}${insert}${element.value.slice(end)}`;
  setNativeProperty(element, "value", next);
  const caret = start + insert.length;
  try {
    element.setSelectionRange(caret, caret);
  } catch {
    // Inputs like email/number don't support selection ranges.
  }
}

/** Insert a single character at the caret, honouring beforeinput cancellation. */
function insertCharacter(element: Element, char: string): boolean {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (!dispatchBeforeInput(element, "insertText", char)) return false;
    const { start, end } = selectionRange(element);
    replaceRange(element, start, end, char);
    dispatchInput(element, "insertText", char);
    return true;
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    if (!dispatchBeforeInput(element, "insertText", char)) return false;
    document.execCommand("insertText", false, char);
    return true;
  }
  return false;
}

function deleteAroundCaret(element: Element, direction: "backward" | "forward"): boolean {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const inputType = direction === "backward" ? "deleteContentBackward" : "deleteContentForward";
    if (!dispatchBeforeInput(element, inputType, null)) return false;
    let { start, end } = selectionRange(element);
    if (start === end) {
      if (direction === "backward") start = Math.max(0, start - 1);
      else end = Math.min(element.value.length, end + 1);
    }
    if (start === end) return false;
    replaceRange(element, start, end, "");
    dispatchInput(element, inputType, null);
    return true;
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    const inputType = direction === "backward" ? "deleteContentBackward" : "deleteContentForward";
    if (!dispatchBeforeInput(element, inputType, null)) return false;
    document.execCommand(direction === "backward" ? "delete" : "forwardDelete");
    return true;
  }
  return false;
}

function selectAll(element: Element): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    try {
      element.setSelectionRange(0, element.value.length);
    } catch {
      element.select?.();
    }
    return;
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}

function formFor(element: Element): HTMLFormElement | undefined {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element instanceof HTMLButtonElement) {
    return element.form ?? undefined;
  }
  return element.closest?.("form") ?? undefined;
}

/**
 * Real browsers submit a form when Enter is pressed in a single-line input and
 * nothing calls preventDefault. Synthetic keyboard events don't do that, so we
 * emulate it — this is what makes "type a query and press Enter" work.
 */
function maybeSubmitForm(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return false;
  const form = formFor(element);
  if (!form) return false;
  const submitter = form.querySelector<HTMLElement>("button[type=submit], input[type=submit], button:not([type])");
  if (typeof form.requestSubmit === "function") {
    form.requestSubmit(submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : undefined);
    return true;
  }
  if (submitter) {
    submitter.click();
    return true;
  }
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  return true;
}

export interface KeyPressResult {
  key: string;
  defaultPrevented: boolean;
  applied: string | undefined;
  /** How long the key was held down, when it was held (see holdChord). */
  held?: number;
  /** Auto-repeat keydowns emitted while the key was held. */
  repeats?: number;
}

/**
 * Dispatch one chord (keydown → optional edit → keyup) on an element.
 * `skipKeyUp` leaves the key logically down so `holdChord` can release it later.
 */
export function pressChord(element: Element, chord: KeyChord, opts: { allowSubmit?: boolean; skipKeyUp?: boolean } = {}): KeyPressResult {
  const init = keyboardInit(chord);
  const notPrevented = element.dispatchEvent(new KeyboardEvent("keydown", init));
  let applied: string | undefined;

  if (notPrevented) {
    const editable = isEditableElement(element);
    const modified = chord.ctrlKey || chord.metaKey || chord.altKey;
    if (chord.key === "Enter" && !modified) {
      if (element instanceof HTMLTextAreaElement && editable) {
        if (insertCharacter(element, "\n")) applied = "newline";
      } else if (opts.allowSubmit !== false && maybeSubmitForm(element)) {
        applied = "submit";
      } else if (element instanceof HTMLElement && !editable) {
        element.click();
        applied = "click";
      }
    } else if (chord.key === "Backspace" && !modified && editable) {
      if (deleteAroundCaret(element, "backward")) applied = "delete";
    } else if (chord.key === "Delete" && !modified && editable) {
      if (deleteAroundCaret(element, "forward")) applied = "delete";
    } else if ((chord.metaKey || chord.ctrlKey) && chord.key.toLowerCase() === "a") {
      selectAll(element);
      applied = "select-all";
    } else if (chord.key.length === 1 && !modified && editable) {
      element.dispatchEvent(new KeyboardEvent("keypress", init));
      if (insertCharacter(element, chord.key)) applied = "insert";
    } else if (chord.key === " " && !modified && element instanceof HTMLElement && !editable) {
      element.click();
      applied = "click";
    }
  }

  if (opts.skipKeyUp !== true) element.dispatchEvent(new KeyboardEvent("keyup", init));
  return { key: chord.key, defaultPrevented: !notPrevented, applied };
}

export interface TypeOptions {
  /** Clear the current value before typing (default true when a locator targets an editable element). */
  clear?: boolean;
  /** Press Enter after the text (form submit / search). */
  submit?: boolean;
  /** Per-character delay in ms (default 0). */
  delayMs?: number;
}

export interface TypeResult {
  typed: number;
  keys: KeyPressResult[];
  cleared: boolean;
  submitted: boolean;
}

/** Clear an editable element's value with proper events. */
export function clearElementValue(element: Element): boolean {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (!element.value) return false;
    if (!dispatchBeforeInput(element, "deleteContentBackward", null)) return false;
    setNativeProperty(element, "value", "");
    dispatchInput(element, "deleteContentBackward", null);
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    if (!element.textContent) return false;
    if (!dispatchBeforeInput(element, "deleteContentBackward", null)) return false;
    element.textContent = "";
    dispatchInput(element, "deleteContentBackward", null);
    return true;
  }
  throw new Error("Target is not a text input, textarea, or contenteditable element.");
}

/**
 * Type text into an element character by character, dispatching the same event
 * sequence a real keystroke produces. `<kbd>Enter</kbd>`-style markup inside the
 * text is expanded into key presses.
 */
export async function typeText(element: Element, value: string, opts: TypeOptions = {}): Promise<TypeResult> {
  focusElement(element);
  const result: TypeResult = { typed: 0, keys: [], cleared: false, submitted: false };

  if (opts.clear !== false && isEditableElement(element)) {
    try {
      result.cleared = clearElementValue(element);
    } catch {
      result.cleared = false;
    }
  }

  const delay = numberArg(opts.delayMs, 0, 0, 1000);
  for (const segment of parseTypeSegments(String(value ?? ""))) {
    if (segment.kind === "keys") {
      for (const chord of parseKeySequence(segment.value)) {
        result.keys.push(pressChord(element, chord));
        if (delay) await sleep(delay);
      }
      continue;
    }
    for (const char of segment.value) {
      const chord: KeyChord = { key: char, code: keyCodeFor(char), altKey: false, ctrlKey: false, metaKey: false, shiftKey: /[A-Z]/.test(char) };
      const pressed = pressChord(element, chord);
      if (pressed.applied === "insert") result.typed += 1;
      else if (!pressed.applied && isEditableElement(element)) {
        // beforeinput/keydown was cancelled by the page; fall back to the value
        // setter so the field still ends up with the requested text.
        setTextValue(element, char, true);
        result.typed += 1;
      }
      if (delay) await sleep(delay);
    }
  }

  if (opts.submit) {
    result.keys.push(pressChord(element, parseKeyChord("Enter")));
    result.submitted = true;
  }

  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return result;
}

/**
 * Hold one chord down for `holdMs`, then release it.
 *
 * Real browsers repeat `keydown` while a key is held, so we do too (~30 Hz,
 * capped) with `repeat: true` — that is what press-and-hold handlers listen for.
 */
export async function holdChord(element: Element, chord: KeyChord, holdMs: number): Promise<KeyPressResult> {
  const init = keyboardInit(chord);
  const result = pressChord(element, chord, { skipKeyUp: true });
  const duration = numberArg(holdMs, 0, 0, 30000);
  const deadline = Date.now() + duration;
  let repeats = 0;
  while (Date.now() < deadline && repeats < 900) {
    await sleep(Math.min(33, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    element.dispatchEvent(new KeyboardEvent("keydown", { ...init, repeat: true }));
    repeats += 1;
  }
  element.dispatchEvent(new KeyboardEvent("keyup", init));
  return { ...result, held: duration, repeats };
}

/** Press a chord sequence on an element (or the active element when omitted). */
export async function pressKeys(
  target: Element | undefined,
  keys: string,
  opts: { delayMs?: number; repeat?: number; holdMs?: number } = {},
): Promise<KeyPressResult[]> {
  const element = target ?? (document.activeElement as Element | null) ?? document.body;
  if (target) focusElement(target);
  const chords = parseKeySequence(keys);
  const repeat = numberArg(opts.repeat, 1, 1, 50);
  const delay = numberArg(opts.delayMs, 0, 0, 1000);
  const holdMs = numberArg(opts.holdMs, 0, 0, 30000);
  const out: KeyPressResult[] = [];
  for (let round = 0; round < repeat; round += 1) {
    for (const chord of chords) {
      out.push(holdMs > 0 ? await holdChord(element, chord, holdMs) : pressChord(element, chord));
      if (delay) await sleep(delay);
    }
  }
  return out;
}

/** Legacy single-key dispatch kept for tools that take explicit modifier flags. */
export function triggerKey(element: Element, key: string, opts: Record<string, unknown> = {}): KeyPressResult {
  focusElement(element);
  const chord: KeyChord = {
    key,
    code: typeof opts.code === "string" ? opts.code : keyCodeFor(key),
    altKey: opts.altKey === true,
    ctrlKey: opts.ctrlKey === true,
    metaKey: opts.metaKey === true,
    shiftKey: opts.shiftKey === true,
  };
  return pressChord(element, chord);
}
