import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function popup(enabled = false, debuggerGranted = true) {
  vi.useFakeTimers();
  const fields = new Map<string, any>();
  const field = (id: string): any => {
    if (!fields.has(id)) fields.set(id, {
      value: "", textContent: "", style: {}, dataset: {}, checked: false, disabled: false,
      handlers: new Map(),
      addEventListener(event: string, handler: unknown) { this.handlers.set(event, handler); },
    });
    return fields.get(id);
  };
  vi.stubGlobal("document", { activeElement: null, getElementById: field, querySelectorAll: () => [] });
  const status = {
    enabled, tabMode: "daemon", providers: [], port: 8787, token: "",
    webAgentOrigin: "https://page.example", webAgentConnected: false,
    webAgents: [{ tabId: 7, origin: "https://at.example", name: "AT Chat", title: "First chat", tabs: 0 }],
  };
  const sendMessage = vi.fn(async (req) => req.type === "getStatus" ? status : { ok: true });
  const requestPermission = vi.fn(async () => debuggerGranted);
  vi.stubGlobal("chrome", {
    runtime: { sendMessage }, tabs: { query: async () => [{ id: 1 }] },
    permissions: { request: requestPermission },
  });
  await import("./popup.js");
  await vi.waitFor(() => expect(field("tabModeHint").textContent).not.toBe(""));
  const change = async (id: string, value: string) => {
    field(id).value = value;
    field(id).handlers.get("change")({ target: field(id) });
    await vi.advanceTimersByTimeAsync(0);
  };
  return { field, status, sendMessage, change, requestPermission };
}

it.each(["trustedInput", "cdpTools"])("requests debugger permission synchronously when enabling %s", async (id) => {
  const { field, sendMessage, requestPermission } = await popup();
  field(id).checked = true;
  field(id).handlers.get("change")({ target: field(id) });
  // No microtask or permission preflight may precede the request: Chrome needs
  // the user gesture from the checkbox change to still be active.
  expect(requestPermission).toHaveBeenCalledWith({ permissions: ["debugger"] });
  await vi.advanceTimersByTimeAsync(0);
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "setSettings", [id]: true }));
});

it("keeps trusted input off when debugger permission is denied", async () => {
  const { field, sendMessage, change } = await popup(false, false);
  field("trustedInput").checked = true;
  await change("trustedInput", "");
  expect(field("trustedInput").checked).toBe(false);
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "setSettings", trustedInput: false }));
});

it("defaults to Daemon, keeps Agent selected across polls and connects to the selected chat", async () => {
  const { field, sendMessage, change } = await popup();
  expect(field("tabMode").value).toBe("daemon");
  expect(field("settings").style.display).toBe("flex");
  expect(field("toggle").disabled).toBe(false);
  expect(field("webAgentPanel").style.display).toBe("none");
  await change("tabMode", "webAgent");
  await vi.advanceTimersByTimeAsync(1600);
  expect(field("tabMode").value).toBe("webAgent");
  expect(field("webAgentTargetRow").style.display).toBe("");
  expect(field("settings").style.display).toBe("none");
  expect(field("openDashboard").style.display).toBe("none");
  expect(field("webAgentPanel").style.display).toBe("none");
  await change("webAgentTarget", "7");
  await field("toggle").handlers.get("click")();
  expect(sendMessage).toHaveBeenCalledWith({ type: "setEnabled", tabId: 1, enabled: true, mode: "webAgent", origin: "https://at.example", agentTabId: 7 });
  expect(sendMessage.mock.calls.some(([req]) => req.type === "setTabBridge")).toBe(false);
});

it("lets an enabled Daemon tab choose Agent before applying, and preserves connection errors", async () => {
  const { field, status, sendMessage, change } = await popup(true);
  expect(field("settings").style.display).toBe("flex");
  await change("tabMode", "webAgent");
  await vi.advanceTimersByTimeAsync(1600);
  expect(field("tabMode").value).toBe("webAgent");
  expect(sendMessage.mock.calls.every(([req]) => req.type === "getStatus")).toBe(true);
  await change("webAgentTarget", "7");
  sendMessage.mockImplementation(async (req) => req.type === "getStatus" ? status : { ok: false, error: "Agent closed" });
  await field("toggle").handlers.get("click")();
  await vi.advanceTimersByTimeAsync(1600);
  expect(field("connectionError").textContent).toBe("Agent closed");
});
