package server_test

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/rytsh/mcp-page-bridge/internal/bridge"
	"github.com/rytsh/mcp-page-bridge/internal/mcpwire"
	"github.com/rytsh/mcp-page-bridge/internal/protocol"
	"github.com/rytsh/mcp-page-bridge/internal/server"
	"github.com/rytsh/mcp-page-bridge/internal/testcert"
)

func TestTLSServerServesHTTPSAndWSS(t *testing.T) {
	certFile, keyFile, pool, err := testcert.Generate(t.TempDir())
	if err != nil {
		t.Fatalf("generate test certificate: %v", err)
	}
	tb := startBridge(t, bridge.Options{}, server.Options{TLSCert: certFile, TLSKey: keyFile})

	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
	}}

	// HTTPS API.
	resp, err := client.Get(fmt.Sprintf("https://127.0.0.1:%d/api/health", tb.srv.Port()))
	if err != nil {
		t.Fatalf("https health request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("https health: expected 200, got %d", resp.StatusCode)
	}
	var health struct {
		Service string `json:"service"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil || health.Service != protocol.ServiceID {
		t.Fatalf("unexpected health body: %+v (%v)", health, err)
	}

	// WSS agent handshake.
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, fmt.Sprintf("wss://127.0.0.1:%d/agent", tb.srv.Port()),
		&websocket.DialOptions{
			Subprotocols: []string{protocol.WSSubprotocol},
			HTTPClient:   client,
		})
	if err != nil {
		t.Fatalf("wss dial: %v", err)
	}
	conn.SetReadLimit(64 << 20)
	peer := mcpwire.NewPeer(conn, nil)
	t.Cleanup(func() { _ = peer.Close() })
	peer.Start()

	result := call(t, peer, "initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "tls-test-agent", "version": "0.0.0"},
	})
	var init struct {
		ServerInfo struct {
			Name string `json:"name"`
		} `json:"serverInfo"`
	}
	if err := json.Unmarshal(result, &init); err != nil || init.ServerInfo.Name != protocol.ServiceID {
		t.Fatalf("unexpected initialize result over wss: %s", result)
	}
}

func TestTLSServerRejectsBadKeyPair(t *testing.T) {
	b := bridge.New(bridge.Options{})
	defer b.Close()
	_, err := server.Start(t.Context(), b, server.Options{
		TLSCert: "/nonexistent/cert.pem",
		TLSKey:  "/nonexistent/key.pem",
	})
	if err == nil {
		t.Fatal("expected an error for a missing key pair")
	}
}
