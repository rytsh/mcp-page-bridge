<script lang="ts">
  import { app, addTodo, increment, toggleTodo } from "./store.svelte";

  let text = $state("");

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const value = text.trim();
    if (value) {
      addTodo(value);
      text = "";
    }
  }
</script>

<main>
  <h1>mcp-page-bridge × Svelte 5</h1>
  <p class="muted">
    This app exposes its runes state via WebMCP (<code>document.modelContext</code>). Run
    <code>npx mcp-page-bridge</code>, enable the extension on this tab, then have your agent
    call <code>svelte__increment</code>, <code>svelte__add-todo</code>, etc.
  </p>

  <section>
    <h2>Counter</h2>
    <div class="count">{app.count}</div>
    <button onclick={() => increment(1)}>+1</button>
    <button onclick={() => increment(-1)}>-1</button>
  </section>

  <section>
    <h2>Todos</h2>
    <form onsubmit={submit}>
      <input bind:value={text} placeholder="New todo…" />
      <button type="submit">Add</button>
    </form>
    <ul>
      {#each app.todos as todo (todo.id)}
        <li>
          <label>
            <input type="checkbox" checked={todo.done} onchange={() => toggleTodo(todo.id)} />
            <span class:done={todo.done}>{todo.text}</span>
            <span class="muted">#{todo.id}</span>
          </label>
        </li>
      {:else}
        <li class="muted">No todos yet — add one or ask the agent.</li>
      {/each}
    </ul>
  </section>
</main>

<style>
  main {
    font-family: system-ui, -apple-system, sans-serif;
    max-width: 560px;
    margin: 40px auto;
    padding: 0 16px;
  }
  h1 {
    font-size: 22px;
  }
  section {
    border: 1px solid #8883;
    border-radius: 12px;
    padding: 12px 16px;
    margin: 16px 0;
  }
  .count {
    font-size: 40px;
    font-weight: 700;
    margin-bottom: 8px;
  }
  .done {
    text-decoration: line-through;
    opacity: 0.6;
  }
  .muted {
    opacity: 0.65;
    font-size: 13px;
  }
  button {
    font: inherit;
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid #8886;
    cursor: pointer;
  }
  input {
    font: inherit;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid #8886;
  }
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    padding: 4px 0;
  }
  code {
    background: #8881;
    padding: 1px 5px;
    border-radius: 4px;
  }
</style>
