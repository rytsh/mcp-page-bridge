<script lang="ts">
  import type { Provider, Selected, SchemaObject, ToolInfo } from "./types";

  interface Props {
    online: boolean;
    selected: Selected | null;
    providers: Provider[];
  }

  const { online, selected, providers }: Props = $props();

  interface Found {
    provider: Provider;
    item: ToolInfo;
  }

  const found = $derived.by((): Found | null => {
    if (!selected) return null;
    for (const provider of providers) {
      if (provider.label !== selected.provider) continue;
      for (const item of provider.tools ?? []) {
        if (item.name === selected.key) return { provider, item };
      }
    }
    return null;
  });

  const params = $derived.by(() => {
    const schema: SchemaObject | undefined = found?.item.inputSchema;
    if (!schema || typeof schema !== "object" || !schema.properties) return null;
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties).map(([name, def]) => {
      const d = def ?? {};
      const type = d.type || (d.enum ? "enum" : d.oneOf ? "oneOf" : d.anyOf ? "anyOf" : "any");
      return { name, type, required: required.has(name), description: d.description || "" };
    });
  });

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  function copyName() {
    if (!found || !navigator.clipboard?.writeText) return;
    navigator.clipboard
      .writeText(found.item.name)
      .then(() => {
        copied = true;
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => (copied = false), 1200);
      })
      .catch(() => {});
  }
</script>

<aside class="detail">
  <div class="detail-inner">
    {#if !online}
      <div class="empty placeholder">Bridge is offline.</div>
    {:else if !selected}
      <div class="empty placeholder">Select an item to inspect its schema and source.</div>
    {:else if !found}
      <div class="empty placeholder">That item is no longer connected.</div>
    {:else}
      <div class="detail-head">
        <span class="kind">tool</span>
        <div class="detail-head-right">
          <button class="copy-btn" type="button" onclick={copyName}>
            {copied ? "Copied" : "Copy name"}
          </button>
          <span class="from">
            {found.provider.label}{found.provider.title ? " / " + found.provider.title : ""}
          </span>
        </div>
      </div>
      <h2>{found.item.name}</h2>
      {#if found.item.description}
        <p class="desc">{found.item.description}</p>
      {/if}
      <div class="section-title">Input</div>
      {#if params?.length}
        <table>
          <thead>
            <tr><th>Param</th><th>Type</th><th>Req</th><th>Description</th></tr>
          </thead>
          <tbody>
            {#each params as param (param.name)}
              <tr>
                <td><span class="pname">{param.name}</span></td>
                <td><span class="type">{param.type}</span></td>
                <td>{#if param.required}<span class="req">yes</span>{:else}-{/if}</td>
                <td>{param.description}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="placeholder">No parameters.</p>
      {/if}
      {#if found.item.inputSchema}
        <details class="raw">
          <summary>Raw input schema</summary>
          <pre>{JSON.stringify(found.item.inputSchema, null, 2)}</pre>
        </details>
      {/if}
    {/if}
  </div>
</aside>
