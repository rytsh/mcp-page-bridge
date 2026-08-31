import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { EmbeddedMcpServer, type MinimalTransport } from "./embedded-server.js";
import { PolyfillModelContext, bindModelContext, installModelContext } from "./webmcp.js";

/**
 * Regression tests for defects found in the WebMCP audit. Each one fails
 * against the pre-fix code; the comment says how.
 */

function fakeWindow(origin = "https://app.example"): Window {
  const win: Record<string, unknown> = { location: { origin }, length: 0 };
  win.top = win;
  return win as unknown as Window;
}

const fakeDocument = (): Document => ({}) as Document;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const tool = (name: string, execute = (): unknown => "ok") => ({
  name,
  description: `desc ${name}`,
  execute,
});

describe("polyfill identity across duplicate module instances", () => {
  // inject.js is evaluated twice in the same MAIN world (manifest
  // content_script + chrome.scripting re-injection). Before the brand check,
  // the second evaluation duck-typed our own polyfill as "native" and switched
  // to the JSON round-trip path, corrupting rich tool results.
  it("does not mistake an already-installed polyfill for a native implementation", () => {
    const doc = fakeDocument();
    const win = fakeWindow();

    const first = installModelContext(doc, win);
    const second = installModelContext(doc, win);

    expect(first.native).toBe(false);
    expect(second.native).toBe(false);
    expect(second.context).toBe(first.context);
  });

  it("keeps the direct-execute path, so structured results survive re-injection", async () => {
    const doc = fakeDocument();
    const win = fakeWindow();
    installModelContext(doc, win);

    // A second bind, as a second copy of the module would do.
    const binding = bindModelContext(doc, win);
    await binding.context.registerTool({
      ...tool("shot"),
      execute: () => ({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }),
    });

    const [entry] = await binding.readTools();
    // Through executeTool()'s JSON string this would still round-trip, but the
    // point is that the polyfill path is taken at all.
    expect(binding.native).toBe(false);
    await expect(entry!.handler({}, { signal: new AbortController().signal })).resolves.toEqual({
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
  });
});

describe("registration lifecycle", () => {
  // The abort listener used to capture only the tool NAME, so aborting a stale
  // controller unregistered whichever tool currently held that name.
  it("an old AbortController does not unregister a later tool of the same name", async () => {
    const mc = new PolyfillModelContext(fakeWindow());
    const old = new AbortController();

    await mc.registerTool(tool("x", () => 1), { signal: old.signal });
    mc.unregisterTool("x");
    await mc.registerTool(tool("x", () => 2));
    old.abort();

    expect((await mc.getTools()).map((t) => t.name)).toEqual(["x"]);
  });

  it("still unregisters via its own signal", async () => {
    const mc = new PolyfillModelContext(fakeWindow());
    const controller = new AbortController();
    await mc.registerTool(tool("x"), { signal: controller.signal });

    controller.abort();

    expect(await mc.getTools()).toHaveLength(0);
  });

  it("detaches the abort listener when the tool goes away by other means", async () => {
    const mc = new PolyfillModelContext(fakeWindow());
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    await mc.registerTool(tool("x"), { signal: controller.signal });
    mc.unregisterTool("x");

    expect(remove).toHaveBeenCalled();
  });

  it("does not accumulate abort listeners on a signal reused across calls", async () => {
    const mc = new PolyfillModelContext(fakeWindow());
    await mc.registerTool(tool("x"));
    const [registered] = await mc.getTools();

    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");

    for (let i = 0; i < 50; i += 1) {
      await mc.executeTool(registered!, {}, { signal: controller.signal });
    }

    // Every listener added for a call is detached when the call settles.
    expect(removed.mock.calls.length).toBe(added.mock.calls.length);
  });
});

describe("change-notification coalescing", () => {
  // 100 registrations used to mean 100 toolchange events and 100 frame-tree
  // walks, while the consumer coalesced them into a single sync anyway.
  it("collapses a synchronous burst of registrations into one toolchange", async () => {
    const mc = new PolyfillModelContext(fakeWindow());
    let events = 0;
    mc.addEventListener("toolchange", () => {
      events += 1;
    });

    // Issued without awaiting in between — no observer can tell them apart.
    await Promise.all(Array.from({ length: 100 }, (_, i) => mc.registerTool(tool(`t${i}`))));
    await flush();

    expect(events).toBe(1);
    expect(await mc.getTools()).toHaveLength(100);
  });

  // Spec guarantees toolchange lands before the registerTool promise resolves,
  // so sequentially awaited registrations MUST each get their own event. What
  // must not happen is a frame-tree walk per event on a lone document.
  it("keeps one event per awaited registration, per spec ordering", async () => {
    const win = fakeWindow();
    const mc = new PolyfillModelContext(win);
    let events = 0;
    mc.addEventListener("toolchange", () => {
      events += 1;
    });

    const topReads = vi.fn(() => win);
    Object.defineProperty(win, "top", { get: topReads, configurable: true });

    for (let i = 0; i < 20; i += 1) await mc.registerTool(tool(`t${i}`));
    await flush();

    expect(events).toBe(20);
    // The fast path reads `top` once per notify and never enumerates frames.
    expect(topReads.mock.calls.length).toBeLessThanOrEqual(events * 2);
  });

  it("still fires again for a later change", async () => {
    const mc = new PolyfillModelContext(fakeWindow());
    let events = 0;
    mc.addEventListener("toolchange", () => {
      events += 1;
    });

    await mc.registerTool(tool("a"));
    await flush();
    mc.unregisterTool("a");
    await flush();

    expect(events).toBe(2);
  });

  // Same problem one layer down: each registerTool emitted its own
  // notifications/tools/list_changed, and the bridge answers every one with a
  // fresh tools/list round-trip.
  it("collapses a burst of registerTool into one MCP list_changed", async () => {
    const server = new EmbeddedMcpServer({ name: "p", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(ct);

    let notifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications += 1;
    });

    for (let i = 0; i < 50; i += 1) server.registerTool({ name: `t${i}` }, () => "ok");
    await new Promise((r) => setTimeout(r, 50));

    expect(notifications).toBe(1);
    expect((await client.listTools()).tools).toHaveLength(50);
  });
});

describe("tool call cancellation", () => {
  // ToolCallOptions.signal documented caller cancellation, but
  // notifications/cancelled was never handled, so it only ever fired on close.
  it("aborts the execute() signal when the agent cancels the request", async () => {
    let seen: AbortSignal | undefined;
    const server = new EmbeddedMcpServer({ name: "p", version: "1.0.0" });
    server.registerTool({ name: "hang" }, (_args, options) => {
      seen = options.signal;
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => resolve("cancelled"));
      });
    });

    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(ct);

    const controller = new AbortController();
    const call = client
      .callTool({ name: "hang", arguments: {} }, undefined, { signal: controller.signal })
      .catch(() => undefined);

    await new Promise((r) => setTimeout(r, 20));
    expect(seen?.aborted).toBe(false);

    controller.abort(); // the SDK sends notifications/cancelled
    await new Promise((r) => setTimeout(r, 20));
    expect(seen?.aborted).toBe(true);
    await call;
  });
});

describe("transport handover", () => {
  // connect() used to leave the previous transport wired up, so a late message
  // on a dead socket was handled and answered on the NEW one — and a late close
  // for the old socket tore down the live connection.
  function recordingTransport(): MinimalTransport & { sent: unknown[] } {
    const t: MinimalTransport & { sent: unknown[] } = {
      sent: [],
      send(message: unknown) {
        t.sent.push(message);
      },
    };
    return t;
  }

  it("ignores messages from a replaced transport", async () => {
    const server = new EmbeddedMcpServer({ name: "p", version: "1.0.0" });
    const first = recordingTransport();
    const second = recordingTransport();

    await server.connect(first);
    await server.connect(second);

    first.onmessage?.({ jsonrpc: "2.0", id: 1, method: "ping" });
    await flush();

    expect(second.sent).toHaveLength(0);
    expect(first.sent).toHaveLength(0);
  });

  it("a late close on the old transport does not kill the live one", async () => {
    const server = new EmbeddedMcpServer({ name: "p", version: "1.0.0" });
    const first = recordingTransport();
    const second = recordingTransport();

    await server.connect(first);
    await server.connect(second);
    first.onclose?.();

    expect(server.connected).toBe(true);

    second.onmessage?.({ jsonrpc: "2.0", id: 1, method: "ping" });
    await flush();
    expect(second.sent).toHaveLength(1);
  });
});

describe("readTools resilience", () => {
  // Returning [] on a transient getTools() failure made the caller unregister
  // every tool and re-register it on the next tick — a list_changed storm.
  it("keeps the last known tools when getTools() fails transiently", async () => {
    let fail = false;
    const registered = {
      name: "t",
      description: "d",
      window: fakeWindow(),
      origin: "https://app.example",
    };
    const context = Object.assign(new EventTarget(), {
      registerTool: async () => undefined,
      getTools: async () => {
        if (fail) throw new Error("NotAllowedError");
        return [registered];
      },
      executeTool: async () => '"ok"',
    });

    const binding = bindModelContext(
      { modelContext: context } as unknown as Document,
      fakeWindow(),
    );

    expect(await binding.readTools()).toHaveLength(1);
    fail = true;
    expect((await binding.readTools()).map((t) => t.def.name)).toEqual(["t"]);
  });
});
