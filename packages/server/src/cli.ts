import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { DEFAULT_PORT, MCP_PAGE_BRIDGE_VERSION } from "mcp-page-bridge-protocol";
import { createBridge } from "./bridge.js";

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return undefined;
}

function parsePort(argv: string[]): number {
  const fromFlag = parseFlag(argv, "--port") ?? process.env.MCP_PAGE_BRIDGE_PORT;
  const n = Number(fromFlag);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

function isAddrInUse(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "EADDRINUSE";
}

async function connectProxy(port: number, token: string | undefined): Promise<void> {
  const url = new URL(`ws://127.0.0.1:${port}/agent`);
  if (token) url.searchParams.set("token", token);

  const stdio = new StdioServerTransport();
  const remote = new WebSocketClientTransport(url);

  stdio.onmessage = (message) => {
    void remote.send(message).catch((error) => stdio.onerror?.(error as Error));
  };
  remote.onmessage = (message) => {
    void stdio.send(message).catch((error) => remote.onerror?.(error as Error));
  };
  stdio.onclose = () => {
    void remote.close().catch(() => {
      // ignore
    });
  };
  remote.onclose = () => {
    void stdio.close().catch(() => {
      // ignore
    });
  };
  remote.onerror = (error) => {
    console.error(`[mcp-page-bridge] proxy websocket error: ${error.message}`);
  };

  await remote.start();
  await stdio.start();
  console.error(`[mcp-page-bridge] MCP stdio proxy ready → ws://127.0.0.1:${port}/agent`);

  const shutdown = async (): Promise<void> => {
    await Promise.allSettled([remote.close(), stdio.close()]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const port = parsePort(argv);
  const token = parseFlag(argv, "--token") ?? process.env.MCP_PAGE_BRIDGE_TOKEN;
  let bridge: Awaited<ReturnType<typeof createBridge>>;
  try {
    bridge = await createBridge({ port, token });
  } catch (error) {
    if (!isAddrInUse(error)) throw error;
    console.error(
      `[mcp-page-bridge] port ${port} is already in use; attaching this agent to the existing bridge`,
    );
    await connectProxy(port, token);
    return;
  }

  // IMPORTANT: stdout is the MCP channel; all logs go to stderr.
  console.error(
    `[mcp-page-bridge] v${MCP_PAGE_BRIDGE_VERSION} — ws://127.0.0.1:${bridge.port}` +
      ` · dashboard http://127.0.0.1:${bridge.port}/` +
      (token ? " (token required)" : ""),
  );

  const transport = new StdioServerTransport();
  await bridge.server.connect(transport);
  console.error("[mcp-page-bridge] MCP stdio server ready (waiting for agent + browser connections)");

  const shutdown = async (): Promise<void> => {
    await bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[mcp-page-bridge] fatal:", error);
  process.exit(1);
});
