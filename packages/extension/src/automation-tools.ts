/**
 * Playwright-like opt-in automation tools for a live page.
 *
 * Locators, the uid snapshot registry, and the synthetic input engine live in
 * dom-core.ts so the always-on core tools (click/type_text/press_key) and these
 * opt-in tools resolve elements and dispatch events exactly the same way.
 */
import type { EmbeddedMcpServer, ToolResult } from "./embedded-server.js";
import {
  actionabilityFor,
  clearSnapshotRefs,
  dispatchMouseLike,
  dispatchPointerLike,
  el,
  inputEvents,
  json,
  locatorMatches,
  locatorSummary,
  mouseAction,
  numberArg,
  parseModifiers,
  parseMouseButton,
  selectorFor,
  setCheckedValue,
  setTextValue,
  sleep,
  snapshotElement,
  stringArg,
  text,
  waitForLocator,
  wheelAt,
} from "./dom-core.js";
import { toLogString } from "./serialize.js";

type ExtCall = (action: string, args?: Record<string, unknown>) => Promise<any>;

interface NetworkEntry {
  id: string;
  type: "fetch" | "xhr";
  method: string;
  url: string;
  requestBody?: string;
  requestHeaders?: Record<string, string>;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyTruncated?: boolean;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
}

interface DialogEntry {
  id: string;
  type: "alert" | "confirm" | "prompt";
  message: string;
  defaultValue?: string;
  handled: "native" | "accept" | "dismiss";
  result?: boolean | string | null;
  time: string;
}

interface DialogOriginals {
  alert: typeof window.alert;
  confirm: typeof window.confirm;
  prompt: typeof window.prompt;
}

const NETWORK_MAX_ENTRIES = 300;
const NETWORK_BODY_LIMIT = 12000;
const networkEntries: NetworkEntry[] = [];
let networkSeq = 0;
let networkCaptureActive = false;
let networkCaptureInstalled = false;
let originalFetch: typeof window.fetch | undefined;
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | undefined;
let originalXhrSend: typeof XMLHttpRequest.prototype.send | undefined;
let originalXhrSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader | undefined;
let xhrMeta = new WeakMap<XMLHttpRequest, { method: string; url: string; requestHeaders: Record<string, string>; entry?: NetworkEntry; startedAt?: number }>();

const dialogEntries: DialogEntry[] = [];
let dialogSeq = 0;
let dialogOriginals: DialogOriginals | undefined;
let dialogMode: "native" | "accept" | "dismiss" = "native";
let dialogPromptText = "";

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function truncateBody(value: string): { body: string; truncated: boolean } {
  if (value.length <= NETWORK_BODY_LIMIT) return { body: value, truncated: false };
  return { body: value.slice(0, NETWORK_BODY_LIMIT), truncated: true };
}

function pushNetworkEntry(entry: NetworkEntry): NetworkEntry {
  networkEntries.push(entry);
  if (networkEntries.length > NETWORK_MAX_ENTRIES) networkEntries.splice(0, networkEntries.length - NETWORK_MAX_ENTRIES);
  return entry;
}

function headersObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return String(init.method).toUpperCase();
  if (typeof input === "object" && "method" in input && typeof input.method === "string") return input.method.toUpperCase();
  return "GET";
}

function bodyPreview(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return truncateBody(body).body;
  if (body instanceof URLSearchParams) return truncateBody(body.toString()).body;
  if (body instanceof FormData) return "[FormData]";
  if (body instanceof Blob) return `[Blob ${body.type || "application/octet-stream"} ${body.size} bytes]`;
  if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength} bytes]`;
  if (ArrayBuffer.isView(body)) return `[${body.constructor.name} ${body.byteLength} bytes]`;
  return toLogString(body).slice(0, NETWORK_BODY_LIMIT);
}

function installNetworkCapture(): void {
  if (networkCaptureInstalled) return;
  networkCaptureInstalled = true;
  originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const fetchImpl = originalFetch;
    if (!fetchImpl) throw new Error("fetch capture is not installed");
    if (!networkCaptureActive) return fetchImpl(input, init);
    const started = performance.now();
    const entry = pushNetworkEntry({ id: `net-${++networkSeq}`, type: "fetch", method: requestMethod(input, init), url: requestUrl(input), requestBody: bodyPreview(init?.body), startedAt: new Date().toISOString() });
    try {
      const response = await fetchImpl(input, init);
      entry.status = response.status;
      entry.statusText = response.statusText;
      entry.responseHeaders = headersObject(response.headers);
      entry.endedAt = new Date().toISOString();
      entry.durationMs = Math.round(performance.now() - started);
      void response.clone().text().then((body) => {
        const truncated = truncateBody(body);
        entry.responseBody = truncated.body;
        entry.responseBodyTruncated = truncated.truncated;
      }).catch(() => {
        entry.responseBody = "[unavailable]";
      });
      return response;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      entry.endedAt = new Date().toISOString();
      entry.durationMs = Math.round(performance.now() - started);
      throw error;
    }
  };

  originalXhrOpen = XMLHttpRequest.prototype.open;
  originalXhrSend = XMLHttpRequest.prototype.send;
  originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function open(method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) {
    xhrMeta.set(this, { method: String(method).toUpperCase(), url: String(url), requestHeaders: {} });
    return originalXhrOpen!.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };
  XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(header: string, value: string) {
    const meta = xhrMeta.get(this);
    if (meta) meta.requestHeaders[header] = value;
    return originalXhrSetRequestHeader!.call(this, header, value);
  };
  XMLHttpRequest.prototype.send = function send(body?: XMLHttpRequestBodyInit | null) {
    const meta = xhrMeta.get(this);
    if (networkCaptureActive && meta) {
      meta.startedAt = performance.now();
      meta.entry = pushNetworkEntry({ id: `net-${++networkSeq}`, type: "xhr", method: meta.method, url: meta.url, requestHeaders: meta.requestHeaders, requestBody: bodyPreview(body), startedAt: new Date().toISOString() });
      const finish = (): void => {
        const entry = meta.entry;
        if (!entry) return;
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.url = this.responseURL || entry.url;
        entry.endedAt = new Date().toISOString();
        entry.durationMs = Math.round(performance.now() - (meta.startedAt ?? performance.now()));
        try {
          entry.responseHeaders = Object.fromEntries(this.getAllResponseHeaders().trim().split(/\r?\n/).filter(Boolean).map((line) => {
            const index = line.indexOf(":");
            return index === -1 ? [line, ""] : [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
          }));
        } catch {
          // ignore response header access errors
        }
        try {
          if (typeof this.responseText === "string") {
            const truncated = truncateBody(this.responseText);
            entry.responseBody = truncated.body;
            entry.responseBodyTruncated = truncated.truncated;
          }
        } catch {
          entry.responseBody = "[unavailable]";
        }
      };
      const fail = (): void => {
        if (meta.entry) meta.entry.error = "XMLHttpRequest failed";
        finish();
      };
      this.addEventListener("loadend", finish, { once: true });
      this.addEventListener("error", fail, { once: true });
      this.addEventListener("timeout", fail, { once: true });
      this.addEventListener("abort", fail, { once: true });
    }
    return originalXhrSend!.call(this, body ?? null);
  };
}

function uninstallNetworkCapture(): void {
  networkCaptureActive = false;
  if (!networkCaptureInstalled) return;
  if (originalFetch) window.fetch = originalFetch;
  if (originalXhrOpen) XMLHttpRequest.prototype.open = originalXhrOpen;
  if (originalXhrSend) XMLHttpRequest.prototype.send = originalXhrSend;
  if (originalXhrSetRequestHeader) XMLHttpRequest.prototype.setRequestHeader = originalXhrSetRequestHeader;
  originalFetch = undefined;
  originalXhrOpen = undefined;
  originalXhrSend = undefined;
  originalXhrSetRequestHeader = undefined;
  xhrMeta = new WeakMap();
  networkCaptureInstalled = false;
}

function networkEntryMatches(entry: NetworkEntry, args: Record<string, unknown>): boolean {
  if (args.url !== undefined && !entry.url.includes(String(args.url))) return false;
  if (args.urlPattern !== undefined && !new RegExp(String(args.urlPattern)).test(entry.url)) return false;
  if (args.method !== undefined && entry.method.toUpperCase() !== String(args.method).toUpperCase()) return false;
  if (args.status !== undefined && entry.status !== Number(args.status)) return false;
  return entry.endedAt !== undefined || args.includePending === true;
}

function storageObject(storage: Storage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null) out[key] = storage.getItem(key) ?? "";
  }
  return out;
}

function listDocumentCookies(): Array<{ name: string; value: string }> {
  return document.cookie.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index === -1 ? { name: decodeURIComponent(part), value: "" } : { name: decodeURIComponent(part.slice(0, index)), value: decodeURIComponent(part.slice(index + 1)) };
  });
}

function installDialogCapture(): void {
  if (dialogOriginals) return;
  dialogOriginals = { alert: window.alert.bind(window), confirm: window.confirm.bind(window), prompt: window.prompt.bind(window) };
  window.alert = (message?: unknown): void => {
    const handled = dialogMode === "native" ? "native" : dialogMode;
    dialogEntries.push({ id: `dialog-${++dialogSeq}`, type: "alert", message: String(message ?? ""), handled, time: new Date().toISOString() });
    if (dialogMode === "native") dialogOriginals?.alert(String(message ?? ""));
  };
  window.confirm = (message?: string): boolean => {
    const result = dialogMode !== "dismiss";
    const handled = dialogMode === "native" ? "native" : dialogMode;
    dialogEntries.push({ id: `dialog-${++dialogSeq}`, type: "confirm", message: String(message ?? ""), handled, result, time: new Date().toISOString() });
    return dialogMode === "native" ? dialogOriginals?.confirm(String(message ?? "")) ?? result : result;
  };
  window.prompt = (message?: string, defaultValue?: string): string | null => {
    const result = dialogMode === "dismiss" ? null : dialogPromptText || defaultValue || "";
    const handled = dialogMode === "native" ? "native" : dialogMode;
    dialogEntries.push({ id: `dialog-${++dialogSeq}`, type: "prompt", message: String(message ?? ""), defaultValue, handled, result, time: new Date().toISOString() });
    return dialogMode === "native" ? dialogOriginals?.prompt(String(message ?? ""), defaultValue) ?? null : result;
  };
}

function restoreDialogCapture(): void {
  if (!dialogOriginals) return;
  window.alert = dialogOriginals.alert;
  window.confirm = dialogOriginals.confirm;
  window.prompt = dialogOriginals.prompt;
  dialogOriginals = undefined;
  dialogMode = "native";
}

function frameElement(selector: unknown): HTMLIFrameElement {
  const frameSelector = stringArg(selector);
  if (!frameSelector) throw new Error("frameSelector is required.");
  const frame = el(frameSelector);
  if (!(frame instanceof HTMLIFrameElement)) throw new Error(`Selector is not an iframe: ${frameSelector}`);
  return frame;
}

function sameOriginFrameDocument(frame: HTMLIFrameElement): Document {
  const doc = frame.contentDocument;
  if (!doc) throw new Error("Frame document is not accessible (cross-origin, sandboxed, or not loaded).");
  return doc;
}

/**
 * Restore everything the automation tools patched on the page (fetch/XHR hooks
 * and alert/confirm/prompt overrides). Call this when the tab is deactivated or
 * the automation toolset is turned off, so the page (and the real user) is no
 * longer affected by a previously-set dialog mode or network capture.
 */
export function teardownAutomationTools(): void {
  uninstallNetworkCapture();
  restoreDialogCapture();
  clearSnapshotRefs();
}

export function registerAutomationTools(server: EmbeddedMcpServer, opts: { extCall: ExtCall }): void {
  // take_snapshot lives in the core input group (input-tools.ts) — uid targeting
  // is what the core click/type_text/press_key tools build on.

  // find_by_text / find_by_role / find_by_label / find_by_test_id used to live
  // here. They were four schemas for one thing `locator_snapshot` already does
  // with its full locator argument set — and the core `find` tool now covers the
  // "just describe it" case. Dropping them keeps the catalog (and the agent's
  // per-session token cost) smaller without losing any capability.

  server.registerTool(
    {
      name: "locator_snapshot",
      description: "Resolve a uid/selector/text/role/label/testId locator and return element snapshots plus actionability state.",
      inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, text: { type: "string" }, role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, testId: { type: "string" }, placeholder: { type: "string" }, exact: { type: "boolean" }, nth: { type: "number" }, visible: { type: "boolean" }, limit: { type: "number", description: "max results (default 10)" }, includeHtml: { type: "boolean" } } },
    },
    async (args) => {
      const limit = numberArg(args.limit, 10, 1, 50);
      const matches = locatorMatches(args, document, args.nth !== undefined);
      return json({ count: matches.length, matches: await Promise.all(matches.slice(0, limit).map(async (element) => ({ ...locatorSummary(element, { includeHtml: args.includeHtml === true }), actionability: await actionabilityFor(element) }))) });
    },
  );

  server.registerTool(
    {
      name: "locator_count",
      description: "Count elements matching a selector/text/role/label/testId locator.",
      inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, testId: { type: "string" }, placeholder: { type: "string" }, exact: { type: "boolean" }, visible: { type: "boolean" } } },
    },
    (args) => json({ count: locatorMatches(args, document, false).length }),
  );

  // click / type_text / press_key live in the always-available core input group
  // (builtins.ts → registerInputTools) so they work with or without this
  // opt-in toolset, and there is only one implementation of each action.

  server.registerTool({ name: "hover", description: "Move the synthetic pointer over a locator.", inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, text: { type: "string" }, role: { type: "string" }, name: { type: "string" }, testId: { type: "string" }, timeoutMs: { type: "number" } } } }, async (args) => {
    const element = await waitForLocator(args, { actionable: false });
    element.scrollIntoView({ block: "center", inline: "center" });
    dispatchPointerLike(element, "pointerover");
    dispatchMouseLike(element, "mouseover");
    dispatchPointerLike(element, "pointermove");
    dispatchMouseLike(element, "mousemove");
    return json({ hovered: locatorSummary(element) });
  });

  // double_click is gone: the core `click` tool takes clickCount 1/2/3, so a
  // second tool for it was pure catalog overhead.

  server.registerTool({ name: "select_option", description: "Select one or more values on a <select> element and fire input/change events.", inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, label: { type: "string" }, value: { description: "string or string[]" }, timeoutMs: { type: "number" } }, required: ["value"] } }, async (args) => {
    const element = await waitForLocator(args);
    if (!(element instanceof HTMLSelectElement)) throw new Error("Target is not a select element.");
    const values = new Set(Array.isArray(args.value) ? args.value.map(String) : [String(args.value ?? "")]);
    for (const option of element.options) option.selected = values.has(option.value) || values.has(option.label);
    inputEvents(element);
    return json({ selected: [...element.selectedOptions].map((option) => ({ value: option.value, label: option.label })) });
  });

  server.registerTool({ name: "check", description: "Check a checkbox/radio locator.", inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, label: { type: "string" }, timeoutMs: { type: "number" } } } }, async (args) => {
    const element = await waitForLocator(args);
    setCheckedValue(element, true);
    return json({ checked: locatorSummary(element) });
  });

  server.registerTool({ name: "uncheck", description: "Uncheck a checkbox locator.", inputSchema: { type: "object", properties: { uid: { type: "string", description: "element uid from take_snapshot" }, selector: { type: "string" }, label: { type: "string" }, timeoutMs: { type: "number" } } } }, async (args) => {
    const element = await waitForLocator(args);
    setCheckedValue(element, false);
    return json({ unchecked: locatorSummary(element) });
  });

  server.registerTool(
    {
      name: "upload_file",
      description:
        "Attach a file to an input[type=file]. Give it a real path on the machine running the bridge (path), " +
        "or synthesise one inline from base64/text. The path form needs the bridge started with --upload-dir and " +
        "the file inside that directory; it is the only form that works for anything larger than a few KB, " +
        "because inline content has to travel through the model's context.",
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "string", description: "element uid from take_snapshot" },
          selector: { type: "string" },
          path: { type: "string", description: "file path on the bridge host, inside the configured --upload-dir" },
          filename: { type: "string", description: "name shown to the page (defaults to the path's basename)" },
          mimeType: { type: "string" },
          base64: { type: "string", description: "inline content, base64 (small files only)" },
          text: { type: "string", description: "inline content, plain text (small files only)" },
        },
      },
    },
    async (args) => {
      const element = await waitForLocator(args);
      if (!(element instanceof HTMLInputElement) || element.type !== "file") throw new Error("Target is not input[type=file].");

      let bytes: Uint8Array;
      let filename = stringArg(args.filename);
      let mimeType = stringArg(args.mimeType);
      let source: string;

      if (args.path !== undefined) {
        const read = (await opts.extCall("readFile", { path: String(args.path) })) as {
          base64: string;
          name: string;
          mimeType?: string;
          size: number;
        };
        bytes = decodeBase64(read.base64);
        filename ??= read.name;
        mimeType ??= read.mimeType;
        source = `path:${args.path}`;
      } else if (args.base64 !== undefined || args.text !== undefined) {
        bytes = args.base64 !== undefined ? decodeBase64(String(args.base64)) : new TextEncoder().encode(String(args.text ?? ""));
        source = args.base64 !== undefined ? "inline:base64" : "inline:text";
      } else {
        throw new Error("upload_file needs path, base64, or text.");
      }
      if (!filename) throw new Error("upload_file needs a filename when the content is given inline.");

      const filePart = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const file = new File([filePart], filename, { type: mimeType ?? "application/octet-stream" });
      const dt = new DataTransfer();
      dt.items.add(file);
      element.files = dt.files;
      inputEvents(element);
      return json({ uploaded: { name: file.name, type: file.type, size: file.size, source } });
    },
  );

  // drag_and_drop is gone: it only ever dispatched the HTML5 DragEvent sequence,
  // which modern drag libraries (dnd-kit, sliders, canvas editors) never listen
  // to. The core `drag` tool does a real pointer drag and still fires the HTML5
  // events when the source is `draggable`.

  server.registerTool(
    {
      name: "mouse",
      description:
        "Low-level pointer action at viewport coordinates, for gestures `drag` cannot express " +
        "(multi-stop paths, press-move-hold-release, canvas painting). " +
        "Sequence them: down → move → move → up. Coordinates are CSS pixels, same space as click{x,y}.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["down", "up", "move", "wheel"], description: "pointer action" },
          x: { type: "number", description: "viewport x (CSS px)" },
          y: { type: "number", description: "viewport y (CSS px)" },
          button: { type: "string", enum: ["left", "middle", "right"], description: "default left" },
          modifiers: { type: "string", description: "modifier chord held, e.g. \"shift\"" },
          buttonHeld: { type: "boolean", description: "for move: the button is still pressed (a drag is in progress)" },
          deltaX: { type: "number", description: "wheel only: horizontal delta in px" },
          deltaY: { type: "number", description: "wheel only: vertical delta in px" },
        },
        required: ["action", "x", "y"],
      },
    },
    async (args) => {
      const action = String(args.action);
      const x = Math.round(Number(args.x));
      const y = Math.round(Number(args.y));
      const modifiers = parseModifiers(args.modifiers);
      if (action === "wheel") {
        return json(wheelAt(x, y, Number(args.deltaX ?? 0), Number(args.deltaY ?? 0), modifiers));
      }
      if (action !== "down" && action !== "up" && action !== "move") {
        throw new Error("action must be down, up, move, or wheel.");
      }
      return json(
        await mouseAction(action, x, y, {
          button: parseMouseButton(args.button),
          modifiers,
          buttonHeld: args.buttonHeld === true,
        }),
      );
    },
  );

  server.registerTool({ name: "start_network_capture", description: "Start page-level fetch/XMLHttpRequest capture (from this point forward).", inputSchema: { type: "object", properties: { clear: { type: "boolean" } } } }, (args) => {
    if (args.clear !== false) networkEntries.length = 0;
    installNetworkCapture();
    networkCaptureActive = true;
    return text("network capture started for fetch/XMLHttpRequest");
  });

  server.registerTool({ name: "stop_network_capture", description: "Stop page-level network capture and restore fetch/XMLHttpRequest hooks.", inputSchema: { type: "object", properties: {} } }, () => {
    uninstallNetworkCapture();
    return text("network capture stopped");
  });

  server.registerTool({ name: "list_network_requests", description: "List captured fetch/XMLHttpRequest entries.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "default 50" }, includeBodies: { type: "boolean" } } } }, (args) => {
    const limit = numberArg(args.limit, 50, 1, NETWORK_MAX_ENTRIES);
    const entries = networkEntries.slice(-limit).map((entry) => args.includeBodies === true ? entry : { ...entry, requestBody: undefined, responseBody: undefined });
    return json({ active: networkCaptureActive, entries });
  });

  server.registerTool({ name: "wait_for_response", description: "Wait for a captured response by url substring/regex, method, and/or status.", inputSchema: { type: "object", properties: { url: { type: "string" }, urlPattern: { type: "string" }, method: { type: "string" }, status: { type: "number" }, timeoutMs: { type: "number", description: "default 5000" }, includePending: { type: "boolean" } } } }, async (args) => {
    const timeoutMs = numberArg(args.timeoutMs, 5000, 0, 60000);
    const start = Date.now();
    for (;;) {
      const found = [...networkEntries].reverse().find((entry) => networkEntryMatches(entry, args));
      if (found) return json(found);
      if (Date.now() - start > timeoutMs) return { content: [{ type: "text", text: `timeout waiting for response after ${timeoutMs}ms` }], isError: true } satisfies ToolResult;
      await sleep(100);
    }
  });

  server.registerTool({ name: "get_response_body", description: "Return a captured response body by network request id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }, (args) => {
    const entry = networkEntries.find((item) => item.id === args.id);
    if (!entry) return { content: [{ type: "text", text: `no network entry found for ${args.id}` }], isError: true } satisfies ToolResult;
    return json({ id: entry.id, url: entry.url, body: entry.responseBody ?? "", truncated: entry.responseBodyTruncated === true });
  });

  server.registerTool({ name: "clear_network_capture", description: "Clear captured network entries.", inputSchema: { type: "object", properties: {} } }, () => {
    const count = networkEntries.length;
    networkEntries.length = 0;
    return text(`cleared ${count} network entr${count === 1 ? "y" : "ies"}`);
  });

  server.registerTool({ name: "get_storage_state", description: "Return origin, localStorage, sessionStorage, and script-readable cookies.", inputSchema: { type: "object", properties: {} } }, () => json({ origin: location.origin, localStorage: storageObject(localStorage), sessionStorage: storageObject(sessionStorage), cookies: listDocumentCookies(), note: "HTTP-only cookies are not visible to page scripts." }));

  server.registerTool({ name: "set_local_storage", description: "Set or remove a localStorage key.", inputSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" }, remove: { type: "boolean" } }, required: ["key"] } }, (args) => {
    const key = String(args.key ?? "");
    if (args.remove === true) localStorage.removeItem(key);
    else localStorage.setItem(key, String(args.value ?? ""));
    return json({ key, value: localStorage.getItem(key) });
  });

  server.registerTool({ name: "set_session_storage", description: "Set or remove a sessionStorage key.", inputSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" }, remove: { type: "boolean" } }, required: ["key"] } }, (args) => {
    const key = String(args.key ?? "");
    if (args.remove === true) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, String(args.value ?? ""));
    return json({ key, value: sessionStorage.getItem(key) });
  });

  server.registerTool({ name: "clear_storage", description: "Clear localStorage, sessionStorage, or both.", inputSchema: { type: "object", properties: { scope: { type: "string", description: "local|session|both (default both)" } } } }, (args) => {
    const scope = String(args.scope ?? "both");
    if (scope === "local" || scope === "both") localStorage.clear();
    if (scope === "session" || scope === "both") sessionStorage.clear();
    return text(`cleared ${scope} storage`);
  });

  server.registerTool({ name: "list_cookies", description: "List script-readable document cookies (HTTP-only cookies are not visible).", inputSchema: { type: "object", properties: {} } }, () => json(listDocumentCookies()));

  server.registerTool({ name: "set_cookie", description: "Set a script-readable cookie with optional attributes.", inputSchema: { type: "object", properties: { name: { type: "string" }, value: { type: "string" }, path: { type: "string" }, maxAge: { type: "number" }, sameSite: { type: "string" }, secure: { type: "boolean" } }, required: ["name", "value"] } }, (args) => {
    const parts = [`${encodeURIComponent(String(args.name ?? ""))}=${encodeURIComponent(String(args.value ?? ""))}`, `path=${String(args.path ?? "/")}`];
    if (args.maxAge !== undefined) parts.push(`max-age=${Number(args.maxAge)}`);
    if (args.sameSite) parts.push(`samesite=${String(args.sameSite)}`);
    if (args.secure === true) parts.push("secure");
    document.cookie = parts.join("; ");
    return json(listDocumentCookies().find((cookie) => cookie.name === String(args.name)) ?? { set: false });
  });

  server.registerTool({ name: "delete_cookie", description: "Delete a script-readable cookie by expiring it.", inputSchema: { type: "object", properties: { name: { type: "string" }, path: { type: "string" } }, required: ["name"] } }, (args) => {
    document.cookie = `${encodeURIComponent(String(args.name ?? ""))}=; path=${String(args.path ?? "/")}; max-age=0`;
    return text(`deleted cookie ${args.name}`);
  });

  server.registerTool({ name: "set_dialog_behavior", description: "Intercept alert/confirm/prompt and auto-accept, auto-dismiss, or restore native behavior.", inputSchema: { type: "object", properties: { mode: { type: "string", description: "accept|dismiss|native" }, promptText: { type: "string" }, clear: { type: "boolean" } }, required: ["mode"] } }, (args) => {
    const mode = String(args.mode ?? "native");
    if (!["accept", "dismiss", "native"].includes(mode)) throw new Error("mode must be accept, dismiss, or native");
    if (args.clear === true) dialogEntries.length = 0;
    dialogPromptText = String(args.promptText ?? "");
    if (mode === "native") restoreDialogCapture();
    else {
      dialogMode = mode as "accept" | "dismiss";
      installDialogCapture();
    }
    return json({ mode, promptText: dialogPromptText || undefined });
  });

  server.registerTool({ name: "list_dialogs", description: "List alert/confirm/prompt calls captured by set_dialog_behavior.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "default 50" } } } }, (args) => json(dialogEntries.slice(-numberArg(args.limit, 50, 1, 200))));

  server.registerTool({ name: "clear_dialogs", description: "Clear captured dialog entries.", inputSchema: { type: "object", properties: {} } }, () => {
    const count = dialogEntries.length;
    dialogEntries.length = 0;
    return text(`cleared ${count} dialog entr${count === 1 ? "y" : "ies"}`);
  });

  server.registerTool({ name: "list_frames", description: "List iframe elements and whether their documents are same-origin accessible.", inputSchema: { type: "object", properties: {} } }, () => json([...document.querySelectorAll("iframe")].map((frame, index) => {
    let accessible = false;
    let url = frame.src || undefined;
    let title = frame.title || undefined;
    try {
      accessible = !!frame.contentDocument;
      url = frame.contentWindow?.location.href || url;
      title = frame.contentDocument?.title || title;
    } catch {
      accessible = false;
    }
    return { index, selector: selectorFor(frame), url, title, accessible, rect: snapshotElement(frame).rect };
  })));

  server.registerTool({ name: "frame_dom_query", description: "Query a same-origin iframe by CSS selector.", inputSchema: { type: "object", properties: { frameSelector: { type: "string" }, selector: { type: "string" }, limit: { type: "number" }, includeHtml: { type: "boolean" } }, required: ["frameSelector", "selector"] } }, (args) => {
    const doc = sameOriginFrameDocument(frameElement(args.frameSelector));
    const matches = [...doc.querySelectorAll(String(args.selector))].slice(0, numberArg(args.limit, 20, 1, 100));
    return json(matches.map((element) => locatorSummary(element, { includeHtml: args.includeHtml === true })));
  });

  server.registerTool({ name: "frame_click", description: "Click inside a same-origin iframe.", inputSchema: { type: "object", properties: { frameSelector: { type: "string" }, selector: { type: "string" } }, required: ["frameSelector", "selector"] } }, (args) => {
    const doc = sameOriginFrameDocument(frameElement(args.frameSelector));
    const element = doc.querySelector(String(args.selector));
    if (!element) throw new Error(`No frame element matches selector: ${args.selector}`);
    if (element instanceof HTMLElement) element.click();
    else dispatchMouseLike(element, "click");
    return json({ clicked: locatorSummary(element) });
  });

  server.registerTool({ name: "frame_set_value", description: "Set an input/textarea/select value inside a same-origin iframe.", inputSchema: { type: "object", properties: { frameSelector: { type: "string" }, selector: { type: "string" }, value: { type: "string" } }, required: ["frameSelector", "selector", "value"] } }, (args) => {
    const doc = sameOriginFrameDocument(frameElement(args.frameSelector));
    const element = doc.querySelector(String(args.selector));
    if (!element) throw new Error(`No frame element matches selector: ${args.selector}`);
    if (element instanceof HTMLSelectElement) {
      element.value = String(args.value ?? "");
      inputEvents(element);
    } else setTextValue(element, String(args.value ?? ""));
    return json({ set: locatorSummary(element) });
  });

  server.registerTool({ name: "resize_window", description: "Resize the current browser window (best-effort viewport approximation).", inputSchema: { type: "object", properties: { width: { type: "number" }, height: { type: "number" } }, required: ["width", "height"] } }, async (args) => json(await opts.extCall("resizeWindow", { width: Number(args.width), height: Number(args.height) })));
}
