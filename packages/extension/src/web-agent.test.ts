import { describe, expect, it, vi } from "vitest";

import { EmbeddedMcpServer } from "./embedded-server.js";
import {
  LoopbackMcpClient,
  TAB_MODE_DAEMON,
  TAB_MODE_WEB_AGENT,
  WEB_AGENT_CHANNEL,
  WEB_AGENT_EXTENSION_ID,
  WEB_AGENT_PROTOCOL_VERSION,
  addOrigin,
  createWebAgentResponder,
  daemonRoute,
  isTabMode,
  normalizeOrigin,
  originApproved,
  parseOrigins,
  parseTabModes,
  parseTabRoute,
  parseWebAgentRequest,
  removeOrigin,
  serializeTabModes,
  toolNames,
  webAgentDescriptor,
  webAgentRoute,
  type WebAgentBackendReply,
} from "./web-agent.js";

const ORIGIN = "https://at.example";

const request = (extra: Record<string, unknown> = {}) => ({
  channel: WEB_AGENT_CHANNEL,
  v: WEB_AGENT_PROTOCOL_VERSION,
  dir: "request",
  id: "r1",
  method: "describe",
  ...extra,
});

function responder(reply: WebAgentBackendReply | ((r: { method: string }) => WebAgentBackendReply), origin = ORIGIN) {
  const self = { name: "page window" };
  const post = vi.fn();
  const ask = vi.fn(async (r: { method: string }) => (typeof reply === "function" ? reply(r) : reply));
  const instance = createWebAgentResponder({ origin, self, post, ask });

  return { instance, post, ask, self };
}

describe("origins", () => {
  it("accepts only origins the browser actually enforces", () => {
    expect(normalizeOrigin("https://at.example/chats#/x")).toBe("https://at.example");
    expect(normalizeOrigin("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
    // A file: page has one opaque origin shared by every local file, so
    // approving one would approve all of them.
    expect(normalizeOrigin("file:///home/me/page.html")).toBe("");
    expect(normalizeOrigin("chrome://extensions")).toBe("");
    expect(normalizeOrigin("not a url")).toBe("");
    expect(normalizeOrigin(undefined)).toBe("");
  });

  it("keeps the list deduped, newest first and free of junk", () => {
    let list = parseOrigins(["https://a.example", "https://a.example", "nonsense", 42]);
    expect(list).toEqual(["https://a.example"]);

    list = addOrigin(list, "https://b.example/page");
    list = addOrigin(list, "https://a.example");
    expect(list).toEqual(["https://a.example", "https://b.example"]);

    expect(originApproved("https://a.example/deep/path", list)).toBe(true);
    // A different port is a different origin, and must not inherit approval.
    expect(originApproved("https://a.example:8443", list)).toBe(false);
    expect(originApproved("", list)).toBe(false);

    expect(removeOrigin(list, "https://a.example")).toEqual(["https://b.example"]);
  });
});

describe("envelope", () => {
  it("claims only messages that are unmistakably this protocol", () => {
    expect(parseWebAgentRequest(request())?.method).toBe("describe");
    // Addressed to us explicitly is still ours.
    expect(parseWebAgentRequest(request({ extension: WEB_AGENT_EXTENSION_ID }))?.method).toBe("describe");

    for (const notOurs of [
      request({ channel: "some.other.bus" }),
      request({ v: 2 }),
      request({ dir: "response" }),
      request({ id: "" }),
      request({ method: "" }),
      // Addressed to a different extension: answering would be impersonation.
      request({ extension: "another-extension" }),
      "a string",
      null,
      ["array"],
    ]) {
      expect(parseWebAgentRequest(notOurs)).toBeNull();
    }
  });
});

describe("responder", () => {
  it("answers this document's own window and nothing else", async () => {
    const { instance, post, ask, self } = responder({ result: { ok: true } });

    await instance.handle({ source: self, origin: ORIGIN, data: request() });
    expect(post).toHaveBeenCalledTimes(1);
    const [message, target] = post.mock.calls[0]!;
    expect(message).toMatchObject({
      channel: WEB_AGENT_CHANNEL,
      v: WEB_AGENT_PROTOCOL_VERSION,
      dir: "response",
      id: "r1",
      extension: WEB_AGENT_EXTENSION_ID,
      result: { ok: true },
    });
    // Never posted to a wildcard target.
    expect(target).toBe(ORIGIN);

    post.mockClear();
    ask.mockClear();
    // A framed sender, a spoofed origin, or a message that is not ours.
    await instance.handle({ source: { other: "frame" }, origin: ORIGIN, data: request() });
    await instance.handle({ source: self, origin: "https://evil.example", data: request() });
    await instance.handle({ source: self, origin: ORIGIN, data: { hello: "world" } });
    expect(ask).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("stays completely silent when the worker refuses the origin", async () => {
    const { instance, post, ask, self } = responder({ silent: true });
    await instance.handle({ source: self, origin: ORIGIN, data: request() });
    // The request reached the worker — this is the refusal path, not the
    // sender check — and still nothing was posted: a site that was never
    // connected must not even learn the extension is installed.
    expect(ask).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("relays a refusal as an error once the worker has answered", async () => {
    const { instance, post, self } = responder({ error: "no tab is connected" });
    await instance.handle({ source: self, origin: ORIGIN, data: request() });
    expect(post.mock.calls[0]![0]).toMatchObject({ error: { message: "no tab is connected" } });
  });

  it("reports a dead service worker instead of hanging the caller", async () => {
    const self = { name: "page window" };
    const post = vi.fn();
    const onError = vi.fn();
    const instance = createWebAgentResponder({
      origin: ORIGIN,
      self,
      post,
      ask: async () => {
        throw new Error("worker gone");
      },
      onError,
    });

    await instance.handle({ source: self, origin: ORIGIN, data: request() });
    expect(onError).toHaveBeenCalled();
    expect(post.mock.calls[0]![0]).toMatchObject({ error: { message: "worker gone" } });
  });

  it("emits unsolicited events so an open tab needs no reload", () => {
    const { instance, post } = responder({ result: null });
    instance.emit("announce");
    expect(post.mock.calls[0]![0]).toMatchObject({
      channel: WEB_AGENT_CHANNEL,
      dir: "event",
      extension: WEB_AGENT_EXTENSION_ID,
      event: "announce",
    });
  });

  it("does nothing at all on a page with no usable origin", async () => {
    const { instance, post, ask, self } = responder({ result: null }, "");
    await instance.handle({ source: self, origin: "", data: request() });
    instance.emit("announce");
    expect(ask).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("descriptor", () => {
  it("explains a thin toolset instead of letting it read as broken", () => {
    const idle = webAgentDescriptor({ enabledTabs: 0, webAgentTabs: 0 });
    expect(idle).toMatchObject({ id: WEB_AGENT_EXTENSION_ID, capabilities: ["tools"] });
    // Nothing enabled at all: the fix is to open or enable a tab.
    expect(idle.notice).toContain("enable_tab");

    // The near-miss that actually happens: tabs are enabled, but pointed
    // elsewhere — at the daemon, or at a different connected site. Saying "no
    // page tools" alone would read as a fault, so the notice names the fix.
    const elsewhere = webAgentDescriptor({ enabledTabs: 2, webAgentTabs: 0 });
    expect(elsewhere.notice).toContain("popup");
    expect(elsewhere.notice).toContain("2 enabled tabs");

    // Singular reads as a sentence too, not "1 enabled tabs are".
    expect(webAgentDescriptor({ enabledTabs: 1, webAgentTabs: 0 }).notice).toContain("1 enabled tab is");

    // Something is actually being served: no notice at all.
    expect(webAgentDescriptor({ enabledTabs: 2, webAgentTabs: 1 }).notice).toBe("");
  });
});

describe("loopback client", () => {
  const server = () => {
    const mcp = new EmbeddedMcpServer({ name: "browser", version: "1", title: "Browser control" });
    mcp.registerTool(
      { name: "list_tabs", description: "List tabs", inputSchema: { type: "object", properties: {} } },
      async () => "two tabs",
    );
    mcp.registerTool({ name: "boom" }, async () => {
      throw new Error("tab is gone");
    });
    return mcp;
  };

  it("runs the real MCP handshake against the shared toolset", async () => {
    const client = new LoopbackMcpClient(server());
    const listed = await client.listTools();
    expect(toolNames(listed)).toEqual(["list_tabs", "boom"]);

    const result = (await client.callTool("list_tabs", {})) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toBe("two tabs");
  });

  it("reports a failing tool as isError rather than as text that reads like success", async () => {
    const client = new LoopbackMcpClient(server());
    const result = (await client.callTool("boom", {})) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("tab is gone");
  });

  it("rejects an unknown tool at the protocol level", async () => {
    const client = new LoopbackMcpClient(server());
    await expect(client.callTool("nope", {})).rejects.toThrow(/Tool not found/);
  });

  it("performs one handshake even when calls race", async () => {
    const mcp = server();
    const connect = vi.spyOn(mcp, "connect");
    const client = new LoopbackMcpClient(mcp);
    await Promise.all([client.listTools(), client.listTools(), client.callTool("list_tabs", {})]);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe("tab mode", () => {
  it("treats anything it does not recognise as not a mode", () => {
    expect(isTabMode(TAB_MODE_DAEMON)).toBe(true);
    expect(isTabMode(TAB_MODE_WEB_AGENT)).toBe(true);
    // A mode from a future or older build must not be honoured just because it
    // is a string: the value decides whether a tab dials a local port.
    expect(isTabMode("both")).toBe(false);
    expect(isTabMode("")).toBe(false);
    expect(isTabMode(undefined)).toBe(false);
    expect(isTabMode(1)).toBe(false);
  });

  it("round-trips through storage and drops entries it cannot trust", () => {
    const modes = parseTabModes({
      "7": webAgentRoute("https://at.example/chats"),
      "9": daemonRoute(),
      // Not a tab id, not a mode, and a web-agent route with no usable origin:
      // each would otherwise decide how a real tab behaves.
      "not-a-tab": webAgentRoute("https://at.example"),
      "11": { mode: "both", origin: "https://at.example" },
      "13": { mode: TAB_MODE_WEB_AGENT, origin: "file:///tmp/x.html" },
      "15": { mode: TAB_MODE_WEB_AGENT },
    });
    expect([...modes]).toEqual([
      [7, { mode: TAB_MODE_WEB_AGENT, origin: "https://at.example" }],
      [9, { mode: TAB_MODE_DAEMON, origin: "" }],
    ]);

    expect(parseTabModes(serializeTabModes(modes))).toEqual(modes);
    expect([...parseTabModes(undefined)]).toEqual([]);
    expect([...parseTabModes(["nope"])]).toEqual([]);
  });

  it("reads a legacy bare mode, but never silently redirects a web-agent tab", () => {
    // Earlier builds stored just the mode string. A daemon tab means the same
    // thing either way, so it upgrades cleanly.
    expect(parseTabRoute(TAB_MODE_DAEMON)).toEqual({ mode: TAB_MODE_DAEMON, origin: "" });

    // A legacy web-agent entry has no origin, and there is no safe guess: it
    // used to mean "every connected site". Dropping it leaves the tab on the
    // daemon *by absence*, which the popup shows — inventing an origin would
    // hand one agent tabs approved for another.
    expect(parseTabRoute(TAB_MODE_WEB_AGENT)).toBeNull();
    // Same for a route that names a site the browser cannot enforce.
    expect(parseTabRoute({ mode: TAB_MODE_WEB_AGENT, origin: "chrome://extensions" })).toBeNull();
  });
});
