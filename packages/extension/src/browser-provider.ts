/**
 * SW-hosted "browser" provider: a single EmbeddedMcpServer (with browser-level
 * tools) connected directly to the bridge over its own WebSocket — independent
 * of any page/tab. Opt-in (the popup toggle starts/stops it). Auto-reconnects.
 */
import { MCP_PAGE_BRIDGE_VERSION } from "mcp-page-bridge-protocol";
import { EmbeddedMcpServer, type MinimalTransport } from "./embedded-server.js";
import { registerBrowserTools } from "./browser-tools.js";

export class BrowserProvider {
  private ws?: WebSocket;
  private server?: EmbeddedMcpServer;
  private want = false;
  private attempts = 0;
  private timer?: ReturnType<typeof setTimeout>;
  /** Incremented on every (re)connect/teardown so stale socket events are ignored. */
  private generation = 0;

  constructor(private readonly urlFn: () => string) {}

  get active(): boolean {
    return this.want;
  }

  start(): void {
    if (this.want) return;
    this.want = true;
    this.attempts = 0;
    this.connect();
  }

  stop(): void {
    this.want = false;
    if (this.timer) clearTimeout(this.timer);
    this.teardown();
  }

  /** Reconnect with fresh settings (e.g. port/token changed). */
  restart(): void {
    if (!this.want) return;
    this.teardown();
    this.attempts = 0;
    this.connect();
  }

  private teardown(): void {
    // Orphan any in-flight socket: its listeners check `generation` and become
    // no-ops, so a late 'close' can't tear down the next connection.
    this.generation += 1;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = undefined;
    void this.server?.close();
    this.server = undefined;
  }

  private connect(): void {
    if (!this.want || this.ws) return;

    const gen = ++this.generation;
    const isCurrent = (): boolean => this.want && this.generation === gen;

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.urlFn(), "mcp");
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;

    const server = new EmbeddedMcpServer({
      name: "browser",
      version: MCP_PAGE_BRIDGE_VERSION,
      title: "Browser control",
    });
    registerBrowserTools(server);
    this.server = server;

    const transport: MinimalTransport = {
      start: () =>
        new Promise<void>((resolve, reject) => {
          if (ws.readyState === WebSocket.OPEN) return resolve();
          const onOpen = (): void => {
            cleanup();
            resolve();
          };
          const onFail = (): void => {
            cleanup();
            reject(new Error("ws closed before open"));
          };
          const cleanup = (): void => {
            ws.removeEventListener("open", onOpen);
            ws.removeEventListener("error", onFail);
            ws.removeEventListener("close", onFail);
          };
          ws.addEventListener("open", onOpen, { once: true });
          ws.addEventListener("error", onFail, { once: true });
          ws.addEventListener("close", onFail, { once: true });
        }),
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => ws.close(),
    };

    ws.addEventListener("message", (e: MessageEvent) => {
      if (!isCurrent()) return;
      try {
        transport.onmessage?.(JSON.parse(typeof e.data === "string" ? e.data : ""));
      } catch {
        // ignore non-JSON
      }
    });
    ws.addEventListener("close", () => {
      if (this.generation !== gen) return; // a newer connection supersedes us
      this.ws = undefined;
      void this.server?.close();
      this.server = undefined;
      if (this.want) this.schedule();
    });
    ws.addEventListener("error", () => {
      // 'close' follows
    });

    void server.connect(transport).then(() => {
      if (isCurrent()) this.attempts = 0;
    });
  }

  private schedule(): void {
    if (!this.want) return;
    this.attempts += 1;
    const delay = Math.min(500 * 2 ** Math.min(this.attempts, 4), 5000);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }
}
