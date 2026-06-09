/**
 * Test helper: builds (once) and runs the Go bridge daemon for e2e tests, so
 * the extension's embedded MCP server is exercised against the real bridge
 * implementation. Requires a Go toolchain on PATH.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

let builtBinary: string | undefined;

/** Compile cmd/mcp-page-bridge once per test run (Go's build cache makes this fast). */
function buildBinary(): string {
  if (builtBinary) return builtBinary;
  const dir = mkdtempSync(join(tmpdir(), "mcp-page-bridge-e2e-"));
  const binary = join(dir, process.platform === "win32" ? "mcp-page-bridge.exe" : "mcp-page-bridge");
  try {
    execFileSync("go", ["build", "-o", binary, "./cmd/mcp-page-bridge"], { cwd: repoRoot, stdio: "pipe" });
  } catch (error) {
    throw new Error(
      `failed to build the Go bridge for e2e tests (is Go installed?): ${(error as Error).message}`,
    );
  }
  builtBinary = binary;
  return binary;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolvePort(port) : reject(new Error("no port"))));
    });
  });
}

export interface GoBridge {
  port: number;
  listProviders(): Promise<Array<{ label: string }>>;
  stop(): Promise<void>;
}

/** Start a Go bridge daemon on a free port and wait until it is healthy. */
export async function startGoBridge(): Promise<GoBridge> {
  const binary = buildBinary();
  const port = await freePort();
  const pidFile = join(mkdtempSync(join(tmpdir(), "mcp-page-bridge-pid-")), "daemon.pid");

  const child: ChildProcess = spawn(binary, ["--daemon", "--port", String(port)], {
    env: { ...process.env, MCP_PAGE_BRIDGE_DAEMON_PID_FILE: pidFile },
    stdio: "ignore",
  });

  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`bridge daemon exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("timed out waiting for the Go bridge daemon");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    port,
    async listProviders() {
      const res = await fetch(`http://127.0.0.1:${port}/api/providers`);
      const body = (await res.json()) as { providers?: Array<{ label: string }> };
      return body.providers ?? [];
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolveExit();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
    },
  };
}
