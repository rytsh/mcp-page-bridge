/**
 * Registers this Svelte app's tools with WebMCP (`document.modelContext`).
 *
 * WebMCP is the standard way for a page to hand client-side functionality to an
 * agent. The mcp-page-bridge extension polyfills `document.modelContext` at
 * document_start, so this works in browsers without native support too — but if
 * neither is present we simply skip registration and the app still runs.
 *
 * Types come from the `webmcp-types` package (see src/webmcp.d.ts).
 */
import { app, addTodo, increment, setCount, snapshot, toggleTodo } from "./store.svelte";

/** Bridge-only knobs (provider label). Absent unless the extension is installed. */
declare global {
  interface Window {
    mcpPageBridge?: { setLabel(value: string): void };
  }
}

export async function registerMcpTools(): Promise<void> {
  const mc = document.modelContext;
  if (!mc) {
    console.info("[mcp] no WebMCP support — install the mcp-page-bridge extension");
    return;
  }

  // The agent sees these namespaced as `svelte__get-state`, etc.
  window.mcpPageBridge?.setLabel("svelte");

  await mc.registerTool({
    name: "get-state",
    description: "Return the full Svelte app state",
    annotations: { readOnlyHint: true },
    execute: () => snapshot(),
  });

  await mc.registerTool({
    name: "get-count",
    description: "Get the counter value",
    annotations: { readOnlyHint: true },
    execute: () => app.count,
  });

  await mc.registerTool({
    name: "increment",
    description: "Increment the counter",
    inputSchema: {
      type: "object",
      properties: { by: { type: "number", description: "amount (default 1)" } },
    },
    execute: ({ by }) => `count is now ${increment(Number(by ?? 1))}`,
  });

  await mc.registerTool({
    name: "set-count",
    description: "Set the counter to a value",
    inputSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    },
    execute: ({ value }) => `count is now ${setCount(Number(value))}`,
  });

  await mc.registerTool({
    name: "add-todo",
    description: "Add a todo item",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    execute: ({ text }) => addTodo(String(text)),
  });

  await mc.registerTool({
    name: "toggle-todo",
    description: "Toggle a todo's done state by id",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
    execute: ({ id }) => toggleTodo(Number(id)) ?? `no todo with id ${String(id)}`,
  });

  await mc.registerTool({
    name: "get-todos",
    description: "List all todos",
    annotations: { readOnlyHint: true },
    execute: () => snapshot().todos,
  });
}
