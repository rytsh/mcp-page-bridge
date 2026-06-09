import { BROWSER_TOOL_NAMES, BUILTIN_TOOL_NAMES } from "mcp-page-bridge-protocol";
import type { Provider, ToolInfo } from "./types";

const BUILTIN_TOOLS = new Set<string>(BUILTIN_TOOL_NAMES);
const BROWSER_TOOLS = new Set<string>(BROWSER_TOOL_NAMES);

export function esc(s: unknown): string {
  return String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

/** Escape + wrap the first filter match in <mark>; safe for {@html}. */
export function highlight(text: string, filter: string): string {
  const s = esc(text);
  if (!filter) return s;
  const i = s.toLowerCase().indexOf(filter);
  if (i < 0) return s;
  return s.slice(0, i) + "<mark>" + s.slice(i, i + filter.length) + "</mark>" + s.slice(i + filter.length);
}

export function shortName(provider: Provider, key: string): string {
  const prefix = provider.label + "__";
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

export function classifyTool(provider: Provider, item: ToolInfo): string {
  const local = shortName(provider, item.name);
  if (provider.label === "browser" || BROWSER_TOOLS.has(local)) return "Browser control";
  if (BUILTIN_TOOLS.has(local)) return "Built-in page tools";
  return "Page tools";
}

export function matchesFilter(provider: Provider, item: ToolInfo, filter: string): boolean {
  if (!filter) return true;
  const hay = (shortName(provider, item.name) + " " + item.name + " " + (item.description || "")).toLowerCase();
  return hay.includes(filter);
}

export interface ToolGroup {
  title: string;
  items: ToolInfo[];
}

export function groupsFor(provider: Provider, filter: string): ToolGroup[] {
  const buckets = new Map<string, ToolInfo[]>();
  for (const item of provider.tools ?? []) {
    if (!matchesFilter(provider, item, filter)) continue;
    const title = classifyTool(provider, item);
    if (!buckets.has(title)) buckets.set(title, []);
    buckets.get(title)!.push(item);
  }
  return [...buckets.entries()].map(([title, items]) => ({ title, items }));
}
