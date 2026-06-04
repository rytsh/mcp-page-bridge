/**
 * Self-contained status dashboard served by the bridge over HTTP on the same
 * port as the WebSocket server. Open http://127.0.0.1:<port>/ in a browser to
 * see connected browser tabs (providers) and their registered tools/prompts/
 * resources. Click an item to inspect its description + input schema.
 * Polls GET /api/providers.
 */

/** The mcp-page-bridge mark (hexagon + plug), served at GET /favicon.svg. */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="22.39,6.00 22.39,18.00 12.00,24.00 1.61,18.00 1.61,6.00 12.00,0.00" fill="#E63946"/><svg x="3" y="3" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M15 8V2"/><path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"/><path d="M9 8V2"/></svg></svg>';

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>mcp-page-bridge dashboard</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1017;
        --panel: #111922;
        --panel-2: #0e151d;
        --panel-3: #141e29;
        --fg: #e8eef6;
        --muted: #91a0af;
        --quiet: #687786;
        --line: #273443;
        --line-strong: #3a4a5c;
        --brand: #e63946;
        --brand-soft: rgba(230, 57, 70, 0.14);
        --green: #3fce7a;
        --green-soft: rgba(63, 206, 122, 0.12);
        --blue: #6da2ff;
        --blue-soft: rgba(109, 162, 255, 0.11);
        --shadow: 0 24px 70px rgba(0, 0, 0, 0.28);
        --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        --sans: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }
      @media (prefers-color-scheme: light) {
        :root {
          color-scheme: light;
          --bg: #f4f6f9;
          --panel: #ffffff;
          --panel-2: #f8fafc;
          --panel-3: #f1f5f9;
          --fg: #141922;
          --muted: #5f6f80;
          --quiet: #7b8794;
          --line: #d8e0e8;
          --line-strong: #bcc8d4;
          --brand-soft: rgba(230, 57, 70, 0.09);
          --green-soft: rgba(46, 155, 78, 0.1);
          --blue-soft: rgba(47, 111, 237, 0.09);
          --shadow: 0 18px 48px rgba(20, 25, 34, 0.08);
        }
      }
      * { box-sizing: border-box; }
      html { min-height: 100%; }
      body {
        min-height: 100%;
        margin: 0;
        color: var(--fg);
        background:
          radial-gradient(circle at 16% 0%, rgba(230, 57, 70, 0.13), transparent 28rem),
          radial-gradient(circle at 86% 6%, rgba(109, 162, 255, 0.12), transparent 30rem),
          var(--bg);
        font-family: var(--sans);
        font-size: 14px;
        line-height: 1.45;
      }
      button { font: inherit; }
      .shell { max-width: 1280px; margin: 0 auto; padding: 24px clamp(16px, 3vw, 36px) 30px; }
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding-bottom: 18px;
        border-bottom: 1px solid var(--line);
      }
      .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
      .brand img { width: 34px; height: 34px; display: block; }
      .eyebrow { color: var(--muted); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; }
      h1 { margin: 1px 0 0; font-size: clamp(22px, 3vw, 32px); line-height: 1; letter-spacing: -0.04em; }
      .endpoint {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
        color: var(--muted);
        font-family: var(--mono);
        font-size: 12px;
      }
      .chip {
        border: 1px solid var(--line);
        background: var(--panel-2);
        color: var(--muted);
        border-radius: 4px;
        padding: 5px 8px;
      }
      .status-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin: 18px 0;
      }
      .status { display: flex; align-items: center; gap: 9px; color: var(--muted); }
      .dot { width: 8px; height: 8px; background: var(--brand); box-shadow: 0 0 0 4px var(--brand-soft); }
      .dot.on { background: var(--green); box-shadow: 0 0 0 4px var(--green-soft); }
      .refresh { color: var(--quiet); font-size: 12px; font-family: var(--mono); }
      .stats {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin-bottom: 18px;
      }
      .stat {
        border: 1px solid var(--line);
        background: linear-gradient(180deg, var(--panel), var(--panel-2));
        border-radius: 6px;
        padding: 12px 13px;
      }
      .stat span { display: block; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
      .stat strong { display: block; margin-top: 4px; font-size: 24px; line-height: 1; letter-spacing: -0.04em; }
      .layout {
        display: grid;
        grid-template-columns: minmax(360px, 0.95fr) minmax(430px, 1.05fr);
        gap: 18px;
        align-items: start;
      }
      .panel-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin: 0 0 9px;
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .card {
        overflow: hidden;
        margin-bottom: 12px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: color-mix(in srgb, var(--panel) 94%, transparent);
        box-shadow: var(--shadow);
      }
      .provider-card:not([open]) .provider-head { border-bottom: 0; }
      .provider-head {
        display: block;
        list-style: none;
        padding: 14px 14px 12px;
        border-bottom: 1px solid var(--line);
        cursor: pointer;
        user-select: none;
      }
      .provider-head::-webkit-details-marker { display: none; }
      .provider-main { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
      .provider-title { min-width: 0; }
      .provider-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .provider-caret {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-top: 1.5px solid var(--muted);
        border-right: 1.5px solid var(--muted);
        transform: rotate(45deg);
        transition: transform 0.15s ease;
      }
      .provider-card[open] .provider-caret { transform: rotate(135deg); }
      .label {
        max-width: 170px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        border: 1px solid color-mix(in srgb, var(--brand) 42%, var(--line));
        background: var(--brand-soft);
        color: var(--brand);
        border-radius: 4px;
        padding: 3px 7px;
        font-family: var(--mono);
        font-size: 12px;
        font-weight: 700;
      }
      .ptitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
      .url { margin-top: 6px; color: var(--quiet); font-family: var(--mono); font-size: 11px; word-break: break-all; }
      .provider-side { display: grid; justify-items: end; gap: 8px; flex-shrink: 0; }
      .metrics { display: flex; gap: 6px; }
      .metric { border: 1px solid var(--line); background: var(--panel-2); color: var(--muted); border-radius: 4px; padding: 3px 6px; font-family: var(--mono); font-size: 11px; }
      .actions { display: flex; gap: 6px; }
      .action-btn {
        appearance: none;
        border: 1px solid var(--line);
        border-radius: 4px;
        background: var(--panel-2);
        color: var(--muted);
        padding: 5px 8px;
        cursor: pointer;
        font-size: 12px;
      }
      .action-btn:hover { color: var(--fg); border-color: var(--line-strong); background: var(--panel-3); }
      .action-btn:disabled { opacity: 0.55; cursor: wait; }
      .action-btn.danger { color: var(--brand); border-color: color-mix(in srgb, var(--brand) 35%, var(--line)); background: var(--brand-soft); }
      .action-btn.danger:hover { border-color: var(--brand); }
      .card-body { padding: 10px; }
      .group {
        margin: 0 0 9px;
        border: 1px solid var(--line);
        border-radius: 5px;
        background: var(--panel-2);
      }
      .group:last-child { margin-bottom: 0; }
      .group summary {
        list-style: none;
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 38px;
        padding: 9px 10px;
        cursor: pointer;
        color: var(--muted);
        user-select: none;
      }
      .group summary::-webkit-details-marker { display: none; }
      .chev {
        width: 7px;
        height: 7px;
        border-top: 1.5px solid currentColor;
        border-right: 1.5px solid currentColor;
        transform: rotate(45deg);
        transition: transform 0.15s ease;
      }
      .group[open] .chev { transform: rotate(135deg); }
      .group-title { flex: 1; font-size: 12px; font-weight: 650; letter-spacing: 0.02em; }
      .group-count { color: var(--quiet); font-family: var(--mono); font-size: 11px; }
      .group-list { display: grid; gap: 4px; padding: 5px; border-top: 1px solid var(--line); }
      .item {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(110px, 0.8fr);
        gap: 10px;
        width: 100%;
        min-height: 40px;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: inherit;
        text-align: left;
        padding: 8px 9px;
        cursor: pointer;
      }
      .item:hover { background: var(--panel-3); border-color: var(--line); }
      .item.active { background: var(--blue-soft); border-color: color-mix(in srgb, var(--blue) 45%, var(--line)); }
      .nm { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 12.5px; }
      .full { display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--quiet); font-family: var(--mono); font-size: 10.5px; }
      .ds { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; align-self: center; }
      .detail {
        position: sticky;
        top: 18px;
        min-height: 360px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: color-mix(in srgb, var(--panel) 96%, transparent);
        box-shadow: var(--shadow);
      }
      .detail-inner { padding: 18px; }
      .detail-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
      .kind {
        border: 1px solid color-mix(in srgb, var(--blue) 40%, var(--line));
        background: var(--blue-soft);
        color: var(--blue);
        border-radius: 4px;
        padding: 3px 7px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .from { color: var(--quiet); font-family: var(--mono); font-size: 11px; text-align: right; }
      .detail h2 { margin: 0 0 6px; font-family: var(--mono); font-size: clamp(18px, 2vw, 22px); line-height: 1.2; letter-spacing: -0.04em; word-break: break-all; }
      .desc { margin: 0 0 16px; color: var(--muted); }
      .section-title { margin: 16px 0 7px; color: var(--muted); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
      table { width: 100%; border-collapse: collapse; overflow: hidden; border: 1px solid var(--line); font-size: 13px; }
      th, td { text-align: left; padding: 8px 9px; border-bottom: 1px solid var(--line); vertical-align: top; }
      tr:last-child td { border-bottom: 0; }
      th { background: var(--panel-2); color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
      .pname { font-family: var(--mono); }
      .type { font-family: var(--mono); color: var(--brand); font-size: 12px; }
      .req { color: var(--brand); font-weight: 800; }
      .raw { margin-top: 14px; border: 1px solid var(--line); border-radius: 5px; background: var(--panel-2); }
      .raw summary { list-style: none; cursor: pointer; padding: 9px 10px; color: var(--muted); font-size: 12px; }
      .raw summary::-webkit-details-marker { display: none; }
      pre { margin: 0; padding: 12px; overflow: auto; border-top: 1px solid var(--line); font-family: var(--mono); font-size: 12px; line-height: 1.45; }
      .empty {
        display: grid;
        place-items: center;
        min-height: 180px;
        padding: 20px;
        color: var(--muted);
        text-align: center;
      }
      .empty.small { min-height: 96px; border: 1px dashed var(--line); border-radius: 5px; background: var(--panel-2); }
      .placeholder { color: var(--muted); }
      code { border: 1px solid var(--line); background: var(--panel-2); padding: 1px 5px; border-radius: 3px; font-family: var(--mono); }
      footer { margin-top: 20px; color: var(--quiet); font-size: 12px; }
      @media (max-width: 900px) {
        .topbar, .status-row { align-items: flex-start; flex-direction: column; }
        .endpoint { justify-content: flex-start; }
        .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .layout { grid-template-columns: 1fr; }
        .detail { position: static; }
      }
      @media (max-width: 560px) {
        .shell { padding-inline: 12px; }
        .stats { grid-template-columns: 1fr; }
        .provider-main { flex-direction: column; }
        .provider-side { justify-items: start; }
        .item { grid-template-columns: 1fr; }
        .ds { align-self: start; }
      }
    </style>
  </head>
  <body>
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
          <span class="chip" id="version">v0.0.0</span>
          <span class="chip" id="endpoint">ws://127.0.0.1:8787</span>
          <span class="chip">GET /api/providers</span>
        </div>
      </header>

      <div class="status-row">
        <div class="status">
          <span class="dot" id="dot"></span>
          <span id="statusText">connecting</span>
        </div>
        <div class="refresh">auto refresh: 1.5s</div>
      </div>

      <section class="stats" aria-label="Connected provider summary">
        <div class="stat"><span>Providers</span><strong id="providerCount">0</strong></div>
        <div class="stat"><span>Tools</span><strong id="toolCount">0</strong></div>
      </section>

      <main class="layout">
        <section>
          <div class="panel-title"><span>Providers</span><span id="listCount">0 connected</span></div>
          <div id="list"></div>
        </section>
        <aside class="detail" id="detail">
          <div class="detail-inner"><div class="empty placeholder">Select an item to inspect its schema and source.</div></div>
        </aside>
      </main>

      <footer>Dashboard is served by the local bridge on the same port as WebSocket transport.</footer>
    </div>

    <script>
      const $ = (id) => document.getElementById(id);
      const esc = (s) =>
        String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

      const EMPTY = "No tools published.";
      const BUILTIN_TOOLS = new Set([
        "eval",
        "dom_query",
        "get_html",
        "get_page_info",
        "click",
        "set_value",
        "scroll",
        "wait_for",
        "console_logs",
        "screenshot",
        "navigate",
        "reload",
      ]);
      const BROWSER_TOOLS = new Set(["list_tabs", "open_tab", "activate_tab", "navigate_tab", "close_tab"]);

      let data = { version: "", port: 8787, providers: [] };
      let selected = null; // { kind, provider, key }
      const openProviders = Object.create(null);
      const openGroups = Object.create(null);

      function shortName(provider, key) {
        const raw = String(key || "");
        const prefix = provider.label + "__";
        return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
      }

      function counts(provider) {
        return {
          tool: (provider.tools || []).length,
        };
      }

      function totals() {
        return data.providers.reduce(
          (acc, p) => {
            acc.providers += 1;
            acc.tools += (p.tools || []).length;
            return acc;
          },
          { providers: 0, tools: 0 },
        );
      }

      function itemList(provider) {
        return provider.tools || [];
      }

      function itemKey(item) {
        return item.name;
      }

      function itemDescription(item) {
        return item.description || "";
      }

      function groupId(provider, title) {
        return provider.label + "|tools|" + title;
      }

      function classifyTool(provider, item) {
        const local = shortName(provider, item.name);
        if (provider.label === "browser" || BROWSER_TOOLS.has(local)) return "Browser control";
        if (BUILTIN_TOOLS.has(local)) return "Built-in page tools";
        return "Page tools";
      }

      function groupsFor(provider) {
        const buckets = new Map();
        for (const item of itemList(provider)) {
          const title = classifyTool(provider, item);
          if (!buckets.has(title)) buckets.set(title, []);
          buckets.get(title).push(item);
        }
        return [...buckets.entries()].map(([title, items]) => ({ title, items }));
      }

      function renderItem(provider, item) {
        const key = itemKey(item);
        const active = selected && selected.kind === "tool" && selected.provider === provider.label && selected.key === key;
        const local = shortName(provider, key);
        return (
          '<button class="item' +
          (active ? " active" : "") +
          '" data-kind="tool" data-provider="' +
          esc(provider.label) +
          '" data-key="' +
          esc(key) +
          '">' +
          '<span><span class="nm">' +
          esc(local) +
          '</span><span class="full">' +
          esc(key) +
          "</span></span>" +
          '<span class="ds">' +
          esc(itemDescription(item)) +
          "</span></button>"
        );
      }

      function renderGroups(provider) {
        const groups = groupsFor(provider);
        if (!groups.length) return '<div class="empty small">' + EMPTY + "</div>";
        return groups
          .map((group) => {
            const id = groupId(provider, group.title);
            const open = openGroups[id] !== false;
            return (
              '<details class="group" data-group="' +
              esc(id) +
              '"' +
              (open ? " open" : "") +
              '><summary><span class="chev"></span><span class="group-title">' +
              esc(group.title) +
              '</span><span class="group-count">' +
              group.items.length +
              '</span></summary><div class="group-list">' +
              group.items.map((item) => renderItem(provider, item)).join("") +
              "</div></details>"
            );
          })
          .join("");
      }

      function renderProvider(provider) {
        const c = counts(provider);
        const title = provider.title || provider.name || provider.label;
        const open = openProviders[provider.label] === true;
        const actions =
          provider.tabId === undefined
            ? ""
            : '<div class="actions"><button class="action-btn provider-action" data-action="activate" data-provider="' +
              esc(provider.label) +
              '">Focus tab</button><button class="action-btn danger provider-action" data-action="close" data-provider="' +
              esc(provider.label) +
              '">Close</button></div>';
        return (
          '<details class="card provider-card" data-provider="' +
          esc(provider.label) +
          '"' +
          (open ? " open" : "") +
          '><summary class="provider-head"><div class="provider-main"><div class="provider-title">' +
          '<div class="provider-name"><span class="label">' +
          esc(provider.label) +
          '</span><span class="provider-caret"></span>' +
          '<span class="ptitle">' +
          esc(title) +
          "</span></div>" +
          (provider.url ? '<div class="url">' + esc(provider.url) + "</div>" : "") +
          '</div><div class="provider-side"><div class="metrics"><span class="metric">Tools ' +
          c.tool +
          "</span></div>" +
          actions +
          "</div></div></summary>" +
          '<div class="card-body">' +
          renderGroups(provider) +
          "</div></details>"
        );
      }

      function allItems() {
        const items = [];
        for (const p of data.providers) {
          for (const t of p.tools || []) items.push({ kind: "tool", provider: p, key: t.name, item: t });
        }
        return items;
      }

      async function callProviderAction(provider, action) {
        if (action === "close" && !confirm("Close tab for provider " + provider + "?")) return;
        const res = await fetch("/api/providers/" + encodeURIComponent(provider) + "/" + action, {
          method: "POST",
          headers: { "x-mcp-page-bridge-dashboard": "1" },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.ok === false) throw new Error(body.error || "action failed");
        if (action === "close" && selected?.provider === provider) selected = null;
        await tick();
      }

      function renderList() {
        const list = $("list");
        if (!data.providers.length) {
          list.innerHTML =
            '<div class="card"><div class="empty">No browsers connected yet.<br/>Enable the mcp-page-bridge extension on a tab.</div></div>';
          return;
        }
        list.innerHTML = data.providers.map(renderProvider).join("");

        for (const card of document.querySelectorAll(".provider-card")) {
          card.addEventListener("toggle", () => {
            openProviders[card.dataset.provider] = card.open;
          });
        }
        for (const btn of document.querySelectorAll(".provider-action")) {
          btn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            btn.disabled = true;
            callProviderAction(btn.dataset.provider, btn.dataset.action)
              .catch((error) => {
                $("statusText").textContent = error instanceof Error ? error.message : String(error);
              })
              .finally(() => {
                btn.disabled = false;
              });
          });
        }
        for (const group of document.querySelectorAll(".group")) {
          group.addEventListener("toggle", () => {
            openGroups[group.dataset.group] = group.open;
          });
        }
        for (const btn of document.querySelectorAll(".item")) {
          btn.addEventListener("click", () => {
            selected = { kind: btn.dataset.kind, provider: btn.dataset.provider, key: btn.dataset.key };
            renderList();
            renderDetail();
          });
        }
      }

      function schemaTable(schema) {
        if (!schema || typeof schema !== "object" || !schema.properties) {
          return '<p class="placeholder">No parameters.</p>';
        }
        const required = new Set(schema.required || []);
        const rows = Object.entries(schema.properties)
          .map(([name, def]) => {
            const d = def || {};
            const type = d.type || (d.enum ? "enum" : d.oneOf ? "oneOf" : d.anyOf ? "anyOf" : "any");
            return (
              "<tr><td><span class='pname'>" +
              esc(name) +
              "</span></td><td><span class='type'>" +
              esc(type) +
              "</span></td><td>" +
              (required.has(name) ? "<span class='req'>yes</span>" : "-") +
              "</td><td>" +
              esc(d.description || "") +
              "</td></tr>"
            );
          })
          .join("");
        return (
          "<table><thead><tr><th>Param</th><th>Type</th><th>Req</th><th>Description</th></tr></thead><tbody>" +
          rows +
          "</tbody></table>"
        );
      }

      function renderDetail() {
        const el = $("detail");
        if (!selected) {
          el.innerHTML = '<div class="detail-inner"><div class="empty placeholder">Select an item to inspect its schema and source.</div></div>';
          return;
        }
        const found = allItems().find(
          (x) => x.kind === selected.kind && x.provider.label === selected.provider && x.key === selected.key,
        );
        if (!found) {
          el.innerHTML = '<div class="detail-inner"><div class="empty placeholder">That item is no longer connected.</div></div>';
          return;
        }

        const { kind, provider, item, key } = found;
        const source = provider.label + (provider.title ? " / " + provider.title : "");
        const body =
          (item.description ? '<p class="desc">' + esc(item.description) + "</p>" : "") +
          '<div class="section-title">Input</div>' +
          schemaTable(item.inputSchema) +
          (item.inputSchema
            ? '<details class="raw"><summary>Raw input schema</summary><pre>' +
              esc(JSON.stringify(item.inputSchema, null, 2)) +
              "</pre></details>"
            : "");

        el.innerHTML =
          '<div class="detail-inner"><div class="detail-head"><span class="kind">' +
          kind +
          '</span><span class="from">' +
          esc(source) +
          "</span></div><h2>" +
          esc(key) +
          "</h2>" +
          body +
          "</div>";
      }

      function updateStats() {
        const t = totals();
        $("providerCount").textContent = t.providers;
        $("toolCount").textContent = t.tools;
        $("listCount").textContent = t.providers + (t.providers === 1 ? " connected" : " connected");
      }

      async function tick() {
        try {
          const res = await fetch("/api/providers", { cache: "no-store" });
          data = await res.json();
          $("dot").className = "dot on";
          $("version").textContent = "v" + data.version;
          $("endpoint").textContent = "ws://127.0.0.1:" + data.port;
          const n = data.providers.length;
          $("statusText").textContent = n ? "bridge online, browser providers connected" : "bridge online, waiting for browser tabs";
          updateStats();
          renderList();
          renderDetail();
        } catch {
          data = { version: "", port: 8787, providers: [] };
          $("dot").className = "dot";
          $("statusText").textContent = "bridge not reachable";
          updateStats();
        }
      }

      tick();
      setInterval(tick, 1500);
    </script>
  </body>
</html>
`;
