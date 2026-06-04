/**
 * Safe value serialization for tool results / console capture / eval output.
 * Handles cycles, DOM nodes, functions, Map/Set, and caps depth/breadth so a
 * huge or circular page object never blows up the JSON-RPC channel.
 *
 * No hard DOM dependency: the `Node` check is guarded so this is unit-testable
 * in Node.
 */

const MAX_DEPTH = 4;
const MAX_ARRAY = 100;
const MAX_KEYS = 80;

function describeNode(node: any): string {
  const tag = typeof node.tagName === "string" ? node.tagName.toLowerCase() : node.nodeName;
  const id = node.id ? `#${node.id}` : "";
  const cls =
    node.classList && node.classList.length ? `.${[...node.classList].join(".")}` : "";
  return `<${tag}${id}${cls}>`;
}

export function safeSerialize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "undefined") return "undefined";
  if (t === "bigint") return (value as bigint).toString();
  if (t === "symbol") return (value as symbol).toString();
  if (t === "function") return `[Function ${(value as { name?: string }).name || "anonymous"}]`;

  if (typeof Node !== "undefined" && value instanceof Node) return describeNode(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Error) return `${value.name}: ${value.message}`;

  if (depth >= MAX_DEPTH) return Array.isArray(value) ? "[Array]" : "[Object]";

  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);

    if (Array.isArray(value)) {
      const out = value.slice(0, MAX_ARRAY).map((v) => safeSerialize(v, depth + 1, seen));
      if (value.length > MAX_ARRAY) out.push(`…(${value.length - MAX_ARRAY} more)`);
      return out;
    }
    if (value instanceof Map) {
      return {
        "[Map]": [...value.entries()]
          .slice(0, 50)
          .map(([k, v]) => [safeSerialize(k, depth + 1, seen), safeSerialize(v, depth + 1, seen)]),
      };
    }
    if (value instanceof Set) {
      return { "[Set]": [...value].slice(0, 50).map((v) => safeSerialize(v, depth + 1, seen)) };
    }

    const out: Record<string, unknown> = {};
    let i = 0;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (i++ >= MAX_KEYS) {
        out["…"] = "(truncated)";
        break;
      }
      try {
        out[key] = safeSerialize((value as Record<string, unknown>)[key], depth + 1, seen);
      } catch {
        out[key] = "[unserializable]";
      }
    }
    return out;
  }

  return String(value);
}

/** Serialize to a compact string suitable for console/log lines. */
export function toLogString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(safeSerialize(value));
  } catch {
    return String(value);
  }
}
