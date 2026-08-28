<p align="center">
  <img src="assets/favicon.svg" alt="mcp-page-bridge" width="96" height="96" />
</p>

<h1 align="center">MCP Page Bridge</h1>

<p align="center">
  Bridge a <strong>live browser page's MCP server</strong> to a coding agent (OpenCode, Claude, Cursor, ...).
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mcp-page-bridge"><img src="https://img.shields.io/npm/v/mcp-page-bridge?style=flat-square&logo=npm&label=npm" alt="npm version" /></a>
  <a href="https://chromewebstore.google.com/detail/mcp-page-bridge/lpehmmnlgeaocbnleigemiadocgadgmo"><img src="https://img.shields.io/chrome-web-store/v/lpehmmnlgeaocbnleigemiadocgadgmo?style=flat-square&logo=googlechrome&logoColor=white&label=chrome%20web%20store" alt="Chrome Web Store" /></a>
  <a href="https://github.com/rytsh/mcp-page-bridge/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/mcp-page-bridge?style=flat-square&label=license" alt="License" /></a>
</p>

`mcp-page-bridge` lets an MCP client/agent use tools exposed by the active browser page. It has two parts:

- A local MCP server (a single Go binary) started by your agent — via `npx`, or as a standalone download.
- A Chromium extension installed from the Chrome Web Store (or manually from GitHub Releases).

```mermaid
flowchart LR
    A["Agent<br/>OpenCode · Claude · …"]

    subgraph bridge["mcp-page-bridge (Go)"]
        B["MCP server over stdio<br/>aggregating proxy<br/>1 MCP Client per tab<br/>tools → label__tool"]
        D["Dashboard + JSON API<br/>/ · /api/providers"]
    end

    subgraph ext["Browser — MV3 extension"]
        SW["Service worker<br/>owns the WebSocket(s)<br/>trusted input · CDP"]
        CS["content script<br/>(ISOLATED)"]
        IN["inject (MAIN)<br/>window.mcp + built-ins"]
        FR["frame agent (MAIN)<br/>every iframe"]
        PG["Your page / app"]
    end

    A <-->|"MCP (stdio)"| B
    B <-->|"WebSocket :8787<br/>raw MCP JSON-RPC"| SW
    SW <-->|"chrome.runtime port"| CS
    CS <-->|"postMessage"| IN
    IN -->|"registers tools"| PG
    SW <-->|"scripting.executeScript<br/>snapshot · actions"| FR
    B -.->|serves| D
```

## Install

### 1. Install the Chrome extension

Add the `mcp-page-bridge` extension from the Chrome Web Store:

> https://chromewebstore.google.com/detail/mcp-page-bridge/lpehmmnlgeaocbnleigemiadocgadgmo

<details><summary>Alternative manual installation from GitHub Releases</summary>

1. Open the [GitHub Releases](https://github.com/rytsh/mcp-page-bridge/releases) page.
2. Download the extension zip from the latest release.
3. Unzip it locally.
4. Open `chrome://extensions`.
5. Enable **Developer mode**.
6. Click **Load unpacked** and select the unzipped extension folder containing `manifest.json`.

</details>

### 2. Add the MCP server to your agent

The bridge runs as a local MCP server over stdio, started via the published npm package with `npx` — or, if you don't have Node installed, via a [standalone binary](#standalone-binary) from GitHub Releases. Configure it once for your agent.

<details><summary>OpenCode</summary>

Add it to `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mcp-page-bridge": {
      "type": "local",
      "command": ["npx", "-y", "mcp-page-bridge", "--port", "8787"],
      "enabled": true
    }
  }
}
```

</details>

<details><summary>Claude Code</summary>

Add it from the CLI:

```bash
claude mcp add mcp-page-bridge -- npx -y mcp-page-bridge --port 8787
```

Or add it to `.mcp.json` (project scope):

```json
{
  "mcpServers": {
    "mcp-page-bridge": {
      "command": "npx",
      "args": ["-y", "mcp-page-bridge", "--port", "8787"]
    }
  }
}
```

</details>

<details><summary>Claude Desktop · Cursor · other agents</summary>

Add it to the agent's MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mcp-page-bridge": {
      "command": "npx",
      "args": ["-y", "mcp-page-bridge", "--port", "8787"]
    }
  }
}
```

</details>

<a name="standalone-binary"></a>
<details><summary>Standalone binary — no Node/npx required</summary>

The bridge also ships as a single-binary Go implementation (~9 MB, no runtime needed). Each [GitHub Release](https://github.com/rytsh/mcp-page-bridge/releases) carries archives with stable (version-free) names, so the `latest` download URL always works:

| Platform | Asset |
|---|---|
| Linux x64 | `mcp-page-bridge-linux-x64.tar.gz` |
| Linux arm64 | `mcp-page-bridge-linux-arm64.tar.gz` |
| macOS Intel | `mcp-page-bridge-darwin-x64.tar.gz` |
| macOS Apple Silicon | `mcp-page-bridge-darwin-arm64.tar.gz` |
| Windows x64 | `mcp-page-bridge-windows-x64.zip` |

Download, extract, and (optionally) put the binary on your `PATH`:

```bash
curl -fsSL https://github.com/rytsh/mcp-page-bridge/releases/latest/download/mcp-page-bridge-linux-x64.tar.gz \
  | tar -xz mcp-page-bridge
sudo mv mcp-page-bridge /usr/local/bin/
```

Then reference the binary instead of `npx` in your agent config. For opencode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mcp-page-bridge": {
      "type": "local",
      "command": ["mcp-page-bridge", "--port", "8787"],
      "enabled": true
    }
  }
}
```

For Claude / Cursor and other `mcpServers`-style agents:

```json
{
  "mcpServers": {
    "mcp-page-bridge": {
      "command": "mcp-page-bridge",
      "args": ["--port", "8787"]
    }
  }
}
```

> On macOS, downloaded binaries may be quarantined by Gatekeeper. Clear it with
> `xattr -d com.apple.quarantine ./mcp-page-bridge`.

With a Go toolchain you can also install straight from source:

```bash
go install github.com/rytsh/mcp-page-bridge/cmd/mcp-page-bridge@latest
```

</details>

<details><summary>Alternative local build and configuration</summary>

If you prefer a local checkout instead of the npm package (requires Go):

```bash
git clone https://github.com/rytsh/mcp-page-bridge.git
cd mcp-page-bridge
go build -o mcp-page-bridge ./cmd/mcp-page-bridge
```

Then point your agent at the built binary. For opencode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mcp-page-bridge": {
      "type": "local",
      "command": ["/absolute/path/to/mcp-page-bridge/mcp-page-bridge", "--port", "8787"],
      "enabled": true
    }
  }
}
```

For Claude / Cursor and other `mcpServers`-style agents:

```json
{
  "mcpServers": {
    "mcp-page-bridge": {
      "command": "/absolute/path/to/mcp-page-bridge/mcp-page-bridge",
      "args": ["--port", "8787"]
    }
  }
}
```

</details>

<details><summary>Remote bridge — connect to a daemon on another machine</summary>

The daemon also speaks **MCP Streamable HTTP** at `http://<host>:<port>/mcp`,
so a daemon running on another machine can be added to your agent as a plain
remote MCP server URL — no local binary needed.

On the remote machine, start the daemon bound to a non-loopback address
(a token is strongly recommended; without one the bridge only logs a warning
and anyone on the network can reach the connected pages' tools):

```bash
mcp-page-bridge --host 0.0.0.0 --port 8787 --token <secret>
```

Then add the URL to your agent. For opencode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mcp-page-bridge": {
      "type": "remote",
      "url": "http://192.168.1.50:8787/mcp",
      "headers": { "Authorization": "Bearer <secret>" },
      "enabled": true
    }
  }
}
```

For Claude Code:

```bash
claude mcp add --transport http mcp-page-bridge http://192.168.1.50:8787/mcp \
  --header "Authorization: Bearer <secret>"
```

For other agents, any of these carries the token:

- `Authorization: Bearer <secret>` header
- `x-mcp-page-bridge-token: <secret>` header
- `?token=<secret>` query parameter (`http://192.168.1.50:8787/mcp?token=<secret>`)

**Alternative: stdio proxy to a remote daemon.** If your agent only supports
stdio servers, run the binary locally pointed at the remote host — it probes
`host:port`, finds the running daemon, and acts as a thin stdio↔WebSocket
proxy instead of spawning a new one:

```json
{
  "mcpServers": {
    "mcp-page-bridge": {
      "command": "npx",
      "args": ["-y", "mcp-page-bridge", "--host", "192.168.1.50", "--port", "8787", "--token", "<secret>"]
    }
  }
}
```

The flags can also be supplied as `MCP_PAGE_BRIDGE_HOST`,
`MCP_PAGE_BRIDGE_PORT`, and `MCP_PAGE_BRIDGE_TOKEN` environment variables.

Notes:

- The same applies on a single machine: if a daemon is already listening on
  the port, a second one is never spawned — every agent connects to it. The
  local daemon is reachable at `http://127.0.0.1:8787/mcp` too.
- The extension popup on the remote browser needs the same host/IP + token.
- Without TLS, traffic is plain `http://`/`ws://` — use a token and a trusted
  network, or enable built-in TLS (below). See
  [DETAILS.md](DETAILS.md#security) for the security notes.

**TLS (built-in).** Give the daemon a certificate and it serves
`https://`/`wss://` natively:

```bash
mcp-page-bridge --host 0.0.0.0 --port 8787 --token <secret> \
  --tls-cert /path/fullchain.pem --tls-key /path/privkey.pem
```

Clients then connect securely:

- **Remote MCP URL**: `https://bridge.example.com:8787/mcp`.
- **stdio proxy**: add `--tls` (plus `--tls-ca <ca.pem>` for a private CA, or
  `--tls-insecure` to skip verification — testing only):

  ```json
  { "args": ["-y", "mcp-page-bridge", "--host", "bridge.example.com", "--port", "8787", "--token", "<secret>", "--tls"] }
  ```

- **Extension popup**: tick **Secure connection (TLS / wss)** in the bridge
  settings. Note the browser must trust the certificate (use a real CA, e.g.
  Let's Encrypt, or install your private CA in the OS/browser trust store —
  self-signed certs are rejected for `wss://`).

The TLS flags are also available as `MCP_PAGE_BRIDGE_TLS`,
`MCP_PAGE_BRIDGE_TLS_CERT`, `MCP_PAGE_BRIDGE_TLS_KEY`, `MCP_PAGE_BRIDGE_TLS_CA`
and `MCP_PAGE_BRIDGE_TLS_INSECURE_SKIP_VERIFY` environment variables.
Alternatively, a reverse proxy (Caddy/nginx) or SSH tunnel in front of a
plain-HTTP bridge works as before.

</details>

### Profiles — multi-user isolation

A **profile key** is a per-user secret that *partitions* a bridge: a browser tab
shared under key `X` is only visible to an agent that connects with the same key
`X`. Use it when several people share one daemon (e.g. a remote bridge) and each
must only see their own tabs.

- **Extension**: set a **Profile key** in the popup (it becomes part of the
  bridge profile alongside host/port/token). Leave it empty for the normal
  single-user/local flow.
- **Agent (stdio)**: pass `--profile <secret>` (or `MCP_PAGE_BRIDGE_PROFILE`).
- **Agent (remote `/mcp`)**: send the secret as the `x-mcp-page-bridge-profile`
  header or a `?profile=<secret>` query parameter — the same secret value you use
  everywhere else.
- **Daemon (operator)**: add `--require-profile` to reject any connection without
  a profile key (true multi-user mode). Off by default so local use needs no
  configuration.
- **Dashboard**: under `--require-profile` it locks behind a login — enter your
  profile key (and token) to see only your tabs. Locally, the **Profile…** button
  lets you switch partitions on demand.

Security: the profile secret is sent like the token (the daemon hashes it into an
opaque partition key), so the **same value works everywhere** — extension, stdio
proxy, remote `/mcp` URL, and dashboard. Matching is on the full hash, so other
users can't enumerate or reach your tabs, but the secret is a bearer credential
on the wire: use `--token` + TLS for any remote/shared daemon and pick a strong
secret. Tabs/agents with **no** profile form a separate default partition and
never see profiled ones (and vice-versa).

```bash
# operator: shared remote daemon, every connection must carry a profile
mcp-page-bridge --host 0.0.0.0 --token <secret> --require-profile \
  --tls-cert /path/fullchain.pem --tls-key /path/privkey.pem

# your agent (stdio proxy): only your tabs
mcp-page-bridge --host bridge.example.com --port 8787 --token <secret> \
  --tls --profile "my-strong-passphrase"
```

See [DETAILS.md](DETAILS.md#profiles-multi-user-isolation) for the full model.

### 3. Use it

1. Start your agent session. The agent should spawn `mcp-page-bridge` from the MCP config.
2. Open the browser page you want to connect.
3. Click the `mcp-page-bridge` extension icon.
4. Click **Enable on this tab**.
5. Ask your agent to call `mcp_page_bridge_list_clients` to confirm the tab is connected.

Every enabled tab already exposes a lean set of built-in tools (`take_snapshot`,
`find`, `click`, `drag`, `type_text`, `press_key`, `get_page_text`, `eval`,
`screenshot`, `navigate`, …) — no page changes needed:

- **Snapshot → act → observe.** `take_snapshot` hands out stable `uid`s for the
  page's interactive elements (cross-origin iframes included, as `f1e2`), and
  action tools append a fresh snapshot to their result, so a click and its
  outcome are one call. Ask for pixels with `observe:"screenshot"`. Scope big
  pages with `rootUid`/`maxDepth`, or skip the tree entirely with
  `find("add to cart button")`.
- **Real pointer input.** `click` carries a `button` (`right` opens the page's
  context menu) and `modifiers` (`ctrl`/`shift` for multi- and range-select);
  `drag` does a stepped pointer drag, which is what dnd-kit, sortable lists,
  sliders and canvas editors actually listen for; `scroll` with a `direction`
  dispatches a real wheel, the only way to move inner scroll containers and
  virtualized lists.
- **Keyboard-accurate input.** `type_text` types character by character (embed
  keys with `<kbd>Enter</kbd>`), `press_key` takes chords like `Meta+A
  Backspace` and can hold keys with `holdMs`. Turn on **Trusted input** in the
  popup and all of it dispatches real browser events for pages that ignore
  synthetic ones.
- **Reading without burning context.** `get_page_text` returns the rendered
  article text instead of raw HTML; `zoom` enlarges one region instead of
  spending a whole screenshot on it.
- **Screenshots that line up with the tree.** `screenshot` supports
  `fullPage:true`, `refs:true` (uid labels drawn on the page) and `maxWidth`, and
  every result states how image pixels map back to the CSS pixels `click{x,y}`
  expects.
- **Follows the file.** `wait_for_download` returns the on-disk path of the file
  a page just exported, so your agent can read it with its own filesystem tools.

Optional dashboard: open `http://127.0.0.1:8787/` while the bridge is running.
Use **Shutdown bridge** there when you want to stop the background daemon.

> **Browser on another device?** Start the bridge with
> `--host 0.0.0.0 --token <secret>` and set the same Host/IP + token in the
> extension popup. A token is strongly recommended for any non-loopback bind.
> See [DETAILS.md](DETAILS.md) for the security notes.

> **Multiple daemons?** Each tab's bridge is just its
> `(host, port, token, secure, profile key)` — set it in the popup and tabs with
> the same config auto-group; new tabs inherit the most recent. Pick a known one
> from the **Bridge** dropdown, and optionally enable **"Group tabs by bridge"**
> to mirror it as Chrome tab groups. See
> [DETAILS.md](DETAILS.md#per-tab-bridges-profiles-and-tab-groups).

## Expose your page's own tools — `window.mcp`

The extension injects a `window.mcp` API into enabled tabs, so your app can
publish **its own** MCP tools to the agent. The simplest form is a plain
manifest — no imports, no extension API, no timing dependency (it works even if
the page runs before the extension injects):

```js
window.mcp = {
  label: "checkout", // tool namespace → checkout__getCart
  tools: {
    getCart: () => store.getState().cart,
    addItem: {
      description: "Add an item to the cart",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: (args) => store.addItem(args.id),
    },
  },
};
```

If the extension is not installed, `window.mcp` is just inert page data — safe
to ship in production. Tool changes are picked up live while the tab is enabled.
More in [DETAILS.md](DETAILS.md#authoring-tools-in-your-own-page); working examples:
[`examples/demo-app`](examples/demo-app) (vanilla) and
[`examples/svelte-app`](examples/svelte-app) (Svelte 5 runes).

## More Details

The full list of built-in tools (design/automation/CDP toolsets), advanced `window.mcp` usage, multi-agent behaviour, security notes, and development details are in [DETAILS.md](DETAILS.md).
