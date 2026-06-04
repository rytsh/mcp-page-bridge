/**
 * Declares this Svelte app's tools for the mcp-page-bridge browser extension. This is safe
 * even when the extension is not installed; it is just data on window.mcp.
 */
import { app, addTodo, increment, setCount, snapshot, toggleTodo } from "./store.svelte";

interface ToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
type ToolHandler = (args: Record<string, any>) => unknown;

type ToolManifest = ToolHandler | (Omit<ToolDef, "name"> & { handler: ToolHandler });

interface McpManifest {
  label?: string;
  tools?: Record<string, ToolManifest>;
  [key: string]: unknown;
}

declare global {
  interface Window {
    mcp?: McpManifest;
  }
}

export function registerMcpTools(): void {
  const mcp = window.mcp && typeof window.mcp === "object" ? window.mcp : {};
  window.mcp = Object.assign(mcp, {
    label: "svelte",
    tools: {
      getState: { description: "Return the full Svelte app state", handler: () => snapshot() },
      getCount: { description: "Get the counter value", handler: () => app.count },
      increment: {
        description: "Increment the counter",
        inputSchema: {
          type: "object",
          properties: { by: { type: "number", description: "amount (default 1)" } },
        },
        handler: (args: Record<string, any>) => `count is now ${increment(Number(args.by ?? 1))}`,
      },
      setCount: {
        description: "Set the counter to a value",
        inputSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        handler: (args: Record<string, any>) => `count is now ${setCount(Number(args.value))}`,
      },
      addTodo: {
        description: "Add a todo item",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        handler: (args: Record<string, any>) => addTodo(String(args.text)),
      },
      toggleTodo: {
        description: "Toggle a todo's done state by id",
        inputSchema: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
        },
        handler: (args: Record<string, any>) => toggleTodo(Number(args.id)) ?? `no todo with id ${args.id}`,
      },
      getTodos: { description: "List all todos", handler: () => snapshot().todos },
    },
  });
}
