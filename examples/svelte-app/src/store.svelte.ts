/**
 * Shared app state using Svelte 5 runes. Lives in a `.svelte.ts` module so
 * `$state` is available outside components. The r-mcp tools (see rmcp.ts) read
 * and mutate this same reactive state, so agent-driven changes update the UI.
 */
export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

export const app = $state<{ count: number; todos: Todo[] }>({
  count: 0,
  todos: [],
});

let nextId = 1;

export function increment(by = 1): number {
  app.count += by;
  return app.count;
}

export function setCount(value: number): number {
  app.count = value;
  return app.count;
}

export function addTodo(text: string): Todo {
  const todo: Todo = { id: nextId++, text, done: false };
  app.todos.push(todo);
  return todo;
}

export function toggleTodo(id: number): Todo | null {
  const todo = app.todos.find((t) => t.id === id);
  if (todo) todo.done = !todo.done;
  return todo ?? null;
}

/** A plain (non-proxy) snapshot, safe to serialize and return to the agent. */
export function snapshot() {
  return $state.snapshot(app);
}
