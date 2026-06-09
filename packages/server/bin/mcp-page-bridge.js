#!/usr/bin/env node
// Thin launcher for the mcp-page-bridge Go binary (esbuild/turbo model): the
// real implementation lives in a per-platform optionalDependency; npm installs
// only the one matching this machine. All arguments and stdio pass through.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const PLATFORM_PACKAGES = {
  "linux-x64": ["mcp-page-bridge-linux-x64", "mcp-page-bridge"],
  "linux-arm64": ["mcp-page-bridge-linux-arm64", "mcp-page-bridge"],
  "darwin-x64": ["mcp-page-bridge-darwin-x64", "mcp-page-bridge"],
  "darwin-arm64": ["mcp-page-bridge-darwin-arm64", "mcp-page-bridge"],
  "win32-x64": ["mcp-page-bridge-windows-x64", "mcp-page-bridge.exe"],
};

function resolveBinary() {
  // Escape hatch for tests, local checkouts, and unsupported platforms.
  if (process.env.MCP_PAGE_BRIDGE_BINARY) return process.env.MCP_PAGE_BRIDGE_BINARY;

  const key = `${process.platform}-${process.arch}`;
  const entry = PLATFORM_PACKAGES[key];
  if (!entry) {
    console.error(
      `[mcp-page-bridge] unsupported platform ${key}; download a binary from ` +
        "https://github.com/rytsh/mcp-page-bridge/releases or build with " +
        "`go install github.com/rytsh/mcp-page-bridge/cmd/mcp-page-bridge@latest`",
    );
    process.exit(1);
  }

  const [pkg, bin] = entry;
  try {
    return require.resolve(`${pkg}/bin/${bin}`);
  } catch {
    console.error(
      `[mcp-page-bridge] the platform package ${pkg} is missing. ` +
        "It installs as an optionalDependency of mcp-page-bridge — make sure optional " +
        "dependencies are not disabled (npm: --no-optional, pnpm: --no-optional), then reinstall.",
    );
    process.exit(1);
  }
}

const child = spawn(resolveBinary(), process.argv.slice(2), { stdio: "inherit" });

child.on("error", (error) => {
  console.error(`[mcp-page-bridge] failed to start binary: ${error.message}`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
