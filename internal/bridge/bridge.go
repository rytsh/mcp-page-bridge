// Package bridge implements the MCP aggregating proxy: it accepts browser
// providers and agent sessions over WebSocket and routes JSON-RPC between
// them, namespacing tool/prompt names per provider label.
package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/rytsh/mcp-page-bridge/internal/mcpwire"
	"github.com/rytsh/mcp-page-bridge/internal/protocol"
)

const (
	metaListClients = "mcp_page_bridge_list_clients"

	dashboardActionTimeout = 5 * time.Second

	// readLimit allows large tool results (e.g. base64 screenshots).
	readLimit = 64 << 20
)

// latestProtocolVersion is what the bridge offers/falls back to.
const latestProtocolVersion = "2025-06-18"

var supportedProtocolVersions = map[string]bool{
	"2024-11-05": true,
	"2025-03-26": true,
	"2025-06-18": true,
}

// Options configures a Bridge.
type Options struct {
	// Token, when set, must accompany WebSocket connects (?token=) and the
	// token-gated HTTP endpoints.
	Token string
	// IdleTimeout > 0 shuts the bridge down after that duration with no
	// connected providers AND no agent connections.
	IdleTimeout time.Duration
	// OnIdleShutdown is invoked after an idle-triggered shutdown completes.
	OnIdleShutdown func()
	Logger         *slog.Logger
}

// Bridge aggregates browser MCP providers for one or more agent sessions.
type Bridge struct {
	opts   Options
	logger *slog.Logger

	mu               sync.Mutex
	providers        map[string]*Provider
	agents           map[*agentSession]struct{}
	labels           *labelStore
	toolRoutes       map[string]nameRoute
	promptRoutes     map[string]nameRoute
	resourceRoutes   map[string]string // uri -> providerId (first wins)
	agentConnections int
	idleTimer        *time.Timer
	closed           bool
}

type agentSession struct {
	peer        *mcpwire.Peer
	initialized bool
}

// New creates a Bridge. It owns no listener; the HTTP server hands accepted
// WebSocket upgrade requests to HandleWS.
func New(opts Options) *Bridge {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	b := &Bridge{
		opts:           opts,
		logger:         logger,
		providers:      map[string]*Provider{},
		agents:         map[*agentSession]struct{}{},
		labels:         newLabelStore(),
		toolRoutes:     map[string]nameRoute{},
		promptRoutes:   map[string]nameRoute{},
		resourceRoutes: map[string]string{},
	}
	// Arm idle auto-shutdown immediately: a daemon that never sees a
	// connection still tears itself down after the timeout.
	b.mu.Lock()
	b.checkIdleLocked()
	b.mu.Unlock()
	return b
}

// ---- idle shutdown ----------------------------------------------------------

// checkIdleLocked arms/disarms the idle timer; call with b.mu held.
func (b *Bridge) checkIdleLocked() {
	if b.opts.IdleTimeout <= 0 || b.closed {
		return
	}
	idle := len(b.providers) == 0 && b.agentConnections == 0
	if idle {
		if b.idleTimer != nil {
			return
		}
		b.idleTimer = time.AfterFunc(b.opts.IdleTimeout, func() {
			b.Close()
			if b.opts.OnIdleShutdown != nil {
				b.opts.OnIdleShutdown()
			}
		})
		return
	}
	if b.idleTimer != nil {
		b.idleTimer.Stop()
		b.idleTimer = nil
	}
}

// ---- WebSocket entry --------------------------------------------------------

// HandleWS upgrades an HTTP request and attaches it as an agent session
// (path /agent) or a browser provider (any other path), mirroring the
// TypeScript bridge.
func (b *Bridge) HandleWS(w http.ResponseWriter, r *http.Request) {
	if b.opts.Token != "" && r.URL.Query().Get("token") != b.opts.Token {
		http.Error(w, "missing or invalid token", http.StatusUnauthorized)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{protocol.WSSubprotocol},
		// The token (when set) is the gate; browser extension service workers
		// connect with an extension origin, so origin checking is disabled
		// exactly like the TS bridge.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	if conn.Subprotocol() != protocol.WSSubprotocol {
		// The TS bridge rejects clients that do not negotiate the "mcp"
		// subprotocol.
		_ = conn.Close(websocket.StatusPolicyViolation, "mcp subprotocol required")
		return
	}
	conn.SetReadLimit(readLimit)

	if r.URL.Path == "/agent" {
		b.attachAgent(conn)
		return
	}
	go b.attachProvider(conn, r.URL)
}

// ---- agent sessions ---------------------------------------------------------

func (b *Bridge) attachAgent(conn *websocket.Conn) {
	peer := mcpwire.NewPeer(conn, b.logger)
	session := &agentSession{peer: peer}

	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		_ = peer.Close()
		return
	}
	b.agents[session] = struct{}{}
	b.agentConnections++
	b.checkIdleLocked()
	b.mu.Unlock()

	peer.OnRequest(func(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, *mcpwire.RPCError) {
		return b.handleAgentRequest(ctx, session, method, params)
	})
	peer.OnClose(func() {
		b.mu.Lock()
		if _, ok := b.agents[session]; ok {
			delete(b.agents, session)
			b.agentConnections--
			b.checkIdleLocked()
		}
		b.mu.Unlock()
	})
	peer.Start()
}

func (b *Bridge) handleAgentRequest(ctx context.Context, session *agentSession, method string, params json.RawMessage) (json.RawMessage, *mcpwire.RPCError) {
	switch method {
	case "initialize":
		session.initialized = true
		return b.initializeResult(params), nil
	case "tools/list":
		return marshalResult(map[string]any{"tools": b.exposedTools()})
	case "tools/call":
		return b.callTool(ctx, params)
	case "prompts/list":
		return marshalResult(map[string]any{"prompts": b.exposedPrompts()})
	case "prompts/get":
		return b.getPrompt(ctx, params)
	case "resources/list":
		return marshalResult(map[string]any{"resources": b.exposedResources()})
	case "resources/read":
		return b.readResource(ctx, params)
	default:
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeMethodNotFound, Message: fmt.Sprintf("method not found: %s", method)}
	}
}

func (b *Bridge) initializeResult(params json.RawMessage) json.RawMessage {
	requested := ""
	var init struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if err := json.Unmarshal(params, &init); err == nil {
		requested = init.ProtocolVersion
	}
	version := latestProtocolVersion
	if supportedProtocolVersions[requested] {
		version = requested
	}
	result, _ := json.Marshal(map[string]any{
		"protocolVersion": version,
		"capabilities": map[string]any{
			"tools":     map[string]any{"listChanged": true},
			"prompts":   map[string]any{"listChanged": true},
			"resources": map[string]any{"listChanged": true},
			"logging":   map[string]any{},
		},
		"serverInfo": map[string]any{
			"name":    protocol.ServiceID,
			"version": protocol.Version,
		},
	})
	return result
}

func marshalResult(v any) (json.RawMessage, *mcpwire.RPCError) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeInternalError, Message: err.Error()}
	}
	return data, nil
}

// ---- agent-facing catalogs (b.mu) ------------------------------------------

func metaTools() []rawObj {
	schema, _ := json.Marshal(map[string]any{
		"type":                 "object",
		"properties":           map[string]any{},
		"additionalProperties": false,
	})
	tool := rawObj{"inputSchema": schema}
	setString(tool, "name", metaListClients)
	setString(tool, "description",
		"List browser MCP providers connected to mcp-page-bridge (label, source page, tool/prompt/resource counts).")
	return []rawObj{tool}
}

// providerContext renders "label · title-or-host" for descriptions.
func providerContext(p *Provider) string {
	ctx := p.label
	if p.meta.Title != "" {
		return ctx + " · " + p.meta.Title
	}
	if p.meta.URL != "" {
		if u, err := url.Parse(p.meta.URL); err == nil && u.Host != "" {
			return ctx + " · " + u.Host
		}
	}
	return ctx
}

func (b *Bridge) exposedTools() []rawObj {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := metaTools()
	for _, p := range b.providers {
		ctx := providerContext(p)
		for _, t := range p.tools {
			name := objString(t, "name")
			title := objString(t, "title")
			if title == "" {
				title = name
			}
			desc := objString(t, "description")
			if desc == "" {
				desc = name
			}
			clone := cloneObj(t)
			setString(clone, "name", protocol.NamespaceName(p.label, name))
			setString(clone, "title", p.label+": "+title)
			setString(clone, "description", "["+ctx+"] "+desc)
			out = append(out, clone)
		}
	}
	return out
}

func (b *Bridge) exposedPrompts() []rawObj {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := []rawObj{}
	for _, p := range b.providers {
		ctx := providerContext(p)
		for _, pr := range p.prompts {
			name := objString(pr, "name")
			desc := objString(pr, "description")
			if desc == "" {
				desc = name
			}
			clone := cloneObj(pr)
			setString(clone, "name", protocol.NamespaceName(p.label, name))
			setString(clone, "description", "["+ctx+"] "+desc)
			out = append(out, clone)
		}
	}
	return out
}

func (b *Bridge) exposedResources() []rawObj {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := []rawObj{}
	seen := map[string]bool{}
	for _, p := range b.providers {
		for _, r := range p.resources {
			uri := objString(r, "uri")
			if seen[uri] {
				continue // dedupe across providers (first wins)
			}
			seen[uri] = true
			clone := cloneObj(r)
			if name := objString(r, "name"); name != "" {
				setString(clone, "name", "["+p.label+"] "+name)
			} else {
				setString(clone, "name", uri)
			}
			out = append(out, clone)
		}
	}
	return out
}

// ---- agent request forwarding ------------------------------------------------

func (b *Bridge) callTool(ctx context.Context, params json.RawMessage) (json.RawMessage, *mcpwire.RPCError) {
	var req struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeInternalError, Message: fmt.Sprintf("invalid tools/call params: %v", err)}
	}

	if req.Name == metaListClients {
		summary, _ := json.MarshalIndent(b.ProviderSummary(), "", "  ")
		return marshalResult(map[string]any{
			"content": []map[string]any{{"type": "text", "text": string(summary)}},
		})
	}

	b.mu.Lock()
	route, ok := b.toolRoutes[req.Name]
	provider := b.providers[route.providerID]
	b.mu.Unlock()
	if !ok || provider == nil {
		return toolError(fmt.Sprintf("Unknown or disconnected tool: %s", req.Name))
	}

	args := req.Arguments
	if args == nil {
		args = mcpwire.EmptyResult
	}
	forward := map[string]any{"name": route.originalName, "arguments": args}
	result, err := provider.peer.Call(ctx, "tools/call", forward, 0)
	if err != nil {
		return toolError(fmt.Sprintf("Tool call failed: %v", err))
	}
	return result, nil
}

func toolError(text string) (json.RawMessage, *mcpwire.RPCError) {
	return marshalResult(map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
		"isError": true,
	})
}

func (b *Bridge) getPrompt(ctx context.Context, params json.RawMessage) (json.RawMessage, *mcpwire.RPCError) {
	var req struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeInternalError, Message: fmt.Sprintf("invalid prompts/get params: %v", err)}
	}

	b.mu.Lock()
	route, ok := b.promptRoutes[req.Name]
	provider := b.providers[route.providerID]
	b.mu.Unlock()
	if !ok || provider == nil {
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeInternalError, Message: fmt.Sprintf("Unknown or disconnected prompt: %s", req.Name)}
	}

	forward := map[string]any{"name": route.originalName}
	if req.Arguments != nil {
		forward["arguments"] = req.Arguments
	}
	result, err := provider.peer.Call(ctx, "prompts/get", forward, 0)
	if err != nil {
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeInternalError, Message: err.Error()}
	}
	return result, nil
}

func (b *Bridge) readResource(ctx context.Context, params json.RawMessage) (json.RawMessage, *mcpwire.RPCError) {
	var req struct {
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeInternalError, Message: fmt.Sprintf("invalid resources/read params: %v", err)}
	}

	b.mu.Lock()
	providerID, ok := b.resourceRoutes[req.URI]
	provider := b.providers[providerID]
	b.mu.Unlock()
	if !ok || provider == nil {
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeInternalError, Message: fmt.Sprintf("Unknown or disconnected resource: %s", req.URI)}
	}

	result, err := provider.peer.Call(ctx, "resources/read", map[string]any{"uri": req.URI}, 0)
	if err != nil {
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeInternalError, Message: err.Error()}
	}
	return result, nil
}

// ---- routing tables -----------------------------------------------------------

// rebuildRoutesLocked rebuilds the name routing tables; call with b.mu held.
func (b *Bridge) rebuildRoutesLocked() {
	b.toolRoutes = map[string]nameRoute{}
	b.promptRoutes = map[string]nameRoute{}
	b.resourceRoutes = map[string]string{}
	for _, p := range b.providers {
		for _, t := range p.tools {
			name := objString(t, "name")
			b.toolRoutes[protocol.NamespaceName(p.label, name)] = nameRoute{providerID: p.id, originalName: name}
		}
		for _, pr := range p.prompts {
			name := objString(pr, "name")
			b.promptRoutes[protocol.NamespaceName(p.label, name)] = nameRoute{providerID: p.id, originalName: name}
		}
		for _, r := range p.resources {
			uri := objString(r, "uri")
			if _, exists := b.resourceRoutes[uri]; !exists {
				b.resourceRoutes[uri] = p.id
			}
		}
	}
}

var listChangedMethods = map[string]string{
	"tools":     "notifications/tools/list_changed",
	"prompts":   "notifications/prompts/list_changed",
	"resources": "notifications/resources/list_changed",
}

func (b *Bridge) notifyChanged(kind string) {
	b.mu.Lock()
	b.rebuildRoutesLocked()
	agents := make([]*agentSession, 0, len(b.agents))
	for a := range b.agents {
		agents = append(agents, a)
	}
	b.mu.Unlock()

	method := listChangedMethods[kind]
	for _, a := range agents {
		go func(a *agentSession) {
			_ = a.peer.Notify(method, nil)
		}(a)
	}
}

// ---- provider sessions ----------------------------------------------------------

func parseRequestMeta(u *url.URL) (tabID *int, providerID string) {
	q := u.Query()
	if raw := q.Get("tabId"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			tabID = &n
		}
	}
	return tabID, q.Get("providerId")
}

func (b *Bridge) attachProvider(conn *websocket.Conn, reqURL *url.URL) {
	peer := mcpwire.NewPeer(conn, b.logger)
	peer.Start()

	// MCP initialize handshake (bridge acts as the client).
	initParams := map[string]any{
		"protocolVersion": latestProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": protocol.ServiceID, "version": protocol.Version},
	}
	initRaw, err := peer.Call(context.Background(), "initialize", initParams, 0)
	if err != nil {
		_ = peer.Close()
		return
	}
	var init struct {
		ServerInfo struct {
			Name       string `json:"name"`
			Version    string `json:"version"`
			Title      string `json:"title"`
			WebsiteURL string `json:"websiteUrl"`
		} `json:"serverInfo"`
		Capabilities struct {
			Tools *struct {
				ListChanged bool `json:"listChanged"`
			} `json:"tools"`
			Prompts *struct {
				ListChanged bool `json:"listChanged"`
			} `json:"prompts"`
			Resources *struct {
				ListChanged bool `json:"listChanged"`
			} `json:"resources"`
			Logging *struct{} `json:"logging"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(initRaw, &init); err != nil {
		_ = peer.Close()
		return
	}
	_ = peer.Notify("notifications/initialized", nil)

	rawName := init.ServerInfo.Name
	if rawName == "" {
		rawName = "browser"
	}
	version := init.ServerInfo.Version
	if version == "" {
		version = "0.0.0"
	}
	tabID, providerID := parseRequestMeta(reqURL)
	meta := Meta{
		URL:        init.ServerInfo.WebsiteURL,
		Title:      init.ServerInfo.Title,
		TabID:      tabID,
		ProviderID: providerID,
	}

	provider := &Provider{
		id:          uuid.NewString(),
		rawName:     rawName,
		version:     version,
		peer:        peer,
		meta:        meta,
		connectedAt: time.Now(),
		caps: capabilities{
			tools:                init.Capabilities.Tools != nil,
			toolsListChanged:     init.Capabilities.Tools != nil && init.Capabilities.Tools.ListChanged,
			prompts:              init.Capabilities.Prompts != nil,
			promptsListChanged:   init.Capabilities.Prompts != nil && init.Capabilities.Prompts.ListChanged,
			resources:            init.Capabilities.Resources != nil,
			resourcesListChanged: init.Capabilities.Resources != nil && init.Capabilities.Resources.ListChanged,
			logging:              init.Capabilities.Logging != nil,
		},
	}

	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		_ = peer.Close()
		return
	}
	provider.label = b.assignLabel(rawName, meta)
	b.providers[provider.id] = provider
	b.checkIdleLocked()
	b.mu.Unlock()

	peer.OnNotification(func(method string, params json.RawMessage) {
		switch method {
		case "notifications/tools/list_changed":
			if provider.caps.toolsListChanged {
				go b.refreshTools(provider)
			}
		case "notifications/prompts/list_changed":
			if provider.caps.promptsListChanged {
				go b.refreshPrompts(provider)
			}
		case "notifications/resources/list_changed":
			if provider.caps.resourcesListChanged {
				go b.refreshResources(provider)
			}
		case "notifications/message":
			if provider.caps.logging {
				b.forwardLogging(provider, params)
			}
		}
	})
	peer.OnClose(func() {
		b.mu.Lock()
		_, existed := b.providers[provider.id]
		delete(b.providers, provider.id)
		if existed {
			b.rebuildRoutesLocked()
			b.checkIdleLocked()
		}
		b.mu.Unlock()
		if existed {
			b.notifyChanged("tools")
			b.notifyChanged("prompts")
			b.notifyChanged("resources")
		}
	})

	b.refreshTools(provider)
	b.refreshPrompts(provider)
	b.refreshResources(provider)
}

func (b *Bridge) refreshTools(p *Provider) {
	if !p.caps.tools {
		return
	}
	tools := b.fetchCatalog(p, "tools/list", "tools")
	b.mu.Lock()
	p.tools = tools
	b.mu.Unlock()
	b.notifyChanged("tools")
}

func (b *Bridge) refreshPrompts(p *Provider) {
	if !p.caps.prompts {
		return
	}
	prompts := b.fetchCatalog(p, "prompts/list", "prompts")
	b.mu.Lock()
	p.prompts = prompts
	b.mu.Unlock()
	b.notifyChanged("prompts")
}

func (b *Bridge) refreshResources(p *Provider) {
	if !p.caps.resources {
		return
	}
	resources := b.fetchCatalog(p, "resources/list", "resources")
	b.mu.Lock()
	p.resources = resources
	b.mu.Unlock()
	b.notifyChanged("resources")
}

func (b *Bridge) fetchCatalog(p *Provider, method, key string) []rawObj {
	result, err := p.peer.Call(context.Background(), method, nil, 0)
	if err != nil {
		return nil
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(result, &parsed); err != nil {
		return nil
	}
	var items []rawObj
	if err := json.Unmarshal(parsed[key], &items); err != nil {
		return nil
	}
	return items
}

func (b *Bridge) forwardLogging(p *Provider, params json.RawMessage) {
	var obj rawObj
	if err := json.Unmarshal(params, &obj); err != nil {
		return
	}
	logger := objString(obj, "logger")
	if logger == "" {
		logger = "page"
	}
	clone := cloneObj(obj)
	setString(clone, "logger", p.label+"/"+logger)

	b.mu.Lock()
	agents := make([]*agentSession, 0, len(b.agents))
	for a := range b.agents {
		agents = append(agents, a)
	}
	b.mu.Unlock()
	for _, a := range agents {
		go func(a *agentSession) {
			_ = a.peer.Notify("notifications/message", clone)
		}(a)
	}
}

// ---- public API ------------------------------------------------------------------

// ToolSummary etc. mirror the TS providerSummary() JSON shape consumed by the
// dashboard and the meta tool.
type ToolSummary struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

type PromptSummary struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Arguments   json.RawMessage `json:"arguments,omitempty"`
}

type ResourceSummary struct {
	URI      string `json:"uri"`
	Name     string `json:"name,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

type ProviderSummaryEntry struct {
	Label       string            `json:"label"`
	Name        string            `json:"name"`
	Version     string            `json:"version"`
	URL         string            `json:"url,omitempty"`
	Title       string            `json:"title,omitempty"`
	TabID       *int              `json:"tabId,omitempty"`
	ProviderID  string            `json:"providerId,omitempty"`
	Tools       []ToolSummary     `json:"tools"`
	Prompts     []PromptSummary   `json:"prompts"`
	Resources   []ResourceSummary `json:"resources"`
	ConnectedAt string            `json:"connectedAt"`
}

// ProviderSummary lists connected providers with their namespaced catalogs.
func (b *Bridge) ProviderSummary() []ProviderSummaryEntry {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := []ProviderSummaryEntry{}
	for _, p := range b.providers {
		entry := ProviderSummaryEntry{
			Label:       p.label,
			Name:        p.rawName,
			Version:     p.version,
			URL:         p.meta.URL,
			Title:       p.meta.Title,
			TabID:       p.meta.TabID,
			ProviderID:  p.meta.ProviderID,
			Tools:       []ToolSummary{},
			Prompts:     []PromptSummary{},
			Resources:   []ResourceSummary{},
			ConnectedAt: p.connectedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		}
		for _, t := range p.tools {
			entry.Tools = append(entry.Tools, ToolSummary{
				Name:        protocol.NamespaceName(p.label, objString(t, "name")),
				Description: objString(t, "description"),
				InputSchema: t["inputSchema"],
			})
		}
		for _, pr := range p.prompts {
			entry.Prompts = append(entry.Prompts, PromptSummary{
				Name:        protocol.NamespaceName(p.label, objString(pr, "name")),
				Description: objString(pr, "description"),
				Arguments:   pr["arguments"],
			})
		}
		for _, r := range p.resources {
			entry.Resources = append(entry.Resources, ResourceSummary{
				URI:      objString(r, "uri"),
				Name:     objString(r, "name"),
				MimeType: objString(r, "mimeType"),
			})
		}
		out = append(out, entry)
	}
	return out
}

// DashboardAction asks a provider's extension to activate or close its tab.
func (b *Bridge) DashboardAction(label, action string) error {
	b.mu.Lock()
	var provider *Provider
	for _, p := range b.providers {
		if p.label == label {
			provider = p
			break
		}
	}
	b.mu.Unlock()

	if provider == nil {
		return &NotFoundError{Label: label}
	}
	if provider.meta.TabID == nil {
		return &NoTabError{}
	}

	method := protocol.MethodDashboardActivateTab
	if action == "close" {
		method = protocol.MethodDashboardCloseTab
	}
	_, err := provider.peer.Call(context.Background(), method, nil, dashboardActionTimeout)
	if err != nil {
		return fmt.Errorf("provider action %s; %w", action, err)
	}
	return nil
}

// NotFoundError reports an unknown provider label.
type NotFoundError struct{ Label string }

func (e *NotFoundError) Error() string { return "provider not found: " + e.Label }

// NoTabError reports a provider without an attached browser tab.
type NoTabError struct{}

func (e *NoTabError) Error() string { return "provider is not attached to a browser tab" }

// HasToken reports whether a shared token is required.
func (b *Bridge) HasToken() bool { return b.opts.Token != "" }

// TokenMatches checks a presented token.
func (b *Bridge) TokenMatches(token string) bool { return token == b.opts.Token }

// Close tears down all sessions. Safe to call multiple times.
func (b *Bridge) Close() {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.closed = true
	if b.idleTimer != nil {
		b.idleTimer.Stop()
		b.idleTimer = nil
	}
	providers := make([]*Provider, 0, len(b.providers))
	for _, p := range b.providers {
		providers = append(providers, p)
	}
	agents := make([]*agentSession, 0, len(b.agents))
	for a := range b.agents {
		agents = append(agents, a)
	}
	b.mu.Unlock()

	for _, p := range providers {
		_ = p.peer.Close()
	}
	for _, a := range agents {
		_ = a.peer.Close()
	}
}
