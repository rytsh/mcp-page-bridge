package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/rytsh/mcp-page-bridge/internal/mcpwire"
)

const (
	// httpSessionEventBuffer bounds queued server->client notifications per
	// HTTP session. When the buffer is full (no SSE stream attached, or a
	// slow reader) new notifications are dropped — they are advisory
	// (list_changed / logging), the client can always re-list.
	httpSessionEventBuffer = 128

	// httpSessionExpiry reaps sessions whose client vanished without a
	// DELETE. Any POST on the session (and an open SSE stream) keeps it
	// alive.
	httpSessionExpiry = 30 * time.Minute
)

// ErrBridgeClosed is returned when a session is opened on a closed bridge.
var ErrBridgeClosed = errors.New("bridge is shut down")

// HTTPSession is one Streamable HTTP agent session (one Mcp-Session-Id).
// Requests are answered synchronously by the bridge; server-initiated
// notifications are buffered for the session's optional GET/SSE stream.
type HTTPSession struct {
	id string
	b  *Bridge

	events chan json.RawMessage
	done   chan struct{}

	mu        sync.Mutex
	streaming bool
	expiry    *time.Timer
	closed    bool
}

// OpenHTTPSession registers a new Streamable HTTP agent session. The session
// counts as an agent connection for idle-shutdown purposes until it is
// closed (DELETE) or expires.
func (b *Bridge) OpenHTTPSession() (*HTTPSession, error) {
	s := &HTTPSession{
		id:     uuid.NewString(),
		b:      b,
		events: make(chan json.RawMessage, httpSessionEventBuffer),
		done:   make(chan struct{}),
	}

	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil, ErrBridgeClosed
	}
	b.httpSessions[s.id] = s
	b.agentConnections++
	b.checkIdleLocked()
	b.mu.Unlock()

	s.mu.Lock()
	s.armExpiryLocked()
	s.mu.Unlock()
	return s, nil
}

// LookupHTTPSession resolves a session by its Mcp-Session-Id value.
func (b *Bridge) LookupHTTPSession(id string) *HTTPSession {
	if id == "" {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.httpSessions[id]
}

// ID is the value carried in the Mcp-Session-Id header.
func (s *HTTPSession) ID() string { return s.id }

// Done is closed when the session has been terminated.
func (s *HTTPSession) Done() <-chan struct{} { return s.done }

// HandleMessage processes one client->server JSON-RPC message and returns
// the response message, or nil for notifications/responses (HTTP 202).
func (s *HTTPSession) HandleMessage(ctx context.Context, msg *mcpwire.Message) *mcpwire.Message {
	s.touch()
	if !msg.IsRequest() {
		return nil
	}
	if msg.Method == "ping" {
		return &mcpwire.Message{JSONRPC: "2.0", ID: msg.ID, Result: mcpwire.EmptyResult}
	}
	result, rpcErr := s.b.handleAgentRequest(ctx, msg.Method, msg.Params)
	if rpcErr != nil {
		return &mcpwire.Message{JSONRPC: "2.0", ID: msg.ID, Error: rpcErr}
	}
	if result == nil {
		result = mcpwire.EmptyResult
	}
	return &mcpwire.Message{JSONRPC: "2.0", ID: msg.ID, Result: result}
}

// AttachStream claims the session's single SSE stream slot. It returns the
// notification channel and a release func, or ok=false when a stream is
// already attached (HTTP 409) or the session is closed.
func (s *HTTPSession) AttachStream() (events <-chan json.RawMessage, release func(), ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.streaming {
		return nil, nil, false
	}
	s.streaming = true
	release = func() {
		s.mu.Lock()
		s.streaming = false
		if !s.closed {
			s.armExpiryLocked()
		}
		s.mu.Unlock()
	}
	return s.events, release, true
}

// Close terminates the session and releases its agent-connection slot.
// Safe to call multiple times.
func (s *HTTPSession) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	if s.expiry != nil {
		s.expiry.Stop()
		s.expiry = nil
	}
	close(s.done)
	s.mu.Unlock()

	b := s.b
	b.mu.Lock()
	if _, registered := b.httpSessions[s.id]; registered {
		delete(b.httpSessions, s.id)
		b.agentConnections--
		b.checkIdleLocked()
	}
	b.mu.Unlock()
}

// enqueueNotification queues a server-initiated notification for the SSE
// stream; drops it when the buffer is full.
func (s *HTTPSession) enqueueNotification(method string, params any) {
	var rawParams json.RawMessage
	if params != nil {
		marshaled, err := json.Marshal(params)
		if err != nil {
			return
		}
		rawParams = marshaled
	}
	data, err := json.Marshal(&mcpwire.Message{JSONRPC: "2.0", Method: method, Params: rawParams})
	if err != nil {
		return
	}
	select {
	case s.events <- data:
	default:
	}
}

// touch postpones the idle expiry; called on every request on the session.
func (s *HTTPSession) touch() {
	s.mu.Lock()
	if !s.closed {
		s.armExpiryLocked()
	}
	s.mu.Unlock()
}

// armExpiryLocked (re)arms the expiry timer; call with s.mu held.
func (s *HTTPSession) armExpiryLocked() {
	if s.expiry != nil {
		s.expiry.Stop()
	}
	s.expiry = time.AfterFunc(httpSessionExpiry, s.expire)
}

// expire closes the session unless an SSE stream is still attached, in which
// case the timer is rearmed.
func (s *HTTPSession) expire() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if s.streaming {
		s.armExpiryLocked()
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	s.Close()
}
