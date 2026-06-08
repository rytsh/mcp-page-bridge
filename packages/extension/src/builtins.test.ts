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
async function setup(opts: { includeEval?: boolean; coreTools?: boolean; designTools?: boolean; automationTools?: boolean; cdpTools?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const server = new EmbeddedMcpServer({ name: "builtins", version: "1.0.0" });
  registerBuiltins(server, {
    extCall: async (action, args) => {
      calls.push([action, args]);
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
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st as unknown as MinimalTransport);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(ct);
  return { client, calls };
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
      "find_by_text",
      "find_by_role",
      "find_by_label",
      "find_by_test_id",
      "locator_snapshot",
      "locator_count",
      "smart_click",
      "hover",
      "double_click",
      "type_text",
      "press_key",
      "clear_value",
      "select_option",
      "check",
      "uncheck",
      "upload_file",
      "drag_and_drop",
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
        "click",
        "console_logs",
        "dom_query",
        "eval",
        "get_html",
        "get_page_info",
        "navigate",
        "reload",
        "screenshot",
        "scroll",
        "set_value",
        "wait_for",
      ].sort(),
    );
    // Design/selection extras are gated off.
    expect(names).not.toContain("apply_css");
    expect(names).not.toContain("get_selected_element");
    expect(names).not.toContain("capture_design_baseline");
    expect(names).not.toContain("smart_click");
    expect(names).not.toContain("start_network_capture");
    expect(names).not.toContain("cdp_attach");
  });

  it("registers automation tools only when enabled", async () => {
    const off = await setup({ automationTools: false });
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain("smart_click");

    const on = await setup({ automationTools: true });
    const names = (await on.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("smart_click");
    expect(names).toContain("start_network_capture");
    expect(names).toContain("get_storage_state");
  });

  it("can disable only the default core tools", async () => {
    const { client } = await setup({ coreTools: false, designTools: false, automationTools: true, cdpTools: false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("smart_click");
    expect(names).not.toContain("eval");
    expect(names).not.toContain("dom_query");
    expect(names).not.toContain("screenshot");
    expect(names).not.toContain("console_logs");
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
