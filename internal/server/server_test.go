package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/rytsh/mcp-page-bridge/internal/bridge"
	"github.com/rytsh/mcp-page-bridge/internal/mcpwire"
	"github.com/rytsh/mcp-page-bridge/internal/protocol"
	"github.com/rytsh/mcp-page-bridge/internal/server"
)

// ---- harness ----------------------------------------------------------------

type testBridge struct {
	b   *bridge.Bridge
	srv *server.Server
}

func startBridge(t *testing.T, opts bridge.Options, srvOpts server.Options) *testBridge {
	t.Helper()
	b := bridge.New(opts)
	srvOpts.Token = opts.Token
	srv, err := server.Start(t.Context(), b, srvOpts)
	if err != nil {
		t.Fatalf("start server: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return &testBridge{b: b, srv: srv}
}

func (tb *testBridge) url(path string) string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", tb.srv.Port(), path)
}

func (tb *testBridge) wsURL(path string) string {
	return fmt.Sprintf("ws://127.0.0.1:%d%s", tb.srv.Port(), path)
}

func dialPeer(t *testing.T, wsURL string) *mcpwire.Peer {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{protocol.WSSubprotocol},
	})
	if err != nil {
		t.Fatalf("dial %s: %v", wsURL, err)
	}
	conn.SetReadLimit(64 << 20)
	peer := mcpwire.NewPeer(conn, nil)
	t.Cleanup(func() { _ = peer.Close() })
	return peer
}

type fakeProviderOpts struct {
	name      string
	query     string // e.g. "?tabId=7&providerId=p1"
	tools     []map[string]any
	prompts   []map[string]any
	resources []map[string]any
	onCall    func(name string, args json.RawMessage) any
	onGet     func(name string) any
	onRead    func(uri string) any
}

// dialProvider connects a fake browser-page MCP server to the bridge.
func dialProvider(t *testing.T, tb *testBridge, opts fakeProviderOpts) *mcpwire.Peer {
	t.Helper()
	peer := dialPeer(t, tb.wsURL("/"+opts.query))
	peer.OnRequest(func(_ context.Context, method string, params json.RawMessage) (json.RawMessage, *mcpwire.RPCError) {
		switch method {
		case "initialize":
			result, _ := json.Marshal(map[string]any{
				"protocolVersion": "2025-06-18",
				"capabilities": map[string]any{
					"tools":     map[string]any{"listChanged": true},
					"prompts":   map[string]any{"listChanged": true},
					"resources": map[string]any{"listChanged": true},
				},
				"serverInfo": map[string]any{"name": opts.name, "version": "1.2.3"},
			})
			return result, nil
		case "tools/list":
			result, _ := json.Marshal(map[string]any{"tools": orEmpty(opts.tools)})
			return result, nil
		case "prompts/list":
			result, _ := json.Marshal(map[string]any{"prompts": orEmpty(opts.prompts)})
			return result, nil
		case "resources/list":
			result, _ := json.Marshal(map[string]any{"resources": orEmpty(opts.resources)})
			return result, nil
		case "tools/call":
			var req struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			_ = json.Unmarshal(params, &req)
			if opts.onCall != nil {
				result, _ := json.Marshal(opts.onCall(req.Name, req.Arguments))
				return result, nil
			}
			result, _ := json.Marshal(map[string]any{
				"content": []map[string]any{{"type": "text", "text": "ok:" + req.Name}},
			})
			return result, nil
		case "prompts/get":
			var req struct {
				Name string `json:"name"`
			}
			_ = json.Unmarshal(params, &req)
			if opts.onGet != nil {
				result, _ := json.Marshal(opts.onGet(req.Name))
				return result, nil
			}
			return nil, &mcpwire.RPCError{Code: mcpwire.CodeMethodNotFound, Message: "no prompt"}
		case "resources/read":
			var req struct {
				URI string `json:"uri"`
			}
			_ = json.Unmarshal(params, &req)
			if opts.onRead != nil {
				result, _ := json.Marshal(opts.onRead(req.URI))
				return result, nil
			}
			return nil, &mcpwire.RPCError{Code: mcpwire.CodeMethodNotFound, Message: "no resource"}
		default:
			return nil, &mcpwire.RPCError{Code: mcpwire.CodeMethodNotFound, Message: method}
		}
	})
	peer.Start()
	return peer
}

// dialAgent connects an MCP client to /agent and performs the initialize handshake.
func dialAgent(t *testing.T, tb *testBridge, query string) *mcpwire.Peer {
	t.Helper()
	peer := dialPeer(t, tb.wsURL("/agent"+query))
	peer.Start()
	result := call(t, peer, "initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "test-agent", "version": "0.0.0"},
	})
	var init struct {
		ServerInfo struct {
			Name string `json:"name"`
		} `json:"serverInfo"`
	}
	if err := json.Unmarshal(result, &init); err != nil || init.ServerInfo.Name != protocol.ServiceID {
		t.Fatalf("unexpected initialize result: %s", result)
	}
	_ = peer.Notify("notifications/initialized", nil)
	return peer
}

func call(t *testing.T, peer *mcpwire.Peer, method string, params any) json.RawMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	result, err := peer.Call(ctx, method, params, 0)
	if err != nil {
		t.Fatalf("call %s: %v", method, err)
	}
	return result
}

func listToolNames(t *testing.T, agent *mcpwire.Peer) []string {
	t.Helper()
	var parsed struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(call(t, agent, "tools/list", nil), &parsed); err != nil {
		t.Fatalf("parse tools/list: %v", err)
	}
	names := make([]string, 0, len(parsed.Tools))
	for _, tool := range parsed.Tools {
		names = append(names, tool.Name)
	}
	return names
}

func waitFor(t *testing.T, what string, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("waitFor: %s not satisfied before timeout", what)
}

func contains(values []string, v string) bool {
	for _, x := range values {
		if x == v {
			return true
		}
	}
	return false
}

func orEmpty(items []map[string]any) []map[string]any {
	if items == nil {
		return []map[string]any{}
	}
	return items
}

func echoTool(name string) []map[string]any {
	return []map[string]any{{
		"name":        name,
		"description": "test tool",
		"inputSchema": map[string]any{"type": "object"},
	}}
}

// ---- tests --------------------------------------------------------------------

func TestMetaToolAlwaysExposed(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	agent := dialAgent(t, tb, "")
	if names := listToolNames(t, agent); !contains(names, "mcp_page_bridge_list_clients") {
		t.Fatalf("meta tool missing from %v", names)
	}
}

func TestNamespacedToolRouting(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	dialProvider(t, tb, fakeProviderOpts{
		name:  "demo",
		tools: echoTool("eval"),
		onCall: func(name string, args json.RawMessage) any {
			return map[string]any{
				"content": []map[string]any{{"type": "text", "text": "called:" + name + ":" + string(args)}},
			}
		},
	})
	agent := dialAgent(t, tb, "")
	waitFor(t, "namespaced tool", func() bool {
		return contains(listToolNames(t, agent), "demo__eval")
	})

	result := call(t, agent, "tools/call", map[string]any{
		"name":      "demo__eval",
		"arguments": map[string]any{"code": "1+1"},
	})
	if !strings.Contains(string(result), "called:eval") {
		t.Fatalf("tool call not routed with original name: %s", result)
	}
	if !strings.Contains(string(result), "1+1") {
		t.Fatalf("tool arguments not forwarded: %s", result)
	}
}

func TestMultipleAgentConnections(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	agent1 := dialAgent(t, tb, "")
	agent2 := dialAgent(t, tb, "")
	if names := listToolNames(t, agent1); !contains(names, "mcp_page_bridge_list_clients") {
		t.Fatal("agent1 missing meta tool")
	}
	if names := listToolNames(t, agent2); !contains(names, "mcp_page_bridge_list_clients") {
		t.Fatal("agent2 missing meta tool")
	}
}

func TestPortAlreadyInUse(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port

	b := bridge.New(bridge.Options{})
	defer b.Close()
	if _, err := server.Start(t.Context(), b, server.Options{Port: port}); err == nil {
		t.Fatal("expected an error for an occupied port")
	}
}

func TestDashboardShutdown(t *testing.T) {
	done := make(chan struct{})
	tb := startBridge(t, bridge.Options{}, server.Options{OnShutdown: func() { close(done) }})

	req, _ := http.NewRequest(http.MethodPost, tb.url("/api/shutdown"), nil)
	req.Header.Set(protocol.DashboardHeader, protocol.DashboardHeaderValue)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("shutdown returned %d", resp.StatusCode)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("OnShutdown was not invoked")
	}
}

func TestForeignOriginRejected(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	req, _ := http.NewRequest(http.MethodGet, tb.url("/api/providers"), nil)
	req.Header.Set("Origin", "https://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for foreign origin, got %d", resp.StatusCode)
	}
}

func TestNoPermissiveCORS(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	resp, err := http.Get(tb.url("/api/providers"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if h := resp.Header.Get("Access-Control-Allow-Origin"); h != "" {
		t.Fatalf("unexpected CORS header: %q", h)
	}
}

func TestDashboardNoStore(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	resp, err := http.Get(tb.url("/"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("dashboard returned %d", resp.StatusCode)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("expected no-store, got %q", cc)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("unexpected content type %q", ct)
	}
}

func TestHealthEndpointWithoutToken(t *testing.T) {
	tb := startBridge(t, bridge.Options{Token: "secret"}, server.Options{})
	resp, err := http.Get(tb.url("/api/health"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("health returned %d", resp.StatusCode)
	}
	var body struct {
		Service       string `json:"service"`
		RequiresToken bool   `json:"requiresToken"`
		Port          int    `json:"port"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Service != protocol.ServiceID || !body.RequiresToken || body.Port != tb.srv.Port() {
		t.Fatalf("unexpected health body: %+v", body)
	}
}

func TestTokenRequiredOnHTTPAPI(t *testing.T) {
	tb := startBridge(t, bridge.Options{Token: "secret"}, server.Options{})

	resp, err := http.Get(tb.url("/api/providers"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", resp.StatusCode)
	}

	req, _ := http.NewRequest(http.MethodGet, tb.url("/api/providers"), nil)
	req.Header.Set(protocol.TokenHeader, "secret")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 with token, got %d", resp2.StatusCode)
	}
}

func TestShutdownWithToken(t *testing.T) {
	done := make(chan struct{})
	tb := startBridge(t, bridge.Options{Token: "secret"}, server.Options{OnShutdown: func() { close(done) }})

	// Missing dashboard header → 403.
	req1, _ := http.NewRequest(http.MethodPost, tb.url("/api/shutdown"), nil)
	req1.Header.Set(protocol.TokenHeader, "secret")
	resp1, _ := http.DefaultClient.Do(req1)
	resp1.Body.Close()
	if resp1.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 without dashboard header, got %d", resp1.StatusCode)
	}

	// Missing token → 401.
	req2, _ := http.NewRequest(http.MethodPost, tb.url("/api/shutdown"), nil)
	req2.Header.Set(protocol.DashboardHeader, protocol.DashboardHeaderValue)
	resp2, _ := http.DefaultClient.Do(req2)
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", resp2.StatusCode)
	}

	// Both → OK.
	req3, _ := http.NewRequest(http.MethodPost, tb.url("/api/shutdown"), nil)
	req3.Header.Set(protocol.DashboardHeader, protocol.DashboardHeaderValue)
	req3.Header.Set(protocol.TokenHeader, "secret")
	resp3, _ := http.DefaultClient.Do(req3)
	resp3.Body.Close()
	if resp3.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp3.StatusCode)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("OnShutdown was not invoked")
	}
}

func TestIdleAutoShutdown(t *testing.T) {
	fired := make(chan struct{})
	tb := startBridge(t, bridge.Options{
		IdleTimeout:    150 * time.Millisecond,
		OnIdleShutdown: func() { close(fired) },
	}, server.Options{})
	_ = tb
	select {
	case <-fired:
	case <-time.After(3 * time.Second):
		t.Fatal("idle shutdown did not fire")
	}
}

func TestListClientsReportsProviders(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	dialProvider(t, tb, fakeProviderOpts{name: "demo", query: "?tabId=7&providerId=p1", tools: echoTool("eval")})
	agent := dialAgent(t, tb, "")
	waitFor(t, "provider registered with tools", func() bool {
		summary := tb.b.ProviderSummary()
		return len(summary) == 1 && len(summary[0].Tools) == 1
	})

	result := call(t, agent, "tools/call", map[string]any{"name": "mcp_page_bridge_list_clients"})
	var parsed struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(result, &parsed); err != nil || len(parsed.Content) == 0 {
		t.Fatalf("unexpected list_clients result: %s", result)
	}
	text := parsed.Content[0].Text
	for _, want := range []string{`"label": "demo"`, `"demo__eval"`, `"tabId": 7`, `"providerId": "p1"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("list_clients output missing %s: %s", want, text)
		}
	}
}

func TestProviderDisconnectRemovesTools(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	provider := dialProvider(t, tb, fakeProviderOpts{name: "demo", tools: echoTool("eval")})
	agent := dialAgent(t, tb, "")
	waitFor(t, "tool appears", func() bool {
		return contains(listToolNames(t, agent), "demo__eval")
	})

	_ = provider.Close()
	waitFor(t, "tool disappears", func() bool {
		return !contains(listToolNames(t, agent), "demo__eval")
	})
}

func TestLabelCollisionDisambiguation(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	dialProvider(t, tb, fakeProviderOpts{name: "demo", query: "?tabId=1", tools: echoTool("a")})
	waitFor(t, "first provider", func() bool { return len(tb.b.ProviderSummary()) == 1 })
	dialProvider(t, tb, fakeProviderOpts{name: "demo", query: "?tabId=2", tools: echoTool("b")})
	waitFor(t, "second provider", func() bool { return len(tb.b.ProviderSummary()) == 2 })

	labels := map[string]bool{}
	for _, p := range tb.b.ProviderSummary() {
		labels[p.Label] = true
	}
	if !labels["demo"] || !labels["demo-2"] {
		t.Fatalf("expected labels demo + demo-2, got %v", labels)
	}
}

func TestLabelStableAcrossReconnect(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})

	p1 := dialProvider(t, tb, fakeProviderOpts{name: "demo", query: "?tabId=1&providerId=x", tools: echoTool("a")})
	waitFor(t, "first provider", func() bool { return len(tb.b.ProviderSummary()) == 1 })
	p2 := dialProvider(t, tb, fakeProviderOpts{name: "demo", query: "?tabId=2&providerId=y", tools: echoTool("b")})
	waitFor(t, "second provider", func() bool { return len(tb.b.ProviderSummary()) == 2 })

	labelByTab := map[int]string{}
	for _, p := range tb.b.ProviderSummary() {
		labelByTab[*p.TabID] = p.Label
	}

	_ = p1.Close()
	_ = p2.Close()
	waitFor(t, "providers gone", func() bool { return len(tb.b.ProviderSummary()) == 0 })

	// Reconnect in reverse order; labels must follow the tab identity.
	dialProvider(t, tb, fakeProviderOpts{name: "demo", query: "?tabId=2&providerId=y", tools: echoTool("b")})
	waitFor(t, "tab2 back", func() bool { return len(tb.b.ProviderSummary()) == 1 })
	dialProvider(t, tb, fakeProviderOpts{name: "demo", query: "?tabId=1&providerId=x", tools: echoTool("a")})
	waitFor(t, "tab1 back", func() bool { return len(tb.b.ProviderSummary()) == 2 })

	for _, p := range tb.b.ProviderSummary() {
		if labelByTab[*p.TabID] != p.Label {
			t.Fatalf("label for tab %d changed: was %s now %s", *p.TabID, labelByTab[*p.TabID], p.Label)
		}
	}
}

func TestPromptAggregationAndGet(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	dialProvider(t, tb, fakeProviderOpts{
		name:    "demo",
		prompts: []map[string]any{{"name": "fix", "description": "fix things"}},
		onGet: func(name string) any {
			return map[string]any{
				"messages": []map[string]any{{
					"role":    "user",
					"content": map[string]any{"type": "text", "text": "prompt:" + name},
				}},
			}
		},
	})
	agent := dialAgent(t, tb, "")

	waitFor(t, "prompt appears", func() bool {
		return strings.Contains(string(call(t, agent, "prompts/list", nil)), "demo__fix")
	})
	result := call(t, agent, "prompts/get", map[string]any{"name": "demo__fix"})
	if !strings.Contains(string(result), "prompt:fix") {
		t.Fatalf("prompts/get not routed with original name: %s", result)
	}
}

func TestResourceAggregationAndRead(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	dialProvider(t, tb, fakeProviderOpts{
		name:      "demo",
		resources: []map[string]any{{"uri": "page://state", "name": "state", "mimeType": "application/json"}},
		onRead: func(uri string) any {
			return map[string]any{
				"contents": []map[string]any{{"uri": uri, "mimeType": "application/json", "text": `{"x":1}`}},
			}
		},
	})
	agent := dialAgent(t, tb, "")

	waitFor(t, "resource appears", func() bool {
		return strings.Contains(string(call(t, agent, "resources/list", nil)), "page://state")
	})
	result := call(t, agent, "resources/read", map[string]any{"uri": "page://state"})
	if !strings.Contains(string(result), `{\"x\":1}`) && !strings.Contains(string(result), `{"x":1}`) {
		t.Fatalf("resources/read not routed: %s", result)
	}
}

func TestNonLoopbackBindRelaxesHostCheck(t *testing.T) {
	// Bound to 0.0.0.0 (token-gated), the bridge must accept LAN-style Host
	// headers but still require the matching port and the token for data.
	b := bridge.New(bridge.Options{Token: "secret"})
	srv, err := server.Start(t.Context(), b, server.Options{Host: "0.0.0.0", Token: "secret"})
	if err != nil {
		t.Fatalf("start server: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })

	get := func(host string, headers map[string]string) int {
		req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/api/providers", srv.Port()), nil)
		req.Host = host
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	lanHost := fmt.Sprintf("192.168.1.5:%d", srv.Port())
	if code := get(lanHost, map[string]string{protocol.TokenHeader: "secret"}); code != http.StatusOK {
		t.Fatalf("LAN host with token: expected 200, got %d", code)
	}
	if code := get(lanHost, nil); code != http.StatusUnauthorized {
		t.Fatalf("LAN host without token: expected 401, got %d", code)
	}
	if code := get("192.168.1.5:9999", map[string]string{protocol.TokenHeader: "secret"}); code != http.StatusForbidden {
		t.Fatalf("wrong port in Host: expected 403, got %d", code)
	}
	if code := get(lanHost, map[string]string{
		protocol.TokenHeader: "secret",
		"Origin":             "https://evil.example",
	}); code != http.StatusForbidden {
		t.Fatalf("foreign origin: expected 403, got %d", code)
	}
}

func TestLoopbackBindKeepsStrictHostCheck(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	req, _ := http.NewRequest(http.MethodGet, tb.url("/api/providers"), nil)
	req.Host = fmt.Sprintf("192.168.1.5:%d", tb.srv.Port())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for non-local Host on loopback bind, got %d", resp.StatusCode)
	}
}

func TestWSTokenEnforced(t *testing.T) {
	tb := startBridge(t, bridge.Options{Token: "secret"}, server.Options{})

	// Without token: handshake must fail.
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, tb.wsURL("/agent"), &websocket.DialOptions{
		Subprotocols: []string{protocol.WSSubprotocol},
	})
	if err == nil {
		conn.Close(websocket.StatusNormalClosure, "")
		t.Fatal("expected WS dial without token to fail")
	}

	// With token: full agent handshake works.
	agent := dialAgent(t, tb, "?token=secret")
	if names := listToolNames(t, agent); !contains(names, "mcp_page_bridge_list_clients") {
		t.Fatal("token-authenticated agent could not list tools")
	}
}
