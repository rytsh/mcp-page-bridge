/**
 * Built-in tools the extension exposes for any enabled tab, registered into the
 * page's embedded MCP server. Page-context tools (eval, DOM, console) run here
 * in the MAIN world. Extension-only tools (screenshot, navigate, reload) are
 * delegated to the service worker via `extCall`.
 */
import type { ContentBlock, EmbeddedMcpServer, ToolResult } from "./embedded-server.js";
import { safeSerialize, toLogString } from "./serialize.js";

export interface ConsoleEntry {
  level: string;
  text: string;
  time: string;
}

export interface ConsoleBuffer {
  entries: ConsoleEntry[];
}

export type ExtCall = (action: string, args?: Record<string, unknown>) => Promise<any>;

/** Hook console.* and global error events into a bounded ring buffer. */
export function installConsoleCapture(max = 300): ConsoleBuffer {
  const entries: ConsoleEntry[] = [];
  const push = (level: string, parts: unknown[]): void => {
    entries.push({
      level,
      text: parts.map((p) => toLogString(p)).join(" ").slice(0, 2000),
      time: new Date().toISOString(),
    });
    if (entries.length > max) entries.splice(0, entries.length - max);
  };

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(level, args);
      original(...args);
    };
  }

  window.addEventListener("error", (e) => push("error", [e.message, e.filename + ":" + e.lineno]));
  window.addEventListener("unhandledrejection", (e) =>
    push("error", ["unhandledrejection:", (e as PromiseRejectionEvent).reason]),
  );

  return { entries };
}

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): ToolResult {
  return text(JSON.stringify(safeSerialize(value), null, 2));
}

async function runEval(code: string): Promise<unknown> {
  // Indirect eval runs in the page's global scope (MAIN world).
  const indirectEval = eval;
  try {
    return await indirectEval(`(async () => (${code}))()`);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return await indirectEval(`(async () => { ${code} })()`);
    }
    throw error;
  }
}

function el(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`No element matches selector: ${selector}`);
  return found;
}

export function registerBuiltins(
  server: EmbeddedMcpServer,
  opts: { extCall: ExtCall; console: ConsoleBuffer },
): void {
  server.registerTool(
    {
      name: "eval",
      description:
        "Evaluate JavaScript in the page (MAIN world) and return the result. Accepts an expression or statements. Async/await supported.",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string", description: "JS expression or statements" } },
        required: ["code"],
      },
    },
    async (args) => {
      try {
        const result = await runEval(String(args.code ?? ""));
        return json(result === undefined ? "undefined" : result);
      } catch (error) {
        return {
          content: [{ type: "text", text: `eval error: ${(error as Error).message}` }],
          isError: true,
        } satisfies ToolResult;
      }
    },
  );

  server.registerTool(
    {
      name: "dom_query",
      description: "Query the DOM with a CSS selector; returns matched elements' tag/id/classes/text/attributes.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          limit: { type: "number", description: "max elements (default 20)" },
          includeHtml: { type: "boolean", description: "include truncated outerHTML" },
        },
        required: ["selector"],
      },
    },
    (args) => {
      const limit = Number(args.limit ?? 20);
      const nodes = [...document.querySelectorAll(String(args.selector))].slice(0, limit);
      return json(
        nodes.map((e) => ({
          tag: e.tagName.toLowerCase(),
          id: e.id || undefined,
          classes: e.className || undefined,
          text: (e.textContent ?? "").trim().slice(0, 200),
          attributes: Object.fromEntries([...e.attributes].map((a) => [a.name, a.value])),
          html: args.includeHtml ? e.outerHTML.slice(0, 1000) : undefined,
        })),
      );
    },
  );

  server.registerTool(
    {
      name: "get_page_info",
      description: "Return current page url, title, readyState, viewport size, and user agent.",
      inputSchema: { type: "object", properties: {} },
    },
    () =>
      json({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        viewport: { width: innerWidth, height: innerHeight },
        userAgent: navigator.userAgent,
      }),
  );

  server.registerTool(
    {
      name: "click",
      description: "Click the first element matching a CSS selector.",
      inputSchema: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
    },
    (args) => {
      (el(String(args.selector)) as HTMLElement).click();
      return text(`clicked ${args.selector}`);
    },
  );

  server.registerTool(
    {
      name: "set_value",
      description: "Set an input/textarea/select value and dispatch input+change events.",
      inputSchema: {
        type: "object",
        properties: { selector: { type: "string" }, value: { type: "string" } },
        required: ["selector", "value"],
      },
    },
    (args) => {
      const node = el(String(args.selector)) as HTMLInputElement;
      node.value = String(args.value ?? "");
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return text(`set ${args.selector} = ${args.value}`);
    },
  );

  server.registerTool(
    {
      name: "scroll",
      description: "Scroll to an element (selector) or to x/y coordinates.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
        },
      },
    },
    (args) => {
      if (args.selector) {
        el(String(args.selector)).scrollIntoView({ behavior: "smooth", block: "center" });
        return text(`scrolled to ${args.selector}`);
      }
      window.scrollTo({ left: Number(args.x ?? 0), top: Number(args.y ?? 0), behavior: "smooth" });
      return text(`scrolled to (${args.x ?? 0}, ${args.y ?? 0})`);
    },
  );

  server.registerTool(
    {
      name: "wait_for",
      description: "Wait until an element matching the selector appears (or time out).",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          timeoutMs: { type: "number", description: "default 5000" },
        },
        required: ["selector"],
      },
    },
    async (args) => {
      const selector = String(args.selector);
      const timeout = Number(args.timeoutMs ?? 5000);
      const start = Date.now();
      for (;;) {
        if (document.querySelector(selector)) return text(`found ${selector}`);
        if (Date.now() - start > timeout) {
          return {
            content: [{ type: "text", text: `timeout waiting for ${selector}` }],
            isError: true,
          } satisfies ToolResult;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  );

  server.registerTool(
    {
      name: "get_html",
      description: "Return outerHTML of a selector (or the whole document), truncated.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          max: { type: "number", description: "max characters (default 5000)" },
        },
      },
    },
    (args) => {
      const max = Number(args.max ?? 5000);
      const html = args.selector
        ? el(String(args.selector)).outerHTML
        : document.documentElement.outerHTML;
      return text(html.length > max ? `${html.slice(0, max)}…(${html.length - max} more)` : html);
    },
  );

  server.registerTool(
    {
      name: "console_logs",
      description: "Return recently captured console output and page errors.",
      inputSchema: {
        type: "object",
        properties: {
          level: { type: "string", description: "filter: log|info|warn|error|debug" },
          limit: { type: "number", description: "max entries (default 50)" },
        },
      },
    },
    (args) => {
      const limit = Number(args.limit ?? 50);
      let entries = opts.console.entries;
      if (args.level) entries = entries.filter((e) => e.level === args.level);
      return json(entries.slice(-limit));
    },
  );

  // ---- extension-backed tools (delegated to the service worker) ----

  server.registerTool(
    {
      name: "screenshot",
      description:
        "Capture a PNG screenshot of the visible tab. Set download:true to also save it to the browser's Downloads folder.",
      inputSchema: {
        type: "object",
        properties: {
          download: { type: "boolean", description: "also save the PNG to Downloads" },
          filename: { type: "string", description: "download filename (default r-mcp-<ts>.png)" },
        },
      },
    },
    async (args) => {
      const res = (await opts.extCall("screenshot", {
        download: !!args.download,
        filename: args.filename ? String(args.filename) : undefined,
      })) as { dataUrl: string; savedAs?: string };
      const base64 = res.dataUrl.includes(",")
        ? res.dataUrl.slice(res.dataUrl.indexOf(",") + 1)
        : res.dataUrl;
      const content: ContentBlock[] = [{ type: "image", data: base64, mimeType: "image/png" }];
      if (res.savedAs) content.push({ type: "text", text: `Saved to Downloads as ${res.savedAs}` });
      return { content } satisfies ToolResult;
    },
  );

  server.registerTool(
    {
      name: "navigate",
      description: "Navigate the tab to a URL.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
    async (args) => {
      await opts.extCall("navigate", { url: String(args.url) });
      return text(`navigating to ${args.url}`);
    },
  );

  server.registerTool(
    {
      name: "reload",
      description: "Reload the tab.",
      inputSchema: { type: "object", properties: {} },
    },
    async () => {
      await opts.extCall("reload");
      return text("reloading");
    },
  );
}
