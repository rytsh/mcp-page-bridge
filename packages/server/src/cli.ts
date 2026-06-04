import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_PORT, RMCP_VERSION } from "@r-mcp/protocol";
import { createBridge } from "./bridge.js";

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return undefined;
}

function parsePort(argv: string[]): number {
  const fromFlag = parseFlag(argv, "--port") ?? process.env.RMCP_PORT;
  const n = Number(fromFlag);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const port = parsePort(argv);
  const token = parseFlag(argv, "--token") ?? process.env.RMCP_TOKEN;
  const bridge = await createBridge({ port, token });

  // IMPORTANT: stdout is the MCP channel; all logs go to stderr.
  console.error(
    `[r-mcp] v${RMCP_VERSION} — ws://127.0.0.1:${bridge.port}` +
      ` · dashboard http://127.0.0.1:${bridge.port}/` +
      (token ? " (token required)" : ""),
  );

  const transport = new StdioServerTransport();
  await bridge.server.connect(transport);
  console.error("[r-mcp] MCP stdio server ready (waiting for agent + browser connections)");

  const shutdown = async (): Promise<void> => {
    await bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[r-mcp] fatal:", error);
  process.exit(1);
});
