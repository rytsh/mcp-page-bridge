import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EmbeddedMcpServer, type MinimalTransport } from "./embedded-server.js";
import { registerBuiltins } from "./builtins.js";

/**
 * Covers the non-DOM built-ins: eval (runs in Node's eval here), console_logs
 * (reads the buffer), and the SW-delegated tools (screenshot/navigate/reload)
 * via a mock extCall. DOM tools require a browser and are exercised manually.
 */
async function setup() {
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
      return { ok: true };
    },
    console: { entries: [{ level: "warn", text: "careful", time: "2026" }] },
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
    ]) {
      expect(names).toContain(n);
    }
  });

  it("eval returns the evaluated expression", async () => {
    const { client } = await setup();
    const res = await client.callTool({ name: "eval", arguments: { code: "1 + 41" } });
    expect(textOf(res)).toContain("42");
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
