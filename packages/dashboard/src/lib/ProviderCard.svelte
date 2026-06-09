<script lang="ts">
  import type { Provider, Selected } from "./types";
  import { groupsFor, highlight, shortName, timeAgo } from "./util";

  interface Props {
    provider: Provider;
    filter: string;
    selected: Selected | null;
    open: boolean;
    openGroups: Record<string, boolean>;
    onToggle: (open: boolean) => void;
    onToggleGroup: (id: string, open: boolean) => void;
    onSelect: (key: string) => void;
    onAction: (action: "activate" | "close") => void;
  }

  const { provider, filter, selected, open, openGroups, onToggle, onToggleGroup, onSelect, onAction }: Props =
    $props();

  const groups = $derived(groupsFor(provider, filter));
  const title = $derived(provider.title || provider.name || provider.label);
  const ago = $derived(timeAgo(provider.connectedAt));

  function groupId(groupTitle: string): string {
    return provider.label + "|tools|" + groupTitle;
  }
</script>

<details
  class="card provider-card"
  {open}
  ontoggle={(event) => onToggle(event.currentTarget.open)}
>
  <summary class="provider-head">
    <div class="provider-main">
      <div class="provider-title">
        <div class="provider-name">
          <span class="label">{provider.label}</span>
          <span class="provider-caret"></span>
          <span class="ptitle">{title}</span>
        </div>
        {#if provider.url}
          <div class="url">{provider.url}</div>
        {/if}
        <div class="provider-meta">
          {#if provider.version}<span>v{provider.version}</span>{/if}
          {#if ago}<span>connected {ago} ago</span>{/if}
        </div>
      </div>
      <div class="provider-side">
        <div class="metrics">
          <span class="metric">Tools {provider.tools?.length ?? 0}</span>
        </div>
        {#if provider.tabId !== undefined}
          <div class="actions">
            <button
              class="action-btn"
              type="button"
              onclick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onAction("activate");
              }}
            >
              Focus tab
            </button>
            <button
              class="action-btn danger"
              type="button"
              onclick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onAction("close");
              }}
            >
              Close
            </button>
          </div>
        {/if}
      </div>
    </div>
  </summary>
  <div class="card-body">
    {#if !groups.length}
      <div class="empty small">No tools published.</div>
    {:else}
      {#each groups as group (group.title)}
        <details
          class="group"
          open={filter ? true : openGroups[groupId(group.title)] !== false}
          ontoggle={(event) => onToggleGroup(groupId(group.title), event.currentTarget.open)}
        >
          <summary>
            <span class="chev"></span>
            <span class="group-title">{group.title}</span>
            <span class="group-count">{group.items.length}</span>
          </summary>
          <div class="group-list">
            {#each group.items as item (item.name)}
              <button
                class="item"
                class:active={selected?.provider === provider.label && selected?.key === item.name}
                type="button"
                onclick={() => onSelect(item.name)}
              >
                <span>
                  <span class="nm">{@html highlight(shortName(provider, item.name), filter)}</span>
                  <span class="full">{item.name}</span>
                </span>
                <span class="ds">{@html highlight(item.description || "", filter)}</span>
              </button>
            {/each}
          </div>
        </details>
      {/each}
    {/if}
  </div>
</details>
