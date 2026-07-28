<script lang="ts">
  import { onMount } from "svelte";
  import {
    ApiError,
    clearCredentials,
    fetchHealth,
    fetchProviders,
    providerAction,
    shutdownBridge,
    setProfileSecret,
    setToken,
    INITIAL_PROFILE,
    INITIAL_TOKEN,
    type Health,
  } from "./lib/api";
  import { EXTENSION_MARK_ATTRIBUTE } from "mcp-page-bridge-protocol";
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
  // The extension marks loopback pages with its version, so we can tell
  // "extension not installed" apart from "installed but no tab enabled".
  let extensionVersion = $state<string | null>(null);

  // ---- auth / profile gate ----
  let health = $state<Health | null>(null);
  let booting = $state(true);
  let locked = $state(false);
  let authError = $state("");
  // Form fields for the login card (separate from the applied values).
  let tokenInput = $state(INITIAL_TOKEN);
  let profileInput = $state(INITIAL_PROFILE);
  // The credentials currently applied to requests (for the header chip / logout).
  let appliedProfile = $state(INITIAL_PROFILE);
  let appliedToken = $state(INITIAL_TOKEN);
  const hasCredentials = $derived(!!(appliedProfile.trim() || appliedToken.trim()));

  let timer: ReturnType<typeof setInterval> | undefined;
  function startPolling() {
    if (timer) return;
    void tick();
    timer = setInterval(() => void tick(), 1500);
  }
  function stopPolling() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function lock(message = "") {
    authError = message;
    locked = true;
    stopPolling();
  }

  async function applyCredentials() {
    setToken(tokenInput.trim());
    setProfileSecret(profileInput.trim());
    appliedProfile = profileInput.trim();
    appliedToken = tokenInput.trim();
    authError = "";
    try {
      const next = await fetchProviders();
      data = next;
      online = true;
      locked = false;
      startPolling();
    } catch (error) {
      online = false;
      authError =
        error instanceof ApiError && error.status === 401
          ? "Invalid token or profile key."
          : "Could not reach the bridge.";
    }
  }

  function logout() {
    clearCredentials();
    tokenInput = "";
    profileInput = "";
    appliedProfile = "";
    appliedToken = "";
    selected = null;
    online = false;
    data = { version: "", port: 8787, providers: [] };
    lock("");
  }

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
    } catch (error) {
      online = false;
      selected = null;
      data = { version: "", port: 8787, providers: [] };
      // The token/profile became invalid (e.g. daemon restarted): re-lock.
      if (error instanceof ApiError && error.status === 401) {
        lock("Session expired — re-enter your credentials.");
      }
    }
  }

  async function boot() {
    try {
      health = await fetchHealth();
    } catch {
      health = null;
    }
    booting = false;
    const needToken = !!health?.requiresToken && !tokenInput.trim();
    const needProfile = !!health?.requiresProfile && !profileInput.trim();
    if (needToken || needProfile) {
      locked = true;
      return;
    }
    startPolling();
  }

  /**
   * The content script sets the marker at document_start, but the extension may
   * still be starting up when the dashboard boots, so poll briefly.
   */
  function watchForExtension(): () => void {
    const read = () => document.documentElement.getAttribute(EXTENSION_MARK_ATTRIBUTE);
    extensionVersion = read();
    if (extensionVersion) return () => undefined;
    const started = Date.now();
    const id = setInterval(() => {
      extensionVersion = read();
      if (extensionVersion || Date.now() - started > 5000) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }

  onMount(() => {
    void boot();
    const stopExtensionWatch = watchForExtension();
    return () => {
      stopPolling();
      stopExtensionWatch();
    };
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
      <span class="chip" class:profiled={appliedProfile.trim()}>
        {appliedProfile.trim() ? "partition: profiled" : "partition: default"}
      </span>
    </div>
  </header>

  <div class="status-row">
    <div class="status">
      <span class="dot" class:on={online}></span>
      <span>{statusText}</span>
    </div>
    <div class="status-actions">
      <div class="refresh">auto refresh: 1.5s</div>
      {#if hasCredentials}
        <button class="profile-btn" type="button" disabled={booting} onclick={logout} title="Forget the token and profile key">
          Log out
        </button>
      {:else}
        <button class="profile-btn" type="button" disabled={booting} onclick={() => lock()} title="Enter a profile key / token">
          Profile…
        </button>
      {/if}
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

  {#if locked}
    <main class="login">
      <form
        class="card login-card"
        onsubmit={(event) => {
          event.preventDefault();
          void applyCredentials();
        }}
      >
        <h2>Unlock the dashboard</h2>
        <p class="muted">
          {health?.requiresProfile
            ? "This bridge is in multi-user mode. Enter your profile key to see only your tabs."
            : "Enter a profile key to view that partition (leave empty for the default/shared view)."}
        </p>
        {#if health?.requiresToken}
          <label class="login-field">
            <span>Token</span>
            <input type="password" autocomplete="off" bind:value={tokenInput} placeholder="shared bridge token" />
          </label>
        {/if}
        <label class="login-field">
          <span>Profile key</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input type="password" autocomplete="off" autofocus bind:value={profileInput} placeholder="your profile secret" />
        </label>
        {#if authError}
          <div class="login-error">{authError}</div>
        {/if}
        <div class="login-actions">
          {#if !health?.requiresProfile}
            <button
              type="button"
              class="ghost-btn"
              onclick={() => {
                profileInput = "";
                void applyCredentials();
              }}
            >
              View default
            </button>
          {/if}
          <button type="submit" class="primary-btn">Open dashboard</button>
        </div>
      </form>
    </main>
  {:else}
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
              {#if appliedProfile.trim()}
                <p>
                  No tabs in this partition. A tab only shows here when its
                  <strong>Profile key</strong> in the extension popup matches this one exactly.
                  If you didn't set a profile key on the tab, it's in the default partition —
                  <button class="link-btn" type="button" onclick={logout}>view the default</button>.
                </p>
              {:else if extensionVersion}
                <p>
                  Extension v{extensionVersion} detected. No tab is enabled yet — open the page you
                  want to expose, click the mcp-page-bridge icon, then <strong>Enable on this tab</strong>.
                </p>
              {:else}
                <p>
                  Extension not detected on this page. Install the mcp-page-bridge browser extension,
                  then reload this dashboard.
                </p>
              {/if}
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
  {/if}
</div>
