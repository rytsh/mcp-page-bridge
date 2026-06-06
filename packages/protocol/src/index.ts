/**
 * Shared constants and helpers used by both the mcp-page-bridge bridge (Node) and the
 * browser-side client (extension). Keep this dependency-free so it can be
 * bundled into a service worker / content script as well as Node.
 */

export const MCP_PAGE_BRIDGE_VERSION = "0.1.3";

/** WebSocket subprotocol negotiated between the browser client and the bridge. */
export const WS_SUBPROTOCOL = "mcp";

/** Default port the bridge listens on for browser WebSocket connections. */
export const DEFAULT_PORT = 8787;

/** Separator between a provider label and the original tool name. */
export const NAMESPACE_SEP = "__";

/** Allowed characters in an MCP tool name component. */
const DISALLOWED = /[^a-zA-Z0-9_-]/g;

/**
 * Turn an arbitrary provider/server name into a tool-name-safe label.
 * Lowercase, spaces/dots -> hyphen, strip disallowed chars, clamp length.
 */
export function sanitizeLabel(input: string | undefined | null): string {
  const base = (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, "-")
    .replace(DISALLOWED, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40);
  return base || "browser";
}

/** Build the agent-facing namespaced tool name. */
export function namespaceName(label: string, name: string): string {
  return `${label}${NAMESPACE_SEP}${name}`;
}

/** Metadata a provider can advertise about the page it lives in. */
export interface ProviderMeta {
  url?: string;
  title?: string;
  userAgent?: string;
  /** Browser tab id, when the provider is owned by an extension content tab. */
  tabId?: number;
  /** Extension-internal provider id for that tab. */
  providerId?: string;
}

/** Bridge -> extension private JSON-RPC methods used by the local dashboard. */
export const MCP_PAGE_BRIDGE_DASHBOARD_ACTIVATE_TAB = "mcpPageBridge/activateTab" as const;
export const MCP_PAGE_BRIDGE_DASHBOARD_CLOSE_TAB = "mcpPageBridge/closeTab" as const;

/** Direction of an internal channel message relative to the bridge. */
export type ChannelDir = "up" | "down";

/**
 * Internal envelope used on the extension's own channel:
 *   page (MAIN) <-> content script (ISOLATED) <-> service worker.
 *
 * This is NOT the wire to the bridge (that is raw MCP JSON-RPC). The SW
 * terminates this envelope and forwards `payload` (a JSON-RPC message) onto the
 * per-provider WebSocket. `providerId` lets a single tab host several providers
 * (e.g. built-ins + a page MCP). `providerId === "*"` denotes a control/global
 * message not tied to a specific provider.
 *
 * `dir` prevents postMessage echo loops since MAIN and ISOLATED scripts share
 * the same `window` and both observe every `message` event.
 */
export interface ChannelMessage {
  /** Magic marker so we can ignore unrelated postMessage traffic. */
  __mcpPageBridge: true;
  dir: ChannelDir;
  providerId: string;
  kind: "rpc" | "open" | "close" | "control" | "ext";
  /**
   * - kind "rpc":     a JSON-RPC message object
   * - kind "open":    `{ url, title }` source metadata (for the popup)
   * - kind "control": `{ action: ControlAction, ... }`
   * - kind "ext":     up = `ExtCallPayload`, down = `ExtResultPayload`
   */
  payload?: unknown;
}

/** Request from the page (MAIN) to the SW to run an extension-only action. */
export interface ExtCallPayload {
  id: number;
  action: string;
  args?: Record<string, unknown>;
}

/** Response from the SW back to the page for an ExtCallPayload. */
export interface ExtResultPayload {
  id: number;
  result?: unknown;
  error?: string;
}

export type ControlAction =
  | "hello"
  | "activate"
  | "deactivate"
  | "startElementPicker"
  | "cancelElementPicker"
  | "clearSelectedElements"
  | "removeSelectedElement"
  | "setSelectedElementMeta"
  | "setSelectedMarkersVisible";

export interface ControlPayload {
  action: ControlAction;
  url?: string;
  title?: string;
  append?: boolean;
  selectionId?: string;
  name?: string;
  group?: string;
  visible?: boolean;
}

export const MCP_PAGE_BRIDGE_MARK = "__mcpPageBridge" as const;
