// Package protocol holds shared constants and helpers mirrored from the
// TypeScript package `mcp-page-bridge-protocol`. Keep the two in sync.
package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Version is the bridge version reported in MCP handshakes and /api/health.
// Overridden at build time via:
//
//	-ldflags "-X github.com/rytsh/mcp-page-bridge/internal/protocol.Version=v0.3.1"
var Version = "0.3.1"

const (
	// WSSubprotocol is negotiated between the browser client and the bridge.
	WSSubprotocol = "mcp"

	// DefaultPort the bridge listens on for browser WebSocket connections.
	DefaultPort = 8787

	// NamespaceSep separates a provider label from the original tool name.
	NamespaceSep = "__"

	// MaxToolNameLen bounds the agent-facing namespaced name. The MCP schema
	// itself sets no limit, but WebMCP allows 128-character tool names and many
	// agent hosts (and the function-calling layers behind them) reject anything
	// over 64. Clamping here is better than letting a host silently drop the
	// tool — or reject the whole catalog.
	MaxToolNameLen = 64

	// DashboardHeader is sent by the local dashboard on state-changing HTTP
	// requests. Cross-origin pages cannot set custom headers without a CORS
	// preflight, so this (combined with Host/Origin validation) keeps the JSON
	// API local-only.
	DashboardHeader      = "x-mcp-page-bridge-dashboard"
	DashboardHeaderValue = "1"

	// TokenHeader carries the shared token on HTTP API requests when set.
	TokenHeader = "x-mcp-page-bridge-token"

	// ProfileQueryParam carries the (already hashed) profile partition key on
	// WebSocket connects and dashboard/API requests.
	ProfileQueryParam = "profile"

	// ProfileHeader carries the (already hashed) profile partition key on
	// Streamable HTTP (/mcp) requests for clients that connect by URL.
	ProfileHeader = "x-mcp-page-bridge-profile"

	// ProfileHashPrefix is the domain-separation prefix mixed into the profile
	// secret before hashing. It keeps the resulting digest from matching a bare
	// SHA-256 of the same password (e.g. a leaked hash database). The extension
	// (Web Crypto) and the stdio proxy MUST compute the identical value.
	ProfileHashPrefix = "mcp-page-bridge:profile:v1:"

	// ServiceID is the stable identifier returned by /api/health and
	// /api/providers so clients can verify a real bridge owns the port.
	ServiceID = "mcp-page-bridge"

	// Bridge -> extension private JSON-RPC methods used by the local dashboard.
	MethodDashboardActivateTab = "mcpPageBridge/activateTab"
	MethodDashboardCloseTab    = "mcpPageBridge/closeTab"

	// MethodReadFile is the extension -> bridge private JSON-RPC method behind
	// `upload_file {path}`: the extension has no filesystem access, the daemon
	// runs next to the agent. Only served when --upload-dir is configured.
	MethodReadFile = "mcpPageBridge/readFile"

	// MaxUploadFileBytes caps a single upload_file read. Large enough for the
	// documents and fixtures an agent realistically attaches, small enough that
	// one call cannot exhaust memory (the payload is base64'd in RAM).
	MaxUploadFileBytes = 32 << 20 // 32 MiB
)

var (
	reWhitespaceDots = regexp.MustCompile(`[\s.]+`)
	reDisallowed     = regexp.MustCompile(`[^a-zA-Z0-9_-]`)
	reHyphenRuns     = regexp.MustCompile(`-{2,}`)
	reEdgeTrim       = regexp.MustCompile(`^[-_]+|[-_]+$`)
)

// SanitizeLabel turns an arbitrary provider/server name into a tool-name-safe
// label: lowercase, spaces/dots -> hyphen, strip disallowed chars, clamp length.
func SanitizeLabel(input string) string {
	base := strings.ToLower(strings.TrimSpace(input))
	base = reWhitespaceDots.ReplaceAllString(base, "-")
	base = reDisallowed.ReplaceAllString(base, "")
	base = reHyphenRuns.ReplaceAllString(base, "-")
	base = reEdgeTrim.ReplaceAllString(base, "")
	if len(base) > 40 {
		base = base[:40]
	}
	if base == "" {
		return "browser"
	}
	return base
}

// NamespaceName builds the agent-facing namespaced tool name, clamped to
// MaxToolNameLen.
//
// Clamping is deterministic — the same label+name always yields the same result
// — so the agent's view stays stable across reconnects, and the bridge's routing
// table (built with this same function) never drifts from the catalog it
// advertises. The digest suffix keeps two long names that share a prefix from
// collapsing onto one.
func NamespaceName(label, name string) string {
	full := label + NamespaceSep + name
	if len(full) <= MaxToolNameLen {
		return full
	}

	suffix := "-" + fmt.Sprintf("%08x", fnv1a32(full))[:6]
	keep := MaxToolNameLen - len(suffix)
	if keep < 1 {
		return suffix[1:]
	}
	head := full[:keep]
	// A provider outside the extension can send non-ASCII names; never cut a
	// multi-byte rune in half.
	for len(head) > 0 && !utf8.ValidString(head) {
		head = head[:len(head)-1]
	}
	return head + suffix
}

// fnv1a32 is FNV-1a over the UTF-8 bytes of s. It is not cryptographic — it only
// has to make accidental collisions unlikely — and is deliberately simple enough
// to reimplement identically in TypeScript (see packages/protocol namespaceName).
func fnv1a32(s string) uint32 {
	h := uint32(2166136261)
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619
	}
	return h
}

// HashProfile derives the opaque partition key from a profile secret. Clients
// send the raw secret on connect (like the token); the daemon calls this to
// hash it into the partition key used for grouping/routing. An empty secret
// yields an empty key (the default, unpartitioned bridge).
func HashProfile(secret string) string {
	if secret == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(ProfileHashPrefix + secret))
	return hex.EncodeToString(sum[:])
}
