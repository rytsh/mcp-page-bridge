import { describe, expect, it, vi } from "vitest";
import { ToolMirror, type ToolTarget } from "./tool-mirror.js";
import type { ToolDefinition, ToolHandler } from "./embedded-server.js";

/**
 * The lifecycle these tests pin down caused two silent failures before the
 * generation counter existed:
 *
 *   - a sync in flight while the embedded server was rebuilt registered the
 *     page's tools onto the doomed server, then recorded them as present, so
 *     the live server stayed empty forever;
 *   - the bookkeeping was cleared before an async close, so the diff could not
 *     tell "never registered" from "registered on a server that is gone".
 *
 * Both present to the user as "the agent stopped seeing my page's tools", with
 * no error anywhere.
 */

/** A stand-in for EmbeddedMcpServer that records what it holds. */
function fakeServer(): ToolTarget & { tools: Set<string>; registrations: number } {
  const tools = new Set<string>();
  return {
    tools,
    registrations: 0,
    registerTool(def: ToolDefinition) {
      tools.add(def.name);
      this.registrations += 1;
      return () => tools.delete(def.name);
    },
    removeTool(name: string) {
      tools.delete(name);
    },
  };
}

const handler: ToolHandler = () => "ok";
const entry = (name: string, description = "d") => ({
  def: { name, description } satisfies ToolDefinition,
  handler,
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("ToolMirror", () => {
  it("registers the source's tools onto the target", async () => {
    const server = fakeServer();
    const mirror = new ToolMirror({
      target: () => ({ server, generation: 1 }),
      read: async () => [entry("a"), entry("b")],
    });

    await mirror.sync();

    expect([...server.tools]).toEqual(["a", "b"]);
  });

  it("does not re-register unchanged tools", async () => {
    const server = fakeServer();
    const tools = [entry("a")];
    const mirror = new ToolMirror({ target: () => ({ server, generation: 1 }), read: async () => tools });

    await mirror.sync();
    await mirror.sync();
    await mirror.sync();

    expect(server.registrations).toBe(1);
  });

  it("re-registers when only the definition changed", async () => {
    const server = fakeServer();
    let description = "first";
    const mirror = new ToolMirror({
      target: () => ({ server, generation: 1 }),
      read: async () => [{ def: { name: "a", description }, handler }],
    });

    await mirror.sync();
    description = "second";
    await mirror.sync();

    expect(server.registrations).toBe(2);
  });

  it("removes tools that disappeared from the source", async () => {
    const server = fakeServer();
    let tools = [entry("a"), entry("b")];
    const mirror = new ToolMirror({ target: () => ({ server, generation: 1 }), read: async () => tools });

    await mirror.sync();
    tools = [entry("a")];
    await mirror.sync();

    expect([...server.tools]).toEqual(["a"]);
    expect(mirror.names).toEqual(["a"]);
  });

  // The B2 regression, exactly.
  it("re-registers onto a NEW server when the target is replaced mid-sync", async () => {
    const first = fakeServer();
    const second = fakeServer();
    let current = { server: first as ToolTarget, generation: 1 };
    let releaseRead: () => void = () => {};

    const mirror = new ToolMirror({
      target: () => current,
      read: async () => {
        await new Promise<void>((r) => {
          releaseRead = r;
        });
        return [entry("a"), entry("b")];
      },
    });

    const pending = mirror.sync();
    await flush();
    // The rebuild happens while read() is still outstanding.
    current = { server: second, generation: 2 };
    releaseRead();
    await pending;

    expect([...second.tools]).toEqual(["a", "b"]);
    expect([...first.tools]).toEqual([]);
  });

  it("recovers when the generation changes between two syncs", async () => {
    const first = fakeServer();
    const second = fakeServer();
    let current = { server: first as ToolTarget, generation: 1 };
    const mirror = new ToolMirror({
      target: () => current,
      read: async () => [entry("a")],
    });

    await mirror.sync();
    expect([...first.tools]).toEqual(["a"]);

    // Server rebuilt: same tools, brand new (empty) server.
    current = { server: second, generation: 2 };
    await mirror.sync();

    expect([...second.tools]).toEqual(["a"]);
  });

  it("does not call removeTool on the new server for a retired one's tools", async () => {
    const first = fakeServer();
    const second = fakeServer();
    const removeSpy = vi.spyOn(second, "removeTool");
    let current = { server: first as ToolTarget, generation: 1 };
    let tools = [entry("a")];

    const mirror = new ToolMirror({ target: () => current, read: async () => tools });
    await mirror.sync();

    current = { server: second, generation: 2 };
    tools = []; // and the page dropped the tool too
    await mirror.sync();

    expect(removeSpy).not.toHaveBeenCalled();
    expect(mirror.names).toEqual([]);
  });

  it("forgets everything when there is no target (tab disabled)", async () => {
    const server = fakeServer();
    let target: { server: ToolTarget; generation: number } | undefined = { server, generation: 1 };
    const mirror = new ToolMirror({ target: () => target, read: async () => [entry("a")] });

    await mirror.sync();
    target = undefined;
    await mirror.sync();

    expect(mirror.names).toEqual([]);
  });

  it("collapses overlapping syncs into one trailing re-run", async () => {
    const server = fakeServer();
    let reads = 0;
    let releaseRead: () => void = () => {};
    const mirror = new ToolMirror({
      target: () => ({ server, generation: 1 }),
      read: async () => {
        reads += 1;
        await new Promise<void>((r) => {
          releaseRead = r;
        });
        return [entry("a")];
      },
    });

    const first = mirror.sync();
    await flush();
    void mirror.sync();
    void mirror.sync();
    void mirror.sync();
    releaseRead();
    await flush();
    releaseRead();
    await first;

    // One in-flight read plus exactly one trailing re-run, not four.
    expect(reads).toBe(2);
  });

  it("reports a read failure and leaves the target untouched", async () => {
    const server = fakeServer();
    const onError = vi.fn();
    let fail = false;
    const mirror = new ToolMirror({
      target: () => ({ server, generation: 1 }),
      read: async () => {
        if (fail) throw new Error("boom");
        return [entry("a")];
      },
      onError,
    });

    await mirror.sync();
    fail = true;
    await mirror.sync();

    expect(onError).toHaveBeenCalledOnce();
    expect([...server.tools]).toEqual(["a"]); // not torn down over a transient failure
  });

  it("does not reject when read() fails", async () => {
    const mirror = new ToolMirror({
      target: () => ({ server: fakeServer(), generation: 1 }),
      read: async () => {
        throw new Error("boom");
      },
    });

    await expect(mirror.sync()).resolves.toBeUndefined();
  });

  it("coalesces scheduled syncs into a single run", async () => {
    const server = fakeServer();
    let reads = 0;
    const mirror = new ToolMirror({
      target: () => ({ server, generation: 1 }),
      read: async () => {
        reads += 1;
        return [entry("a")];
      },
    });

    for (let i = 0; i < 50; i += 1) mirror.schedule();
    await flush();

    expect(reads).toBe(1);
  });
});
