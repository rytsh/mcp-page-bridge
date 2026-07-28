/** Optional Chrome DevTools Protocol tools, delegated to the service worker. */
import type { ContentBlock, EmbeddedMcpServer, ToolResult } from "./embedded-server.js";
import { clampToolText } from "./dom-core.js";
import { safeSerialize } from "./serialize.js";

type ExtCall = (action: string, args?: Record<string, unknown>) => Promise<any>;

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: clampToolText(value) }] };
}

function json(value: unknown): ToolResult {
  return text(JSON.stringify(safeSerialize(value), null, 2));
}

function cdp(extCall: ExtCall, action: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return extCall("cdp", { ...args, action });
}

export function registerCdpTools(server: EmbeddedMcpServer, opts: { extCall: ExtCall }): void {
  server.registerTool(
    {
      name: "cdp_status",
      description: "Advanced CDP status for this tab: debugger permission, attach state, enabled domains, buffered events.",
      inputSchema: { type: "object", properties: {} },
    },
    async () => json(await cdp(opts.extCall, "status")),
  );

  server.registerTool(
    {
      name: "cdp_attach",
      description: "Attach Chrome DevTools Protocol to this tab and enable domains (default: Network, Page, Runtime). Chrome will show a debugging banner.",
      inputSchema: {
        type: "object",
        properties: {
          domains: { type: "array", items: { type: "string" }, description: "CDP domains to enable, e.g. Network/Page/Runtime/Performance." },
        },
      },
    },
    async (args) => json(await cdp(opts.extCall, "attach", args)),
  );

  server.registerTool(
    {
      name: "cdp_detach",
      description: "Detach CDP from this tab and stop Chrome's debugging banner for this tab.",
      inputSchema: { type: "object", properties: {} },
    },
    async () => json(await cdp(opts.extCall, "detach")),
  );

  server.registerTool(
    {
      name: "cdp_send_command",
      description: "Send a raw Chrome DevTools Protocol command to this tab. Advanced escape hatch.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "CDP command, e.g. Network.enable or Runtime.evaluate." },
          params: { type: "object", description: "Command parameters." },
        },
        required: ["command"],
      },
    },
    async (args) => json(await cdp(opts.extCall, "send", args)),
  );

  server.registerTool(
    {
      name: "cdp_list_events",
      description: "List buffered CDP events for this tab, optionally filtered by domain or exact method.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Filter by domain prefix, e.g. Network." },
          method: { type: "string", description: "Filter by exact method, e.g. Network.responseReceived." },
          limit: { type: "number", description: "max events (default 100)" },
        },
      },
    },
    async (args) => json(await cdp(opts.extCall, "events", args)),
  );

  server.registerTool(
    {
      name: "cdp_clear_events",
      description: "Clear buffered CDP events for this tab.",
      inputSchema: { type: "object", properties: {} },
    },
    async () => json(await cdp(opts.extCall, "clearEvents")),
  );

  server.registerTool(
    {
      name: "cdp_get_response_body",
      description: "Return a response body by CDP Network requestId from a Network.responseReceived event.",
      inputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"] },
    },
    async (args) => json(await cdp(opts.extCall, "getResponseBody", args)),
  );

  server.registerTool(
    {
      name: "cdp_emulate_viewport",
      description: "Use CDP Emulation.setDeviceMetricsOverride for this tab.",
      inputSchema: {
        type: "object",
        properties: {
          width: { type: "number" },
          height: { type: "number" },
          deviceScaleFactor: { type: "number", description: "default 1" },
          mobile: { type: "boolean", description: "default false" },
        },
        required: ["width", "height"],
      },
    },
    async (args) => json(await cdp(opts.extCall, "emulateViewport", args)),
  );

  server.registerTool(
    {
      name: "cdp_clear_emulation",
      description: "Clear CDP viewport/geolocation/network emulation applied by advanced tools.",
      inputSchema: { type: "object", properties: {} },
    },
    async () => json(await cdp(opts.extCall, "clearEmulation")),
  );

  server.registerTool(
    {
      name: "cdp_dispatch_mouse",
      description: "Dispatch a trusted-ish mouse event via CDP Input.dispatchMouseEvent.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "mousePressed|mouseReleased|mouseMoved|mouseWheel" },
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string", description: "left|middle|right|none" },
          clickCount: { type: "number", description: "default 1" },
        },
        required: ["type", "x", "y"],
      },
    },
    async (args) => json(await cdp(opts.extCall, "dispatchMouse", args)),
  );

  server.registerTool(
    {
      name: "cdp_dispatch_key",
      description: "Dispatch keyDown/keyUp via CDP Input.dispatchKeyEvent.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key value, e.g. Enter or a." },
          code: { type: "string", description: "Physical code, e.g. Enter or KeyA." },
          text: { type: "string", description: "Text for printable keys." },
          windowsVirtualKeyCode: { type: "number" },
        },
        required: ["key"],
      },
    },
    async (args) => json(await cdp(opts.extCall, "dispatchKey", args)),
  );

  server.registerTool(
    {
      name: "cdp_evaluate",
      description: "Evaluate JavaScript through CDP Runtime.evaluate (works below page scripts, distinct from page eval).",
      inputSchema: {
        type: "object",
        properties: {
          expression: { type: "string" },
          awaitPromise: { type: "boolean", description: "default true" },
          returnByValue: { type: "boolean", description: "default true" },
        },
        required: ["expression"],
      },
    },
    async (args) => json(await cdp(opts.extCall, "evaluate", args)),
  );

  server.registerTool(
    {
      name: "cdp_capture_screenshot",
      description: "Capture a screenshot via CDP Page.captureScreenshot; can capture beyond viewport.",
      inputSchema: {
        type: "object",
        properties: {
          format: { type: "string", description: "png|jpeg|webp (default png)" },
          quality: { type: "number", description: "0-100 for jpeg/webp" },
          captureBeyondViewport: { type: "boolean" },
        },
      },
    },
    async (args) => {
      const result = (await cdp(opts.extCall, "screenshot", args)) as { data?: string };
      if (!result.data) return json(result);
      const mimeType = args.format === "jpeg" ? "image/jpeg" : args.format === "webp" ? "image/webp" : "image/png";
      return { content: [{ type: "image", data: result.data, mimeType }] as ContentBlock[] } satisfies ToolResult;
    },
  );

  server.registerTool(
    {
      name: "cdp_get_performance_metrics",
      description: "Return CDP Performance.getMetrics for this tab.",
      inputSchema: { type: "object", properties: {} },
    },
    async () => json(await cdp(opts.extCall, "performanceMetrics")),
  );

  server.registerTool(
    {
      name: "cdp_set_network_conditions",
      description: "Emulate network conditions via CDP Network.emulateNetworkConditions.",
      inputSchema: {
        type: "object",
        properties: {
          offline: { type: "boolean" },
          latency: { type: "number", description: "ms" },
          downloadThroughput: { type: "number", description: "bytes/sec, -1 disables" },
          uploadThroughput: { type: "number", description: "bytes/sec, -1 disables" },
        },
      },
    },
    async (args) => json(await cdp(opts.extCall, "setNetworkConditions", args)),
  );

  server.registerTool(
    {
      name: "cdp_set_user_agent",
      description: "Override user agent via CDP Network.setUserAgentOverride.",
      inputSchema: { type: "object", properties: { userAgent: { type: "string" } }, required: ["userAgent"] },
    },
    async (args) => json(await cdp(opts.extCall, "setUserAgent", args)),
  );

  server.registerTool(
    {
      name: "cdp_set_geolocation",
      description: "Override geolocation via CDP Emulation.setGeolocationOverride.",
      inputSchema: {
        type: "object",
        properties: { latitude: { type: "number" }, longitude: { type: "number" }, accuracy: { type: "number", description: "meters, default 100" } },
        required: ["latitude", "longitude"],
      },
    },
    async (args) => json(await cdp(opts.extCall, "setGeolocation", args)),
  );
}
