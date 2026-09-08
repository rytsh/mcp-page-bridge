import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("keeps saved and requested debugger flags off in Firefox without querying permissions", async () => {
  const onMessage = { addListener: vi.fn() };
  const contains = vi.fn().mockRejectedValue(new Error("Invalid permission: debugger"));
  const sessionGet = vi.fn().mockResolvedValue({});
  const localSet = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("chrome", {}); // Using callback-only chrome would fail this test.
  vi.stubGlobal("browser", {
    runtime: { id: "test", getBrowserInfo: vi.fn(), onMessage, onConnect: { addListener: vi.fn() } },
    permissions: { contains },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({ cdpTools: true, trustedInput: true }),
        set: localSet,
      },
      session: { get: sessionGet, set: vi.fn().mockResolvedValue(undefined) },
    },
    tabs: { onRemoved: { addListener: vi.fn() } },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  });
  await import("./background.js");
  await vi.waitFor(() => expect(sessionGet).toHaveBeenCalledWith("tabBridges"));
  const listener = onMessage.addListener.mock.calls[0]![0];
  const message = (req: object) => new Promise<Record<string, unknown>>((resolve) => {
    expect(listener(req, { id: "test" }, resolve)).toBe(true);
  });

  const status = await message({ type: "getStatus", tabId: 1 });
  expect(status).toMatchObject({ cdpTools: false, trustedInput: false, cdpDebuggerPermission: false });
  const result = await message({ type: "setSettings", cdpTools: true, trustedInput: true });
  expect(result).toMatchObject({ ok: true, cdpTools: false, trustedInput: false });
  expect(localSet).toHaveBeenCalledWith(expect.objectContaining({ cdpTools: false, trustedInput: false }));
  expect(contains).not.toHaveBeenCalled();
});
