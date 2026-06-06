import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DASHBOARD_HEADER,
  DASHBOARD_HEADER_VALUE,
  DEFAULT_PORT,
  MCP_PAGE_BRIDGE_VERSION,
  SERVICE_ID,
  TOKEN_HEADER,
} from "mcp-page-bridge-protocol";
import { createBridge } from "./bridge.js";

const DAEMON_FLAG = "--daemon";
const DAEMON_READY_TIMEOUT_MS = 5000;
const DAEMON_READY_INTERVAL_MS = 100;

/** Path of the daemon PID file for a given port (env override for tests). */
function pidFilePath(port: number): string {
  return process.env.MCP_PAGE_BRIDGE_DAEMON_PID_FILE ?? join(tmpdir(), `mcp-page-bridge-${port}.pid`);
}

async function writePidFile(path: string): Promise<void> {
  try {
    await writeFile(path, `${process.pid}\n`);
  } catch (error) {
    console.error(`[mcp-page-bridge] warning: failed to write pid file: ${(error as Error).message}`);
  }
}

async function removePidFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {
    // ignore
  });
}

async function readPidFile(port: number): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(pidFilePath(port), "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Parse `--idle-timeout <seconds>` (or env) into milliseconds; 0 disables. */
function parseIdleTimeoutMs(argv: string[]): number {
  const raw = parseFlag(argv, "--idle-timeout") ?? process.env.MCP_PAGE_BRIDGE_IDLE_TIMEOUT;
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid --idle-timeout "${raw}": expected a non-negative number of seconds`);
  }
  return Math.round(n * 1000);
}

type BridgeProbe =
  | { status: "none" }
  | { status: "foreign" }
  | { status: "bridge"; requiresToken: boolean };

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 500): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Identify what (if anything) is listening on the bridge HTTP port. */
export async function probeBridge(port: number): Promise<BridgeProbe> {
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/api/health`);
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { service?: unknown; requiresToken?: unknown };
      if (body.service === SERVICE_ID) {
        return { status: "bridge", requiresToken: !!body.requiresToken };
      }
      return { status: "foreign" };
    }
    if (res.status === 404) {
      // Possibly an older bridge without /api/health: fall back to /api/providers.
      const legacy = await fetchWithTimeout(`http://127.0.0.1:${port}/api/providers`);
      if (legacy.status === 401) return { status: "bridge", requiresToken: true };
      if (legacy.ok) {
        const body = (await legacy.json().catch(() => ({}))) as { providers?: unknown };
        if (Array.isArray(body.providers)) return { status: "bridge", requiresToken: false };
      }
      return { status: "foreign" };
    }
    return { status: "foreign" };
  } catch {
    return { status: "none" };
  }
}

/** Confirm our token is accepted by a token-protected bridge (true/false). */
async function tokenAccepted(port: number, token: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/api/providers`, {
      headers: { [TOKEN_HEADER]: token },
    });
    return res.ok;
  } catch {
    return false;
  }
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return undefined;
}

export function parsePort(argv: string[]): number {
  const fromFlag = parseFlag(argv, "--port") ?? process.env.MCP_PAGE_BRIDGE_PORT;
  if (fromFlag === undefined) return DEFAULT_PORT;
  const n = Number(fromFlag);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid --port "${fromFlag}": expected an integer in 1..65535`);
  }
  return n;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function daemonExecArgv(): string[] {
  return process.execArgv.filter((arg) => !arg.startsWith("--inspect") && !arg.startsWith("--debug"));
}

async function bridgeReady(port: number): Promise<boolean> {
  return (await probeBridge(port)).status === "bridge";
}

/**
 * Verify that a bridge already running on `port` is compatible with this agent's
 * token before we attach. Throws a clear, actionable error on mismatch.
 */
export async function assertCompatibleToken(
  port: number,
  token: string | undefined,
  probe: BridgeProbe,
): Promise<void> {
  if (probe.status !== "bridge") return;
  if (probe.requiresToken) {
    if (!token) {
      throw new Error(
        `a bridge is already running on port ${port} and requires a token; ` +
          `pass --token <secret> (or set MCP_PAGE_BRIDGE_TOKEN) to attach`,
      );
    }
    if (!(await tokenAccepted(port, token))) {
      throw new Error(
        `a bridge is already running on port ${port} but rejected the provided token; ` +
          `every agent on this port must use the same --token`,
      );
    }
  } else if (token) {
    console.error(
      `[mcp-page-bridge] note: a tokenless bridge is already running on port ${port}; ` +
        `the provided token is ignored for this attach`,
    );
  }
}

async function startDaemon(port: number, token: string | undefined, idleTimeoutMs: number): Promise<void> {
  const pidFile = pidFilePath(port);
  const bridge = await createBridge({
    port,
    token,
    idleTimeoutMs,
    onIdleShutdown: () => {
      console.error(`[mcp-page-bridge] idle for ${idleTimeoutMs}ms with no agents/providers; shutting down`);
      void removePidFile(pidFile).finally(() => process.exit(0));
    },
  });
  await writePidFile(pidFile);
  console.error(
    `[mcp-page-bridge] daemon v${MCP_PAGE_BRIDGE_VERSION} — ws://127.0.0.1:${bridge.port}` +
      ` · dashboard http://127.0.0.1:${bridge.port}/` +
      (token ? " (token required)" : "") +
      (idleTimeoutMs > 0 ? ` · idle-timeout ${idleTimeoutMs / 1000}s` : ""),
  );

  const shutdown = async (): Promise<void> => {
    await bridge.close();
    await removePidFile(pidFile);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function ensureDaemon(port: number, token: string | undefined, idleTimeoutMs: number): Promise<void> {
  const existing = await probeBridge(port);
  if (existing.status === "bridge") {
    await assertCompatibleToken(port, token, existing);
    return;
  }
  if (existing.status === "foreign") {
    throw new Error(
      `port ${port} is in use by a non-mcp-page-bridge server; ` +
        `choose another port with --port <n>`,
    );
  }

  const script = fileURLToPath(import.meta.url);
  const args = [...daemonExecArgv(), script, DAEMON_FLAG, "--port", String(port)];
  if (idleTimeoutMs > 0) args.push("--idle-timeout", String(idleTimeoutMs / 1000));
  const env: NodeJS.ProcessEnv = { ...process.env, MCP_PAGE_BRIDGE_PORT: String(port) };
  if (token) env.MCP_PAGE_BRIDGE_TOKEN = token;

  let spawnError: Error | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const child = spawn(process.execPath, args, {
    detached: true,
    env,
    stdio: "ignore",
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  child.unref();

  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (exit) {
      throw new Error(
        `bridge daemon exited before it was ready` +
          (exit.signal ? ` (signal ${exit.signal})` : ` (code ${exit.code ?? "unknown"})`),
      );
    }
    if (await bridgeReady(port)) {
      console.error(`[mcp-page-bridge] started background bridge daemon on port ${port}`);
      return;
    }
    await delay(DAEMON_READY_INTERVAL_MS);
  }

  throw new Error(`timed out waiting for bridge daemon on port ${port}`);
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

/** `mcp-page-bridge stop` — shut down a running daemon on the given port. */
async function stopDaemon(port: number, token: string | undefined): Promise<void> {
  const probe = await probeBridge(port);
  if (probe.status === "none") {
    console.error(`[mcp-page-bridge] no bridge is running on port ${port}`);
    return;
  }
  if (probe.status === "foreign") {
    throw new Error(`port ${port} is held by a non-mcp-page-bridge server; refusing to stop it`);
  }
  if (probe.requiresToken && !token) {
    throw new Error(`the bridge on port ${port} requires a token; pass --token <secret> to stop it`);
  }

  const headers: Record<string, string> = { [DASHBOARD_HEADER]: DASHBOARD_HEADER_VALUE };
  if (token) headers[TOKEN_HEADER] = token;
  try {
    const res = await fetchWithTimeout(
      `http://127.0.0.1:${port}/api/shutdown`,
      { method: "POST", headers },
      2000,
    );
    if (!res.ok) throw new Error(`shutdown endpoint returned ${res.status}`);
    console.error(`[mcp-page-bridge] shutdown requested on port ${port}`);
    return;
  } catch (error) {
    // Fall back to a PID signal if the HTTP request failed.
    const pid = await readPidFile(port);
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
        console.error(`[mcp-page-bridge] sent SIGTERM to daemon pid ${pid} on port ${port}`);
        return;
      } catch {
        // fall through
      }
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
  const port = parsePort(argv);
  const token = parseFlag(argv, "--token") ?? process.env.MCP_PAGE_BRIDGE_TOKEN;

  if (command === "stop") {
    await stopDaemon(port, token);
    return;
  }

  if (hasFlag(argv, DAEMON_FLAG)) {
    await startDaemon(port, token, parseIdleTimeoutMs(argv));
    return;
  }

  await ensureDaemon(port, token, parseIdleTimeoutMs(argv));
  await connectProxy(port, token);
}

// Only run when invoked as the entry script, not when imported by tests.
const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error("[mcp-page-bridge] fatal:", error);
    process.exit(1);
  });
}
