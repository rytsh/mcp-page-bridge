/**
 * Web agents: serving tools to an agent that runs *inside a web app*, with no
 * daemon in between.
 *
 * Every other path in this extension reaches an agent through the bridge
 * daemon: the page's MCP server tunnels out over a WebSocket the service worker
 * owns, and the daemon aggregates it for a coding agent over stdio or HTTP.
 * That is the right shape when the agent is a separate program. It is pure
 * overhead when the agent is a web app the person already has open — it runs on
 * this machine, in this browser, and a page and an extension can talk directly
 * through `window.postMessage`.
 *
 * So there are two kinds of consumer now, and they do not overlap:
 *
 * - **coding agent** — external process, reaches us through the daemon.
 * - **web agent** — a web app in this browser, reaches us through this module.
 *
 * The protocol is vendor-neutral by construction: the agent broadcasts
 * `describe` and every extension implementing it answers with its own id and
 * capabilities, so this is one answer among possibly several rather than a
 * private handshake. The channel literal below is the name AT publishes for it;
 * it is a wire constant, not a statement about who may use it.
 *
 * Two rules carry the design:
 *
 * 1. **Silence is the answer for an origin the user has not connected.** An
 *    unconditional reply would turn this into a fingerprinting probe on every
 *    site the content script runs on — the same reason `content.ts` marks
 *    `<html>` only on loopback origins. Approval is per origin and is given in
 *    the popup, on the tab the person is looking at.
 * 2. **The page never reaches chrome.\* directly.** The content script only
 *    relays; every decision is made in the service worker, which is the only
 *    context that knows which origins were approved.
 *
 * No `chrome.*` and no DOM globals are referenced here — the pieces that need
 * them take them as parameters — so the whole protocol is unit-testable
 * (`web-agent.test.ts`).
 */
import { MCP_PAGE_BRIDGE_VERSION } from "mcp-page-bridge-protocol";
import type { EmbeddedMcpServer, MinimalTransport } from "./embedded-server.js";

/**
 * Channel discriminator, shared with the web agent verbatim. The literal is the
 * one AT publishes; any web app speaking this protocol uses the same value.
 */
export const WEB_AGENT_CHANNEL = "at.extension.bridge";
/** Protocol revision. A peer ignores anything that is not exactly this. */
export const WEB_AGENT_PROTOCOL_VERSION = 1;
/** Our stable id in a web agent's registry, and the key its approval uses. */
export const WEB_AGENT_EXTENSION_ID = "mcp-page-bridge";
/** The only capability we declare today. */
export const WEB_AGENT_CAPABILITY_TOOLS = "tools";

export const WEB_AGENT_METHOD_DESCRIBE = "describe";
export const WEB_AGENT_METHOD_LIST_TOOLS = "tools/list";
export const WEB_AGENT_METHOD_CALL_TOOL = "tools/call";

/** `chrome.storage.local` key holding the origins the user connected. */
export const WEB_AGENT_ORIGINS_KEY = "webAgentOrigins";

/** `chrome.storage.session` key holding the per-tab routing choice. */
export const TAB_MODE_KEY = "tabModes";

/** Upper bound on remembered per-tab routes, mirroring the origin cap. */
const MAX_ROUTES = 256;

/** Upper bound on remembered origins, so the list cannot grow without limit. */
const MAX_ORIGINS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ---- origins -----------------------------------------------------------------

/**
 * Canonical origin of a page URL, or `""` when it is not one we may serve.
 *
 * Only http/https: an approval is meaningful only for an origin the browser
 * enforces, and `file:` pages share one opaque origin, so approving one would
 * approve every local file the person ever opens.
 */
export function normalizeOrigin(raw: string | undefined | null): string {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function parseOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const origin = normalizeOrigin(typeof entry === "string" ? entry : "");
    if (origin && !out.includes(origin)) out.push(origin);
    if (out.length >= MAX_ORIGINS) break;
  }
  return out;
}

export function originApproved(origin: string, approved: string[]): boolean {
  const normalized = normalizeOrigin(origin);
  return !!normalized && approved.includes(normalized);
}

/** Newest first, deduped and capped — the list is a UI list as well as a check. */
export function addOrigin(approved: string[], origin: string): string[] {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return approved;
  return [normalized, ...approved.filter((o) => o !== normalized)].slice(0, MAX_ORIGINS);
}

export function removeOrigin(approved: string[], origin: string): string[] {
  const normalized = normalizeOrigin(origin);
  return approved.filter((o) => o !== normalized);
}

// ---- tab mode ----------------------------------------------------------------

/**
 * Who an enabled tab's page tools are served to.
 *
 * A tab hosts one MCP server and one set of uid-bearing DOM state, and the two
 * consumers drive it in ways that do not compose: the daemon expects to own the
 * `initialize` handshake on a socket it can bounce, while a web agent expects
 * synchronous in-worker calls. Serving both at once would mean two clients
 * interleaving `take_snapshot` and `click` against one uid registry, where the
 * second snapshot silently invalidates the first one's uids. So the tab picks
 * one, and the popup says which.
 *
 * `"daemon"` is the default because it is what the extension was for, and
 * because an unattended tab dialling a local port is the behaviour every
 * existing install already depends on.
 */
export type TabMode = "daemon" | "webAgent";

export const TAB_MODE_DAEMON: TabMode = "daemon";
export const TAB_MODE_WEB_AGENT: TabMode = "webAgent";

export function isTabMode(value: unknown): value is TabMode {
  return value === TAB_MODE_DAEMON || value === TAB_MODE_WEB_AGENT;
}

/**
 * Where an enabled tab's page tools go.
 *
 * Both modes name a destination, and saying so in one shape keeps them from
 * drifting into two half-explained features: a daemon tab targets a bridge
 * profile, a web-agent tab targets one connected origin. The alternative —
 * serving every connected origin at once — puts two agents on one uid registry,
 * which is the same thing the mode itself exists to prevent, one level up.
 *
 * `origin` is only meaningful for `webAgent`, and is `""` for a daemon tab. A
 * `webAgent` route whose origin has since been disconnected serves nobody,
 * which is the correct reading: the person revoked that site.
 */
export interface TabRoute {
  mode: TabMode;
  /** For `webAgent`: the single origin served. Empty for `daemon`. */
  origin: string;
}

export function daemonRoute(): TabRoute {
  return { mode: TAB_MODE_DAEMON, origin: "" };
}

export function webAgentRoute(origin: string): TabRoute {
  return { mode: TAB_MODE_WEB_AGENT, origin: normalizeOrigin(origin) };
}

/**
 * Reads one route, or `null` when it is not one we can honour.
 *
 * A `webAgent` entry without a usable origin is rejected rather than downgraded
 * to `daemon`: silently redirecting a tab to a local port is exactly the
 * surprise this whole mechanism is meant to remove.
 */
export function parseTabRoute(value: unknown): TabRoute | null {
  // Tolerated for one upgrade: earlier builds stored a bare mode string.
  if (isTabMode(value)) return value === TAB_MODE_DAEMON ? daemonRoute() : null;
  if (!isRecord(value)) return null;
  const { mode, origin } = value;
  if (!isTabMode(mode)) return null;
  if (mode === TAB_MODE_DAEMON) return daemonRoute();
  const normalized = normalizeOrigin(typeof origin === "string" ? origin : "");
  return normalized ? { mode: TAB_MODE_WEB_AGENT, origin: normalized } : null;
}

/** Reads the persisted `tabId -> route` map, dropping anything malformed. */
export function parseTabModes(value: unknown): Map<number, TabRoute> {
  const out = new Map<number, TabRoute>();
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (out.size >= MAX_ROUTES) break;
    const tabId = Number(key);
    // Only a real tab id, and only a route we still understand: a stale entry
    // from an older build must not decide how a tab behaves today.
    if (!Number.isInteger(tabId)) continue;
    const route = parseTabRoute(entry);
    if (route) out.set(tabId, route);
  }
  return out;
}

export function serializeTabModes(modes: Map<number, TabRoute>): Record<string, TabRoute> {
  const out: Record<string, TabRoute> = {};
  for (const [tabId, route] of modes) out[String(tabId)] = route;
  return out;
}

// ---- envelope ----------------------------------------------------------------

export interface WebAgentRequest {
  id: string;
  method: string;
  params: unknown;
  /** Present when the agent addressed one extension; absent on a broadcast. */
  extension: string;
}

/**
 * Reads a web-agent request, or `null` when the message is not one.
 *
 * Strict on purpose: this listener sits on every page, so anything that is not
 * unmistakably this protocol has to fall through untouched.
 */
export function parseWebAgentRequest(data: unknown): WebAgentRequest | null {
  if (!isRecord(data)) return null;
  if (data.channel !== WEB_AGENT_CHANNEL) return null;
  if (data.v !== WEB_AGENT_PROTOCOL_VERSION) return null;
  if (data.dir !== "request") return null;
  if (typeof data.id !== "string" || !data.id) return null;
  if (typeof data.method !== "string" || !data.method) return null;
  const extension = typeof data.extension === "string" ? data.extension : "";
  // An addressed request for somebody else is not ours to answer.
  if (extension && extension !== WEB_AGENT_EXTENSION_ID) return null;
  return { id: data.id, method: data.method, params: data.params, extension };
}

export function webAgentResponse(id: string, result: unknown): Record<string, unknown> {
  return {
    channel: WEB_AGENT_CHANNEL,
    v: WEB_AGENT_PROTOCOL_VERSION,
    dir: "response",
    id,
    extension: WEB_AGENT_EXTENSION_ID,
    result,
  };
}

export function webAgentErrorResponse(id: string, message: string): Record<string, unknown> {
  return {
    channel: WEB_AGENT_CHANNEL,
    v: WEB_AGENT_PROTOCOL_VERSION,
    dir: "response",
    id,
    extension: WEB_AGENT_EXTENSION_ID,
    error: { message },
  };
}

export type WebAgentEventName = "announce" | "tools_changed" | "goodbye";

export function webAgentEvent(event: WebAgentEventName): Record<string, unknown> {
  return {
    channel: WEB_AGENT_CHANNEL,
    v: WEB_AGENT_PROTOCOL_VERSION,
    dir: "event",
    extension: WEB_AGENT_EXTENSION_ID,
    event,
  };
}

// ---- descriptor --------------------------------------------------------------

export interface DescriptorInput {
  /** Tabs enabled at all, whatever they are pointed at. */
  enabledTabs: number;
  /** Of those, the ones pointed at *this* agent. */
  webAgentTabs: number;
}

/**
 * What the web agent lists in its extension picker.
 *
 * `notice` is rendered verbatim and exists so a connected extension that is
 * offering little does not read as broken. The browser toolset is always here;
 * page tools depend on a tab having been pointed at this agent specifically,
 * and the three cases below are genuinely different problems, so they get
 * different sentences instead of one hedge covering all of them.
 */
export function webAgentDescriptor(input: DescriptorInput): Record<string, unknown> {
  const notice = (): string => {
    if (input.webAgentTabs > 0) return "";
    if (input.enabledTabs > 0) {
      // The usual near-miss: tabs are enabled, but pointed elsewhere — at the
      // daemon, or at another connected site. Naming the fix is the whole value
      // of the message, and it is the same fix either way.
      return `Page tools are unavailable: ${input.enabledTabs} enabled ${
        input.enabledTabs === 1 ? "tab is" : "tabs are"
      } serving something else. In the extension popup, set a tab to serve this site.`;
    }
    return "No tab is enabled. Use open_tab or enable_tab, or enable one from the extension popup with this site chosen, to get its page tools.";
  };

  return {
    id: WEB_AGENT_EXTENSION_ID,
    name: "MCP Page Bridge",
    version: MCP_PAGE_BRIDGE_VERSION,
    capabilities: [WEB_AGENT_CAPABILITY_TOOLS],
    description:
      "Browser control: list, open, activate, navigate and close tabs. Tabs set to serve this web agent also expose their page tools (snapshot, click, type).",
    notice: notice(),
  };
}

// ---- content-script side -----------------------------------------------------

/** What the service worker answers a relayed request with. */
export type WebAgentBackendReply =
  | { silent: true }
  | { result: unknown }
  | { error: string };

export interface WebAgentResponderOptions {
  /** This document's origin; both the accept check and the post target. */
  origin: string;
  /** The window whose messages are accepted — this document's own. */
  self: unknown;
  post(message: unknown, targetOrigin: string): void;
  /** Relay to the service worker, which owns every decision. */
  ask(request: WebAgentRequest, origin: string): Promise<WebAgentBackendReply>;
  onError?(error: unknown): void;
}

export interface WebAgentResponder {
  /** Feed one `message` event. Resolves once any reply has been posted. */
  handle(event: { source?: unknown; origin?: string; data?: unknown }): Promise<void>;
  /** Push an unsolicited event into the page (connect / disconnect / changes). */
  emit(event: WebAgentEventName): void;
}

export function createWebAgentResponder(options: WebAgentResponderOptions): WebAgentResponder {
  const { origin, post } = options;

  return {
    async handle(event) {
      // The page's own window, and this document's origin. A framed or forged
      // sender is refused here as well as in the agent, because neither side
      // can see what the other checked.
      if (!origin) return;
      if (event.source !== options.self) return;
      if (event.origin !== origin) return;
      const request = parseWebAgentRequest(event.data);
      if (!request) return;

      let reply: WebAgentBackendReply;
      try {
        reply = await options.ask(request, origin);
      } catch (error) {
        options.onError?.(error);
        // The worker being unreachable is not information the page is entitled
        // to on an unapproved origin, and on an approved one an error beats a
        // hang — so this is only reported once the worker itself said yes.
        reply = { error: (error as Error)?.message || "the extension is unavailable" };
      }

      if ("silent" in reply) return;
      if ("error" in reply) {
        post(webAgentErrorResponse(request.id, reply.error), origin);
        return;
      }
      post(webAgentResponse(request.id, reply.result), origin);
    },

    emit(event) {
      if (!origin) return;
      post(webAgentEvent(event), origin);
    },
  };
}

// ---- service-worker side -----------------------------------------------------

/**
 * Drives an `EmbeddedMcpServer` in-process.
 *
 * This path has no socket, but the toolset it serves is the same one the daemon
 * sees, so it is reached the same way rather than through a second, parallel
 * registry that could drift: one loopback transport, the real `initialize` /
 * `tools/list` / `tools/call` handshake, and the server's own error semantics
 * (a throwing tool answers `isError`, which the agent surfaces as a tool error
 * rather than as text that reads like success).
 */
export class LoopbackMcpClient {
  private readonly transport: MinimalTransport;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 1;
  private starting?: Promise<void>;

  constructor(private readonly server: EmbeddedMcpServer) {
    this.transport = {
      send: (message) => {
        const reply = message as { id?: number; result?: unknown; error?: { message?: string } };
        if (reply?.id === undefined || reply.id === null) return; // a notification
        const entry = this.pending.get(reply.id);
        if (!entry) return;
        this.pending.delete(reply.id);
        if (reply.error) entry.reject(new Error(reply.error.message || "MCP error"));
        else entry.resolve(reply.result);
      },
    };
  }

  /** Idempotent, and safe to race: concurrent calls share one handshake. */
  start(): Promise<void> {
    if (!this.starting) {
      this.starting = (async () => {
        await this.server.connect(this.transport);
        await this.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "web-agent", version: MCP_PAGE_BRIDGE_VERSION },
        });
        this.notify("notifications/initialized");
      })().catch((error) => {
        // A failed handshake must not leave a permanently poisoned client.
        this.starting = undefined;
        throw error;
      });
    }
    return this.starting;
  }

  async listTools(): Promise<unknown> {
    await this.start();
    return this.request("tools/list", {});
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.start();
    return this.request("tools/call", { name, arguments: args ?? {} });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Everything except a tool call answers synchronously, so there is no
      // timer here: a hanging tool is bounded by the agent's own per-call
      // deadline, which is the one the user can actually see.
      this.transport.onmessage?.({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string): void {
    this.transport.onmessage?.({ jsonrpc: "2.0", method });
  }
}

/**
 * Names the tools an MCP `tools/list` result carries, for the popup's summary.
 * Tolerant because it is display only.
 */
export function toolNames(listResult: unknown): string[] {
  if (!isRecord(listResult) || !Array.isArray(listResult.tools)) return [];
  return listResult.tools
    .map((tool) => (isRecord(tool) && typeof tool.name === "string" ? tool.name : ""))
    .filter(Boolean);
}
