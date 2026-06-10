package server_test

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/rytsh/mcp-page-bridge/internal/bridge"
	"github.com/rytsh/mcp-page-bridge/internal/mcpwire"
	"github.com/rytsh/mcp-page-bridge/internal/protocol"
	"github.com/rytsh/mcp-page-bridge/internal/server"
)

// ---- streamable HTTP helpers --------------------------------------------------

func mcpPost(t *testing.T, tb *testBridge, sessionID string, headers map[string]string, body string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, tb.url("/mcp"), strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if sessionID != "" {
		req.Header.Set("Mcp-Session-Id", sessionID)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return resp, data
}

func mcpInitialize(t *testing.T, tb *testBridge, headers map[string]string) string {
	t.Helper()
	resp, body := mcpPost(t, tb, "", headers,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"http-test","version":"0.0.0"}}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("initialize: expected 200, got %d: %s", resp.StatusCode, body)
	}
	sessionID := resp.Header.Get("Mcp-Session-Id")
	if sessionID == "" {
		t.Fatalf("initialize response missing Mcp-Session-Id header")
	}
	var msg mcpwire.Message
	if err := json.Unmarshal(body, &msg); err != nil {
		t.Fatalf("parse initialize response: %v", err)
	}
	var init struct {
		ServerInfo struct {
			Name string `json:"name"`
		} `json:"serverInfo"`
	}
	if err := json.Unmarshal(msg.Result, &init); err != nil || init.ServerInfo.Name != protocol.ServiceID {
		t.Fatalf("unexpected initialize result: %s", body)
	}
	return sessionID
}

func resultOf(t *testing.T, body []byte) json.RawMessage {
	t.Helper()
	var msg mcpwire.Message
	if err := json.Unmarshal(body, &msg); err != nil {
		t.Fatalf("parse JSON-RPC response %s: %v", body, err)
	}
	if msg.Error != nil {
		t.Fatalf("unexpected JSON-RPC error: %v", msg.Error)
	}
	return msg.Result
}

// ---- tests ----------------------------------------------------------------------

func TestMCPHTTPSessionLifecycle(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	dialProvider(t, tb, fakeProviderOpts{name: "shop", tools: echoTool("getCart")})
	waitFor(t, "tool registered", func() bool {
		summary := tb.b.ProviderSummary()
		return len(summary) == 1 && len(summary[0].Tools) == 1
	})

	sessionID := mcpInitialize(t, tb, nil)

	// notifications are accepted with 202 and no body
	resp, _ := mcpPost(t, tb, sessionID, nil, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("notification: expected 202, got %d", resp.StatusCode)
	}

	// tools/list sees the namespaced provider tool
	resp, body := mcpPost(t, tb, sessionID, nil, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("tools/list: expected 200, got %d: %s", resp.StatusCode, body)
	}
	var tools struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(resultOf(t, body), &tools); err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(tools.Tools))
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
	}
	if !contains(names, "shop__getCart") || !contains(names, "mcp_page_bridge_list_clients") {
		t.Fatalf("unexpected tools: %v", names)
	}

	// tools/call routes through to the provider
	resp, body = mcpPost(t, tb, sessionID, nil,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"shop__getCart","arguments":{}}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("tools/call: expected 200, got %d: %s", resp.StatusCode, body)
	}
	if !strings.Contains(string(resultOf(t, body)), "ok:getCart") {
		t.Fatalf("unexpected tools/call result: %s", body)
	}

	// ping is answered locally
	resp, body = mcpPost(t, tb, sessionID, nil, `{"jsonrpc":"2.0","id":4,"method":"ping"}`)
	if resp.StatusCode != http.StatusOK || string(resultOf(t, body)) != "{}" {
		t.Fatalf("ping: expected {} result, got %d: %s", resp.StatusCode, body)
	}

	// DELETE terminates the session; later requests are 404
	req, _ := http.NewRequest(http.MethodDelete, tb.url("/mcp"), nil)
	req.Header.Set("Mcp-Session-Id", sessionID)
	delResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = delResp.Body.Close()
	if delResp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE: expected 200, got %d", delResp.StatusCode)
	}
	resp, _ = mcpPost(t, tb, sessionID, nil, `{"jsonrpc":"2.0","id":5,"method":"tools/list"}`)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("after DELETE: expected 404, got %d", resp.StatusCode)
	}
}

func TestMCPHTTPRequiresSession(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	// non-initialize request without a session header → 404 (re-initialize)
	resp, _ := mcpPost(t, tb, "", nil, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 without session, got %d", resp.StatusCode)
	}
	resp, _ = mcpPost(t, tb, "bogus-session", nil, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown session, got %d", resp.StatusCode)
	}
}

func TestMCPHTTPRejectsBatch(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	resp, _ := mcpPost(t, tb, "", nil, `[{"jsonrpc":"2.0","id":1,"method":"initialize"}]`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for batch, got %d", resp.StatusCode)
	}
}

func TestMCPHTTPTokenAuth(t *testing.T) {
	tb := startBridge(t, bridge.Options{Token: "secret"}, server.Options{})

	initBody := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`

	// no token → 401
	resp, _ := mcpPost(t, tb, "", nil, initBody)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", resp.StatusCode)
	}
	// wrong bearer → 401
	resp, _ = mcpPost(t, tb, "", map[string]string{"Authorization": "Bearer nope"}, initBody)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 with wrong bearer, got %d", resp.StatusCode)
	}
	// Authorization: Bearer → 200
	sessionID := mcpInitialize(t, tb, map[string]string{"Authorization": "Bearer secret"})
	if sessionID == "" {
		t.Fatal("no session via bearer auth")
	}
	// the bridge token header works too
	resp, _ = mcpPost(t, tb, sessionID,
		map[string]string{protocol.TokenHeader: "secret"},
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 with token header, got %d", resp.StatusCode)
	}
}

func TestMCPHTTPSSEListChanged(t *testing.T) {
	tb := startBridge(t, bridge.Options{}, server.Options{})
	sessionID := mcpInitialize(t, tb, nil)

	req, err := http.NewRequest(http.MethodGet, tb.url("/mcp"), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Mcp-Session-Id", sessionID)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /mcp: expected 200, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("unexpected content type %q", ct)
	}

	// a second concurrent stream on the same session is refused
	second, err := http.DefaultClient.Do(req.Clone(req.Context()))
	if err != nil {
		t.Fatal(err)
	}
	_ = second.Body.Close()
	if second.StatusCode != http.StatusConflict {
		t.Fatalf("second stream: expected 409, got %d", second.StatusCode)
	}

	// connecting a provider must emit list_changed notifications on the stream
	events := make(chan string, 16)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if data, found := strings.CutPrefix(line, "data: "); found {
				events <- data
			}
		}
	}()

	dialProvider(t, tb, fakeProviderOpts{name: "shop", tools: echoTool("getCart")})

	deadline := time.After(5 * time.Second)
	for {
		select {
		case data := <-events:
			var msg mcpwire.Message
			if err := json.Unmarshal([]byte(data), &msg); err != nil {
				t.Fatalf("bad SSE payload %q: %v", data, err)
			}
			if msg.Method == "notifications/tools/list_changed" {
				return // success
			}
		case <-deadline:
			t.Fatal("timed out waiting for tools/list_changed on the SSE stream")
		}
	}
}

func TestMCPHTTPSessionCountsAsAgent(t *testing.T) {
	// An open HTTP session must hold the idle-shutdown timer off.
	idleFired := make(chan struct{}, 1)
	tb := startBridge(t, bridge.Options{
		IdleTimeout:    150 * time.Millisecond,
		OnIdleShutdown: func() { idleFired <- struct{}{} },
	}, server.Options{})

	sessionID := mcpInitialize(t, tb, nil)
	select {
	case <-idleFired:
		t.Fatal("idle shutdown fired while an HTTP session was open")
	case <-time.After(400 * time.Millisecond):
	}

	// after DELETE the bridge goes idle and shuts down
	req, _ := http.NewRequest(http.MethodDelete, tb.url("/mcp"), nil)
	req.Header.Set("Mcp-Session-Id", sessionID)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	select {
	case <-idleFired:
	case <-time.After(2 * time.Second):
		t.Fatal("idle shutdown did not fire after the HTTP session closed")
	}
}
