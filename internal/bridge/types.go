package bridge

import (
	"encoding/json"
	"time"

	"github.com/rytsh/mcp-page-bridge/internal/mcpwire"
)

// rawObj is a JSON object whose unknown fields must survive passthrough.
type rawObj = map[string]json.RawMessage

// objString extracts a string field from a raw object ("" when absent).
func objString(o rawObj, key string) string {
	raw, ok := o[key]
	if !ok {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}

// setString sets a string field on a raw object.
func setString(o rawObj, key, value string) {
	data, _ := json.Marshal(value)
	o[key] = data
}

// cloneObj shallow-copies a raw object so per-agent rewrites don't mutate the
// provider's stored catalog.
func cloneObj(o rawObj) rawObj {
	out := make(rawObj, len(o))
	for k, v := range o {
		out[k] = v
	}
	return out
}

// Meta is the page metadata a provider advertises.
type Meta struct {
	URL        string
	Title      string
	TabID      *int
	ProviderID string
}

// capability flags parsed from the provider's initialize result.
type capabilities struct {
	tools                bool
	toolsListChanged     bool
	prompts              bool
	promptsListChanged   bool
	resources            bool
	resourcesListChanged bool
	logging              bool
}

// Provider is a connected browser MCP server (one per WebSocket connection).
type Provider struct {
	id          string
	label       string
	rawName     string
	version     string
	peer        *mcpwire.Peer
	caps        capabilities
	meta        Meta
	connectedAt time.Time

	// catalogs (guarded by Bridge.mu)
	tools     []rawObj
	prompts   []rawObj
	resources []rawObj
}

type nameRoute struct {
	providerID   string
	originalName string
}
