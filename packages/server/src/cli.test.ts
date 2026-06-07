import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createBridge, type Bridge } from "./bridge.js";
import { assertCompatibleToken, isDirectInvocation, parsePort, probeBridge } from "./cli.js";

const children = new Set<ChildProcessWithoutNullStreams>();
const daemonPids = new Set<number>();
const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...children].map((child) => stopChild(child)));

  for (const pid of daemonPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore already-exited daemons
    }
  }
  daemonPids.clear();

  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("failed to allocate a free port");
  return port;
}

async function waitFor<T>(fn: () => T | Promise<T>, predicate: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function bridgeReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/providers`);
    if (!res.ok) return false;
    const body = (await res.json()) as { providers?: unknown };
    return Array.isArray(body.providers);
  } catch {
    return false;
  }
}

function startCli(port: number, pidFile: string): ChildProcessWithoutNullStreams {
  const tsx = resolve("node_modules/.bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const child = spawn(tsx, ["src/cli.ts", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, MCP_PAGE_BRIDGE_DAEMON_PID_FILE: pidFile },
  });
  children.add(child);
  return child;
}

async function initialize(child: ChildProcessWithoutNullStreams): Promise<string> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cli-test", version: "0.0.0" },
      },
    })}\n`,
  );

  return waitFor(
    () => stdout,
    (value) => value.includes('"id":1') || stderr.includes("fatal"),
  ).then((value) => {
    if (stderr.includes("fatal")) throw new Error(stderr);
    return value;
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  children.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe("mcp-page-bridge CLI", () => {
  it("recognizes npm bin symlinks as direct CLI invocations", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mcp-page-bridge-"));
    tempDirs.add(tempDir);
    const realEntry = join(tempDir, "cli.js");
    const binEntry = join(tempDir, "mcp-page-bridge");
    await writeFile(realEntry, "");
    await symlink(realEntry, binEntry);

    expect(isDirectInvocation(binEntry, pathToFileURL(realEntry).href)).toBe(true);
  });

  it("keeps the bridge daemon alive after the first stdio proxy exits", async () => {
    const port = await getFreePort();
    const tempDir = await mkdtemp(join(tmpdir(), "mcp-page-bridge-"));
    tempDirs.add(tempDir);
    const pidFile = join(tempDir, "daemon.pid");

    const first = startCli(port, pidFile);
    const firstInit = await initialize(first);
    expect(firstInit).toContain('"serverInfo"');

    const daemonPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(Number.isInteger(daemonPid)).toBe(true);
    daemonPids.add(daemonPid);

    await stopChild(first);
    await waitFor(() => bridgeReady(port), Boolean);

    const second = startCli(port, pidFile);
    const secondInit = await initialize(second);
    expect(secondInit).toContain('"serverInfo"');
    await stopChild(second);

    const shutdown = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      headers: { "x-mcp-page-bridge-dashboard": "1" },
    });
    expect(shutdown.ok).toBe(true);
    await waitFor(() => bridgeReady(port), (ready) => !ready);
  });
});

describe("parsePort", () => {
  it("returns the default when no port is given", () => {
    expect(parsePort([])).toBe(8787);
  });
  it("parses a valid integer port", () => {
    expect(parsePort(["--port", "9000"])).toBe(9000);
  });
  it("rejects non-integer and out-of-range ports", () => {
    expect(() => parsePort(["--port", "8787.5"])).toThrow(/invalid --port/);
    expect(() => parsePort(["--port", "0"])).toThrow(/invalid --port/);
    expect(() => parsePort(["--port", "70000"])).toThrow(/invalid --port/);
    expect(() => parsePort(["--port", "abc"])).toThrow(/invalid --port/);
  });
});

describe("probeBridge", () => {
  let bridge: Bridge | undefined;
  let foreign: HttpServer | undefined;

  afterEach(async () => {
    if (bridge) {
      await bridge.close();
      bridge = undefined;
    }
    if (foreign) {
      await new Promise<void>((resolve) => foreign!.close(() => resolve()));
      foreign = undefined;
    }
  });

  it("reports none when nothing is listening", async () => {
    const port = await getFreePort();
    expect(await probeBridge(port)).toEqual({ status: "none" });
  });

  it("reports foreign for a non-bridge HTTP server", async () => {
    const port = await getFreePort();
    foreign = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hello: "world" }));
    });
    await new Promise<void>((resolve) => foreign!.listen(port, "127.0.0.1", resolve));
    expect(await probeBridge(port)).toEqual({ status: "foreign" });
  });

  it("reports a real bridge and its token requirement", async () => {
    bridge = await createBridge({ port: 0 });
    expect(await probeBridge(bridge.port)).toEqual({ status: "bridge", requiresToken: false });
  });

  it("detects a token-protected bridge", async () => {
    bridge = await createBridge({ port: 0, token: "secret" });
    const probe = await probeBridge(bridge.port);
    expect(probe).toEqual({ status: "bridge", requiresToken: true });
  });
});

describe("assertCompatibleToken", () => {
  let bridge: Bridge | undefined;
  afterEach(async () => {
    if (bridge) {
      await bridge.close();
      bridge = undefined;
    }
  });

  it("throws when a token-protected bridge gets no token", async () => {
    bridge = await createBridge({ port: 0, token: "secret" });
    await expect(
      assertCompatibleToken(bridge.port, undefined, { status: "bridge", requiresToken: true }),
    ).rejects.toThrow(/requires a token/);
  });

  it("throws when the provided token is wrong", async () => {
    bridge = await createBridge({ port: 0, token: "secret" });
    await expect(
      assertCompatibleToken(bridge.port, "wrong", { status: "bridge", requiresToken: true }),
    ).rejects.toThrow(/rejected the provided token/);
  });

  it("accepts the matching token", async () => {
    bridge = await createBridge({ port: 0, token: "secret" });
    await expect(
      assertCompatibleToken(bridge.port, "secret", { status: "bridge", requiresToken: true }),
    ).resolves.toBeUndefined();
  });

  it("tolerates a token against a tokenless bridge", async () => {
    bridge = await createBridge({ port: 0 });
    await expect(
      assertCompatibleToken(bridge.port, "extra", { status: "bridge", requiresToken: false }),
    ).resolves.toBeUndefined();
  });
});
