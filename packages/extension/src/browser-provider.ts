/**
 * SW-hosted "browser" provider: a single EmbeddedMcpServer (with browser-level
 * tools) connected directly to the bridge over its own WebSocket — independent
 * of any page/tab. Opt-in (the popup toggle starts/stops it). Auto-reconnects.
 */
import { EmbeddedMcpServer, type MinimalTransport } from "./embedded-server.js";
import { registerBrowserTools } from "./browser-tools.js";

export class BrowserProvider {
  private ws?: WebSocket;
  private server?: EmbeddedMcpServer;
  private want = false;
  private attempts = 0;
  private timer?: ReturnType<typeof setTimeout>;

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
      version: "0.1.3",
      title: "Browser control",
    });
    registerBrowserTools(server);
    this.server = server;

    const transport: MinimalTransport = {
      start: () =>
        new Promise<void>((resolve, reject) => {
          if (ws.readyState === WebSocket.OPEN) return resolve();
          ws.addEventListener("open", () => resolve(), { once: true });
          ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
        }),
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => ws.close(),
    };

    ws.addEventListener("message", (e: MessageEvent) => {
      try {
        transport.onmessage?.(JSON.parse(typeof e.data === "string" ? e.data : ""));
      } catch {
        // ignore non-JSON
      }
    });
    ws.addEventListener("close", () => {
      this.ws = undefined;
      void this.server?.close();
      this.server = undefined;
      if (this.want) this.schedule();
    });
    ws.addEventListener("error", () => {
      // 'close' follows
    });

    void server.connect(transport).then(() => {
      this.attempts = 0;
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
