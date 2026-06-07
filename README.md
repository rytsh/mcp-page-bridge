<p align="center">
  <img src="assets/favicon.svg" alt="mcp-page-bridge" width="96" height="96" />
</p>

<h1 align="center">mcp-page-bridge</h1>

<p align="center">
  Bridge a <strong>live browser page's MCP server</strong> to a coding agent (opencode, Claude, Cursor, ...).
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mcp-page-bridge"><img src="https://img.shields.io/npm/v/mcp-page-bridge?style=flat-square&logo=npm&label=npm" alt="npm version" /></a>
  <a href="https://chromewebstore.google.com/detail/mcp-page-bridge/lpehmmnlgeaocbnleigemiadocgadgmo"><img src="https://img.shields.io/chrome-web-store/v/lpehmmnlgeaocbnleigemiadocgadgmo?style=flat-square&logo=googlechrome&logoColor=white&label=chrome%20web%20store" alt="Chrome Web Store" /></a>
  <a href="https://github.com/rytsh/mcp-page-bridge/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/mcp-page-bridge?style=flat-square&label=license" alt="License" /></a>
</p>

`mcp-page-bridge` lets an MCP client/agent use tools exposed by the active browser page. It has two parts:

- A local MCP server started by your agent, or manually from your terminal.
- A Chromium extension installed from the Chrome Web Store (or manually from GitHub Releases).

```mermaid
flowchart LR
    A["Agent<br/>opencode · Claude · …"]

    subgraph bridge["mcp-page-bridge (Node)"]
        B["MCP server over stdio<br/>aggregating proxy<br/>1 MCP Client per tab<br/>tools → label__tool"]
        D["Dashboard + JSON API<br/>/ · /api/providers"]
    end

    subgraph ext["Browser — MV3 extension"]
        SW["Service worker<br/>owns the WebSocket(s)"]
        CS["content script<br/>(ISOLATED)"]
        IN["inject (MAIN)<br/>window.mcp"]
        PG["Your page / app"]
    end

    A <-->|"MCP (stdio)"| B
    B <-->|"WebSocket :8787<br/>raw MCP JSON-RPC"| SW
    SW <-->|"chrome.runtime port"| CS
    CS <-->|"postMessage"| IN
    IN -->|"registers tools"| PG
    B -.->|serves| D
```

## Install

### 1. Install the Chrome extension

Add `mcp-page-bridge` extension in Chrome web Store.

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

The bridge runs as a local MCP server over stdio, started via the published npm package with `npx`. Configure it once for your agent.

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

<details><summary>Alternative local build and configuration</summary>

If you prefer a local checkout instead of the npm package:

```bash
git clone https://github.com/rytsh/mcp-page-bridge.git
cd mcp-page-bridge
pnpm install
pnpm approve-builds --all
pnpm --filter mcp-page-bridge build
```

Then point your agent at the built local CLI. For opencode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mcp-page-bridge": {
      "type": "local",
      "command": ["node", "/absolute/path/to/mcp-page-bridge/packages/server/dist/cli.js", "--port", "8787"],
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
      "command": "node",
      "args": ["/absolute/path/to/mcp-page-bridge/packages/server/dist/cli.js", "--port", "8787"]
    }
  }
}
```

</details>

### 3. Use it

1. Start your agent session. The agent should spawn `mcp-page-bridge` from the MCP config.
2. Open the browser page you want to connect.
3. Click the `mcp-page-bridge` extension icon.
4. Click **Enable on this tab**.
5. Ask your agent to call `mcp_page_bridge_list_clients` to confirm the tab is connected.

Optional dashboard: open `http://127.0.0.1:8787/` while the bridge is running.
Use **Shutdown bridge** there when you want to stop the background daemon.

## More Details

Advanced usage, page authoring with `window.mcp`, built-in browser tools, security notes, examples, and development details are in [DETAILS.md](DETAILS.md).
