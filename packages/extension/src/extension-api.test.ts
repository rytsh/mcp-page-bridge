import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionApi, hasDebuggerPermission, supportsDebugger } from "./extension-api.js";

afterEach(() => vi.unstubAllGlobals());

describe("extension API compatibility", () => {
  it("selects Firefox's promise namespace instead of callback-only chrome", async () => {
    const query = vi.fn().mockResolvedValue([{ id: 1 }]);
    const callbackQuery = vi.fn();
    vi.stubGlobal("browser", { runtime: { getBrowserInfo: vi.fn() }, tabs: { query } });
    vi.stubGlobal("chrome", { tabs: { query: callbackQuery } });
    await expect(extensionApi().tabs.query({})).resolves.toEqual([{ id: 1 }]);
    expect(callbackQuery).not.toHaveBeenCalled();
  });

  it("does not query the unsupported debugger permission in Firefox", async () => {
    const contains = vi.fn().mockRejectedValue(new Error("Invalid permission: debugger"));
    vi.stubGlobal("browser", { runtime: { getBrowserInfo: vi.fn() }, permissions: { contains } });
    expect(supportsDebugger()).toBe(false);
    await expect(hasDebuggerPermission()).resolves.toBe(false);
    expect(contains).not.toHaveBeenCalled();
  });

  it("allows Chrome permission requests when the optional API is not yet exposed", async () => {
    const api = { runtime: {}, permissions: { contains: vi.fn() } };
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", api);
    expect(extensionApi()).toBe(api);
    expect(supportsDebugger()).toBe(true);
    await expect(hasDebuggerPermission()).resolves.toBe(false);
    expect(api.permissions.contains).not.toHaveBeenCalled();
  });

  it.each([false, true])("honors Chrome debugger permission %s", async (granted) => {
    const contains = vi.fn().mockResolvedValue(granted);
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", { runtime: {}, debugger: {}, permissions: { contains } });
    await expect(hasDebuggerPermission()).resolves.toBe(granted);
    expect(contains).toHaveBeenCalledWith({ permissions: ["debugger"] });
  });
});
