/** Playwright-like opt-in automation tools for a live page. */
import type { EmbeddedMcpServer, ToolResult } from "./embedded-server.js";
import { safeSerialize, toLogString } from "./serialize.js";

type ExtCall = (action: string, args?: Record<string, unknown>) => Promise<any>;

interface ElementSnapshot {
  selector: string;
  tag: string;
  id?: string;
  classes?: string[];
  text?: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; top: number; right: number; bottom: number; left: number; width: number; height: number };
  pickedAt?: string;
}

interface NetworkEntry {
  id: string;
  type: "fetch" | "xhr";
  method: string;
  url: string;
  requestBody?: string;
  requestHeaders?: Record<string, string>;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyTruncated?: boolean;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
}

interface DialogEntry {
  id: string;
  type: "alert" | "confirm" | "prompt";
  message: string;
  defaultValue?: string;
  handled: "native" | "accept" | "dismiss";
  result?: boolean | string | null;
  time: string;
}

interface DialogOriginals {
  alert: typeof window.alert;
  confirm: typeof window.confirm;
  prompt: typeof window.prompt;
}

const NETWORK_MAX_ENTRIES = 300;
const NETWORK_BODY_LIMIT = 12000;
const networkEntries: NetworkEntry[] = [];
let networkSeq = 0;
let networkCaptureActive = false;
let networkCaptureInstalled = false;
let originalFetch: typeof window.fetch | undefined;
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | undefined;
let originalXhrSend: typeof XMLHttpRequest.prototype.send | undefined;
let originalXhrSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader | undefined;
let xhrMeta = new WeakMap<XMLHttpRequest, { method: string; url: string; requestHeaders: Record<string, string>; entry?: NetworkEntry; startedAt?: number }>();

const dialogEntries: DialogEntry[] = [];
let dialogSeq = 0;
let dialogOriginals: DialogOriginals | undefined;
let dialogMode: "native" | "accept" | "dismiss" = "native";
let dialogPromptText = "";

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): ToolResult {
  return text(JSON.stringify(safeSerialize(value), null, 2));
}

function el(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`No element matches selector: ${selector}`);
  return found;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberArg(value: unknown, fallback: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function textMatches(value: string, query: unknown, exact: unknown): boolean {
  const needle = normalizeText(String(query ?? ""));
  if (!needle) return false;
  const haystack = normalizeText(value);
  return exact === true ? haystack === needle : haystack.toLowerCase().includes(needle.toLowerCase());
}

function escapeSelectorPart(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (css?.escape) return css.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function selectorLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function queryCount(selector: string): number {
  try {
    return document.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

function selectorFor(element: Element): string {
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

function elementText(element: Element): string {
  return normalizeText(element.textContent ?? "");
}

function snapshotElement(element: Element): ElementSnapshot {
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

function accessibleName(element: Element): string {
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

function isVisibleElement(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
}

function isDisabledElement(element: Element): boolean {
  if (element.getAttribute("aria-disabled") === "true") return true;
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement || element instanceof HTMLOptionElement) {
    return element.disabled;
  }
  return false;
}

function isEditableElement(element: Element): boolean {
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

function elementRole(element: Element): string | undefined {
  return element.getAttribute("role")?.trim() || implicitRole(element);
}

function allElements(root: ParentNode = document): Element[] {
  const base = root instanceof Document ? root.documentElement : root;
  if (base instanceof Element) return [base, ...base.querySelectorAll("*")];
  return [...root.querySelectorAll("*")];
}

function inputLabels(element: Element): string[] {
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
// take_snapshot walks the visible DOM, assigns short uids to interactive and
// structural elements, and returns a compact indented text tree. The uids
// resolve through this registry, so follow-up actions (smart_click, type_text,
// check, ...) can target `uid` directly instead of guessing CSS selectors —
// the same interaction model as chrome-devtools-mcp's take_snapshot.

interface SnapshotEntry {
  element: Element;
  children: SnapshotEntry[];
}

let snapshotGeneration = 0;
let snapshotUidSeq = 0;
const snapshotRefs = new Map<string, WeakRef<Element>>();

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

function renderSnapshotEntries(entries: SnapshotEntry[], depth: number, lines: string[], budget: { left: number; truncated: boolean }): void {
  for (const entry of entries) {
    if (budget.left <= 0) {
      budget.truncated = true;
      return;
    }
    budget.left -= 1;
    const uid = `${snapshotGeneration}_${++snapshotUidSeq}`;
    snapshotRefs.set(uid, new WeakRef(entry.element));
    lines.push(`${"  ".repeat(depth)}${snapshotLine(uid, entry.element)}`);
    renderSnapshotEntries(entry.children, depth + 1, lines, budget);
  }
}

function resolveUid(uid: string): Element {
  const element = snapshotRefs.get(uid)?.deref();
  if (!element) {
    throw new Error(`Unknown or stale uid "${uid}" (current snapshot generation is ${snapshotGeneration}); call take_snapshot for fresh uids.`);
  }
  if (!element.isConnected) {
    throw new Error(`Element for uid "${uid}" is no longer attached to the DOM; call take_snapshot again.`);
  }
  return element;
}

function clearSnapshotRefs(): void {
  snapshotRefs.clear();
}

function locatorMatches(args: Record<string, unknown>, rootArg?: ParentNode, applyNth = true): Element[] {
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

function locatorSummary(element: Element, opts: { includeHtml?: boolean } = {}): Record<string, unknown> {
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

function centerPoint(element: Element): { x: number; y: number } {
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

async function actionabilityFor(element: Element): Promise<Record<string, unknown>> {
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

async function waitForLocator(args: Record<string, unknown>, opts: { timeoutMs?: number; actionable?: boolean; strict?: boolean } = {}): Promise<Element> {
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

function focusElement(element: Element): void {
  if (element instanceof HTMLElement || element instanceof SVGElement) element.focus();
}

function dispatchMouseLike(element: Element, type: string, init: MouseEventInit = {}): boolean {
  const point = centerPoint(element);
  return element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: point.x, clientY: point.y, button: 0, buttons: type === "mouseup" || type === "click" || type === "dblclick" ? 0 : 1, ...init }));
}

function dispatchPointerLike(element: Element, type: string): boolean {
  const point = centerPoint(element);
  const init: PointerEventInit = { bubbles: true, cancelable: true, composed: true, view: window, clientX: point.x, clientY: point.y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
  if (typeof PointerEvent === "function") return element.dispatchEvent(new PointerEvent(type, init));
  return dispatchMouseLike(element, type.replace(/^pointer/, "mouse"));
}

function clickElement(element: Element, detail = 1): void {
  focusElement(element);
  dispatchPointerLike(element, "pointerover");
  dispatchMouseLike(element, "mouseover", { detail });
  dispatchPointerLike(element, "pointermove");
  dispatchMouseLike(element, "mousemove", { detail });
  dispatchPointerLike(element, "pointerdown");
  dispatchMouseLike(element, "mousedown", { detail });
  dispatchPointerLike(element, "pointerup");
  dispatchMouseLike(element, "mouseup", { detail });
  if (detail === 2) dispatchMouseLike(element, "dblclick", { detail });
  else if (element instanceof HTMLElement) element.click();
  else dispatchMouseLike(element, "click", { detail });
}

function setNativeProperty(element: Element, prop: "value" | "checked", value: unknown): void {
  const proto = Object.getPrototypeOf(element) as object | null;
  const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, prop) : undefined;
  if (descriptor?.set) descriptor.set.call(element, value);
  else (element as unknown as Record<string, unknown>)[prop] = value;
}

function inputEvents(element: Element): void {
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function setTextValue(element: Element, value: string, append = false): void {
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

function setCheckedValue(element: Element, checked: boolean): void {
  if (!(element instanceof HTMLInputElement) || !["checkbox", "radio"].includes(element.type)) throw new Error("Target is not a checkbox or radio input.");
  focusElement(element);
  if (element.checked !== checked) {
    setNativeProperty(element, "checked", checked);
    inputEvents(element);
  }
}

function triggerKey(element: Element, key: string, opts: Record<string, unknown> = {}): void {
  focusElement(element);
  const init: KeyboardEventInit = { key, code: typeof opts.code === "string" ? opts.code : key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true, altKey: opts.altKey === true, ctrlKey: opts.ctrlKey === true, metaKey: opts.metaKey === true, shiftKey: opts.shiftKey === true };
  element.dispatchEvent(new KeyboardEvent("keydown", init));
  element.dispatchEvent(new KeyboardEvent("keyup", init));
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function truncateBody(value: string): { body: string; truncated: boolean } {
  if (value.length <= NETWORK_BODY_LIMIT) return { body: value, truncated: false };
  return { body: value.slice(0, NETWORK_BODY_LIMIT), truncated: true };
}

function pushNetworkEntry(entry: NetworkEntry): NetworkEntry {
  networkEntries.push(entry);
  if (networkEntries.length > NETWORK_MAX_ENTRIES) networkEntries.splice(0, networkEntries.length - NETWORK_MAX_ENTRIES);
  return entry;
}

function headersObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return String(init.method).toUpperCase();
  if (typeof input === "object" && "method" in input && typeof input.method === "string") return input.method.toUpperCase();
  return "GET";
}

function bodyPreview(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return truncateBody(body).body;
  if (body instanceof URLSearchParams) return truncateBody(body.toString()).body;
  if (body instanceof FormData) return "[FormData]";
  if (body instanceof Blob) return `[Blob ${body.type || "application/octet-stream"} ${body.size} bytes]`;
  if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength} bytes]`;
  if (ArrayBuffer.isView(body)) return `[${body.constructor.name} ${body.byteLength} bytes]`;
  return toLogString(body).slice(0, NETWORK_BODY_LIMIT);
}

function installNetworkCapture(): void {
  if (networkCaptureInstalled) return;
  networkCaptureInstalled = true;
  originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const fetchImpl = originalFetch;
    if (!fetchImpl) throw new Error("fetch capture is not installed");
    if (!networkCaptureActive) return fetchImpl(input, init);
    const started = performance.now();
    const entry = pushNetworkEntry({ id: `net-${++networkSeq}`, type: "fetch", method: requestMethod(input, init), url: requestUrl(input), requestBody: bodyPreview(init?.body), startedAt: new Date().toISOString() });
    try {
      const response = await fetchImpl(input, init);
      entry.status = response.status;
      entry.statusText = response.statusText;
      entry.responseHeaders = headersObject(response.headers);
      entry.endedAt = new Date().toISOString();
      entry.durationMs = Math.round(performance.now() - started);
      void response.clone().text().then((body) => {
        const truncated = truncateBody(body);
        entry.responseBody = truncated.body;
        entry.responseBodyTruncated = truncated.truncated;
      }).catch(() => {
        entry.responseBody = "[unavailable]";
      });
      return response;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      entry.endedAt = new Date().toISOString();
      entry.durationMs = Math.round(performance.now() - started);
      throw error;
    }
  };

  originalXhrOpen = XMLHttpRequest.prototype.open;
  originalXhrSend = XMLHttpRequest.prototype.send;
  originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function open(method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) {
    xhrMeta.set(this, { method: String(method).toUpperCase(), url: String(url), requestHeaders: {} });
    return originalXhrOpen!.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };
  XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(header: string, value: string) {
    const meta = xhrMeta.get(this);
    if (meta) meta.requestHeaders[header] = value;
    return originalXhrSetRequestHeader!.call(this, header, value);
  };
  XMLHttpRequest.prototype.send = function send(body?: XMLHttpRequestBodyInit | null) {
    const meta = xhrMeta.get(this);
    if (networkCaptureActive && meta) {
      meta.startedAt = performance.now();
      meta.entry = pushNetworkEntry({ id: `net-${++networkSeq}`, type: "xhr", method: meta.method, url: meta.url, requestHeaders: meta.requestHeaders, requestBody: bodyPreview(body), startedAt: new Date().toISOString() });
      const finish = (): void => {
        const entry = meta.entry;
        if (!entry) return;
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.url = this.responseURL || entry.url;
        entry.endedAt = new Date().toISOString();
        entry.durationMs = Math.round(performance.now() - (meta.startedAt ?? performance.now()));
        try {
          entry.responseHeaders = Object.fromEntries(this.getAllResponseHeaders().trim().split(/\r?\n/).filter(Boolean).map((line) => {
            const index = line.indexOf(":");
            return index === -1 ? [line, ""] : [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
          }));
        } catch {
          // ignore response header access errors
        }
        try {
          if (typeof this.responseText === "string") {
            const truncated = truncateBody(this.responseText);
            entry.responseBody = truncated.body;
            entry.responseBodyTruncated = truncated.truncated;
          }
        } catch {
          entry.responseBody = "[unavailable]";
        }
      };
      const fail = (): void => {
        if (meta.entry) meta.entry.error = "XMLHttpRequest failed";
        finish();
      };
      this.addEventListener("loadend", finish, { once: true });
      this.addEventListener("error", fail, { once: true });
      this.addEventListener("timeout", fail, { once: true });
      this.addEventListener("abort", fail, { once: true });
    }
    return originalXhrSend!.call(this, body ?? null);
  };
}

function uninstallNetworkCapture(): void {
  networkCaptureActive = false;
  if (!networkCaptureInstalled) return;
  if (originalFetch) window.fetch = originalFetch;
  if (originalXhrOpen) XMLHttpRequest.prototype.open = originalXhrOpen;
  if (originalXhrSend) XMLHttpRequest.prototype.send = originalXhrSend;
  if (originalXhrSetRequestHeader) XMLHttpRequest.prototype.setRequestHeader = originalXhrSetRequestHeader;
  originalFetch = undefined;
  originalXhrOpen = undefined;
  originalXhrSend = undefined;
  originalXhrSetRequestHeader = undefined;
  xhrMeta = new WeakMap();
  networkCaptureInstalled = false;
}

function networkEntryMatches(entry: NetworkEntry, args: Record<string, unknown>): boolean {
  if (args.url !== undefined && !entry.url.includes(String(args.url))) return false;
  if (args.urlPattern !== undefined && !new RegExp(String(args.urlPattern)).test(entry.url)) return false;
  if (args.method !== undefined && entry.method.toUpperCase() !== String(args.method).toUpperCase()) return false;
  if (args.status !== undefined && entry.status !== Number(args.status)) return false;
  return entry.endedAt !== undefined || args.includePending === true;
}

function storageObject(storage: Storage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null) out[key] = storage.getItem(key) ?? "";
  }
  return out;
}

function listDocumentCookies(): Array<{ name: string; value: string }> {
  return document.cookie.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index === -1 ? { name: decodeURIComponent(part), value: "" } : { name: decodeURIComponent(part.slice(0, index)), value: decodeURIComponent(part.slice(index + 1)) };
  });
}

function installDialogCapture(): void {
  if (dialogOriginals) return;
  dialogOriginals = { alert: window.alert.bind(window), confirm: window.confirm.bind(window), prompt: window.prompt.bind(window) };
  window.alert = (message?: unknown): void => {
    const handled = dialogMode === "native" ? "native" : dialogMode;
    dialogEntries.push({ id: `dialog-${++dialogSeq}`, type: "alert", message: String(message ?? ""), handled, time: new Date().toISOString() });
    if (dialogMode === "native") dialogOriginals?.alert(String(message ?? ""));
  };
  window.confirm = (message?: string): boolean => {
    const result = dialogMode !== "dismiss";
    const handled = dialogMode === "native" ? "native" : dialogMode;
    dialogEntries.push({ id: `dialog-${++dialogSeq}`, type: "confirm", message: String(message ?? ""), handled, result, time: new Date().toISOString() });
    return dialogMode === "native" ? dialogOriginals?.confirm(String(message ?? "")) ?? result : result;
  };
  window.prompt = (message?: string, defaultValue?: string): string | null => {
    const result = dialogMode === "dismiss" ? null : dialogPromptText || defaultValue || "";
    const handled = dialogMode === "native" ? "native" : dialogMode;
    dialogEntries.push({ id: `dialog-${++dialogSeq}`, type: "prompt", message: String(message ?? ""), defaultValue, handled, result, time: new Date().toISOString() });
    return dialogMode === "native" ? dialogOriginals?.prompt(String(message ?? ""), defaultValue) ?? null : result;
  };
}

function restoreDialogCapture(): void {
  if (!dialogOriginals) return;
  window.alert = dialogOriginals.alert;
  window.confirm = dialogOriginals.confirm;
  window.prompt = dialogOriginals.prompt;
  dialogOriginals = undefined;
  dialogMode = "native";
}

function frameElement(selector: unknown): HTMLIFrameElement {
  const frameSelector = stringArg(selector);
  if (!frameSelector) throw new Error("frameSelector is required.");
  const frame = el(frameSelector);
  if (!(frame instanceof HTMLIFrameElement)) throw new Error(`Selector is not an iframe: ${frameSelector}`);
  return frame;
}

function sameOriginFrameDocument(frame: HTMLIFrameElement): Document {
  const doc = frame.contentDocument;
  if (!doc) throw new Error("Frame document is not accessible (cross-origin, sandboxed, or not loaded).");
  return doc;
}

/**
 * Restore everything the automation tools patched on the page (fetch/XHR hooks
 * and alert/confirm/prompt overrides). Call this when the tab is deactivated or
 * the automation toolset is turned off, so the page (and the real user) is no
 * longer affected by a previously-set dialog mode or network capture.
 */
export function teardownAutomationTools(): void {
  uninstallNetworkCapture();
  restoreDialogCapture();
  clearSnapshotRefs();
}

export function registerAutomationTools(server: EmbeddedMcpServer, opts: { extCall: ExtCall }): void {
  server.registerTool(
    {
      name: "take_snapshot",
      description:
        "Take a compact text snapshot of the page's interactive/structural elements with stable uids. " +
        "Pass a uid to smart_click / type_text / hover / check / select_option etc. instead of a selector. " +
        "Uids go stale after navigation or DOM changes — take a fresh snapshot then.",
      inputSchema: {
        type: "object",
        properties: {
          maxNodes: { type: "number", description: "max elements in the snapshot (default 400)" },
          includeHidden: { type: "boolean", description: "include elements that are not visible (default false)" },
        },
      },
    },
    (args) => {
      snapshotGeneration += 1;
      snapshotUidSeq = 0;
      snapshotRefs.clear();
      const budget = { left: numberArg(args.maxNodes, 400, 10, 2000), truncated: false };
      const entries = buildSnapshotEntries(document.body, args.includeHidden === true);
      const lines: string[] = [];
      renderSnapshotEntries(entries, 0, lines, budget);
      const header = `Page snapshot — ${document.title ? `"${normalizeText(document.title)}" — ` : ""}${location.href}`;
      const footer = budget.truncated
        ? `\n[truncated at ${numberArg(args.maxNodes, 400, 10, 2000)} nodes — pass a larger maxNodes to see more]`
        : "";
      return text(`${header}\n${lines.join("\n") || "(no interactive or structural elements found)"}${footer}`);
    },
  );

  server.registerTool(
    {
      name: "find_by_text",
      description: "Find visible elements by text content.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, exact: { type: "boolean" }, limit: { type: "number", description: "max results (default 20)" }, includeHtml: { type: "boolean" } }, required: ["text"] },
    },
    (args) => {
      const limit = numberArg(args.limit, 20, 1, 100);
      const matches = locatorMatches({ text: args.text, exact: args.exact }, document, false);
      return json({ count: matches.length, matches: matches.slice(0, limit).map((element) => locatorSummary(element, { includeHtml: args.includeHtml === true })) });
    },
  );

  server.registerTool(
    {
      name: "find_by_role",
      description: "Find elements by ARIA/implicit role, optionally filtered by accessible name.",
      inputSchema: { type: "object", properties: { role: { type: "string", description: "button, link, textbox, checkbox, heading, etc." }, name: { type: "string", description: "accessible name filter" }, exact: { type: "boolean" }, limit: { type: "number", description: "max results (default 20)" }, includeHtml: { type: "boolean" } }, required: ["role"] },
    },
    (args) => {
      const limit = numberArg(args.limit, 20, 1, 100);
      const matches = locatorMatches({ role: args.role, name: args.name, exact: args.exact }, document, false);
      return json({ count: matches.length, matches: matches.slice(0, limit).map((element) => locatorSummary(element, { includeHtml: args.includeHtml === true })) });
    },
  );

  server.registerTool(
    {
      name: "find_by_label",
      description: "Find form controls by associated label, aria-label, or placeholder.",
      inputSchema: { type: "object", properties: { label: { type: "string" }, exact: { type: "boolean" }, limit: { type: "number", description: "max results (default 20)" }, includeHtml: { type: "boolean" } }, required: ["label"] },
    },
    (args) => {
      const limit = numberArg(args.limit, 20, 1, 100);
      const matches = locatorMatches({ label: args.label, exact: args.exact }, document, false);
      return json({ count: matches.length, matches: matches.slice(0, limit).map((element) => locatorSummary(element, { includeHtml: args.includeHtml === true })) });
    },
  );

  server.registerTool(
    {
      name: "find_by_test_id",
      description: "Find elements by data-testid/data-test/data-cy.",
      inputSchema: { type: "object", properties: { testId: { type: "string" }, limit: { type: "number", description: "max results (default 20)" }, includeHtml: { type: "boolean" } }, required: ["testId"] },
    },
    (args) => {
      const limit = numberArg(args.limit, 20, 1, 100);
      const matches = locatorMatches({ testId: args.testId }, document, false);
      return json({ count: matches.length, matches: matches.slice(0, limit).map((element) => locatorSummary(element, { includeHtml: args.includeHtml === true })) });
    },
  );

  server.registerTool(
    {
      name: "locator_snapshot",
      description: "Resolve a uid/selector/text/role/label/testId locator and return element snapshots plus actionability state.",
      inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, text: { type: "string" }, role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, testId: { type: "string" }, placeholder: { type: "string" }, exact: { type: "boolean" }, nth: { type: "number" }, visible: { type: "boolean" }, limit: { type: "number", description: "max results (default 10)" }, includeHtml: { type: "boolean" } } },
    },
    async (args) => {
      const limit = numberArg(args.limit, 10, 1, 50);
      const matches = locatorMatches(args, document, args.nth !== undefined);
      return json({ count: matches.length, matches: await Promise.all(matches.slice(0, limit).map(async (element) => ({ ...locatorSummary(element, { includeHtml: args.includeHtml === true }), actionability: await actionabilityFor(element) }))) });
    },
  );

  server.registerTool(
    {
      name: "locator_count",
      description: "Count elements matching a selector/text/role/label/testId locator.",
      inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, testId: { type: "string" }, placeholder: { type: "string" }, exact: { type: "boolean" }, visible: { type: "boolean" } } },
    },
    (args) => json({ count: locatorMatches(args, document, false).length }),
  );

  server.registerTool(
    {
      name: "smart_click",
      description: "Click a locator (uid from take_snapshot, or selector/text/role/...) after Playwright-like visibility/enabled/stability/coverage checks.",
      inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, text: { type: "string" }, role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, testId: { type: "string" }, exact: { type: "boolean" }, nth: { type: "number" }, timeoutMs: { type: "number", description: "default 5000" }, force: { type: "boolean", description: "skip actionability checks" }, strict: { type: "boolean" } } },
    },
    async (args) => {
      const element = await waitForLocator(args, { actionable: args.force !== true, strict: args.strict === true });
      const before = await actionabilityFor(element);
      clickElement(element);
      return json({ clicked: locatorSummary(element), actionability: before });
    },
  );

  server.registerTool({ name: "hover", description: "Move the synthetic pointer over a locator.", inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, text: { type: "string" }, role: { type: "string" }, name: { type: "string" }, testId: { type: "string" }, timeoutMs: { type: "number" } } } }, async (args) => {
    const element = await waitForLocator(args, { actionable: false });
    element.scrollIntoView({ block: "center", inline: "center" });
    dispatchPointerLike(element, "pointerover");
    dispatchMouseLike(element, "mouseover");
    dispatchPointerLike(element, "pointermove");
    dispatchMouseLike(element, "mousemove");
    return json({ hovered: locatorSummary(element) });
  });

  server.registerTool({ name: "double_click", description: "Double-click a locator after actionability checks.", inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, text: { type: "string" }, role: { type: "string" }, name: { type: "string" }, testId: { type: "string" }, timeoutMs: { type: "number" }, force: { type: "boolean" } } } }, async (args) => {
    const element = await waitForLocator(args, { actionable: args.force !== true });
    clickElement(element, 1);
    clickElement(element, 1);
    dispatchMouseLike(element, "dblclick", { detail: 2 });
    return json({ doubleClicked: locatorSummary(element) });
  });

  server.registerTool({ name: "type_text", description: "Type or set text into an input/textarea/contenteditable locator and fire input/change events.", inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, label: { type: "string" }, placeholder: { type: "string" }, text: { type: "string" }, value: { type: "string" }, append: { type: "boolean" }, timeoutMs: { type: "number" } } } }, async (args) => {
    const element = await waitForLocator(args, { actionable: false });
    setTextValue(element, String(args.value ?? args.text ?? ""), args.append === true);
    return json({ typed: locatorSummary(element), value: (element as HTMLInputElement | HTMLTextAreaElement).value ?? element.textContent ?? "" });
  });

  server.registerTool({ name: "press_key", description: "Dispatch keydown/keyup to a locator or the active element.", inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, text: { type: "string" }, role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, testId: { type: "string" }, placeholder: { type: "string" }, key: { type: "string" }, code: { type: "string" }, altKey: { type: "boolean" }, ctrlKey: { type: "boolean" }, metaKey: { type: "boolean" }, shiftKey: { type: "boolean" } }, required: ["key"] } }, async (args) => {
    const hasLocator = args.uid || args.selector || args.text || args.role || args.name || args.label || args.testId || args.placeholder;
    const element = hasLocator ? await waitForLocator(args) : (document.activeElement ?? document.body);
    triggerKey(element, String(args.key ?? ""), args);
    return json({ pressed: args.key, target: locatorSummary(element) });
  });

  server.registerTool({ name: "clear_value", description: "Clear an input/textarea/contenteditable locator.", inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, label: { type: "string" }, placeholder: { type: "string" }, timeoutMs: { type: "number" } } } }, async (args) => {
    const element = await waitForLocator(args);
    setTextValue(element, "", false);
    return json({ cleared: locatorSummary(element) });
  });

  server.registerTool({ name: "select_option", description: "Select one or more values on a <select> element and fire input/change events.", inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, label: { type: "string" }, value: { description: "string or string[]" }, timeoutMs: { type: "number" } }, required: ["value"] } }, async (args) => {
    const element = await waitForLocator(args);
    if (!(element instanceof HTMLSelectElement)) throw new Error("Target is not a select element.");
    const values = new Set(Array.isArray(args.value) ? args.value.map(String) : [String(args.value ?? "")]);
    for (const option of element.options) option.selected = values.has(option.value) || values.has(option.label);
    inputEvents(element);
    return json({ selected: [...element.selectedOptions].map((option) => ({ value: option.value, label: option.label })) });
  });

  server.registerTool({ name: "check", description: "Check a checkbox/radio locator.", inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, label: { type: "string" }, timeoutMs: { type: "number" } } } }, async (args) => {
    const element = await waitForLocator(args);
    setCheckedValue(element, true);
    return json({ checked: locatorSummary(element) });
  });

  server.registerTool({ name: "uncheck", description: "Uncheck a checkbox locator.", inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, label: { type: "string" }, timeoutMs: { type: "number" } } } }, async (args) => {
    const element = await waitForLocator(args);
    setCheckedValue(element, false);
    return json({ unchecked: locatorSummary(element) });
  });

  server.registerTool({ name: "upload_file", description: "Attach a synthetic File to an input[type=file] from base64 or text content.", inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, filename: { type: "string" }, mimeType: { type: "string" }, base64: { type: "string" }, text: { type: "string" } }, required: ["filename"] } }, async (args) => {
    const element = await waitForLocator(args);
    if (!(element instanceof HTMLInputElement) || element.type !== "file") throw new Error("Target is not input[type=file].");
    const bytes = args.base64 !== undefined ? decodeBase64(String(args.base64)) : new TextEncoder().encode(String(args.text ?? ""));
    const filePart = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const file = new File([filePart], String(args.filename), { type: String(args.mimeType ?? "application/octet-stream") });
    const dt = new DataTransfer();
    dt.items.add(file);
    element.files = dt.files;
    inputEvents(element);
    return json({ uploaded: { name: file.name, type: file.type, size: file.size } });
  });

  server.registerTool({ name: "drag_and_drop", description: "Dispatch drag/drop events from one locator to another (selector or uid from take_snapshot).", inputSchema: { type: "object", properties: { sourceSelector: { type: "string" }, targetSelector: { type: "string" }, sourceUid: { type: "string", description: "source element uid from take_snapshot" }, targetUid: { type: "string", description: "target element uid from take_snapshot" }, timeoutMs: { type: "number" } } } }, async (args) => {
    const source = await waitForLocator({ selector: args.sourceSelector, uid: args.sourceUid, timeoutMs: args.timeoutMs }, { actionable: true });
    const target = await waitForLocator({ selector: args.targetSelector, uid: args.targetUid, timeoutMs: args.timeoutMs }, { actionable: true });
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer }));
    return json({ dragged: locatorSummary(source), droppedOn: locatorSummary(target) });
  });

  server.registerTool({ name: "start_network_capture", description: "Start page-level fetch/XMLHttpRequest capture (from this point forward).", inputSchema: { type: "object", properties: { clear: { type: "boolean" } } } }, (args) => {
    if (args.clear !== false) networkEntries.length = 0;
    installNetworkCapture();
    networkCaptureActive = true;
    return text("network capture started for fetch/XMLHttpRequest");
  });

  server.registerTool({ name: "stop_network_capture", description: "Stop page-level network capture and restore fetch/XMLHttpRequest hooks.", inputSchema: { type: "object", properties: {} } }, () => {
    uninstallNetworkCapture();
    return text("network capture stopped");
  });

  server.registerTool({ name: "list_network_requests", description: "List captured fetch/XMLHttpRequest entries.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "default 50" }, includeBodies: { type: "boolean" } } } }, (args) => {
    const limit = numberArg(args.limit, 50, 1, NETWORK_MAX_ENTRIES);
    const entries = networkEntries.slice(-limit).map((entry) => args.includeBodies === true ? entry : { ...entry, requestBody: undefined, responseBody: undefined });
    return json({ active: networkCaptureActive, entries });
  });

  server.registerTool({ name: "wait_for_response", description: "Wait for a captured response by url substring/regex, method, and/or status.", inputSchema: { type: "object", properties: { url: { type: "string" }, urlPattern: { type: "string" }, method: { type: "string" }, status: { type: "number" }, timeoutMs: { type: "number", description: "default 5000" }, includePending: { type: "boolean" } } } }, async (args) => {
    const timeoutMs = numberArg(args.timeoutMs, 5000, 0, 60000);
    const start = Date.now();
    for (;;) {
      const found = [...networkEntries].reverse().find((entry) => networkEntryMatches(entry, args));
      if (found) return json(found);
      if (Date.now() - start > timeoutMs) return { content: [{ type: "text", text: `timeout waiting for response after ${timeoutMs}ms` }], isError: true } satisfies ToolResult;
      await sleep(100);
    }
  });

  server.registerTool({ name: "get_response_body", description: "Return a captured response body by network request id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }, (args) => {
    const entry = networkEntries.find((item) => item.id === args.id);
    if (!entry) return { content: [{ type: "text", text: `no network entry found for ${args.id}` }], isError: true } satisfies ToolResult;
    return json({ id: entry.id, url: entry.url, body: entry.responseBody ?? "", truncated: entry.responseBodyTruncated === true });
  });

  server.registerTool({ name: "clear_network_capture", description: "Clear captured network entries.", inputSchema: { type: "object", properties: {} } }, () => {
    const count = networkEntries.length;
    networkEntries.length = 0;
    return text(`cleared ${count} network entr${count === 1 ? "y" : "ies"}`);
  });

  server.registerTool({ name: "get_storage_state", description: "Return origin, localStorage, sessionStorage, and script-readable cookies.", inputSchema: { type: "object", properties: {} } }, () => json({ origin: location.origin, localStorage: storageObject(localStorage), sessionStorage: storageObject(sessionStorage), cookies: listDocumentCookies(), note: "HTTP-only cookies are not visible to page scripts." }));

  server.registerTool({ name: "set_local_storage", description: "Set or remove a localStorage key.", inputSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" }, remove: { type: "boolean" } }, required: ["key"] } }, (args) => {
    const key = String(args.key ?? "");
    if (args.remove === true) localStorage.removeItem(key);
    else localStorage.setItem(key, String(args.value ?? ""));
    return json({ key, value: localStorage.getItem(key) });
  });

  server.registerTool({ name: "set_session_storage", description: "Set or remove a sessionStorage key.", inputSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" }, remove: { type: "boolean" } }, required: ["key"] } }, (args) => {
    const key = String(args.key ?? "");
    if (args.remove === true) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, String(args.value ?? ""));
    return json({ key, value: sessionStorage.getItem(key) });
  });

  server.registerTool({ name: "clear_storage", description: "Clear localStorage, sessionStorage, or both.", inputSchema: { type: "object", properties: { scope: { type: "string", description: "local|session|both (default both)" } } } }, (args) => {
    const scope = String(args.scope ?? "both");
    if (scope === "local" || scope === "both") localStorage.clear();
    if (scope === "session" || scope === "both") sessionStorage.clear();
    return text(`cleared ${scope} storage`);
  });

  server.registerTool({ name: "list_cookies", description: "List script-readable document cookies (HTTP-only cookies are not visible).", inputSchema: { type: "object", properties: {} } }, () => json(listDocumentCookies()));

  server.registerTool({ name: "set_cookie", description: "Set a script-readable cookie with optional attributes.", inputSchema: { type: "object", properties: { name: { type: "string" }, value: { type: "string" }, path: { type: "string" }, maxAge: { type: "number" }, sameSite: { type: "string" }, secure: { type: "boolean" } }, required: ["name", "value"] } }, (args) => {
    const parts = [`${encodeURIComponent(String(args.name ?? ""))}=${encodeURIComponent(String(args.value ?? ""))}`, `path=${String(args.path ?? "/")}`];
    if (args.maxAge !== undefined) parts.push(`max-age=${Number(args.maxAge)}`);
    if (args.sameSite) parts.push(`samesite=${String(args.sameSite)}`);
    if (args.secure === true) parts.push("secure");
    document.cookie = parts.join("; ");
    return json(listDocumentCookies().find((cookie) => cookie.name === String(args.name)) ?? { set: false });
  });

  server.registerTool({ name: "delete_cookie", description: "Delete a script-readable cookie by expiring it.", inputSchema: { type: "object", properties: { name: { type: "string" }, path: { type: "string" } }, required: ["name"] } }, (args) => {
    document.cookie = `${encodeURIComponent(String(args.name ?? ""))}=; path=${String(args.path ?? "/")}; max-age=0`;
    return text(`deleted cookie ${args.name}`);
  });

  server.registerTool({ name: "set_dialog_behavior", description: "Intercept alert/confirm/prompt and auto-accept, auto-dismiss, or restore native behavior.", inputSchema: { type: "object", properties: { mode: { type: "string", description: "accept|dismiss|native" }, promptText: { type: "string" }, clear: { type: "boolean" } }, required: ["mode"] } }, (args) => {
    const mode = String(args.mode ?? "native");
    if (!["accept", "dismiss", "native"].includes(mode)) throw new Error("mode must be accept, dismiss, or native");
    if (args.clear === true) dialogEntries.length = 0;
    dialogPromptText = String(args.promptText ?? "");
    if (mode === "native") restoreDialogCapture();
    else {
      dialogMode = mode as "accept" | "dismiss";
      installDialogCapture();
    }
    return json({ mode, promptText: dialogPromptText || undefined });
  });

  server.registerTool({ name: "list_dialogs", description: "List alert/confirm/prompt calls captured by set_dialog_behavior.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "default 50" } } } }, (args) => json(dialogEntries.slice(-numberArg(args.limit, 50, 1, 200))));

  server.registerTool({ name: "clear_dialogs", description: "Clear captured dialog entries.", inputSchema: { type: "object", properties: {} } }, () => {
    const count = dialogEntries.length;
    dialogEntries.length = 0;
    return text(`cleared ${count} dialog entr${count === 1 ? "y" : "ies"}`);
  });

  server.registerTool({ name: "list_frames", description: "List iframe elements and whether their documents are same-origin accessible.", inputSchema: { type: "object", properties: {} } }, () => json([...document.querySelectorAll("iframe")].map((frame, index) => {
    let accessible = false;
    let url = frame.src || undefined;
    let title = frame.title || undefined;
    try {
      accessible = !!frame.contentDocument;
      url = frame.contentWindow?.location.href || url;
      title = frame.contentDocument?.title || title;
    } catch {
      accessible = false;
    }
    return { index, selector: selectorFor(frame), url, title, accessible, rect: snapshotElement(frame).rect };
  })));

  server.registerTool({ name: "frame_dom_query", description: "Query a same-origin iframe by CSS selector.", inputSchema: { type: "object", properties: { frameSelector: { type: "string" }, selector: { type: "string" }, limit: { type: "number" }, includeHtml: { type: "boolean" } }, required: ["frameSelector", "selector"] } }, (args) => {
    const doc = sameOriginFrameDocument(frameElement(args.frameSelector));
    const matches = [...doc.querySelectorAll(String(args.selector))].slice(0, numberArg(args.limit, 20, 1, 100));
    return json(matches.map((element) => locatorSummary(element, { includeHtml: args.includeHtml === true })));
  });

  server.registerTool({ name: "frame_click", description: "Click inside a same-origin iframe.", inputSchema: { type: "object", properties: { frameSelector: { type: "string" }, selector: { type: "string" } }, required: ["frameSelector", "selector"] } }, (args) => {
    const doc = sameOriginFrameDocument(frameElement(args.frameSelector));
    const element = doc.querySelector(String(args.selector));
    if (!element) throw new Error(`No frame element matches selector: ${args.selector}`);
    if (element instanceof HTMLElement) element.click();
    else dispatchMouseLike(element, "click");
    return json({ clicked: locatorSummary(element) });
  });

  server.registerTool({ name: "frame_set_value", description: "Set an input/textarea/select value inside a same-origin iframe.", inputSchema: { type: "object", properties: { frameSelector: { type: "string" }, selector: { type: "string" }, value: { type: "string" } }, required: ["frameSelector", "selector", "value"] } }, (args) => {
    const doc = sameOriginFrameDocument(frameElement(args.frameSelector));
    const element = doc.querySelector(String(args.selector));
    if (!element) throw new Error(`No frame element matches selector: ${args.selector}`);
    if (element instanceof HTMLSelectElement) {
      element.value = String(args.value ?? "");
      inputEvents(element);
    } else setTextValue(element, String(args.value ?? ""));
    return json({ set: locatorSummary(element) });
  });

  server.registerTool({ name: "resize_window", description: "Resize the current browser window (best-effort viewport approximation).", inputSchema: { type: "object", properties: { width: { type: "number" }, height: { type: "number" } }, required: ["width", "height"] } }, async (args) => json(await opts.extCall("resizeWindow", { width: Number(args.width), height: Number(args.height) })));
}
