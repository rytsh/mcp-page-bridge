/** Persistent, click-through page annotations. No page styles or content are changed. */
import type { EmbeddedMcpServer } from "./embedded-server.js";
import { isFrameUid, json, querySelectorAllDeep, resolveUid } from "./dom-core.js";

const MAX_ANNOTATIONS = 50;
const HOST_ID = "__mcp-page-bridge-annotations";
const DEFAULT_COLOR = "#facc15";
type AnnotationStyle = "highlight" | "circle" | "outline";

interface Annotation {
  id: string;
  selector?: string;
  uid?: string;
  style: AnnotationStyle;
  color: string;
  text: string;
  padding: number;
  element: Element;
  expiresAt: number;
}

interface Marker extends Annotation {
  box: HTMLDivElement;
  label: HTMLDivElement;
  arrow: SVGSVGElement;
  path: SVGPathElement;
}

const markers = new Map<string, Marker>();
let sequence = 0;
let host: HTMLDivElement | undefined;
let root: ShadowRoot | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function integer(value: unknown, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}.`);
  }
  return value;
}

function parseAnnotation(value: unknown, expiresAt: number): Annotation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each annotation must be an object.");
  const input = value as Record<string, unknown>;
  const selector = typeof input.selector === "string" ? input.selector.trim() : undefined;
  const uid = typeof input.uid === "string" ? input.uid.trim() : undefined;
  if (!!selector === !!uid) throw new Error("Each annotation needs exactly one selector or uid.");
  if (isFrameUid(uid)) throw new Error("Frame uids are not supported by annotate_page; target an element in the main document.");
  const style = input.style ?? "highlight";
  if (style !== "highlight" && style !== "circle" && style !== "outline") throw new Error("style must be highlight, circle, or outline.");
  const color = input.color ?? DEFAULT_COLOR;
  if (typeof color !== "string" || !/^#[\da-f]{6}$/i.test(color)) throw new Error("color must be a six-digit hex color, such as #ef4444.");
  if (input.text !== undefined && (typeof input.text !== "string" || input.text.length > 1000)) {
    throw new Error("text must be a plain-text string of at most 1000 characters.");
  }
  if (input.id !== undefined && (typeof input.id !== "string" || !input.id.trim() || input.id.length > 100)) {
    throw new Error("id must be a non-empty string of at most 100 characters.");
  }
  let element: Element;
  if (uid) element = resolveUid(uid);
  else {
    const matches = querySelectorAllDeep(selector!);
    if (matches.length !== 1) throw new Error(`Selector "${selector}" matches ${matches.length} elements; use a selector for exactly one element or a snapshot uid.`);
    element = matches[0]!;
  }
  if (element.id === HOST_ID || host?.contains(element) || element.getRootNode() === root) {
    throw new Error("Cannot annotate the annotation overlay itself.");
  }
  return {
    id: typeof input.id === "string" ? input.id.trim() : `annotation-${++sequence}`,
    selector, uid, style, color, text: (input.text as string | undefined) ?? "",
    padding: integer(input.padding, 6, 32, "padding"), element, expiresAt,
  };
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") clearAnnotations();
}

function mount(): ShadowRoot {
  if (root && host?.isConnected) return root;
  host = document.createElement("div");
  host.id = HOST_ID;
  // Inline !important protects the host from broad site selectors. Shadow DOM
  // isolates the shapes and labels; none of them intercept input or take focus.
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;";
  host.setAttribute("role", "region");
  host.setAttribute("aria-label", "Page annotations; press Escape to clear");
  root = host.attachShadow({ mode: "open" });
  const css = document.createElement("style");
  css.textContent = `
    :host { pointer-events:none; }
    .box,.label,.arrow { position:fixed; pointer-events:none; box-sizing:border-box; }
    .box { border:3px solid var(--color); border-radius:6px; }
    .box[data-style="highlight"] { background:var(--fill); }
    .box[data-style="circle"] { border-radius:50%; }
    .label { max-width:320px; padding:8px 11px; border:1px solid #d1d5db;
      border-radius:6px; background:#fff; color:#111827; font:600 13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
      overflow-wrap:anywhere; white-space:pre-wrap; box-shadow:0 4px 14px rgba(15,23,42,.18); }
    .arrow { inset:0; width:100%; height:100%; overflow:visible; }
  `;
  root.append(css);
  document.documentElement.append(host);
  window.addEventListener("scroll", positionAll, true);
  window.addEventListener("resize", positionAll);
  window.addEventListener("keydown", onKeydown, true);
  // A single bounded timer also catches layout shifts and animated targets.
  timer = setInterval(positionAll, 100);
  return root;
}

function removeMarker(id: string): boolean {
  const marker = markers.get(id);
  if (!marker) return false;
  marker.box.remove();
  marker.label.remove();
  marker.arrow.remove();
  markers.delete(id);
  return true;
}

function unmount(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  window.removeEventListener("scroll", positionAll, true);
  window.removeEventListener("resize", positionAll);
  window.removeEventListener("keydown", onKeydown, true);
  host?.remove();
  host = undefined;
  root = undefined;
}

/** Also called when the bridge is disabled or its built-in toolset is rebuilt. */
export function clearAnnotations(ids?: string[]): { cleared: number; remaining: number } {
  let cleared = 0;
  for (const id of ids ?? [...markers.keys()]) if (removeMarker(id)) cleared += 1;
  if (!markers.size && host) unmount();
  return { cleared, remaining: markers.size };
}

function positionAll(): void {
  if (host && !host.isConnected) {
    clearAnnotations();
    return;
  }
  const now = Date.now();
  for (const marker of markers.values()) {
    if (!marker.element.isConnected || (marker.expiresAt > 0 && marker.expiresAt <= now)) {
      removeMarker(marker.id);
      continue;
    }
    const rect = marker.element.getBoundingClientRect();
    const style = getComputedStyle(marker.element);
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth && style.visibility !== "hidden" && style.display !== "none";
    for (const node of [marker.box, marker.label, marker.arrow]) node.style.display = visible ? "" : "none";
    if (!visible) continue;
    const pad = marker.padding;
    Object.assign(marker.box.style, {
      left: `${rect.left - pad}px`, top: `${rect.top - pad}px`,
      width: `${rect.width + 2 * pad}px`, height: `${rect.height + 2 * pad}px`,
    });
    if (!marker.text) {
      marker.label.style.display = "none";
      marker.arrow.style.display = "none";
      continue;
    }
    marker.label.style.maxWidth = `${Math.max(1, Math.min(320, innerWidth - 16))}px`;
    const labelRect = marker.label.getBoundingClientRect();
    // If a resize makes a note impossible to display, remove this annotation
    // rather than silently clipping part of an instruction.
    if (labelRect.height > innerHeight - 16 || labelRect.width > innerWidth - 16) {
      removeMarker(marker.id);
      continue;
    }
    const above = rect.top - pad - labelRect.height - 16 >= 8;
    const left = Math.max(8, Math.min(rect.left, innerWidth - labelRect.width - 8));
    const top = Math.max(8, Math.min(above ? rect.top - pad - labelRect.height - 16 : rect.bottom + pad + 16, innerHeight - labelRect.height - 8));
    marker.label.style.left = `${left}px`;
    marker.label.style.top = `${top}px`;
    const x = Math.max(8, Math.min(rect.left + rect.width / 2, innerWidth - 8));
    const targetY = above ? rect.top - pad : rect.bottom + pad;
    const startX = Math.max(left + 8, Math.min(x, left + labelRect.width - 8));
    const startY = above ? top + labelRect.height : top;
    const dx = startX - x;
    const dy = startY - targetY;
    const length = Math.hypot(dx, dy) || 1;
    const headX = x + dx / length * 7;
    const headY = targetY + dy / length * 7;
    marker.path.setAttribute("d", `M ${startX} ${startY} L ${x} ${targetY} M ${headX - dy / length * 4} ${headY + dx / length * 4} L ${x} ${targetY} L ${headX + dy / length * 4} ${headY - dx / length * 4}`);
  }
  if (!markers.size && host) unmount();
}

export function annotatePage(args: Record<string, unknown>): object {
  if (!Array.isArray(args.annotations) || !args.annotations.length || args.annotations.length > MAX_ANNOTATIONS) {
    throw new Error(`annotations must contain between 1 and ${MAX_ANNOTATIONS} items.`);
  }
  if (args.replace !== undefined && typeof args.replace !== "boolean") throw new Error("replace must be a boolean.");
  const duration = integer(args.durationMs, 0, 600000, "durationMs");
  const expiresAt = duration ? Date.now() + duration : 0;
  // Resolve and validate the entire batch first: a bad target must not erase an
  // existing guide or leave a half-painted replacement behind.
  const annotations = args.annotations.map((value) => parseAnnotation(value, expiresAt));
  const ids = annotations.map((annotation) => annotation.id);
  if (new Set(ids).size !== ids.length) throw new Error("Annotation ids must be unique within a batch.");
  const replace = args.replace !== false;
  if (!replace && new Set([...markers.keys(), ...ids]).size > MAX_ANNOTATIONS) {
    throw new Error(`At most ${MAX_ANNOTATIONS} annotations may be active; clear some or use replace:true.`);
  }
  // Measure notes before replacing a guide. A long note that cannot fit the
  // viewport is an explicit error, not a partially visible instruction.
  const measuringRoot = mount();
  try {
    for (const annotation of annotations) {
      if (!annotation.text) continue;
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = annotation.text;
      label.style.visibility = "hidden";
      label.style.maxWidth = `${Math.max(1, Math.min(320, innerWidth - 16))}px`;
      measuringRoot.append(label);
      const rect = label.getBoundingClientRect();
      label.remove();
      if (rect.height > innerHeight - 16 || rect.width > innerWidth - 16) {
        throw new Error(`Note for annotation "${annotation.id}" does not fit the viewport; shorten text or enlarge the browser window.`);
      }
    }
  } catch (error) {
    if (!markers.size) unmount();
    throw error;
  }
  if (replace) clearAnnotations();
  const shadow = mount();
  for (const annotation of annotations) {
    removeMarker(annotation.id);
    const box = document.createElement("div");
    box.className = "box";
    box.dataset.style = annotation.style;
    box.dataset.annotationId = annotation.id;
    box.style.setProperty("--color", annotation.color);
    box.style.setProperty("--fill", `${annotation.color}38`);
    box.setAttribute("aria-hidden", "true");
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    arrow.classList.add("arrow");
    arrow.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", annotation.color);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    arrow.append(path);
    const label = document.createElement("div");
    label.className = "label";
    label.setAttribute("role", "note");
    label.textContent = annotation.text; // Never interpret tool-supplied HTML.
    shadow.append(box, arrow, label);
    markers.set(annotation.id, { ...annotation, box, label, arrow, path });
  }
  positionAll();
  return {
    annotations: annotations.map(({ id, selector, uid, style, color, text }) => ({ id, selector, uid, style, color, text })),
    total: markers.size, durationMs: duration,
  };
}

export function registerAnnotationTools(server: EmbeddedMcpServer): void {
  server.registerTool({
    name: "annotate_page",
    description: "Draw persistent, click-through highlights, circles or outlines with plain-text notes and arrows over page elements. Targets follow scroll/layout changes. Use an exact CSS selector (including shadow DOM) or a main-document snapshot uid. No iframe uids. Replaces the current guide by default; Escape clears it. Does not change page content or click anything.",
    inputSchema: {
      type: "object",
      properties: {
        annotations: {
          type: "array", minItems: 1, maxItems: MAX_ANNOTATIONS,
          items: {
            type: "object", additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 100, description: "Optional stable id; reuse with replace:false to update an annotation." },
              selector: { type: "string", minLength: 1, description: "CSS selector matching exactly one element. Specify selector OR uid." },
              uid: { type: "string", minLength: 1, description: "Main-document uid from take_snapshot/find. Specify uid OR selector." },
              style: { type: "string", enum: ["highlight", "circle", "outline"], default: "highlight" },
              color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", default: DEFAULT_COLOR },
              text: { type: "string", maxLength: 1000, description: "Plain-text explanation, e.g. 'Click here'. Must fit the viewport without truncation. Omit for just a shape." },
              padding: { type: "integer", minimum: 0, maximum: 32, default: 6 },
            },
            oneOf: [{ required: ["selector"], not: { required: ["uid"] } }, { required: ["uid"], not: { required: ["selector"] } }],
          },
        },
        replace: { type: "boolean", default: true, description: "Replace all previous annotations. False adds/updates by id." },
        durationMs: { type: "integer", minimum: 0, maximum: 600000, default: 0, description: "Auto-clear this batch after milliseconds; 0 stays until cleared, Escape, document navigation or bridge shutdown." },
      },
      required: ["annotations"], additionalProperties: false,
    },
  }, (args) => json(annotatePage(args)));

  server.registerTool({
    name: "clear_annotations",
    description: "Remove all page annotations, or only the supplied annotation ids. Does not touch page content, CSS patches or selected-element markers.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { ids: { type: "array", maxItems: MAX_ANNOTATIONS, items: { type: "string" }, description: "Omit to remove every annotation." } },
    },
  }, (args) => {
    if (args.ids !== undefined && (!Array.isArray(args.ids) || args.ids.length > MAX_ANNOTATIONS || args.ids.some((id) => typeof id !== "string"))) {
      throw new Error("ids must be an array of at most 50 strings.");
    }
    return json(clearAnnotations(args.ids as string[] | undefined));
  });
}
