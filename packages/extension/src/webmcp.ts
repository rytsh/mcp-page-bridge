/**
 * WebMCP (`document.modelContext`) support.
 *
 * WebMCP is the W3C Web Machine Learning CG proposal that lets a page expose
 * client-side functionality to agents as MCP tools:
 *
 *   await document.modelContext.registerTool({
 *     name: "add-todo",
 *     description: "Add an item to the user's todo list",
 *     inputSchema: { type: "object", properties: { text: { type: "string" } } },
 *     async execute({ text }, { signal }) { return addTodo(text); },
 *   }, { signal: controller.signal });
 *
 * This module does two things:
 *
 *   1. **Polyfill.** If the browser has no native `document.modelContext`
 *      (anything outside the Chrome 149 / Edge 150 origin trials), we install a
 *      spec-shaped implementation at document_start so pages written against the
 *      standard work everywhere. mcp-page-bridge *is* the agent, so there is no
 *      need to wait for a built-in one.
 *   2. **Adapter.** Either way we expose the page's tools to the bridge: for the
 *      polyfill we call the page's `execute` callback directly; for the native
 *      implementation we go through `getTools()` / `executeTool()` and subscribe
 *      to `toolchange`.
 *
 * Spec: https://webmachinelearning.github.io/webmcp/
 *
 * Kept free of extension-specific imports (only the embedded server's tool
 * types) so it is unit-testable in Node with a fake document/window.
 */
import type {
  ToolAnnotations,
  ToolDefinition,
  ToolHandler,
  ToolHandlerReturn,
} from "./embedded-server.js";

// ---- spec types (mirrors the `webmcp-types` npm package) ---------------------

export interface ToolExecuteCallbackOptions {
  signal: AbortSignal;
}

export type ToolExecuteCallback = (
  inputObject: Record<string, unknown>,
  options: ToolExecuteCallbackOptions,
) => unknown | Promise<unknown>;

export interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: ToolExecuteCallback;
  annotations?: ToolAnnotations;
}

export interface ModelContextRegisterToolOptions {
  signal?: AbortSignal;
  exposedTo?: string[];
}

export interface ModelContextGetToolOptions {
  fromOrigins?: string[];
}

export interface RegisteredTool {
  name: string;
  title?: string;
  description: string;
  /** A deep copy of the schema passed to registerTool(). */
  inputSchema?: Record<string, unknown>;
  window: Window;
  origin: string;
  annotations?: ToolAnnotations;
}

/** The subset of `ModelContext` we rely on (native or polyfilled). */
export interface ModelContextLike extends EventTarget {
  registerTool(tool: ModelContextTool, options?: ModelContextRegisterToolOptions): Promise<void>;
  getTools(options?: ModelContextGetToolOptions): Promise<RegisteredTool[]>;
  executeTool(
    tool: RegisteredTool,
    inputObject?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
}

/** Per spec: 1-128 chars, ASCII alphanumeric plus `_`, `-` and `.`. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

// ---- polyfill ----------------------------------------------------------------

/** Where a frame parks its polyfill so same-origin frames can find it. */
const FRAME_KEY = "__mcpPageBridgeModelContext";

interface FrameWithModelContext extends Window {
  [FRAME_KEY]?: PolyfillModelContext;
}

interface ToolEntry {
  tool: ModelContextTool;
  /** Serialized-then-parsed copy handed out by getTools(). */
  inputSchema?: Record<string, unknown>;
  exposedOrigins: string[];
  /** Detaches this entry's abort listener when it is unregistered by any means. */
  detach?: () => void;
}

function domException(name: string, message: string): Error {
  const Ctor = (globalThis as { DOMException?: typeof DOMException }).DOMException;
  if (Ctor) return new Ctor(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}

/** JSON round-trip, mirroring the spec's "serialize a JavaScript value to a JSON string". */
function jsonClone(value: unknown): Record<string, unknown> {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Value could not be serialized to JSON");
  return JSON.parse(json) as Record<string, unknown>;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

/**
 * The spec's "tool is exposed to an origin" algorithm.
 *
 * `exposedTo` is ADDITIVE, not restrictive: a same-origin caller is always
 * allowed, and the listed origins are granted on top of that. Treating it as a
 * whitelist would make a tool registered with `exposedTo` uncallable by its own
 * page — and by the extension, which runs in that page's world.
 *
 * https://webmachinelearning.github.io/webmcp/#tool-is-exposed-to-an-origin
 */
export function isToolExposedTo(
  ownerOrigin: string,
  exposedOrigins: readonly string[],
  accessingOrigin: string,
): boolean {
  if (ownerOrigin === accessingOrigin) return true;
  return exposedOrigins.includes(accessingOrigin);
}

/**
 * Spec-shaped `ModelContext`, used when the browser has no native one.
 *
 * Deliberate simplifications, all of which only *widen* what works (the page
 * cannot observe a stricter behavior than the native API would give it):
 *   - `exposedTo` origins are recorded and enforced on executeTool(), but there
 *     is no cross-origin `postMessage` plumbing: only same-origin frames that
 *     also carry a polyfill participate.
 *   - The Permissions Policy `tools` feature is not consulted.
 */
/**
 * Brand on our polyfill instances.
 *
 * `instanceof` is not enough: inject.js can be evaluated twice in the same MAIN
 * world (manifest content_script + chrome.scripting re-injection), giving two
 * copies of this module and therefore two distinct classes. The second copy
 * must still recognise the first copy's object as a polyfill — otherwise it
 * takes the native code path and round-trips every result through JSON,
 * destroying the rich content blocks executeLocal() exists to preserve.
 */
const POLYFILL_BRAND = "__mcpPageBridgePolyfill";

/** True for our polyfill, including one built by another copy of this module. */
export function isPolyfillContext(
  context: unknown,
): context is PolyfillModelContext {
  return (
    !!context &&
    typeof context === "object" &&
    (context as Record<string, unknown>)[POLYFILL_BRAND] === true
  );
}

export class PolyfillModelContext extends EventTarget implements ModelContextLike {
  /** See POLYFILL_BRAND — survives across duplicate module instances. */
  readonly [POLYFILL_BRAND] = true;

  private readonly entries = new Map<string, ToolEntry>();
  private onToolChange: ((event: Event) => unknown) | null = null;
  private toolChangeQueued = false;

  constructor(private readonly win: Window) {
    super();
  }

  get ontoolchange(): ((event: Event) => unknown) | null {
    return this.onToolChange;
  }

  set ontoolchange(handler: ((event: Event) => unknown) | null) {
    if (this.onToolChange) this.removeEventListener("toolchange", this.onToolChange);
    this.onToolChange = typeof handler === "function" ? handler : null;
    if (this.onToolChange) this.addEventListener("toolchange", this.onToolChange);
  }

  async registerTool(
    tool: ModelContextTool,
    options: ModelContextRegisterToolOptions = {},
  ): Promise<void> {
    if (!tool || typeof tool !== "object") {
      throw new TypeError("registerTool: tool must be an object");
    }
    const { name, description, execute } = tool;
    if (typeof execute !== "function") {
      throw new TypeError("registerTool: tool.execute must be a function");
    }
    if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
      throw domException(
        "InvalidStateError",
        `registerTool: invalid tool name ${JSON.stringify(name)} (1-128 chars of [A-Za-z0-9_.-])`,
      );
    }
    if (typeof description !== "string" || description === "") {
      throw domException("InvalidStateError", `registerTool: "${name}" needs a non-empty description`);
    }
    if (this.entries.has(name)) {
      throw domException("InvalidStateError", `registerTool: "${name}" is already registered`);
    }

    // Throws (TypeError / circular structure) before anything is registered.
    const inputSchema = tool.inputSchema === undefined ? undefined : jsonClone(tool.inputSchema);

    const exposedOrigins: string[] = [];
    for (const origin of options.exposedTo ?? []) {
      const parsed = originOf(String(origin));
      if (parsed === "null") {
        throw domException("SecurityError", `registerTool: invalid exposedTo origin ${String(origin)}`);
      }
      exposedOrigins.push(parsed);
    }

    const signal = options.signal;
    if (signal?.aborted) throw signal.reason;

    const entry: ToolEntry = { tool, inputSchema, exposedOrigins };
    if (signal) {
      // Compare identity, not just the name: a page can unregister `x` and
      // register a *different* `x`, and aborting the first controller must not
      // take the second one down.
      const onAbort = (): void => {
        if (this.entries.get(name) === entry) this.unregisterTool(name);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // {once:true} only reclaims the listener if it fires; a long-lived signal
      // would otherwise accumulate one per register/unregister cycle.
      entry.detach = () => signal.removeEventListener("abort", onAbort);
    }
    this.entries.set(name, entry);
    this.notifyToolChange();
  }

  /**
   * Not in the spec: invoke a locally-registered tool's `execute` directly,
   * skipping the JSON round-trip `executeTool()` mandates so rich MCP results
   * (image/resource content blocks) reach the agent unchanged.
   */
  async executeLocal(
    tool: RegisteredTool,
    inputObject: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const owner = this.contextFor(tool) ?? this;
    const entry = owner.entries.get(tool.name);
    if (!entry) throw new Error(`Tool not found: ${tool.name}`);
    return owner.invoke(entry, inputObject, signal);
  }

  /** Not in the spec — the abort-signal path is, this is the same thing by name. */
  unregisterTool(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;
    this.entries.delete(name);
    entry.detach?.();
    this.notifyToolChange();
    return true;
  }

  async getTools(options: ModelContextGetToolOptions = {}): Promise<RegisteredTool[]> {
    const caller = this.origin();
    // Default is same-origin only; fromOrigins opts into additional owners.
    const allowedOwners = new Set<string>([caller]);
    for (const origin of options.fromOrigins ?? []) allowedOwners.add(originOf(String(origin)));

    const out: RegisteredTool[] = [];
    for (const context of this.reachableContexts()) {
      const ownerOrigin = context.origin();
      if (!allowedOwners.has(ownerOrigin)) continue;
      for (const entry of context.entries.values()) {
        // Must agree with executeTool(), or a caller can list a tool it cannot run.
        if (!isToolExposedTo(ownerOrigin, entry.exposedOrigins, caller)) continue;
        out.push(context.toRegistered(entry));
      }
    }
    return out;
  }

  async executeTool(
    tool: RegisteredTool,
    inputObject: Record<string, unknown> = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const owner = this.contextFor(tool);
    if (!owner) throw domException("UnknownError", `executeTool: unknown tool "${tool?.name}"`);

    const entry = owner.entries.get(tool.name);
    if (!entry) throw domException("UnknownError", `executeTool: unknown tool "${tool.name}"`);
    if (!isToolExposedTo(owner.origin(), entry.exposedOrigins, this.origin())) {
      throw domException("UnknownError", `executeTool: "${tool.name}" is not exposed to this origin`);
    }

    // Spec: arguments cross the boundary as a JSON string.
    const input = jsonClone(inputObject ?? {});
    const value = await owner.invoke(entry, input, options.signal);
    const json = JSON.stringify(value);
    return json === undefined ? "null" : json;
  }

  // -- internals --------------------------------------------------------------

  private toRegistered(entry: ToolEntry): RegisteredTool {
    const { name, title, description, annotations } = entry.tool;
    return {
      name,
      ...(title === undefined ? {} : { title }),
      description,
      ...(entry.inputSchema === undefined ? {} : { inputSchema: jsonClone(entry.inputSchema) }),
      window: this.win,
      origin: this.origin(),
      ...(annotations === undefined ? {} : { annotations: { ...annotations } }),
    };
  }

  private async invoke(
    entry: ToolEntry,
    input: Record<string, unknown>,
    outerSignal?: AbortSignal,
  ): Promise<unknown> {
    if (outerSignal?.aborted) throw outerSignal.reason;
    const controller = new AbortController();
    const forward = (): void => controller.abort(outerSignal?.reason);
    outerSignal?.addEventListener("abort", forward, { once: true });
    try {
      return await entry.tool.execute(input, { signal: controller.signal });
    } finally {
      // The caller's signal can outlive the call (one signal, many calls), so
      // detach explicitly instead of relying on {once:true} firing.
      outerSignal?.removeEventListener("abort", forward);
    }
  }

  private origin(): string {
    try {
      return this.win.location.origin;
    } catch {
      return "null";
    }
  }

  private notifyToolChange(): void {
    // Spec fires `toolchange` from a task, not synchronously during
    // registerTool, and guarantees it lands BEFORE the registerTool promise
    // resolves. So a page doing `await registerTool()` in a loop legitimately
    // gets one event per tool and we must not merge those.
    //
    // What we can collapse is a synchronous burst (registrations issued without
    // awaiting in between), which costs nothing to observers.
    if (this.toolChangeQueued) return;
    this.toolChangeQueued = true;
    queueMicrotask(() => {
      this.toolChangeQueued = false;
      for (const context of this.reachableContexts()) {
        context.dispatchEvent(new Event("toolchange"));
      }
    });
  }

  /** This context plus any same-origin frame in the tree that also has one. */
  private reachableContexts(): PolyfillModelContext[] {
    // Fast path for the overwhelmingly common case: a lone top-level document.
    // This runs on every registerTool, getTools and executeTool, so walking the
    // frame tree when there is no tree to walk is pure waste.
    try {
      if (this.win.top === this.win && this.win.length === 0) return [this];
    } catch {
      return [this];
    }

    const out = new Set<PolyfillModelContext>([this]);
    let root: Window;
    try {
      root = this.win.top ?? this.win;
    } catch {
      return [...out];
    }
    const walk = (frame: Window): void => {
      let context: PolyfillModelContext | undefined;
      let children: Window[] = [];
      try {
        context = (frame as FrameWithModelContext)[FRAME_KEY];
        children = Array.from({ length: frame.length }, (_, i) => frame[i]).filter(
          (f): f is Window => !!f,
        );
      } catch {
        return; // cross-origin frame: opaque to us, and to the spec's default too
      }
      if (context) out.add(context);
      for (const child of children) walk(child);
    };
    walk(root);
    return [...out];
  }

  /** Find the polyfill instance that owns a RegisteredTool handed back to us. */
  private contextFor(tool: RegisteredTool | undefined): PolyfillModelContext | undefined {
    if (!tool?.name) return undefined;
    const target = tool.window;
    for (const context of this.reachableContexts()) {
      if (context.win === target || (!target && context.entries.has(tool.name))) return context;
    }
    return undefined;
  }
}

// ---- installation ------------------------------------------------------------

export interface InstallResult {
  context: ModelContextLike;
  /** False when we polyfilled it. */
  native: boolean;
}

function hasNativeModelContext(doc: Document): boolean {
  const value = (doc as Document & { modelContext?: unknown }).modelContext;
  if (isPolyfillContext(value)) return false; // ours, from an earlier injection
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ModelContextLike).registerTool === "function" &&
    typeof (value as ModelContextLike).getTools === "function"
  );
}

/**
 * Return the native `document.modelContext`, or install our polyfill on the
 * document and return that. Idempotent — a second call in the same frame returns
 * the same object (inject.js can be delivered twice: manifest + scripting API).
 */
export function installModelContext(
  doc: Document = document,
  win: Window = window,
): InstallResult {
  if (hasNativeModelContext(doc)) {
    return { context: (doc as Document & { modelContext: ModelContextLike }).modelContext, native: true };
  }

  const frame = win as FrameWithModelContext;
  const existing = (doc as Document & { modelContext?: unknown }).modelContext;
  const context =
    frame[FRAME_KEY] ??
    (isPolyfillContext(existing) ? existing : undefined) ??
    new PolyfillModelContext(win);
  frame[FRAME_KEY] = context;

  try {
    Object.defineProperty(doc, "modelContext", {
      configurable: true,
      enumerable: true,
      get: () => context,
    });
  } catch {
    (doc as Document & { modelContext?: ModelContextLike }).modelContext = context;
  }
  return { context, native: false };
}

// ---- adapter: WebMCP tools -> embedded MCP server ----------------------------

/**
 * `executeTool()` resolves with a JSON string (the spec serializes the tool's
 * return value at the boundary). Parse it back so structured MCP results and
 * content blocks survive; fall back to the raw string if it is not JSON.
 */
export function parseExecuteToolResult(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  if (value === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** `_meta` key carrying WebMCP's untrustedContentHint, which MCP has no slot for. */
export const UNTRUSTED_CONTENT_META_KEY = "webmcp/untrustedContentHint";

/** Prefixed onto the description so the model — not just the host — sees it. */
const UNTRUSTED_PREFIX = "[untrusted output] ";

/**
 * MCP requires a tool's `inputSchema` root to be `{"type": "object"}`; WebMCP
 * puts no constraint on it. A validating MCP client rejects the ENTIRE
 * tools/list over one bad schema, so coerce here and tell the page author.
 * (The bridge repairs this again for non-extension providers — see
 * normalizeToolSchemas in internal/bridge/types.go.)
 */
function normalizeInputSchema(
  name: string,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (schema === undefined) return undefined;
  if (schema.type === "object") return schema;
  console.warn(
    `[mcp-page-bridge] tool "${name}": inputSchema root must be {"type":"object"} for MCP; coercing.`,
  );
  return { ...schema, type: "object" };
}

function toDefinition(tool: RegisteredTool): ToolDefinition {
  // WebMCP's ToolAnnotations is {readOnlyHint, untrustedContentHint}; MCP's is
  // {title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint}. Only
  // readOnlyHint is common, so a validating MCP client silently drops
  // untrustedContentHint — the one hint that matters for prompt-injection risk.
  // Carry it in `_meta` (which MCP passes through) AND in the description, which
  // is what the model actually reads.
  const untrusted = tool.annotations?.untrustedContentHint === true;
  const description = untrusted
    ? UNTRUSTED_PREFIX + (tool.description ?? "")
    : tool.description;
  const inputSchema = normalizeInputSchema(tool.name, tool.inputSchema);

  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(description === undefined ? {} : { description }),
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    ...(untrusted ? { _meta: { [UNTRUSTED_CONTENT_META_KEY]: true } } : {}),
  };
}

export interface ModelContextBinding {
  readonly native: boolean;
  readonly context: ModelContextLike;
  /** Current page tools, ready to hand to EmbeddedMcpServer.registerTool(). */
  readTools(): Promise<Array<{ def: ToolDefinition; handler: ToolHandler }>>;
  /** Subscribe to `toolchange`. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Install (or adopt) `document.modelContext` and adapt it for the bridge. */
export function bindModelContext(doc: Document = document, win: Window = window): ModelContextBinding {
  const { context, native } = installModelContext(doc, win);
  const polyfill = isPolyfillContext(context) ? context : undefined;

  // Handlers are stable per tool name across readTools() calls, so callers can
  // diff on identity and only re-register what actually changed. Each one
  // resolves the *current* registration at call time, so a page that unregisters
  // a tool and registers a new one under the same name still routes correctly.
  // (WebMCP rejects registering a duplicate name outright, so a genuine swap
  // always goes through an unregister first.)
  const handlers = new Map<string, ToolHandler>();
  const latest = new Map<string, RegisteredTool>();
  /** Last successful read; reused when a transient getTools() failure occurs. */
  let lastTools: RegisteredTool[] = [];

  const handlerFor = (name: string): ToolHandler => {
    const cached = handlers.get(name);
    if (cached) return cached;
    const handler: ToolHandler = async (args, options) => {
      const tool = latest.get(name);
      if (!tool) throw new Error(`Tool not found: ${name}`);
      // Polyfill: call the page's `execute` directly — no JSON round-trip, so a
      // tool can return image/resource content blocks unchanged. On the native
      // path the spec forces the result through a JSON string, so a tool
      // returning "42" arrives as the number 42; that asymmetry is unavoidable.
      if (polyfill) {
        return (await polyfill.executeLocal(tool, args ?? {}, options.signal)) as ToolHandlerReturn;
      }
      const json = await context.executeTool(tool, args ?? {}, { signal: options.signal });
      return parseExecuteToolResult(json) as ToolHandlerReturn;
    };
    handlers.set(name, handler);
    return handler;
  };

  const readTools = async (): Promise<Array<{ def: ToolDefinition; handler: ToolHandler }>> => {
    let tools: RegisteredTool[];
    try {
      tools = await context.getTools();
    } catch {
      // Insecure context, denied `tools` permission, or a transient failure.
      // Returning [] here would make the caller unregister every tool and then
      // re-register them on the next tick — a burst of list_changed for nothing.
      tools = lastTools;
    }
    lastTools = tools;

    latest.clear();
    for (const tool of tools) latest.set(tool.name, tool);
    for (const name of [...handlers.keys()]) {
      if (!latest.has(name)) handlers.delete(name);
    }

    return tools.map((tool) => ({ def: toDefinition(tool), handler: handlerFor(tool.name) }));
  };

  const subscribe = (listener: () => void): (() => void) => {
    const onChange = (): void => listener();
    context.addEventListener("toolchange", onChange);
    return () => context.removeEventListener("toolchange", onChange);
  };

  return { native, context, readTools, subscribe };
}
