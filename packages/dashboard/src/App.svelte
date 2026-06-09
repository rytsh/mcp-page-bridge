<script lang="ts">
  import { onMount } from "svelte";
  import { fetchProviders, providerAction, shutdownBridge } from "./lib/api";
  import type { ProvidersResponse, Selected } from "./lib/types";
  import { groupsFor } from "./lib/util";
  import ProviderCard from "./lib/ProviderCard.svelte";
  import DetailPanel from "./lib/DetailPanel.svelte";

  let data = $state<ProvidersResponse>({ version: "", port: 8787, providers: [] });
  let online = $state(false);
  let shutdownRequested = $state(false);
  let shuttingDown = $state(false);
  let statusOverride = $state("");
  let filter = $state("");
  let selected = $state<Selected | null>(null);
  let openProviders = $state<Record<string, boolean>>({});
  let openGroups = $state<Record<string, boolean>>({});

  const totals = $derived({
    providers: data.providers.length,
    tools: data.providers.reduce((acc, p) => acc + (p.tools?.length ?? 0), 0),
  });

  const visibleProviders = $derived(
    filter ? data.providers.filter((p) => groupsFor(p, filter).length > 0) : data.providers,
  );

  const statusText = $derived.by(() => {
    if (statusOverride) return statusOverride;
    if (shuttingDown) return "shutting down bridge";
    if (shutdownRequested) return online ? "bridge shutdown requested" : "bridge shut down";
    if (!online) return "bridge not reachable";
    return data.providers.length
      ? "bridge online, browser providers connected"
      : "bridge online, waiting for browser tabs";
  });

  async function tick() {
    try {
      const next = await fetchProviders();
      statusOverride = "";
      if (shutdownRequested) {
        online = false;
        selected = null;
        data = { ...next, providers: [] };
        return;
      }
      online = true;
      data = next;
    } catch {
      online = false;
      selected = null;
      data = { version: "", port: 8787, providers: [] };
    }
  }

  onMount(() => {
    void tick();
    const timer = setInterval(() => void tick(), 1500);
    return () => clearInterval(timer);
  });

  async function handleAction(label: string, action: "activate" | "close") {
    if (action === "close" && !confirm(`Close tab for provider ${label}?`)) return;
    try {
      await providerAction(label, action);
      if (action === "close" && selected?.provider === label) selected = null;
      await tick();
    } catch (error) {
      statusOverride = error instanceof Error ? error.message : String(error);
    }
  }

  async function handleShutdown() {
    if (!confirm("Shutdown the local mcp-page-bridge daemon? Connected agents and browser tabs will disconnect.")) {
      return;
    }
    shuttingDown = true;
    try {
      await shutdownBridge();
      shutdownRequested = true;
      online = false;
      selected = null;
      data = { ...data, providers: [] };
    } catch (error) {
      statusOverride = error instanceof Error ? error.message : String(error);
    } finally {
      shuttingDown = false;
    }
  }
</script>

<div class="shell">
  <header class="topbar">
    <div class="brand">
      <img src="/favicon.svg" alt="" />
      <div>
        <div class="eyebrow">browser MCP bridge</div>
        <h1>mcp-page-bridge dashboard</h1>
      </div>
    </div>
    <div class="endpoint">
      <span class="chip">v{data.version || "0.0.0"}</span>
      <span class="chip">ws://{location.hostname || "127.0.0.1"}:{data.port}</span>
      <span class="chip">GET /api/providers</span>
    </div>
  </header>

  <div class="status-row">
    <div class="status">
      <span class="dot" class:on={online}></span>
      <span>{statusText}</span>
    </div>
    <div class="status-actions">
      <div class="refresh">auto refresh: 1.5s</div>
      <button
        class="shutdown-btn"
        type="button"
        disabled={!online || shuttingDown}
        onclick={() => void handleShutdown()}
      >
        Shutdown bridge
      </button>
    </div>
  </div>

  <section class="stats" aria-label="Connected provider summary">
    <div class="stat"><span>Providers</span><strong>{totals.providers}</strong></div>
    <div class="stat"><span>Tools</span><strong>{totals.tools}</strong></div>
  </section>

  <main class="layout">
    <section>
      <div class="panel-title">
        <span>Providers</span><span>{totals.providers} connected</span>
      </div>
      <input
        class="search"
        type="search"
        placeholder="Filter tools by name or description…"
        autocomplete="off"
        spellcheck="false"
        oninput={(event) => (filter = event.currentTarget.value.trim().toLowerCase())}
      />
      <div>
        {#if !online}
          <div class="card">
            <div class="empty">
              {#if shutdownRequested}
                Bridge shutdown requested.<br />Restart mcp-page-bridge to use the dashboard again.
              {:else}
                Bridge is not reachable.<br />Start mcp-page-bridge and refresh this page.
              {/if}
            </div>
          </div>
        {:else if !data.providers.length}
          <div class="card">
            <div class="empty">
              No browsers connected yet.<br />Enable the mcp-page-bridge extension on a tab.
            </div>
          </div>
        {:else if !visibleProviders.length}
          <div class="card"><div class="empty">No tools match "{filter}".</div></div>
        {:else}
          {#each visibleProviders as provider (provider.label)}
            <ProviderCard
              {provider}
              {filter}
              {selected}
              open={filter ? true : openProviders[provider.label] === true}
              {openGroups}
              onToggle={(open) => (openProviders[provider.label] = open)}
              onToggleGroup={(id, open) => (openGroups[id] = open)}
              onSelect={(key) => (selected = { provider: provider.label, key })}
              onAction={(action) => void handleAction(provider.label, action)}
            />
          {/each}
        {/if}
      </div>
    </section>
    <DetailPanel {online} {selected} providers={data.providers} />
  </main>
</div>
