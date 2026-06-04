/**
 * Normalizes "declarative" tools a page exposes as plain data on the window
 * (window.mcp / window.mcp.tools) into {def, handler} pairs the embedded
 * server can register. Accepts:
 *   - object map of name -> handler function
 *   - object map of name -> { description?, title?, inputSchema?, handler }
 *   - array of { name, description?, title?, inputSchema?, handler }
 * Pure (no DOM) so it is unit-testable.
 */
import type { ToolDefinition, ToolHandler } from "./embedded-server.js";

export interface DeclarativeTool {
  name?: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  handler?: ToolHandler;
}

export function normalizeDeclarativeTools(
  raw: unknown,
): Array<{ def: ToolDefinition; handler: ToolHandler }> {
  if (!raw || typeof raw !== "object") return [];

  const entries: Array<[string | undefined, unknown]> = Array.isArray(raw)
    ? raw.map((t) => [(t as DeclarativeTool)?.name, t])
    : Object.entries(raw as Record<string, unknown>);

  const out: Array<{ def: ToolDefinition; handler: ToolHandler }> = [];
  for (const [name, val] of entries) {
    if (!name) continue;
    if (typeof val === "function") {
      out.push({ def: { name }, handler: val as ToolHandler });
    } else if (val && typeof val === "object" && typeof (val as DeclarativeTool).handler === "function") {
      const t = val as DeclarativeTool;
      out.push({
        def: { name, title: t.title, description: t.description, inputSchema: t.inputSchema },
        handler: t.handler as ToolHandler,
      });
    }
  }
  return out;
}
