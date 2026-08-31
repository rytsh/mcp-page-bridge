import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EmbeddedMcpServer } from "./embedded-server.js";
import {
  PolyfillModelContext,
  bindModelContext,
  installModelContext,
  isToolExposedTo,
  parseExecuteToolResult,
  UNTRUSTED_CONTENT_META_KEY,
  type ModelContextLike,
  type RegisteredTool,
} from "./webmcp.js";

/** Minimal stand-ins for the bits of window/document the module touches. */
function fakeWindow(origin = "https://app.example"): Window {
  const win = {
    location: { origin },
    length: 0,
    top: undefined as unknown as Window,
  };
  win.top = win as unknown as Window;
  return win as unknown as Window;
}

function fakeDocument(): Document {
  return {} as Document;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function tool(name: string, execute = (): unknown => "ok"): Parameters<
  PolyfillModelContext["registerTool"]
>[0] {
  return { name, description: `desc for ${name}`, execute };
}

describe("PolyfillModelContext.registerTool", () => {
  let mc: PolyfillModelContext;

  beforeEach(() => {
    mc = new PolyfillModelContext(fakeWindow());
  });

  it("registers a tool and exposes it via getTools()", async () => {
    await mc.registerTool({
      name: "add-todo",
      title: "Add todo",
      description: "Add an item",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      annotations: { readOnlyHint: false },
      execute: () => "done",
    });

    const tools = await mc.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "add-todo",
      title: "Add todo",
      description: "Add an item",
      origin: "https://app.example",
      annotations: { readOnlyHint: false },
    });
    expect(tools[0]!.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
    });
  });

  it("deep-copies inputSchema so later page mutations do not leak", async () => {
    const schema: Record<string, unknown> = { type: "object", properties: {} };
    await mc.registerTool({ ...tool("t"), inputSchema: schema });
    schema.type = "mutated";

    const [registered] = await mc.getTools();
    expect(registered!.inputSchema).toMatchObject({ type: "object" });
  });

  it("rejects duplicate names", async () => {
    await mc.registerTool(tool("dup"));
    await expect(mc.registerTool(tool("dup"))).rejects.toMatchObject({
      name: "InvalidStateError",
    });
  });

  it("rejects invalid names and empty descriptions", async () => {
    await expect(mc.registerTool(tool("has space"))).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    await expect(mc.registerTool(tool("a".repeat(129)))).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    await expect(
      mc.registerTool({ name: "ok", description: "", execute: () => 1 }),
    ).rejects.toMatchObject({ name: "InvalidStateError" });
    await expect(
      mc.registerTool({ name: "ok", description: "d" } as never),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("accepts the full legal name charset", async () => {
    await expect(mc.registerTool(tool("a.b-c_D9"))).resolves.toBeUndefined();
  });

  it("unregisters via the AbortSignal", async () => {
    const controller = new AbortController();
    await mc.registerTool(tool("temp"), { signal: controller.signal });
    expect(await mc.getTools()).toHaveLength(1);

    controller.abort();
    expect(await mc.getTools()).toHaveLength(0);
  });

  it("rejects an already-aborted signal without registering", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(mc.registerTool(tool("nope"), { signal: controller.signal })).rejects.toBeDefined();
    expect(await mc.getTools()).toHaveLength(0);
  });

  it("rejects non-URL exposedTo origins", async () => {
    await expect(mc.registerTool(tool("x"), { exposedTo: ["not-a-url"] })).rejects.toMatchObject({
      name: "SecurityError",
    });
  });
});

describe("PolyfillModelContext toolchange", () => {
  it("fires on register and unregister", async () => {
    const mc = new PolyfillModelContext(fakeWindow());
    const seen = vi.fn();
    mc.addEventListener("toolchange", seen);

    await mc.registerTool(tool("a"));
    await flush();
    expect(seen).toHaveBeenCalledTimes(1);

    mc.unregisterTool("a");
    await flush();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("supports the ontoolchange handler property", async () => {
    const mc = new PolyfillModelContext(fakeWindow());
    const seen = vi.fn();
    mc.ontoolchange = seen;
    expect(mc.ontoolchange).toBe(seen);

    await mc.registerTool(tool("a"));
    await flush();
    expect(seen).toHaveBeenCalledTimes(1);

    mc.ontoolchange = null;
    mc.unregisterTool("a");
    await flush();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("PolyfillModelContext.executeTool", () => {
  let mc: PolyfillModelContext;

  beforeEach(() => {
    mc = new PolyfillModelContext(fakeWindow());
  });

  it("resolves with the JSON-stringified return value, per spec", async () => {
    await mc.registerTool({
      ...tool("sum"),
      execute: (input) => ({ total: (input.a as number) + (input.b as number) }),
    });
    const [registered] = await mc.getTools();
    await expect(mc.executeTool(registered!, { a: 2, b: 5 })).resolves.toBe('{"total":7}');
  });

  it("stringifies an undefined return as null", async () => {
    await mc.registerTool({ ...tool("void"), execute: () => undefined });
    const [registered] = await mc.getTools();
    await expect(mc.executeTool(registered!)).resolves.toBe("null");
  });

  it("passes an AbortSignal through to execute()", async () => {
    let seen: AbortSignal | undefined;
    await mc.registerTool({
      ...tool("slow"),
      execute: (_input, options) =>
        new Promise((resolve) => {
          seen = options.signal;
          options.signal.addEventListener("abort", () => resolve("aborted"));
        }),
    });
    const [registered] = await mc.getTools();
    const controller = new AbortController();
    const pending = mc.executeTool(registered!, {}, { signal: controller.signal });
    await flush();
    expect(seen).toBeInstanceOf(AbortSignal);
    controller.abort();
    await expect(pending).resolves.toBe('"aborted"');
  });

  it("rejects for an unknown tool", async () => {
    const ghost = {
      name: "ghost",
      description: "d",
      window: fakeWindow(),
      origin: "https://app.example",
    } satisfies RegisteredTool;
    await expect(mc.executeTool(ghost)).rejects.toBeDefined();
  });

  // Spec: "If tool owner origin is same origin with accessing origin, return
  // true." exposedTo GRANTS extra origins, it does not revoke the owner's own.
  it("still lets the owning origin call a tool that also sets exposedTo", async () => {
    await mc.registerTool(tool("shared"), { exposedTo: ["https://partner.example"] });
    const [registered] = await mc.getTools();
    await expect(mc.executeTool(registered!)).resolves.toBe('"ok"');
  });

  it("lists a tool with exposedTo to its own origin (list and execute must agree)", async () => {
    await mc.registerTool(tool("shared"), { exposedTo: ["https://partner.example"] });
    expect((await mc.getTools()).map((t) => t.name)).toEqual(["shared"]);
  });
});

describe("installModelContext", () => {
  it("installs the polyfill when there is no native implementation", () => {
    const doc = fakeDocument();
    const { context, native } = installModelContext(doc, fakeWindow());
    expect(native).toBe(false);
    expect(context).toBeInstanceOf(PolyfillModelContext);
    expect((doc as Document & { modelContext?: unknown }).modelContext).toBe(context);
  });

  it("is idempotent within a frame", () => {
    const win = fakeWindow();
    const a = installModelContext(fakeDocument(), win).context;
    const b = installModelContext(fakeDocument(), win).context;
    expect(a).toBe(b);
  });

  it("adopts a native implementation instead of overwriting it", () => {
    const nativeContext = Object.assign(new EventTarget(), {
      registerTool: async () => undefined,
      getTools: async () => [],
      executeTool: async () => "null",
    }) as unknown as ModelContextLike;
    const doc = { modelContext: nativeContext } as unknown as Document;

    const result = installModelContext(doc, fakeWindow());
    expect(result.native).toBe(true);
    expect(result.context).toBe(nativeContext);
  });
});

describe("parseExecuteToolResult", () => {
  it("parses JSON", () => {
    expect(parseExecuteToolResult('{"a":1}')).toEqual({ a: 1 });
    expect(parseExecuteToolResult("null")).toBeNull();
    expect(parseExecuteToolResult('"hi"')).toBe("hi");
  });

  it("falls back to the raw string for non-JSON", () => {
    expect(parseExecuteToolResult("not json")).toBe("not json");
  });

  it("maps empty/undefined to null", () => {
    expect(parseExecuteToolResult("")).toBeNull();
    expect(parseExecuteToolResult(undefined)).toBeNull();
  });
});

describe("bindModelContext", () => {
  it("adapts polyfill tools into MCP tool definitions, calling execute directly", async () => {
    const doc = fakeDocument();
    const binding = bindModelContext(doc, fakeWindow());
    expect(binding.native).toBe(false);

    await binding.context.registerTool({
      name: "get-cart",
      title: "Get cart",
      description: "Return the cart",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      // A rich MCP result must survive untouched (no JSON round-trip).
      execute: () => ({ content: [{ type: "text", text: "2 items" }] }),
    });

    const [entry] = await binding.readTools();
    expect(entry!.def).toEqual({
      name: "get-cart",
      title: "Get cart",
      description: "Return the cart",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    });
    await expect(entry!.handler({}, { signal: new AbortController().signal })).resolves.toEqual({
      content: [{ type: "text", text: "2 items" }],
    });
  });

  it("returns a stable handler per tool name across reads", async () => {
    const binding = bindModelContext(fakeDocument(), fakeWindow());
    await binding.context.registerTool(tool("stable"));

    const first = (await binding.readTools())[0]!.handler;
    const second = (await binding.readTools())[0]!.handler;
    expect(second).toBe(first);
  });

  it("routes a stable handler to the current implementation after a re-register", async () => {
    const doc = fakeDocument();
    const binding = bindModelContext(doc, fakeWindow());
    const mc = binding.context as PolyfillModelContext;

    await mc.registerTool(tool("swap", () => "v1"));
    const handler = (await binding.readTools())[0]!.handler;
    const signal = new AbortController().signal;
    await expect(handler({}, { signal })).resolves.toBe("v1");

    mc.unregisterTool("swap");
    await mc.registerTool(tool("swap", () => "v2"));
    await binding.readTools();
    await expect(handler({}, { signal })).resolves.toBe("v2");
  });

  it("drops cached handlers for tools that went away", async () => {
    const binding = bindModelContext(fakeDocument(), fakeWindow());
    const mc = binding.context as PolyfillModelContext;

    await mc.registerTool(tool("gone"));
    const handler = (await binding.readTools())[0]!.handler;

    mc.unregisterTool("gone");
    expect(await binding.readTools()).toHaveLength(0);
    await expect(handler({}, { signal: new AbortController().signal })).rejects.toThrow(
      /Tool not found/,
    );
  });

  it("re-reads tools when toolchange fires", async () => {
    const binding = bindModelContext(fakeDocument(), fakeWindow());
    const listener = vi.fn();
    const unsubscribe = binding.subscribe(listener);

    await binding.context.registerTool(tool("a"));
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(await binding.readTools()).toHaveLength(1);

    unsubscribe();
    await binding.context.registerTool(tool("b"));
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("goes through executeTool() and parses its JSON for a native context", async () => {
    const registered: RegisteredTool = {
      name: "native-tool",
      description: "From the browser",
      inputSchema: { type: "object" },
      window: fakeWindow(),
      origin: "https://app.example",
    };
    const executeTool = vi.fn(async () => '{"ok":true}');
    const nativeContext = Object.assign(new EventTarget(), {
      registerTool: async () => undefined,
      getTools: async () => [registered],
      executeTool,
    }) as unknown as ModelContextLike;

    const binding = bindModelContext(
      { modelContext: nativeContext } as unknown as Document,
      fakeWindow(),
    );
    expect(binding.native).toBe(true);

    const [entry] = await binding.readTools();
    expect(entry!.def).toMatchObject({ name: "native-tool", description: "From the browser" });

    const signal = new AbortController().signal;
    await expect(entry!.handler({ a: 1 }, { signal })).resolves.toEqual({ ok: true });
    expect(executeTool).toHaveBeenCalledWith(registered, { a: 1 }, { signal });
  });

  it("returns no tools when a native getTools() rejects", async () => {
    const nativeContext = Object.assign(new EventTarget(), {
      registerTool: async () => undefined,
      getTools: async () => {
        throw new Error("NotAllowedError");
      },
      executeTool: async () => "null",
    }) as unknown as ModelContextLike;

    const binding = bindModelContext(
      { modelContext: nativeContext } as unknown as Document,
      fakeWindow(),
    );
    expect(await binding.readTools()).toEqual([]);
  });
});

describe("WebMCP -> EmbeddedMcpServer -> MCP SDK client", () => {
  it("surfaces a page's registered tool to a real MCP client, annotations included", async () => {
    const binding = bindModelContext(fakeDocument(), fakeWindow());
    await binding.context.registerTool({
      name: "add-todo",
      title: "Add todo",
      description: "Add an item to the todo list",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      annotations: { readOnlyHint: false },
      execute: ({ text }) => `added ${String(text)}`,
    });

    // What inject.ts does: mirror document.modelContext into the embedded server.
    const server = new EmbeddedMcpServer({ name: "page", version: "1.0.0" });
    for (const { def, handler } of await binding.readTools()) server.registerTool(def, handler);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "add-todo",
      title: "Add todo",
      description: "Add an item to the todo list",
      annotations: { readOnlyHint: false },
    });
    expect(tools[0]!.inputSchema).toMatchObject({ type: "object", required: ["text"] });

    const result = await client.callTool({ name: "add-todo", arguments: { text: "milk" } });
    const content = (result as { content: Array<{ text?: string }> }).content;
    expect(content[0]!.text).toBe("added milk");
  });
});

describe("WebMCP -> MCP translation gaps", () => {
  it("carries untrustedContentHint in _meta and the description, since MCP drops it", async () => {
    const binding = bindModelContext(fakeDocument(), fakeWindow());
    await binding.context.registerTool({
      name: "read-page",
      description: "Return the page's visible text.",
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () => "…",
    });

    const [entry] = await binding.readTools();
    expect(entry!.def.description).toBe("[untrusted output] Return the page's visible text.");
    expect(entry!.def._meta).toEqual({ [UNTRUSTED_CONTENT_META_KEY]: true });
    // The original annotations still ride along for clients that understand them.
    expect(entry!.def.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
  });

  it("leaves trusted tools alone", async () => {
    const binding = bindModelContext(fakeDocument(), fakeWindow());
    await binding.context.registerTool({
      name: "safe",
      description: "Nothing scary.",
      annotations: { readOnlyHint: true },
      execute: () => 1,
    });

    const [entry] = await binding.readTools();
    expect(entry!.def.description).toBe("Nothing scary.");
    expect(entry!.def._meta).toBeUndefined();
  });

  it("coerces an inputSchema whose root is not an object", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const binding = bindModelContext(fakeDocument(), fakeWindow());
    await binding.context.registerTool({
      name: "bad-schema",
      description: "Root type is wrong.",
      inputSchema: { type: "string" },
      execute: () => 1,
    });

    const [entry] = await binding.readTools();
    expect(entry!.def.inputSchema).toEqual({ type: "object" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps a schema that is missing `type` but has properties", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const binding = bindModelContext(fakeDocument(), fakeWindow());
    await binding.context.registerTool({
      name: "no-type",
      description: "Missing root type.",
      inputSchema: { properties: { a: { type: "string" } }, required: ["a"] },
      execute: () => 1,
    });

    const [entry] = await binding.readTools();
    expect(entry!.def.inputSchema).toEqual({
      properties: { a: { type: "string" } },
      required: ["a"],
      type: "object",
    });
    warn.mockRestore();
  });

  it("survives a real MCP client (the whole point of coercing)", async () => {
    const binding = bindModelContext(fakeDocument(), fakeWindow());
    await binding.context.registerTool({
      name: "bad-schema",
      description: "Root type is wrong.",
      inputSchema: { type: "string" },
      annotations: { untrustedContentHint: true },
      execute: () => "ok",
    });

    const server = new EmbeddedMcpServer({ name: "page", version: "1.0.0" });
    for (const { def, handler } of await binding.readTools()) server.registerTool(def, handler);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct);

    // Without the coercion this listTools() throws and takes every other
    // provider's tools with it.
    const { tools } = await client.listTools();
    expect(tools[0]!.name).toBe("bad-schema");
    expect(tools[0]!._meta).toEqual({ [UNTRUSTED_CONTENT_META_KEY]: true });
  });
});

describe("isToolExposedTo (spec algorithm)", () => {
  const owner = "https://app.example";
  const partner = "https://partner.example";
  const stranger = "https://evil.example";

  it("always allows the owning origin, exposedTo or not", () => {
    expect(isToolExposedTo(owner, [], owner)).toBe(true);
    expect(isToolExposedTo(owner, [partner], owner)).toBe(true);
  });

  it("denies a third origin by default", () => {
    expect(isToolExposedTo(owner, [], stranger)).toBe(false);
  });

  it("grants exactly the listed origins", () => {
    expect(isToolExposedTo(owner, [partner], partner)).toBe(true);
    expect(isToolExposedTo(owner, [partner], stranger)).toBe(false);
  });
});
