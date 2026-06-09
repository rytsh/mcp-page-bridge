// Package protocol holds shared constants and helpers mirrored from the
// TypeScript package `mcp-page-bridge-protocol`. Keep the two in sync.
package protocol

import (
	"regexp"
	"strings"
)

// Version is the bridge version reported in MCP handshakes and /api/health.
// Overridden at build time via:
//
//	-ldflags "-X github.com/rytsh/mcp-page-bridge/internal/protocol.Version=v0.1.8"
var Version = "0.2.1"

const (
	// WSSubprotocol is negotiated between the browser client and the bridge.
	WSSubprotocol = "mcp"

	// DefaultPort the bridge listens on for browser WebSocket connections.
	DefaultPort = 8787

	// NamespaceSep separates a provider label from the original tool name.
	NamespaceSep = "__"

	// DashboardHeader is sent by the local dashboard on state-changing HTTP
	// requests. Cross-origin pages cannot set custom headers without a CORS
	// preflight, so this (combined with Host/Origin validation) keeps the JSON
	// API local-only.
	DashboardHeader      = "x-mcp-page-bridge-dashboard"
	DashboardHeaderValue = "1"

	// TokenHeader carries the shared token on HTTP API requests when set.
	TokenHeader = "x-mcp-page-bridge-token"

	// ServiceID is the stable identifier returned by /api/health and
	// /api/providers so clients can verify a real bridge owns the port.
	ServiceID = "mcp-page-bridge"

	// Bridge -> extension private JSON-RPC methods used by the local dashboard.
	MethodDashboardActivateTab = "mcpPageBridge/activateTab"
	MethodDashboardCloseTab    = "mcpPageBridge/closeTab"
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

// NamespaceName builds the agent-facing namespaced tool name.
func NamespaceName(label, name string) string {
	return label + NamespaceSep + name
}
