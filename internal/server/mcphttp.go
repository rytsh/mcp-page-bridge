// Streamable HTTP MCP transport: POST /mcp answers JSON-RPC requests, GET
// /mcp streams server-initiated notifications over SSE, DELETE /mcp ends the
// session. This lets remote MCP clients use the bridge with a plain URL
// instead of the stdio proxy.
package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/rytsh/mcp-page-bridge/internal/mcpwire"
)

const (
	// sessionHeader carries the Streamable HTTP session id (MCP spec).
	sessionHeader = "Mcp-Session-Id"

	// maxMCPBodySize matches the bridge's WebSocket read limit.
	maxMCPBodySize = 64 << 20

	// sseKeepAliveInterval spaces comment frames that keep proxies from
	// timing the GET stream out.
	sseKeepAliveInterval = 30 * time.Second
)

// JSON-RPC error codes used for HTTP-level failures.
const (
	codeParseError     = -32700
	codeInvalidRequest = -32600
)

// mcpGate applies the shared checks for all /mcp verbs. The host check is the
// same DNS-rebinding defense as the rest of the HTTP surface; the token (when
// configured) authorizes the caller.
func (s *Server) mcpGate(w http.ResponseWriter, r *http.Request) bool {
	if !s.hostAllowed(r) {
		s.mcpError(w, http.StatusForbidden, codeInvalidRequest, "request host/origin not allowed")
		return false
	}
	if !s.mcpTokenOK(r) {
		s.mcpError(w, http.StatusUnauthorized, codeInvalidRequest, "missing or invalid token")
		return false
	}
	return true
}

// mcpTokenOK accepts the shared token via `Authorization: Bearer <token>`,
// the x-mcp-page-bridge-token header, or a ?token= query parameter.
func (s *Server) mcpTokenOK(r *http.Request) bool {
	if s.opts.Token == "" {
		return true
	}
	if auth := r.Header.Get("Authorization"); auth != "" {
		if bearer, found := strings.CutPrefix(auth, "Bearer "); found && bearer == s.opts.Token {
			return true
		}
	}
	return s.tokenOK(r)
}

func (s *Server) handleMCPPost(w http.ResponseWriter, r *http.Request) {
	if !s.mcpGate(w, r) {
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxMCPBodySize))
	if err != nil {
		s.mcpError(w, http.StatusBadRequest, codeParseError, fmt.Sprintf("read body: %v", err))
		return
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		// JSON-RPC batching was removed in MCP 2025-06-18; the bridge never
		// supported it on any transport.
		s.mcpError(w, http.StatusBadRequest, codeInvalidRequest, "JSON-RPC batching is not supported")
		return
	}
	var msg mcpwire.Message
	if err := json.Unmarshal(trimmed, &msg); err != nil {
		s.mcpError(w, http.StatusBadRequest, codeParseError, fmt.Sprintf("invalid JSON-RPC message: %v", err))
		return
	}

	// initialize opens a fresh session; everything else needs Mcp-Session-Id.
	if msg.IsRequest() && msg.Method == "initialize" {
		session, err := s.bridge.OpenHTTPSession()
		if err != nil {
			s.mcpError(w, http.StatusServiceUnavailable, mcpwire.CodeInternalError, err.Error())
			return
		}
		resp := session.HandleMessage(r.Context(), &msg)
		w.Header().Set(sessionHeader, session.ID())
		s.writeMCPResponse(w, resp)
		return
	}

	session := s.bridge.LookupHTTPSession(r.Header.Get(sessionHeader))
	if session == nil {
		// 404 tells spec-compliant clients to re-initialize.
		s.mcpError(w, http.StatusNotFound, codeInvalidRequest, "unknown or expired session; send initialize to start a new one")
		return
	}

	resp := session.HandleMessage(r.Context(), &msg)
	if resp == nil { // notification or client response: accepted, no body
		w.WriteHeader(http.StatusAccepted)
		return
	}
	s.writeMCPResponse(w, resp)
}

func (s *Server) handleMCPGet(w http.ResponseWriter, r *http.Request) {
	if !s.mcpGate(w, r) {
		return
	}
	session := s.bridge.LookupHTTPSession(r.Header.Get(sessionHeader))
	if session == nil {
		s.mcpError(w, http.StatusNotFound, codeInvalidRequest, "unknown or expired session; send initialize to start a new one")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		s.mcpError(w, http.StatusInternalServerError, mcpwire.CodeInternalError, "streaming unsupported")
		return
	}
	events, release, ok := session.AttachStream()
	if !ok {
		s.mcpError(w, http.StatusConflict, codeInvalidRequest, "session already has an active event stream")
		return
	}
	defer release()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	keepAlive := time.NewTicker(sseKeepAliveInterval)
	defer keepAlive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-session.Done():
			return
		case <-keepAlive.C:
			if _, err := io.WriteString(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case event := <-events:
			if _, err := fmt.Fprintf(w, "data: %s\n\n", event); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) handleMCPDelete(w http.ResponseWriter, r *http.Request) {
	if !s.mcpGate(w, r) {
		return
	}
	session := s.bridge.LookupHTTPSession(r.Header.Get(sessionHeader))
	if session == nil {
		s.mcpError(w, http.StatusNotFound, codeInvalidRequest, "unknown or expired session")
		return
	}
	session.Close()
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// writeMCPResponse writes a JSON-RPC response message with HTTP 200.
func (s *Server) writeMCPResponse(w http.ResponseWriter, msg *mcpwire.Message) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(msg)
}

// mcpError writes a JSON-RPC error envelope (id null) with the given HTTP
// status, so MCP clients surface a useful message instead of a bare status.
func (s *Server) mcpError(w http.ResponseWriter, status, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      nil,
		"error":   map[string]any{"code": code, "message": message},
	})
}
