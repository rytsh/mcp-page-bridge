import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BUILTIN_TOOL_NAMES } from "mcp-page-bridge-protocol";
import { EmbeddedMcpServer, type MinimalTransport } from "./embedded-server.js";
import { registerBuiltins } from "./builtins.js";

/**
 * Covers the non-DOM built-ins: eval (runs in Node's eval here), console_logs
 * (reads the buffer), and the SW-delegated tools (screenshot/navigate/reload)
 * via a mock extCall. DOM tools require a browser and are exercised manually.
 */
async function setup(
  opts: {
    includeEval?: boolean;
    coreTools?: boolean;
    designTools?: boolean;
    automationTools?: boolean;
    cdpTools?: boolean;
    trustedInput?: boolean;
    failInput?: boolean;
  } = {},
) {
  const calls: Array<[string, unknown]> = [];
  const server = new EmbeddedMcpServer({ name: "builtins", version: "1.0.0" });
  registerBuiltins(server, {
    extCall: async (action, args) => {
      calls.push([action, args]);
      if (action === "input") {
        if (opts.failInput) throw new Error("debugger permission missing");
        return { ok: true, via: "cdp" };
      }
      if (action === "frameAct") return { clicked: { selector: "#inner" }, via: "js" };
      if (action === "frameOverlay") return { markers: 7 };
      if (action === "frameSnapshot") return { text: "Page snapshot — top\n\niframe f1 — https://embed.test\n  e1 button", frames: 2 };
      if (action === "screenshot") {
        const download = !!(args as { download?: boolean } | undefined)?.download;
        const filename = (args as { filename?: string } | undefined)?.filename;
        return {
          dataUrl: "data:image/png;base64,QUJD",
          savedAs: download ? filename ?? "mcp-page-bridge.png" : undefined,
        };
      }
      if (action === "cdp") return { ok: true, action: (args as { action?: string } | undefined)?.action };
      return { ok: true };
    },
    console: { entries: [{ level: "warn", text: "careful", time: "2026" }] },
    includeEval: opts.includeEval,
    coreTools: opts.coreTools,
    // Default the design/selection toolset ON in tests unless a case overrides
    // it, so the existing full-catalog assertions keep covering those tools.
    designTools: opts.designTools !== false,
    automationTools: opts.automationTools !== false,
    cdpTools: opts.cdpTools !== false,
    trustedInput: opts.trustedInput === true,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st as unknown as MinimalTransport);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(ct);
  return { client, calls };
}

/** The action payload is always the first content block; observations follow. */
function payloadOf(r: unknown): Record<string, unknown> {
  const content = (r as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

function textOf(r: unknown): string {
  const content = (r as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
}

describe("built-in tools", () => {
  it("registers the full built-in toolset", async () => {
    const { client } = await setup();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of [
      "eval",
      "dom_query",
      "get_page_info",
      "click",
      "set_value",
      "scroll",
      "wait_for",
      "get_html",
      "get_selected_element",
      "get_selected_elements",
      "get_computed_style",
      "highlight_element",
      "show_selected_marker",
      "hide_selected_marker",
      "clear_selected_elements",
      "remove_selected_element",
      "update_selected_element",
      "apply_css",
      "list_css_patches",
      "remove_css_patch",
      "clear_css_patches",
      "export_css_patches",
      "export_design_changes",
      "accessibility_audit",
      "responsive_summary",
      "debug_summary",
      "console_logs",
      "capture_design_baseline",
      "compare_design_baseline",
      "clear_design_baseline",
      "screenshot",
      "navigate",
      "reload",
      "take_snapshot",
      "find",
      "drag",
      "get_page_text",
      "zoom",
      "list_downloads",
      "wait_for_download",
      "locator_snapshot",
      "locator_count",
      "hover",
      "select_option",
      "check",
      "uncheck",
      "upload_file",
      "mouse",
      "start_network_capture",
      "stop_network_capture",
      "list_network_requests",
      "wait_for_response",
      "get_response_body",
      "clear_network_capture",
      "get_storage_state",
      "set_local_storage",
      "set_session_storage",
      "clear_storage",
      "list_cookies",
      "set_cookie",
      "delete_cookie",
      "set_dialog_behavior",
      "list_dialogs",
      "clear_dialogs",
      "list_frames",
      "frame_dom_query",
      "frame_click",
      "frame_set_value",
      "resize_window",
      "cdp_status",
      "cdp_attach",
      "cdp_detach",
      "cdp_send_command",
      "cdp_list_events",
      "cdp_clear_events",
      "cdp_get_response_body",
      "cdp_emulate_viewport",
      "cdp_clear_emulation",
      "cdp_dispatch_mouse",
      "cdp_dispatch_key",
      "cdp_evaluate",
      "cdp_capture_screenshot",
      "cdp_get_performance_metrics",
      "cdp_set_network_conditions",
      "cdp_set_user_agent",
      "cdp_set_geolocation",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("BUILTIN_TOOL_NAMES stays in sync with the registered built-ins", async () => {
    // The dashboard classifies tools using BUILTIN_TOOL_NAMES. If a built-in is
    // added here but not to the protocol list, it leaks into the "Page tools"
    // group. This guard keeps the single source of truth honest. The full set
    // (core + opt-in design tools) must match the protocol list.
    const { client } = await setup({ designTools: true });
    const registered = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(registered).toEqual([...BUILTIN_TOOL_NAMES].sort());
  });

  it("registers only the lean core toolset when design tools are off", async () => {
    const { client } = await setup({ designTools: false, automationTools: false, cdpTools: false });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "clear_value",
        "click",
        "console_logs",
        "dom_query",
        "drag",
        "eval",
        "find",
        "get_html",
        "get_page_info",
        "get_page_text",
        "list_downloads",
        "navigate",
        "press_key",
        "reload",
        "screenshot",
        "scroll",
        "set_value",
        "take_snapshot",
        "type_text",
        "wait_for",
        "wait_for_download",
        "zoom",
      ].sort(),
    );
    // Design/selection extras are gated off.
    expect(names).not.toContain("apply_css");
    expect(names).not.toContain("get_selected_element");
    expect(names).not.toContain("capture_design_baseline");
    expect(names).not.toContain("locator_snapshot");
    expect(names).not.toContain("start_network_capture");
    expect(names).not.toContain("cdp_attach");
  });

  it("registers automation tools only when enabled", async () => {
    const off = await setup({ automationTools: false });
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain("locator_snapshot");

    const on = await setup({ automationTools: true });
    const names = (await on.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("locator_snapshot");
    expect(names).toContain("mouse");
    expect(names).toContain("start_network_capture");
    expect(names).toContain("get_storage_state");
  });

  it("rejects unknown/stale snapshot uids with a re-snapshot hint", async () => {
    // The uid registry is page-local; a uid that was never handed out by
    // take_snapshot must fail fast (before any DOM access) and point the agent
    // back at take_snapshot. This covers the resolveUid error path in Node.
    const { client } = await setup({ automationTools: true });
    const result = await client.callTool({ name: "click", arguments: { uid: "1_999" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("take_snapshot");
  });

  it("can disable only the default core tools", async () => {
    const { client } = await setup({ coreTools: false, designTools: false, automationTools: true, cdpTools: false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("locator_snapshot");
    // Input primitives stay available even with the core toolset off.
    expect(names).toContain("take_snapshot");
    expect(names).toContain("click");
    expect(names).toContain("type_text");
    expect(names).toContain("press_key");
    expect(names).not.toContain("eval");
    expect(names).not.toContain("dom_query");
    expect(names).not.toContain("screenshot");
    expect(names).not.toContain("console_logs");
  });

  it("routes input through CDP when trusted input is on", async () => {
    const { client, calls } = await setup({ trustedInput: true });

    const clicked = await client.callTool({ name: "click", arguments: { x: 40, y: 60, observe: "none" } });
    expect(payloadOf(clicked)).toMatchObject({ via: "cdp", clickCount: 1 });
    expect(calls).toContainEqual(["input", { kind: "click", x: 40, y: 60, clickCount: 1, button: "left", modifiers: 0 }]);

    const pressed = await client.callTool({ name: "press_key", arguments: { keys: "Meta+A Backspace", observe: "none" } });
    expect(payloadOf(pressed)).toMatchObject({ via: "cdp", pressed: 2 });
    const keyCall = calls.find(([action, args]) => action === "input" && (args as { kind?: string }).kind === "keys");
    expect(keyCall).toBeDefined();
    const keys = (keyCall![1] as { keys: Array<Record<string, unknown>> }).keys;
    expect(keys).toHaveLength(2);
    expect(keys[1]).toMatchObject({ key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, text: "" });
  });

  it("appends an observation to actions unless observe:none", async () => {
    // Without a DOM the snapshot can't be rendered, but the contract still
    // holds: the action payload comes first, the observation is appended and
    // never turns the call into an error.
    const { client, calls } = await setup({ trustedInput: true });

    const observed = await client.callTool({ name: "click", arguments: { x: 1, y: 2 } });
    const blocks = (observed as { content: Array<{ type: string; text?: string }> }).content;
    expect(payloadOf(observed)).toMatchObject({ via: "cdp" });
    expect(blocks.length).toBeGreaterThan(1);
    expect(observed.isError).toBeFalsy();

    const withShot = await client.callTool({ name: "click", arguments: { x: 1, y: 2, observe: "screenshot" } });
    const shotBlocks = (withShot as { content: Array<{ type: string; data?: string }> }).content;
    expect(shotBlocks.some((b) => b.type === "image")).toBe(true);
    expect(calls.some(([action]) => action === "screenshot")).toBe(true);

    const quiet = await client.callTool({ name: "click", arguments: { x: 1, y: 2, observe: "none" } });
    expect((quiet as { content: unknown[] }).content).toHaveLength(1);
  });

  it("routes sub-frame uids to the owning frame", async () => {
    const { client, calls } = await setup({ trustedInput: true });

    const res = await client.callTool({ name: "click", arguments: { uid: "f2e5", observe: "none" } });
    expect(payloadOf(res)).toMatchObject({ frame: "f2", via: "js" });
    expect(calls).toContainEqual([
      "frameAct",
      { uid: "f2e5", clickCount: 1, button: "left", modifiers: undefined, timeoutMs: undefined, kind: "click" },
    ]);
    // A frame target must never go through the trusted (top-frame) input path.
    expect(calls.some(([action]) => action === "input")).toBe(false);
  });

  it("take_snapshot stitches frames through the service worker", async () => {
    const { client, calls } = await setup();
    const res = await client.callTool({ name: "take_snapshot", arguments: {} });
    expect(textOf(res)).toContain("iframe f1");
    expect(calls).toContainEqual(["frameSnapshot", { maxNodes: 400, includeHidden: false, maxDepth: 15 }]);
  });

  it("never calls the trusted input path when the switch is off", async () => {
    const { client, calls } = await setup({ trustedInput: false });
    await client.callTool({ name: "press_key", arguments: { keys: "Enter" } }).catch(() => undefined);
    expect(calls.some(([action]) => action === "input")).toBe(false);
  });

  it("falls back to synthetic events when the trusted path fails", async () => {
    // Minimal DOM so the synthetic fallback can actually run in Node: the
    // engine only needs an element to dispatch on plus the HTML*Element globals
    // its instanceof checks look at.
    const dispatched: string[] = [];
    const target = { dispatchEvent: (e: { type: string }) => (dispatched.push(e.type), true), isConnected: true };
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = { ...globals };
    globals.document = { activeElement: target, body: target };
    globals.KeyboardEvent = class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    };
    for (const name of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLButtonElement", "HTMLOptionElement", "SVGElement"]) {
      if (globals[name] === undefined) globals[name] = class {};
    }

    try {
      const { client } = await setup({ trustedInput: true, failInput: true });
      const res = await client.callTool({ name: "press_key", arguments: { keys: "Escape", observe: "none" } });
      const payload = payloadOf(res) as { via: string; trustedError: string };
      expect(payload.via).toBe("js");
      expect(payload.trustedError).toContain("debugger permission missing");
      expect(dispatched).toEqual(["keydown", "keyup"]);
    } finally {
      for (const key of ["document", "KeyboardEvent", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLButtonElement", "HTMLOptionElement", "SVGElement"]) {
        if (key in saved) globals[key] = saved[key];
        else delete globals[key];
      }
    }
  });

  it("registers CDP tools only when enabled", async () => {
    const off = await setup({ cdpTools: false });
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain("cdp_attach");

    const on = await setup({ cdpTools: true });
    const names = (await on.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("cdp_attach");
    expect(names).toContain("cdp_send_command");
    expect(names).toContain("cdp_emulate_viewport");
  });

  it("eval returns the evaluated expression", async () => {
    const { client } = await setup();
    const res = await client.callTool({ name: "eval", arguments: { code: "1 + 41" } });
    expect(textOf(res)).toContain("42");
  });

  it("eval explains CSP unsafe-eval failures", async () => {
    const { client } = await setup();
    const res = await client.callTool({
      name: "eval",
      arguments: {
        code: `(() => { throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive") })()`,
      },
    });
    expect(textOf(res)).toContain("Page CSP blocked arbitrary JavaScript evaluation");
    expect(textOf(res)).toContain("dedicated non-eval tools");
  });

  it("omits eval when includeEval is false", async () => {
    const { client } = await setup({ includeEval: false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("eval");
    // Other built-ins remain available.
    expect(names).toContain("dom_query");
    expect(names).toContain("screenshot");
  });

  it("console_logs returns captured entries", async () => {
    const { client } = await setup();
    const res = await client.callTool({ name: "console_logs", arguments: {} });
    expect(textOf(res)).toContain("careful");
  });

  it("navigate delegates to the SW via extCall", async () => {
    const { client, calls } = await setup();
    await client.callTool({ name: "navigate", arguments: { url: "https://x.test" } });
    expect(calls).toContainEqual(["navigate", { url: "https://x.test" }]);
  });

  it("screenshot returns an image content block", async () => {
    const { client } = await setup();
    const res = await client.callTool({ name: "screenshot", arguments: {} });
    const block = (res as { content: Array<{ type: string; data?: string; mimeType?: string }> })
      .content[0]!;
    expect(block.type).toBe("image");
    expect(block.mimeType).toBe("image/png");
    expect(block.data).toBe("QUJD");
  });

  it("screenshot draws and removes uid labels when refs:true", async () => {
    const { client, calls } = await setup();
    const res = await client.callTool({ name: "screenshot", arguments: { refs: true, fullPage: true } });
    expect(textOf(res)).toContain("7 uid label(s)");
    expect(calls).toContainEqual(["frameOverlay", { show: true }]);
    expect(calls).toContainEqual(["frameOverlay", { show: false }]);
    expect(calls).toContainEqual([
      "screenshot",
      { download: false, filename: undefined, fullPage: true },
    ]);
  });

  it("screenshot with download:true returns a saved-as note", async () => {
    const { client } = await setup();
    const res = await client.callTool({
      name: "screenshot",
      arguments: { download: true, filename: "cart.png" },
    });
    const blocks = (res as { content: Array<{ type: string; text?: string }> }).content;
    expect(blocks[0]!.type).toBe("image");
    expect(blocks.some((b) => b.type === "text" && b.text?.includes("cart.png"))).toBe(true);
  });
});
