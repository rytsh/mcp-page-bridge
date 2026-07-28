/**
 * Built-in tools the extension exposes for any enabled tab, registered into the
 * page's embedded MCP server. Page-context tools (eval, DOM, console) run here
 * in the MAIN world. Extension-only tools (screenshot, navigate, reload) are
 * delegated to the service worker via `extCall`.
 */
import type { ContentBlock, EmbeddedMcpServer, ToolResult } from "./embedded-server.js";
import { registerAutomationTools } from "./automation-tools.js";
import { registerCdpTools } from "./cdp-tools.js";
import { registerInputTools } from "./input-tools.js";
import { observeMode, observeProperty, withObservation } from "./observe.js";
import { clampToolText, hideUidOverlay, showUidOverlay } from "./dom-core.js";
import { safeSerialize, toLogString } from "./serialize.js";

export interface ConsoleEntry {
  level: string;
  text: string;
  time: string;
}

export interface ConsoleBuffer {
  entries: ConsoleEntry[];
}

export type ExtCall = (action: string, args?: Record<string, unknown>) => Promise<any>;

/** Hook console.* and global error events into a bounded ring buffer. */
export function installConsoleCapture(max = 300): ConsoleBuffer {
  const entries: ConsoleEntry[] = [];
  const push = (level: string, parts: unknown[]): void => {
    entries.push({
      level,
      text: parts.map((p) => toLogString(p)).join(" ").slice(0, 2000),
      time: new Date().toISOString(),
    });
    if (entries.length > max) entries.splice(0, entries.length - max);
  };

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(level, args);
      original(...args);
    };
  }

  window.addEventListener("error", (e) => push("error", [e.message, e.filename + ":" + e.lineno]));
  window.addEventListener("unhandledrejection", (e) =>
    push("error", ["unhandledrejection:", (e as PromiseRejectionEvent).reason]),
  );

  return { entries };
}

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: clampToolText(value) }] };
}

function json(value: unknown): ToolResult {
  return text(JSON.stringify(safeSerialize(value), null, 2));
}

async function runEval(code: string): Promise<unknown> {
  // Indirect eval runs in the page's global scope (MAIN world).
  const indirectEval = eval;
  try {
    return await indirectEval(`(async () => (${code}))()`);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return await indirectEval(`(async () => { ${code} })()`);
    }
    throw error;
  }
}

function cspEvalHint(error: Error): string | undefined {
  const message = error.message.toLowerCase();
  if (!message.includes("content security policy") && !message.includes("unsafe-eval")) return undefined;
  return [
    "Page CSP blocked arbitrary JavaScript evaluation (unsafe-eval).",
    "This is expected on locked-down pages such as GitHub.",
    "Do not try to bypass the page CSP with inline/script-tag injection.",
    "Use the dedicated non-eval tools instead: dom_query, get_html, get_page_info, get_selected_element, get_computed_style, apply_css, click, set_value, screenshot, or navigate.",
  ].join(" ");
}

function el(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`No element matches selector: ${selector}`);
  return found;
}

interface ElementSnapshot {
  selectionId?: string;
  index?: number;
  primary?: boolean;
  name?: string;
  group?: string;
  selector: string;
  tag: string;
  id?: string;
  classes?: string[];
  text?: string;
  attributes: Record<string, string>;
  rect: {
    x: number;
    y: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
  };
  pickedAt?: string;
  marker?: {
    visible: boolean;
    color: "yellow-transparent";
    label: string;
  };
}

interface CssPatch {
  id: string;
  selector?: string;
  css: string;
  renderedCss: string;
  reason?: string;
  createdAt: string;
}

interface SelectedElementEntry {
  id: string;
  element?: Element;
  snapshot: ElementSnapshot;
  name?: string;
  group?: string;
}

interface DesignBaseline {
  label: string;
  dataUrl: string;
  base64: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  url: string;
  title: string;
}

interface SelectedMarker {
  overlay: HTMLDivElement;
  label: HTMLDivElement;
  timer: ReturnType<typeof setInterval>;
}

const CSS_PATCH_ATTR = "data-mcp-page-bridge-css-patch";
const SELECTED_MARKER_ATTR = "data-mcp-page-bridge-selected-marker";
const DEFAULT_STYLE_PROPS = [
  "display",
  "position",
  "box-sizing",
  "width",
  "height",
  "margin",
  "padding",
  "color",
  "background",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "border",
  "border-radius",
  "box-shadow",
  "opacity",
  "transform",
];

let selectedElement: Element | undefined;
let selectedSnapshot: ElementSnapshot | undefined;
let selectedSeq = 0;
let selectedMarkersVisible = true;
const selectedElements: SelectedElementEntry[] = [];
const selectedMarkers = new Map<string, SelectedMarker>();
let cssPatchSeq = 0;
const cssPatches = new Map<string, CssPatch>();
let latestBaseline: DesignBaseline | undefined;

function escapeSelectorPart(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (css?.escape) return css.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
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

function snapshotElement(element: Element): ElementSnapshot {
  const rect = element.getBoundingClientRect();
  return {
    selector: selectorFor(element),
    tag: element.tagName.toLowerCase(),
    id: element.id || undefined,
    classes: [...element.classList].filter(Boolean),
    text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 300) || undefined,
    attributes: Object.fromEntries([...element.attributes].slice(0, 30).map((a) => [a.name, a.value])),
    rect: {
      x: rect.x,
      y: rect.y,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    },
    pickedAt: new Date().toISOString(),
  };
}

function markerLabel(snapshot: ElementSnapshot): string {
  const prefix = snapshot.name || (snapshot.index ? `Selected ${snapshot.index}` : "Selected");
  return `${prefix} for agent: ${snapshot.selector}`;
}

function removeSelectedMarker(id?: string): void {
  if (id) {
    const marker = selectedMarkers.get(id);
    if (!marker) return;
    clearInterval(marker.timer);
    marker.overlay.remove();
    marker.label.remove();
    selectedMarkers.delete(id);
    return;
  }

  for (const marker of selectedMarkers.values()) {
    clearInterval(marker.timer);
    marker.overlay.remove();
    marker.label.remove();
  }
  selectedMarkers.clear();
  document.querySelectorAll(`[${SELECTED_MARKER_ATTR}]`).forEach((node) => node.remove());
}

function selectedIndex(entry: SelectedElementEntry): number {
  return selectedElements.indexOf(entry);
}

function decorateSnapshot(entry: SelectedElementEntry, snapshot: ElementSnapshot): ElementSnapshot {
  const index = selectedIndex(entry);
  const decorated = {
    ...snapshot,
    selectionId: entry.id,
    index: index >= 0 ? index + 1 : undefined,
    primary: selectedElements[selectedElements.length - 1] === entry,
    name: entry.name,
    group: entry.group,
  } satisfies ElementSnapshot;
  decorated.marker = {
    visible: !!selectedMarkers.get(entry.id)?.overlay.isConnected,
    color: "yellow-transparent",
    label: markerLabel(decorated),
  };
  return decorated;
}

function syncSelectedEntry(entry: SelectedElementEntry): ElementSnapshot {
  if (entry.element?.isConnected) entry.snapshot = snapshotElement(entry.element);
  else {
    const found = document.querySelector(entry.snapshot.selector);
    if (found) {
      entry.element = found;
      entry.snapshot = snapshotElement(found);
    }
  }
  const snapshot = decorateSnapshot(entry, entry.snapshot);
  entry.snapshot = snapshot;
  return snapshot;
}

function syncPrimarySelection(): ElementSnapshot | undefined {
  const entry = selectedElements[selectedElements.length - 1];
  if (!entry) {
    selectedElement = undefined;
    selectedSnapshot = undefined;
    return undefined;
  }
  const snapshot = syncSelectedEntry(entry);
  selectedElement = entry.element;
  selectedSnapshot = snapshot;
  return snapshot;
}

function positionSelectedMarker(entry: SelectedElementEntry): void {
  const marker = selectedMarkers.get(entry.id);
  const element = entry.element;
  if (!marker || !element?.isConnected) return;

  const snapshot = syncSelectedEntry(entry);
  const rect = element.getBoundingClientRect();
  const offscreen =
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.bottom < 0 ||
    rect.right < 0 ||
    rect.top > innerHeight ||
    rect.left > innerWidth;
  marker.overlay.style.display = offscreen ? "none" : "block";
  marker.label.style.display = offscreen ? "none" : "block";
  if (offscreen) return;

  marker.overlay.style.left = `${rect.left}px`;
  marker.overlay.style.top = `${rect.top}px`;
  marker.overlay.style.width = `${rect.width}px`;
  marker.overlay.style.height = `${rect.height}px`;
  marker.label.textContent = markerLabel(snapshot);
  marker.label.style.left = `${Math.min(Math.max(8, rect.left), Math.max(8, innerWidth - 340))}px`;
  marker.label.style.top = `${Math.max(8, rect.top - 34)}px`;
}

function showMarkerForEntry(entry: SelectedElementEntry): ElementSnapshot | undefined {
  const element = entry.element?.isConnected
    ? entry.element
    : document.querySelector(entry.snapshot.selector) ?? undefined;
  if (!element) return undefined;

  entry.element = element;
  entry.snapshot = snapshotElement(element);
  removeSelectedMarker(entry.id);

  const overlay = document.createElement("div");
  const label = document.createElement("div");
  overlay.setAttribute(SELECTED_MARKER_ATTR, `${entry.id}:overlay`);
  label.setAttribute(SELECTED_MARKER_ATTR, `${entry.id}:label`);
  Object.assign(overlay.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483646",
    border: "2px solid #facc15",
    borderRadius: "8px",
    background: "rgba(250, 204, 21, 0.28)",
    boxShadow: "0 0 0 4px rgba(250, 204, 21, 0.24), 0 10px 28px rgba(161, 98, 7, 0.20)",
  });
  Object.assign(label.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483647",
    maxWidth: "330px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    padding: "6px 9px",
    borderRadius: "8px",
    background: "#facc15",
    color: "#1f2937",
    font: "12px system-ui, -apple-system, Segoe UI, sans-serif",
    fontWeight: "700",
    boxShadow: "0 8px 24px rgba(161, 98, 7, 0.28)",
  });
  document.documentElement.append(overlay, label);

  selectedMarkers.set(entry.id, {
    overlay,
    label,
    timer: setInterval(() => {
      if (!entry.element?.isConnected) {
        removeSelectedMarker(entry.id);
        return;
      }
      positionSelectedMarker(entry);
    }, 150),
  });
  positionSelectedMarker(entry);
  return syncSelectedEntry(entry);
}

export function showSelectedElementMarker(): ElementSnapshot | undefined {
  selectedMarkersVisible = true;
  for (const entry of selectedElements) showMarkerForEntry(entry);
  return syncPrimarySelection();
}

export function hideSelectedElementMarker(): void {
  selectedMarkersVisible = false;
  removeSelectedMarker();
}

export function setSelectedMarkersVisible(visible: boolean): void {
  selectedMarkersVisible = visible;
  if (visible) showSelectedElementMarker();
  else removeSelectedMarker();
}

export function getSelectedMarkersVisible(): boolean {
  return selectedMarkersVisible;
}

export function clearSelectedElements(): void {
  removeSelectedMarker();
  selectedElements.length = 0;
  selectedElement = undefined;
  selectedSnapshot = undefined;
}

export function removeSelectedElement(id: string): boolean {
  const index = selectedElements.findIndex((entry) => entry.id === id);
  if (index === -1) return false;
  removeSelectedMarker(id);
  selectedElements.splice(index, 1);
  syncPrimarySelection();
  for (const entry of selectedElements) positionSelectedMarker(entry);
  return true;
}

export function setSelectedElementMeta(id: string, meta: { name?: string; group?: string }): boolean {
  const entry = selectedElements.find((item) => item.id === id);
  if (!entry) return false;
  if (Object.prototype.hasOwnProperty.call(meta, "name")) entry.name = meta.name?.trim() || undefined;
  if (Object.prototype.hasOwnProperty.call(meta, "group")) entry.group = meta.group?.trim() || undefined;
  entry.snapshot = decorateSnapshot(entry, entry.snapshot);
  positionSelectedMarker(entry);
  syncPrimarySelection();
  return true;
}

function selectedEntry(selectionId: unknown): SelectedElementEntry | undefined {
  const id = typeof selectionId === "string" ? selectionId.trim() : "";
  if (id) return selectedElements.find((entry) => entry.id === id);
  return selectedElements[selectedElements.length - 1];
}

export function setSelectedElement(
  element: Element | undefined,
  opts: { append?: boolean } = {},
): ElementSnapshot | undefined {
  if (!element) {
    clearSelectedElements();
    return undefined;
  }
  if (!opts.append) clearSelectedElements();

  const entry: SelectedElementEntry = {
    id: `sel-${++selectedSeq}`,
    element,
    snapshot: snapshotElement(element),
  };
  selectedElements.push(entry);
  if (selectedMarkersVisible) showMarkerForEntry(entry);
  return syncPrimarySelection();
}

export function getSelectedElementSnapshot(): ElementSnapshot | undefined {
  return syncPrimarySelection();
}

export function getSelectedElementSnapshots(): ElementSnapshot[] {
  return selectedElements.map(syncSelectedEntry);
}

function targetElement(selector: unknown): Element {
  if (typeof selector === "string" && selector.trim()) return el(selector.trim());
  if (selectedElement?.isConnected) return selectedElement;
  if (selectedSnapshot?.selector) return el(selectedSnapshot.selector);
  throw new Error("No selector provided and no element has been picked from the extension popup yet.");
}

function targetSelector(selector: unknown): string | undefined {
  if (typeof selector === "string" && selector.trim()) return selector.trim();
  return getSelectedElementSnapshot()?.selector;
}

function renderCss(selector: string | undefined, css: string): string {
  const trimmed = css.trim();
  if (!trimmed) throw new Error("CSS cannot be empty.");
  if (!selector) return trimmed;
  if (trimmed.includes("{")) {
    throw new Error(
      "Targeted CSS patches must use declarations only (for example: color:red;). Complete CSS rules are page-wide; omit selector and avoid an active picked element only when that is intentional.",
    );
  }
  return `${selector} {\n${trimmed}\n}`;
}

function styleHost(): HTMLElement {
  return document.head ?? document.body ?? document.documentElement;
}

function addCssPatch(selector: string | undefined, css: string, reason: string | undefined): CssPatch {
  const renderedCss = renderCss(selector, css);
  if (!selector && !renderedCss.includes("{")) {
    throw new Error("Provide a selector, pick an element from the popup, or pass complete CSS rules.");
  }

  const id = `css-${++cssPatchSeq}`;
  const patch: CssPatch = {
    id,
    selector,
    css: css.trim(),
    renderedCss,
    reason,
    createdAt: new Date().toISOString(),
  };
  const style = document.createElement("style");
  style.setAttribute(CSS_PATCH_ATTR, id);
  style.textContent = `/* mcp-page-bridge ${id}${reason ? `: ${reason}` : ""} */\n${renderedCss}`;
  styleHost().append(style);
  cssPatches.set(id, patch);
  return patch;
}

export function removeCssPatch(id: string): boolean {
  document.querySelector(`style[${CSS_PATCH_ATTR}="${escapeSelectorPart(id)}"]`)?.remove();
  return cssPatches.delete(id);
}

export function clearCssPatches(): number {
  const count = cssPatches.size;
  for (const id of [...cssPatches.keys()]) removeCssPatch(id);
  return count;
}

export function getCssPatches(): CssPatch[] {
  return [...cssPatches.values()];
}

export function exportCssPatches(): string {
  const patches = getCssPatches();
  if (!patches.length) return "/* No mcp-page-bridge CSS patches on this page. */";
  return patches
    .map((patch) => [
      `/* ${patch.id}${patch.reason ? `: ${patch.reason}` : ""} */`,
      patch.renderedCss,
    ].join("\n"))
    .join("\n\n");
}

function computedStyleFor(element: Element, properties: unknown): Record<string, string> {
  const style = getComputedStyle(element);
  const props = Array.isArray(properties) && properties.length ? properties.map(String) : DEFAULT_STYLE_PROPS;
  return Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]));
}

function highlightElement(element: Element, durationMs: number): void {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483647",
    border: "2px solid #7c3aed",
    borderRadius: "8px",
    background: "rgba(124, 58, 237, 0.14)",
    boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.10)",
  });

  const update = (): void => {
    const rect = element.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  };
  update();
  document.documentElement.append(overlay);

  const timer = setInterval(update, 100);
  setTimeout(() => {
    clearInterval(timer);
    overlay.remove();
  }, Math.max(250, durationMs));
}

function elementText(element: Element): string {
  return (element.textContent ?? "").trim().replace(/\s+/g, " ");
}

function labelTextForInput(element: Element): string {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
    return "";
  }
  const labels = "labels" in element ? [...(element.labels ?? [])].map(elementText).join(" ") : "";
  return labels.trim();
}

function accessibleName(element: Element): string {
  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;
  const labelledBy = element.getAttribute("aria-labelledby")?.trim();
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (text) return text;
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

function parseRgb(value: string): { r: number; g: number; b: number; a: number } | undefined {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return undefined;
  const parts = match[1]!.split(",").map((part) => part.trim());
  const r = Number(parts[0]);
  const g = Number(parts[1]);
  const b = Number(parts[2]);
  const a = parts[3] === undefined ? 1 : Number(parts[3]);
  if ([r, g, b, a].some((part) => Number.isNaN(part))) return undefined;
  return { r, g, b, a };
}

function effectiveBackground(element: Element): string {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const bg = parseRgb(getComputedStyle(node).backgroundColor);
    if (bg && bg.a > 0) return `rgb(${bg.r}, ${bg.g}, ${bg.b})`;
  }
  return "rgb(255, 255, 255)";
}

function luminance(part: number): number {
  const v = part / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foreground: string, background: string): number | undefined {
  const fg = parseRgb(foreground);
  const bg = parseRgb(background);
  if (!fg || !bg || fg.a === 0) return undefined;
  const l1 = 0.2126 * luminance(fg.r) + 0.7152 * luminance(fg.g) + 0.0722 * luminance(fg.b);
  const l2 = 0.2126 * luminance(bg.r) + 0.7152 * luminance(bg.g) + 0.0722 * luminance(bg.b);
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

function directText(element: Element): string {
  return [...element.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}

function accessibilityAudit(selector: unknown, maxElements: unknown): Record<string, unknown> {
  const root = typeof selector === "string" && selector.trim() ? el(selector.trim()) : document.body;
  const max = Math.max(20, Math.min(1000, Number(maxElements ?? 250) || 250));
  const issues: Array<{ impact: string; selector: string; message: string; detail?: string }> = [];
  const add = (impact: string, element: Element, message: string, detail?: string): void => {
    issues.push({ impact, selector: selectorFor(element), message, detail });
  };

  const all = [root, ...[...root.querySelectorAll("*")].slice(0, max - 1)];
  const seenIds = new Map<string, Element>();
  for (const element of all) {
    if (element.id) {
      const first = seenIds.get(element.id);
      if (first) add("serious", element, `Duplicate id "${element.id}"`, `First seen at ${selectorFor(first)}`);
      else seenIds.set(element.id, element);
    }
  }

  for (const image of all.filter((element): element is HTMLImageElement => element instanceof HTMLImageElement)) {
    if (!image.hasAttribute("alt")) add("serious", image, "Image is missing alt text.");
  }

  const interactive = all.filter((element) =>
    element.matches('button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [tabindex]'),
  );
  for (const element of interactive) {
    if (!isVisibleElement(element)) continue;
    if (!accessibleName(element)) add("serious", element, "Interactive element has no accessible name.");
  }

  let previousHeading = 0;
  for (const heading of all.filter((element) => /^H[1-6]$/.test(element.tagName))) {
    const level = Number(heading.tagName.slice(1));
    if (previousHeading && level > previousHeading + 1) {
      add("moderate", heading, `Heading level jumps from h${previousHeading} to h${level}.`);
    }
    previousHeading = level;
  }

  const textElements = all.filter((element) => directText(element) && isVisibleElement(element)).slice(0, max);
  for (const element of textElements) {
    const style = getComputedStyle(element);
    const ratio = contrastRatio(style.color, effectiveBackground(element));
    if (!ratio) continue;
    const size = Number.parseFloat(style.fontSize || "0");
    const weight = Number.parseFloat(style.fontWeight || "400");
    const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    if (ratio < required) add("moderate", element, `Text contrast is ${ratio.toFixed(2)}:1; expected at least ${required}:1.`);
  }

  return {
    checked: all.length,
    truncated: root.querySelectorAll("*").length + 1 > max,
    counts: issues.reduce<Record<string, number>>((acc, issue) => {
      acc[issue.impact] = (acc[issue.impact] ?? 0) + 1;
      return acc;
    }, {}),
    issues: issues.slice(0, 100),
  };
}

function collectMediaQueries(maxRules: unknown): string[] {
  const max = Math.max(20, Math.min(500, Number(maxRules ?? 120) || 120));
  const found: string[] = [];
  const visitRules = (rules: CSSRuleList): void => {
    for (const rule of [...rules]) {
      if (found.length >= max) return;
      if (rule instanceof CSSMediaRule) {
        found.push(rule.conditionText);
        visitRules(rule.cssRules);
      } else if ("cssRules" in rule) {
        try {
          visitRules((rule as CSSGroupingRule).cssRules);
        } catch {
          // Cross-origin or unsupported rules are skipped.
        }
      }
    }
  };
  for (const sheet of [...document.styleSheets]) {
    if (found.length >= max) break;
    try {
      if (sheet.cssRules) visitRules(sheet.cssRules);
    } catch {
      // Cross-origin stylesheet.
    }
  }
  return [...new Set(found)];
}

export function registerBuiltins(
  server: EmbeddedMcpServer,
  opts: { extCall: ExtCall; console: ConsoleBuffer; includeEval?: boolean; coreTools?: boolean; designTools?: boolean; automationTools?: boolean; cdpTools?: boolean; trustedInput?: boolean },
): void {
  const captureScreenshot = async (): Promise<{ dataUrl: string; base64: string }> => {
    const res = (await opts.extCall("screenshot", { download: false })) as { dataUrl: string };
    const base64 = res.dataUrl.includes(",") ? res.dataUrl.slice(res.dataUrl.indexOf(",") + 1) : res.dataUrl;
    return { dataUrl: res.dataUrl, base64 };
  };

  if (opts.coreTools !== false) {
    // `eval` runs arbitrary JS in the page. It's the most powerful built-in, so a
    // page can opt out of it (window.mcp.allowEval(false)) while keeping the other
    // built-ins. Defaults to on to preserve existing behavior.
    if (opts.includeEval !== false) {
    server.registerTool(
    {
      name: "eval",
      description:
        "Run JS in the page and return the result (expression or statements; async/await ok). Strict page CSP (e.g. GitHub) blocks this — use the DOM/CSS tools there instead.",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string", description: "JS to run" } },
        required: ["code"],
      },
    },
    async (args) => {
      try {
        const result = await runEval(String(args.code ?? ""));
        return json(result === undefined ? "undefined" : result);
      } catch (error) {
        const hint = error instanceof Error ? cspEvalHint(error) : undefined;
        return {
          content: [{ type: "text", text: `eval error: ${hint ?? (error as Error).message}` }],
          isError: true,
        } satisfies ToolResult;
      }
    },
    );
  }

  server.registerTool(
    {
      name: "dom_query",
      description: "Query the DOM by CSS selector; returns tag/id/classes/text/attributes of matches.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          limit: { type: "number", description: "max (default 20)" },
          includeHtml: { type: "boolean", description: "include truncated outerHTML" },
        },
        required: ["selector"],
      },
    },
    (args) => {
      const limit = Number(args.limit ?? 20);
      const nodes = [...document.querySelectorAll(String(args.selector))].slice(0, limit);
      return json(
        nodes.map((e) => ({
          tag: e.tagName.toLowerCase(),
          id: e.id || undefined,
          classes: e.className || undefined,
          text: (e.textContent ?? "").trim().slice(0, 200),
          attributes: Object.fromEntries([...e.attributes].map((a) => [a.name, a.value])),
          html: args.includeHtml ? e.outerHTML.slice(0, 1000) : undefined,
        })),
      );
    },
  );

  server.registerTool(
    {
      name: "get_page_info",
      description: "Page url, title, readyState, viewport, and user agent.",
      inputSchema: { type: "object", properties: {} },
    },
    () =>
      json({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        viewport: { width: innerWidth, height: innerHeight },
        userAgent: navigator.userAgent,
      }),
  );

  server.registerTool(
    {
      name: "set_value",
      description:
        "Set an input/textarea/select value in one shot and fire input+change events. " +
        "Prefer type_text when the page reacts to typing (autocomplete, search-as-you-type, validation on keystrokes).",
      inputSchema: {
        type: "object",
        properties: { selector: { type: "string" }, value: { type: "string" }, observe: observeProperty("none") },
        required: ["selector", "value"],
      },
    },
    (args) => {
      const node = el(String(args.selector)) as HTMLInputElement;
      node.value = String(args.value ?? "");
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return withObservation(text(`set ${args.selector} = ${args.value}`), observeMode(args, "none"), { extCall: opts.extCall });
    },
  );

  server.registerTool(
    {
      name: "scroll",
      description: "Scroll to a selector or to x/y.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          observe: observeProperty("snapshot"),
        },
      },
    },
    (args) => {
      const observe = observeMode(args);
      if (args.selector) {
        el(String(args.selector)).scrollIntoView({ behavior: "smooth", block: "center" });
        return withObservation(text(`scrolled to ${args.selector}`), observe, { extCall: opts.extCall, settleMs: 400 });
      }
      window.scrollTo({ left: Number(args.x ?? 0), top: Number(args.y ?? 0), behavior: "smooth" });
      return withObservation(text(`scrolled to (${args.x ?? 0}, ${args.y ?? 0})`), observe, { extCall: opts.extCall, settleMs: 400 });
    },
  );

  server.registerTool(
    {
      name: "wait_for",
      description: "Wait until a selector appears (or time out).",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          timeoutMs: { type: "number", description: "default 5000" },
        },
        required: ["selector"],
      },
    },
    async (args) => {
      const selector = String(args.selector);
      const timeout = Number(args.timeoutMs ?? 5000);
      const start = Date.now();
      for (;;) {
        if (document.querySelector(selector)) return text(`found ${selector}`);
        if (Date.now() - start > timeout) {
          return {
            content: [{ type: "text", text: `timeout waiting for ${selector}` }],
            isError: true,
          } satisfies ToolResult;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  );

  server.registerTool(
    {
      name: "get_html",
      description: "outerHTML of a selector (or whole document), truncated.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          max: { type: "number", description: "max chars (default 5000)" },
        },
      },
    },
    (args) => {
      const max = Number(args.max ?? 5000);
      const html = args.selector
        ? el(String(args.selector)).outerHTML
        : document.documentElement.outerHTML;
      return text(html.length > max ? `${html.slice(0, max)}…(${html.length - max} more)` : html);
    },
  );
  }

  // Input primitives (click / type_text / press_key / clear_value) are shared:
  // they belong to the core toolset, but stay available when a page turns core
  // tools off and only enables the automation toolset.
  if (opts.coreTools !== false || opts.automationTools) {
    registerInputTools(server, { extCall: opts.extCall, trustedInput: opts.trustedInput });
  }

  if (opts.automationTools) registerAutomationTools(server, { extCall: opts.extCall });
  if (opts.cdpTools) registerCdpTools(server, { extCall: opts.extCall });

  // ---- design / selection toolset (opt-in) ----
  // Off by default to keep the built-in catalog small (fewer tokens in the
  // agent's tool list). Enabled via the popup "Design tools" switch, which the
  // service worker forwards on the activate control message.
  if (opts.designTools) {
  server.registerTool(
    {
      name: "get_selected_element",
      description:
        "The element picked in the popup — the 'yellow/selected place'. Returns its selector and geometry.",
      inputSchema: { type: "object", properties: {} },
    },
    () =>
      json(
        getSelectedElementSnapshot() ?? {
          selected: false,
          message: "No element has been picked from the extension popup yet.",
        },
      ),
  );

  server.registerTool(
    {
      name: "get_selected_elements",
      description: "All elements picked in the popup (last item is primary).",
      inputSchema: { type: "object", properties: {} },
    },
    () => json(getSelectedElementSnapshots()),
  );

  server.registerTool(
    {
      name: "get_computed_style",
      description: "Computed CSS for a selector, or the picked element if omitted.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "Omit to use the picked element." },
          properties: {
            type: "array",
            items: { type: "string" },
            description: "Props to return (default common design props).",
          },
        },
      },
    },
    (args) => {
      const element = targetElement(args.selector);
      return json({ element: snapshotElement(element), styles: computedStyleFor(element, args.properties) });
    },
  );

  server.registerTool(
    {
      name: "highlight_element",
      description: "Briefly highlight a selector, or the picked element if omitted.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "Omit to use the picked element." },
          durationMs: { type: "number", description: "ms (default 2000)" },
        },
      },
    },
    (args) => {
      const element = targetElement(args.selector);
      highlightElement(element, Number(args.durationMs ?? 2000));
      return text(`highlighted ${snapshotElement(element).selector}`);
    },
  );

  server.registerTool(
    {
      name: "show_selected_marker",
      description: "Show the persistent marker on the picked element, or on a selector.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "Omit to use the picked element." },
        },
      },
    },
    (args) => {
      if (typeof args.selector === "string" && args.selector.trim()) setSelectedElement(el(args.selector.trim()));
      const snapshot = showSelectedElementMarker();
      return snapshot ? json(snapshot) : text("no selected element to mark");
    },
  );

  server.registerTool(
    {
      name: "hide_selected_marker",
      description: "Hide selection markers (selections stay remembered).",
      inputSchema: { type: "object", properties: {} },
    },
    () => {
      hideSelectedElementMarker();
      return text("selected marker hidden");
    },
  );

  server.registerTool(
    {
      name: "clear_selected_elements",
      description: "Forget all picked elements and their markers.",
      inputSchema: { type: "object", properties: {} },
    },
    () => {
      const count = getSelectedElementSnapshots().length;
      clearSelectedElements();
      return text(`cleared ${count} selected element(s)`);
    },
  );

  server.registerTool(
    {
      name: "remove_selected_element",
      description: "Forget one picked element by selectionId.",
      inputSchema: {
        type: "object",
        properties: { selectionId: { type: "string" } },
        required: ["selectionId"],
      },
    },
    (args) => {
      const id = String(args.selectionId ?? "");
      return removeSelectedElement(id) ? text(`removed selected element ${id}`) : text(`no selected element found for ${id}`);
    },
  );

  server.registerTool(
    {
      name: "update_selected_element",
      description: "Set name/group for a picked element.",
      inputSchema: {
        type: "object",
        properties: {
          selectionId: { type: "string", description: "Omit for the latest selection." },
          name: { type: "string", description: "Name (empty clears)." },
          group: { type: "string", description: "Group (empty clears)." },
        },
      },
    },
    (args) => {
      const entry = selectedEntry(args.selectionId);
      if (!entry) return text("no selected element to update");
      const meta: { name?: string; group?: string } = {};
      if (Object.prototype.hasOwnProperty.call(args, "name")) meta.name = String(args.name ?? "");
      if (Object.prototype.hasOwnProperty.call(args, "group")) meta.group = String(args.group ?? "");
      setSelectedElementMeta(entry.id, meta);
      return json(syncSelectedEntry(entry));
    },
  );

  server.registerTool(
    {
      name: "apply_css",
      description:
        "Apply a temporary, reversible CSS patch (returns a patch id). For the picked/selected element, omit selector and pass declarations only (e.g. color:red); it is scoped to that element. Full rules like `.x{...}` are page-wide and rejected when a selector or picked element is targeted.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "Omit to target the picked element." },
          css: {
            type: "string",
            description: "Declarations (color:red;) for a selector/picked element, or full rules for page-wide changes.",
          },
          reason: { type: "string", description: "Why (optional)." },
        },
        required: ["css"],
      },
    },
    (args) => {
      const css = String(args.css ?? "");
      const selector = targetSelector(args.selector);
      const patch = addCssPatch(selector, css, args.reason ? String(args.reason) : undefined);
      return json({ patch, totalPatches: cssPatches.size });
    },
  );

  server.registerTool(
    {
      name: "list_css_patches",
      description: "List active temporary CSS patches.",
      inputSchema: { type: "object", properties: {} },
    },
    () => json([...cssPatches.values()]),
  );

  server.registerTool(
    {
      name: "remove_css_patch",
      description: "Remove one temporary CSS patch by id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    (args) => {
      const id = String(args.id ?? "");
      return removeCssPatch(id) ? text(`removed ${id}`) : text(`no CSS patch found for ${id}`);
    },
  );

  server.registerTool(
    {
      name: "clear_css_patches",
      description: "Remove all temporary CSS patches.",
      inputSchema: { type: "object", properties: {} },
    },
    () => text(`removed ${clearCssPatches()} CSS patch(es)`),
  );

  server.registerTool(
    {
      name: "export_css_patches",
      description: "Return active CSS patches as source-ready CSS.",
      inputSchema: { type: "object", properties: {} },
    },
    () => text(exportCssPatches()),
  );

  server.registerTool(
    {
      name: "export_design_changes",
      description: "Return picked elements + CSS patches as a migration bundle for source code.",
      inputSchema: { type: "object", properties: {} },
    },
    () =>
      json({
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        selectedElements: getSelectedElementSnapshots(),
        cssPatches: getCssPatches(),
        css: exportCssPatches(),
      }),
  );

  server.registerTool(
    {
      name: "accessibility_audit",
      description: "Lightweight a11y audit for the page or a selector.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "Root (default body)." },
          maxElements: { type: "number", description: "max elements (default 250, max 1000)" },
        },
      },
    },
    (args) => json(accessibilityAudit(args.selector, args.maxElements)),
  );

  server.registerTool(
    {
      name: "responsive_summary",
      description: "Viewport, picked-element geometry, and page media queries.",
      inputSchema: {
        type: "object",
        properties: {
          maxRules: { type: "number", description: "max media rules (default 120)" },
        },
      },
    },
    (args) =>
      json({
        viewport: {
          width: innerWidth,
          height: innerHeight,
          devicePixelRatio,
          orientation: innerWidth >= innerHeight ? "landscape" : "portrait",
        },
        mediaQueries: collectMediaQueries(args.maxRules),
        selectedElements: getSelectedElementSnapshots(),
        note: "This summarizes the live viewport. Use browser devtools or source changes for real viewport emulation.",
      }),
  );

  server.registerTool(
    {
      name: "debug_summary",
      description: "Compact debug: page state, console errors/warnings, selections, patch count.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "recent console entries (default 20)" },
        },
      },
    },
    (args) => {
      const limit = Number(args.limit ?? 20);
      const entries = opts.console.entries.slice(-limit);
      const counts = opts.console.entries.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.level] = (acc[entry.level] ?? 0) + 1;
        return acc;
      }, {});
      return json({
        page: {
          url: location.href,
          title: document.title,
          readyState: document.readyState,
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        },
        console: {
          counts,
          recent: entries,
          recentErrors: entries.filter((entry) => entry.level === "error"),
          recentWarnings: entries.filter((entry) => entry.level === "warn"),
        },
        selectedElements: getSelectedElementSnapshots(),
        cssPatchCount: cssPatches.size,
        network: "Network capture is not enabled by mcp-page-bridge; use page tools or DevTools for request-level details.",
      });
    },
  );
  } // end design/selection toolset

  if (opts.coreTools !== false) {
  server.registerTool(
    {
      name: "console_logs",
      description: "Recent console output and page errors.",
      inputSchema: {
        type: "object",
        properties: {
          level: { type: "string", description: "filter: log|info|warn|error|debug" },
          limit: { type: "number", description: "max entries (default 50)" },
        },
      },
    },
    (args) => {
      const limit = Number(args.limit ?? 50);
      let entries = opts.console.entries;
      if (args.level) entries = entries.filter((e) => e.level === args.level);
      return json(entries.slice(-limit));
    },
  );
  }

  // ---- design baseline tools (opt-in, delegated to the service worker) ----
  if (opts.designTools) {
  server.registerTool(
    {
      name: "capture_design_baseline",
      description: "Capture a baseline screenshot for later before/after compare.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string", description: "label (default baseline)" },
        },
      },
    },
    async (args) => {
      const shot = await captureScreenshot();
      latestBaseline = {
        label: String(args.label ?? "baseline").trim() || "baseline",
        dataUrl: shot.dataUrl,
        base64: shot.base64,
        capturedAt: new Date().toISOString(),
        viewport: { width: innerWidth, height: innerHeight },
        url: location.href,
        title: document.title,
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(safeSerialize({ ...latestBaseline, dataUrl: undefined, base64: undefined }), null, 2) },
          { type: "image", data: shot.base64, mimeType: "image/png" },
        ],
      } satisfies ToolResult;
    },
  );

  server.registerTool(
    {
      name: "compare_design_baseline",
      description: "Screenshot now and compare to the saved baseline (before/after).",
      inputSchema: { type: "object", properties: {} },
    },
    async () => {
      if (!latestBaseline) {
        return { content: [{ type: "text", text: "No design baseline captured yet. Call capture_design_baseline first." }], isError: true };
      }
      const current = await captureScreenshot();
      const summary = {
        baseline: {
          label: latestBaseline.label,
          capturedAt: latestBaseline.capturedAt,
          viewport: latestBaseline.viewport,
          url: latestBaseline.url,
          title: latestBaseline.title,
        },
        current: {
          capturedAt: new Date().toISOString(),
          viewport: { width: innerWidth, height: innerHeight },
          url: location.href,
          title: document.title,
        },
        exactPngMatch: latestBaseline.base64 === current.base64,
        note: "Pixel diffing is not performed in-page; both images are returned for visual before/after review.",
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(safeSerialize(summary), null, 2) },
          { type: "text", text: "Baseline:" },
          { type: "image", data: latestBaseline.base64, mimeType: "image/png" },
          { type: "text", text: "Current:" },
          { type: "image", data: current.base64, mimeType: "image/png" },
        ],
      } satisfies ToolResult;
    },
  );

  server.registerTool(
    {
      name: "clear_design_baseline",
      description: "Forget the saved screenshot baseline.",
      inputSchema: { type: "object", properties: {} },
    },
    () => {
      const hadBaseline = !!latestBaseline;
      latestBaseline = undefined;
      return text(hadBaseline ? "design baseline cleared" : "no design baseline was stored");
    },
  );
  } // end design baseline tools

  if (opts.coreTools !== false) {
  // ---- core extension-backed tools (delegated to the service worker) ----

  server.registerTool(
    {
      name: "screenshot",
      description:
        "PNG screenshot of the tab. fullPage:true captures the whole scrollable page (needs the optional debugger permission), " +
        "refs:true labels every element from the last snapshot with its uid so the image and the uid tree line up, " +
        "download:true also saves it to Downloads.",
      inputSchema: {
        type: "object",
        properties: {
          fullPage: { type: "boolean", description: "capture beyond the viewport (default false)" },
          refs: { type: "boolean", description: "overlay uid labels from the last snapshot (default false)" },
          download: { type: "boolean", description: "also save to Downloads" },
          filename: { type: "string", description: "download filename" },
        },
      },
    },
    async (args) => {
      const withRefs = args.refs === true;
      let markers = 0;
      if (withRefs) {
        try {
          const shown = (await opts.extCall("frameOverlay", { show: true })) as { markers?: number };
          markers = shown?.markers ?? 0;
        } catch {
          markers = showUidOverlay();
        }
        // Give the compositor a frame to paint the markers.
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      try {
        const res = (await opts.extCall("screenshot", {
          download: !!args.download,
          filename: args.filename ? String(args.filename) : undefined,
          fullPage: args.fullPage === true,
        })) as { dataUrl: string; savedAs?: string; fullPage?: boolean; fullPageError?: string };
        const base64 = res.dataUrl.includes(",")
          ? res.dataUrl.slice(res.dataUrl.indexOf(",") + 1)
          : res.dataUrl;
        const content: ContentBlock[] = [{ type: "image", data: base64, mimeType: "image/png" }];
        if (withRefs) {
          content.push({ type: "text", text: `${markers} uid label(s) drawn from the last snapshot.` });
        }
        if (res.fullPageError) content.push({ type: "text", text: `full page unavailable (${res.fullPageError}); captured the viewport instead` });
        if (res.savedAs) content.push({ type: "text", text: `Saved to Downloads as ${res.savedAs}` });
        return { content } satisfies ToolResult;
      } finally {
        if (withRefs) {
          try {
            await opts.extCall("frameOverlay", { show: false });
          } catch {
            hideUidOverlay();
          }
        }
      }
    },
  );

  server.registerTool(
    {
      name: "navigate",
      description: "Navigate the tab to a URL.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
    async (args) => {
      await opts.extCall("navigate", { url: String(args.url) });
      return text(`navigating to ${args.url}`);
    },
  );

  server.registerTool(
    {
      name: "reload",
      description: "Reload the tab.",
      inputSchema: { type: "object", properties: {} },
    },
    async () => {
      await opts.extCall("reload");
      return text("reloading");
    },
  );
  }
}
