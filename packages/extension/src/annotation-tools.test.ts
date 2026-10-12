import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { annotatePage, clearAnnotations } from "./annotation-tools.js";

const { targets } = vi.hoisted(() => ({ targets: new Map<string, any[]>() }));
vi.mock("./dom-core.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./dom-core.js")>(),
  querySelectorAllDeep: (selector: string) => targets.get(selector) ?? [],
  resolveUid: (uid: string) => {
    const element = targets.get(uid)?.[0];
    if (!element) throw new Error("Unknown or stale uid");
    return element;
  },
}));

class Node {
  id = "";
  isConnected = true;
  children: Node[] = [];
  parent?: Node;
  shadowRoot?: Node;
  textContent = "";
  className = "";
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  style: Record<string, any> = { setProperty(name: string, value: string) { this[name] = value; } };
  classList = { add: (name: string) => { this.className = name; } };
  rect = { left: 100, top: 100, width: 120, height: 40, right: 220, bottom: 140 };
  append(...nodes: Node[]) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  attachShadow() { return this.shadowRoot = new Node(); }
  getRootNode(): Node { return this.parent?.getRootNode() ?? this; }
  contains(node: Node): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  getBoundingClientRect() { return this.rect; }
}

let documentRoot: Node;
let windowEvents: Map<string, Function>;
const shadow = () => documentRoot.children[0]!.shadowRoot!;
const boxes = () => shadow().children.filter((node) => node.className === "box");
const labels = () => shadow().children.filter((node) => node.className === "label");

beforeEach(() => {
  vi.useFakeTimers();
  targets.clear();
  targets.set("#button", [new Node()]);
  targets.set("e1", targets.get("#button")!);
  documentRoot = new Node();
  windowEvents = new Map();
  vi.stubGlobal("document", { documentElement: documentRoot, createElement: () => new Node(), createElementNS: () => new Node() });
  vi.stubGlobal("window", {
    addEventListener: (name: string, handler: Function) => windowEvents.set(name, handler),
    removeEventListener: (name: string) => windowEvents.delete(name),
  });
  vi.stubGlobal("innerWidth", 800);
  vi.stubGlobal("innerHeight", 600);
  vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
});

afterEach(() => {
  clearAnnotations();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("paints isolated click-through shapes and renders notes as text, not HTML", () => {
  const result = annotatePage({ annotations: [{ selector: "#button", id: "buy", style: "circle", color: "#ef4444", text: "<img onerror=alert(1)>" }] });
  expect(result).toMatchObject({ total: 1, durationMs: 0 });
  expect(documentRoot.children[0]!.style.cssText).toContain("pointer-events:none!important");
  expect(boxes()[0]!.dataset.style).toBe("circle");
  expect(boxes()[0]!.style.left).toBe("94px");
  expect(labels()[0]!.textContent).toBe("<img onerror=alert(1)>");
  expect(labels()[0]!.children).toHaveLength(0);
});

it("supports snapshot uids and shape-only annotations", () => {
  annotatePage({ annotations: [{ uid: "e1" }] });
  expect(boxes()).toHaveLength(1);
  expect(labels()[0]!.style.display).toBe("none");
});

it.each([
  [{ selector: "#missing" }, /matches 0/],
  [{ selector: "#button", uid: "e1" }, /exactly one/],
  [{ uid: "f2e1" }, /Frame uids/],
  [{ selector: "#button", color: "red;position:fixed" }, /hex color/],
  [{ selector: "#button", style: "unknown" }, /style must/],
  [{ selector: "#button", padding: -1 }, /padding must/],
])("rejects invalid annotations without erasing an existing guide: %j", (annotation, error) => {
  annotatePage({ annotations: [{ selector: "#button", id: "existing" }] });
  expect(() => annotatePage({ annotations: [annotation] })).toThrow(error);
  expect(boxes()[0]!.dataset.annotationId).toBe("existing");
});

it("rejects ambiguous selectors rather than marking the wrong element", () => {
  targets.set(".button", [new Node(), new Node()]);
  expect(() => annotatePage({ annotations: [{ selector: ".button" }] })).toThrow(/matches 2/);
});

it("adds and updates stable ids, replaces by default and clears selectively", () => {
  annotatePage({ annotations: [{ selector: "#button", id: "a" }] });
  annotatePage({ replace: false, annotations: [{ selector: "#button", id: "b" }] });
  expect(boxes()).toHaveLength(2);
  annotatePage({ replace: false, annotations: [{ selector: "#button", id: "a", text: "Updated" }] });
  expect(boxes()).toHaveLength(2);
  expect(clearAnnotations(["a", "missing"])).toEqual({ cleared: 1, remaining: 1 });
  annotatePage({ annotations: [{ selector: "#button", id: "c" }] });
  expect(boxes()).toHaveLength(1);
  expect(boxes()[0]!.dataset.annotationId).toBe("c");
});

it("tracks layout changes and hides annotations while offscreen", async () => {
  annotatePage({ annotations: [{ selector: "#button" }] });
  const target = targets.get("#button")![0];
  target.rect.left = 200;
  windowEvents.get("scroll")!();
  expect(boxes()[0]!.style.left).toBe("194px");
  target.rect.top = 700;
  await vi.advanceTimersByTimeAsync(100);
  expect(boxes()[0]!.style.display).toBe("none");
  target.rect.top = 100;
  await vi.advanceTimersByTimeAsync(100);
  expect(boxes()[0]!.style.display).toBe("");
});

it("expires annotations and removes timers and listeners when the last one is gone", async () => {
  annotatePage({ durationMs: 200, annotations: [{ selector: "#button" }] });
  await vi.advanceTimersByTimeAsync(200);
  expect(documentRoot.children).toHaveLength(0);
  expect(windowEvents.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("removes disconnected targets without rebinding to a different matching element", async () => {
  annotatePage({ annotations: [{ selector: "#button" }] });
  targets.get("#button")![0].isConnected = false;
  targets.set("#button", [new Node()]);
  await vi.advanceTimersByTimeAsync(100);
  expect(documentRoot.children).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("Escape clears the guide without consuming the page's key event", () => {
  annotatePage({ annotations: [{ selector: "#button" }] });
  const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
  windowEvents.get("keydown")!(event);
  expect(documentRoot.children).toHaveLength(0);
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(event.stopPropagation).not.toHaveBeenCalled();
});

it("rejects notes that cannot fit without erasing the current guide", () => {
  annotatePage({ annotations: [{ selector: "#button", id: "existing" }] });
  vi.stubGlobal("innerHeight", 40);
  expect(() => annotatePage({ annotations: [{ selector: "#button", text: "Too tall for this viewport" }] })).toThrow(/does not fit/);
  expect(boxes()[0]!.dataset.annotationId).toBe("existing");
});

it("bounds annotation count and rejects duplicate ids and invalid durations", () => {
  expect(() => annotatePage({ annotations: Array.from({ length: 51 }, () => ({ selector: "#button" })) })).toThrow(/between 1 and 50/);
  expect(() => annotatePage({ annotations: [{ selector: "#button", id: "a" }, { selector: "#button", id: "a" }] })).toThrow(/unique/);
  expect(() => annotatePage({ durationMs: -1, annotations: [{ selector: "#button" }] })).toThrow(/durationMs/);
  annotatePage({ annotations: Array.from({ length: 50 }, (_, i) => ({ selector: "#button", id: `a${i}` })) });
  expect(() => annotatePage({ replace: false, annotations: [{ selector: "#button", id: "overflow" }] })).toThrow(/At most 50/);
  expect(boxes()).toHaveLength(50);
});
