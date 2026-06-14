package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/rytsh/mcp-page-bridge/internal/bridge"
	"github.com/rytsh/mcp-page-bridge/internal/protocol"
	"github.com/rytsh/mcp-page-bridge/internal/server"
)

// tryDial attempts a raw WebSocket handshake and reports whether it succeeded.
// Unlike dialPeer it does not fail the test on error (the error is the point).
func tryDial(t *testing.T, wsURL string) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{protocol.WSSubprotocol},
	})
	if err == nil {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}
	return err
}

func httpToolNames(t *testing.T, body []byte) []string {
	t.Helper()
	var tools struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(resultOf(t, body), &tools); err != nil {
		t.Fatalf("parse tools/list: %v", err)
	}
	names := make([]string, 0, len(tools.Tools))
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
	}
	return names
}

// TestProfilePartitionIsolation is the core multi-user guarantee: agents only
// see providers sharing their profile key, and a cross-partition tool call is
// rejected even with the exact namespaced name.
func TestProfilePartitionIsolation(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	dialProvider(t, tb, fakeProviderOpts{name: "alice", query: "?profile=alicekey&tabId=1", tools: echoTool("eval")})
	dialProvider(t, tb, fakeProviderOpts{name: "bob", query: "?profile=bobkey&tabId=2", tools: echoTool("ping")})

	agentAlice := dialAgent(t, tb, "?profile=alicekey")
	agentBob := dialAgent(t, tb, "?profile=bobkey")
	agentNone := dialAgent(t, tb, "")

	waitFor(t, "alice sees her tool", func() bool { return contains(listToolNames(t, agentAlice), "alice__eval") })
	waitFor(t, "bob sees his tool", func() bool { return contains(listToolNames(t, agentBob), "bob__ping") })

	if names := listToolNames(t, agentAlice); contains(names, "bob__ping") {
		t.Fatalf("alice must not see bob's tools: %v", names)
	}
	if names := listToolNames(t, agentBob); contains(names, "alice__eval") {
		t.Fatalf("bob must not see alice's tools: %v", names)
	}
	noneNames := listToolNames(t, agentNone)
	if contains(noneNames, "alice__eval") || contains(noneNames, "bob__ping") {
		t.Fatalf("profile-less agent must not see partitioned tools: %v", noneNames)
	}
	if !contains(noneNames, "mcp_page_bridge_list_clients") {
		t.Fatalf("meta tool must always be present: %v", noneNames)
	}

	// Cross-partition tool call is rejected even with the exact namespaced name.
	result := call(t, agentAlice, "tools/call", map[string]any{"name": "bob__ping", "arguments": map[string]any{}})
	if !strings.Contains(string(result), "Unknown or disconnected tool") {
		t.Fatalf("expected cross-partition call to be rejected, got: %s", result)
	}
}

// TestProfileListClientsScoped ensures the meta tool only reports the caller's
// partition.
func TestProfileListClientsScoped(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	dialProvider(t, tb, fakeProviderOpts{name: "alice", query: "?profile=alicekey", tools: echoTool("eval")})
	dialProvider(t, tb, fakeProviderOpts{name: "bob", query: "?profile=bobkey", tools: echoTool("ping")})
	agentAlice := dialAgent(t, tb, "?profile=alicekey")
	waitFor(t, "alice provider registered", func() bool { return len(tb.b.ProviderSummary(protocol.HashProfile("alicekey"))) == 1 })

	result := call(t, agentAlice, "tools/call", map[string]any{"name": "mcp_page_bridge_list_clients"})
	text := string(result)
	if !strings.Contains(text, "alice__eval") {
		t.Fatalf("list_clients missing alice's provider: %s", text)
	}
	if strings.Contains(text, "bob") {
		t.Fatalf("list_clients leaked bob's provider into alice's partition: %s", text)
	}
}

// TestProfileMCPHTTPScoped confirms the Streamable HTTP transport partitions by
// profile, and that the session remembers the profile across requests.
func TestProfileMCPHTTPScoped(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	dialProvider(t, tb, fakeProviderOpts{name: "alice", query: "?profile=alicekey", tools: echoTool("eval")})
	dialProvider(t, tb, fakeProviderOpts{name: "bob", query: "?profile=bobkey", tools: echoTool("ping")})
	waitFor(t, "providers registered", func() bool {
		return len(tb.b.ProviderSummary(protocol.HashProfile("alicekey"))) == 1 && len(tb.b.ProviderSummary(protocol.HashProfile("bobkey"))) == 1
	})

	// initialize carries the profile via the header; the session stores it.
	sessionID := mcpInitialize(t, tb, map[string]string{protocol.ProfileHeader: "alicekey"})
	// no profile header on the follow-up: the session must already be scoped.
	_, body := mcpPost(t, tb, sessionID, nil, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	names := httpToolNames(t, body)
	if !contains(names, "alice__eval") {
		t.Fatalf("http agent missing its own tool: %v", names)
	}
	if contains(names, "bob__ping") {
		t.Fatalf("http agent leaked another partition's tool: %v", names)
	}
}

// TestProfileRequiredRejectsConnections verifies multi-user mode rejects any
// provider/agent (WS) and HTTP session that omits a profile key.
func TestProfileRequiredRejectsConnections(t *testing.T) {
	tb := startBridge(t, bridge.Options{RequireProfile: true}, server.Options{})

	if err := tryDial(t, tb.wsURL("/")); err == nil {
		t.Fatal("expected provider dial without profile to be rejected")
	}
	if err := tryDial(t, tb.wsURL("/agent")); err == nil {
		t.Fatal("expected agent dial without profile to be rejected")
	}
	// A profiled agent connects fine.
	agent := dialAgent(t, tb, "?profile=alicekey")
	if names := listToolNames(t, agent); !contains(names, "mcp_page_bridge_list_clients") {
		t.Fatal("profiled agent could not list tools")
	}

	// /mcp initialize without a profile → 401; with the header → 200.
	initBody := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`
	resp, _ := mcpPost(t, tb, "", nil, initBody)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for /mcp without profile, got %d", resp.StatusCode)
	}
	if sessionID := mcpInitialize(t, tb, map[string]string{protocol.ProfileHeader: "alicekey"}); sessionID == "" {
		t.Fatal("no /mcp session with a profile header")
	}
}

// TestProfileProvidersAPIScoped confirms the dashboard JSON API only lists the
// requested partition.
func TestProfileProvidersAPIScoped(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	dialProvider(t, tb, fakeProviderOpts{name: "alice", query: "?profile=alicekey", tools: echoTool("eval")})
	waitFor(t, "registered", func() bool { return len(tb.b.ProviderSummary(protocol.HashProfile("alicekey"))) == 1 })

	count := func(query string) int {
		resp, err := http.Get(tb.url("/api/providers" + query))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body struct {
			Providers []json.RawMessage `json:"providers"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return len(body.Providers)
	}
	if c := count("?profile=alicekey"); c != 1 {
		t.Fatalf("alice partition: expected 1 provider, got %d", c)
	}
	if c := count(""); c != 0 {
		t.Fatalf("default partition: expected 0 providers, got %d", c)
	}
	if c := count("?profile=bobkey"); c != 0 {
		t.Fatalf("bob partition: expected 0 providers, got %d", c)
	}
}

// TestProfileHealthReportsRequirement surfaces multi-user mode on /api/health.
func TestProfileHealthReportsRequirement(t *testing.T) {
	tb := startBridge(t, bridge.Options{RequireProfile: true}, server.Options{})
	resp, err := http.Get(tb.url("/api/health"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		RequiresProfile bool `json:"requiresProfile"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.RequiresProfile {
		t.Fatal("expected requiresProfile=true on /api/health")
	}
}
