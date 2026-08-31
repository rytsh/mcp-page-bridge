/**
 * Mirrors an async tool source (`document.modelContext`) into an MCP server,
 * registering and removing only what actually changed.
 *
 * Extracted from inject.ts because the tricky part is not the diff, it is the
 * lifecycle around it: reading tools is asynchronous, while the server being
 * mirrored into can be torn down and rebuilt underneath us (a label change
 * reconnects it, a toolset toggle replaces it). Getting that wrong is silent —
 * the tab looks enabled, the page looks registered, and the agent sees nothing.
 *
 * The target is therefore identified by a **generation**. Bookkeeping records
 * which generation each registration belongs to, so anything left over from a
 * retired server is re-registered rather than assumed present. No DOM, no
 * extension APIs — see tool-mirror.test.ts.
 */
import type { ToolDefinition, ToolHandler } from "./embedded-server.js";

export interface ToolTarget {
  registerTool(def: ToolDefinition, handler: ToolHandler): unknown;
  removeTool(name: string): void;
}

export interface ToolMirrorOptions {
  /**
   * The server to mirror into and its generation, or undefined when there is
   * nothing to mirror into (the tab is disabled). Re-read after every await, so
   * it must always describe the CURRENT target.
   */
  target(): { server: ToolTarget; generation: number } | undefined;
  /** Read the tool source. May reject; see onError. */
  read(): Promise<Array<{ def: ToolDefinition; handler: ToolHandler }>>;
  onError?(error: unknown): void;
}

interface Registration {
  handler: ToolHandler;
  /** Serialized definition, so metadata-only edits are noticed too. */
  signature: string;
  /** Which target generation this registration lives on. */
  generation: number;
}

export class ToolMirror {
  private readonly registered = new Map<string, Registration>();
  private queued = false;
  private inFlight = false;
  private dirty = false;

  constructor(private readonly options: ToolMirrorOptions) {}

  /** Tool names currently believed to be registered on the live target. */
  get names(): string[] {
    return [...this.registered.keys()];
  }

  /** Coalesce a burst of change notifications into a single sync. */
  schedule(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      void this.sync();
    });
  }

  async sync(): Promise<void> {
    if (this.inFlight) {
      this.dirty = true; // fold into the run already underway
      return;
    }
    this.inFlight = true;
    try {
      do {
        this.dirty = false;

        let current: Array<{ def: ToolDefinition; handler: ToolHandler }>;
        try {
          current = await this.options.read();
        } catch (error) {
          this.options.onError?.(error);
          return;
        }

        // Read the target only AFTER the await: it may have been replaced while
        // we were reading.
        const target = this.options.target();
        if (!target) {
          this.registered.clear();
          return;
        }
        const { server, generation } = target;

        const names = new Set(current.map((t) => t.def.name));
        for (const [name, entry] of [...this.registered]) {
          if (entry.generation !== generation) {
            // Belongs to a retired server. Forget it — do NOT call removeTool on
            // the new one — so the loop below re-registers it if it still exists.
            this.registered.delete(name);
            continue;
          }
          if (!names.has(name)) {
            server.removeTool(name);
            this.registered.delete(name);
          }
        }

        for (const { def, handler } of current) {
          const signature = JSON.stringify(def);
          const previous = this.registered.get(def.name);
          if (previous?.handler !== handler || previous.signature !== signature) {
            server.registerTool(def, handler);
            this.registered.set(def.name, { handler, signature, generation });
          }
        }
      } while (this.dirty);
    } finally {
      this.inFlight = false;
    }
  }
}
