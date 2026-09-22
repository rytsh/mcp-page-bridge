import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function content() {
  const listeners: Array<(event: unknown) => void> = [];
  const onMessage = { addListener: vi.fn() };
  const sendMessage = vi.fn();
  const win = { addEventListener: (_: string, listener: (event: unknown) => void) => listeners.push(listener), postMessage: vi.fn() };
  vi.stubGlobal("window", win);
  vi.stubGlobal("location", { hostname: "at.example", origin: "https://at.example", href: "https://at.example/" });
  vi.stubGlobal("document", { title: "AT Chat" });
  const runtime = {
    id: "test", onMessage, sendMessage, lastError: undefined,
    connect: () => ({ onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() }, postMessage: vi.fn() }),
  };
  vi.stubGlobal("chrome", { runtime });
  await import("./content.js");
  const deliver = (extra: object, origin = "https://at.example") => {
    for (const listener of listeners) listener({ source: win, origin, data: { channel: "at.extension.bridge", v: 1, ...extra } });
  };
  return { win, runtime, deliver, onMessage, sendMessage };
}

it("waits for the callback API response instead of treating its void return as failure", async () => {
  const { deliver, sendMessage, win } = await content();
  deliver({ dir: "request", method: "describe", id: "r1" });
  expect(sendMessage).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(win.postMessage).not.toHaveBeenCalled();
  sendMessage.mock.calls[0]![1]({ result: { id: "mcp-page-bridge" } });
  await vi.waitFor(() => expect(win.postMessage).toHaveBeenCalledWith(expect.objectContaining({ dir: "response", id: "r1", result: { id: "mcp-page-bridge" } }), "https://at.example"));
});

it("probes live Web connections and drops chats that stop answering", async () => {
  vi.useFakeTimers();
  const { deliver, onMessage, win } = await content();
  const listener = onMessage.addListener.mock.calls[0]![0];
  const reply = vi.fn();
  expect(listener({ type: "discoverWebAgent" }, {}, reply)).toBe(true);
  expect(win.postMessage).toHaveBeenCalledWith(expect.objectContaining({ dir: "agent", event: "discover" }), "https://at.example");
  deliver({ dir: "agent", event: "announce", name: "AT Chat" });
  await vi.advanceTimersByTimeAsync(100);
  expect(reply).toHaveBeenLastCalledWith({ name: "AT Chat" });
  listener({ type: "discoverWebAgent" }, {}, reply);
  deliver({ dir: "agent", event: "announce", name: "forged" }, "https://other.example");
  await vi.advanceTimersByTimeAsync(100);
  expect(reply).toHaveBeenLastCalledWith({ name: "" });
});
