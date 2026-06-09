package mcpwire

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// DefaultRequestTimeout mirrors the TypeScript SDK's default (60s).
const DefaultRequestTimeout = 60 * time.Second

const writeTimeout = 30 * time.Second

// ErrPeerClosed is returned for calls made on (or interrupted by) a closed peer.
var ErrPeerClosed = errors.New("mcpwire: peer closed")

// RequestHandler answers an incoming request. Return a result or an *RPCError.
type RequestHandler func(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, *RPCError)

// NotificationHandler observes an incoming notification.
type NotificationHandler func(method string, params json.RawMessage)

// Peer is a bidirectional JSON-RPC endpoint over one WebSocket connection.
// It serves both roles the bridge needs: MCP server toward agents and MCP
// client toward browser providers.
type Peer struct {
	conn   *websocket.Conn
	logger *slog.Logger

	writeMu sync.Mutex

	nextID    atomic.Int64
	pendingMu sync.Mutex
	pending   map[string]chan *Message

	onRequest atomic.Pointer[RequestHandler]
	onNotify  atomic.Pointer[NotificationHandler]
	onClose   atomic.Pointer[func()]

	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
}

// NewPeer wraps an already-accepted/dialed WebSocket connection. Call Start
// to launch the read loop after registering handlers.
func NewPeer(conn *websocket.Conn, logger *slog.Logger) *Peer {
	if logger == nil {
		logger = slog.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Peer{
		conn:    conn,
		logger:  logger,
		pending: map[string]chan *Message{},
		ctx:     ctx,
		cancel:  cancel,
	}
}

// OnRequest registers the handler for incoming requests (besides built-in ping).
func (p *Peer) OnRequest(h RequestHandler) { p.onRequest.Store(&h) }

// OnNotification registers the handler for incoming notifications.
func (p *Peer) OnNotification(h NotificationHandler) { p.onNotify.Store(&h) }

// OnClose registers a callback fired exactly once when the peer shuts down.
func (p *Peer) OnClose(f func()) { p.onClose.Store(&f) }

// Done is closed when the peer has shut down.
func (p *Peer) Done() <-chan struct{} { return p.ctx.Done() }

// Start launches the read loop.
func (p *Peer) Start() {
	go p.readLoop()
}

func (p *Peer) readLoop() {
	defer p.shutdown()
	for {
		_, data, err := p.conn.Read(p.ctx)
		if err != nil {
			return
		}
		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			p.logger.Debug("mcpwire: dropping unparsable message", "error", err)
			continue
		}
		switch {
		case msg.IsRequest():
			go p.serveRequest(&msg)
		case msg.IsNotification():
			if h := p.onNotify.Load(); h != nil && *h != nil {
				(*h)(msg.Method, msg.Params)
			}
		case msg.IsResponse():
			p.deliver(&msg)
		default:
			p.logger.Debug("mcpwire: dropping malformed message")
		}
	}
}

func (p *Peer) serveRequest(req *Message) {
	if req.Method == "ping" {
		_ = p.respond(req.ID, EmptyResult, nil)
		return
	}
	h := p.onRequest.Load()
	if h == nil || *h == nil {
		_ = p.respond(req.ID, nil, &RPCError{Code: CodeMethodNotFound, Message: fmt.Sprintf("method not found: %s", req.Method)})
		return
	}
	result, rpcErr := (*h)(p.ctx, req.Method, req.Params)
	if rpcErr != nil {
		_ = p.respond(req.ID, nil, rpcErr)
		return
	}
	if result == nil {
		result = EmptyResult
	}
	_ = p.respond(req.ID, result, nil)
}

func (p *Peer) respond(id json.RawMessage, result json.RawMessage, rpcErr *RPCError) error {
	return p.write(&Message{JSONRPC: "2.0", ID: id, Result: result, Error: rpcErr})
}

func (p *Peer) deliver(msg *Message) {
	key := string(msg.ID)
	p.pendingMu.Lock()
	ch, ok := p.pending[key]
	if ok {
		delete(p.pending, key)
	}
	p.pendingMu.Unlock()
	if ok {
		ch <- msg
	}
}

// Call sends a request and waits for its response. A zero timeout uses
// DefaultRequestTimeout. params may be nil, json.RawMessage, or any
// marshalable value.
func (p *Peer) Call(ctx context.Context, method string, params any, timeout time.Duration) (json.RawMessage, error) {
	if timeout <= 0 {
		timeout = DefaultRequestTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	rawParams, err := marshalParams(params)
	if err != nil {
		return nil, fmt.Errorf("marshal params for %s; %w", method, err)
	}

	id := json.RawMessage(strconv.FormatInt(p.nextID.Add(1), 10))
	ch := make(chan *Message, 1)
	key := string(id)

	p.pendingMu.Lock()
	p.pending[key] = ch
	p.pendingMu.Unlock()
	defer func() {
		p.pendingMu.Lock()
		delete(p.pending, key)
		p.pendingMu.Unlock()
	}()

	if err := p.write(&Message{JSONRPC: "2.0", ID: id, Method: method, Params: rawParams}); err != nil {
		return nil, err
	}

	select {
	case resp := <-ch:
		if resp == nil { // channel closed during peer shutdown
			return nil, ErrPeerClosed
		}
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("request %s; %w", method, ctx.Err())
	case <-p.ctx.Done():
		return nil, ErrPeerClosed
	}
}

// Notify sends a fire-and-forget notification.
func (p *Peer) Notify(method string, params any) error {
	rawParams, err := marshalParams(params)
	if err != nil {
		return fmt.Errorf("marshal params for %s; %w", method, err)
	}
	return p.write(&Message{JSONRPC: "2.0", Method: method, Params: rawParams})
}

func marshalParams(params any) (json.RawMessage, error) {
	switch v := params.(type) {
	case nil:
		return nil, nil
	case json.RawMessage:
		return v, nil
	default:
		data, err := json.Marshal(params)
		if err != nil {
			return nil, err
		}
		return data, nil
	}
}

func (p *Peer) write(msg *Message) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal message; %w", err)
	}
	ctx, cancel := context.WithTimeout(p.ctx, writeTimeout)
	defer cancel()

	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if err := p.conn.Write(ctx, websocket.MessageText, data); err != nil {
		return fmt.Errorf("write message; %w", err)
	}
	return nil
}

func (p *Peer) shutdown() {
	p.closeOnce.Do(func() {
		p.cancel()
		_ = p.conn.Close(websocket.StatusNormalClosure, "")
		p.pendingMu.Lock()
		pending := p.pending
		p.pending = map[string]chan *Message{}
		p.pendingMu.Unlock()
		for _, ch := range pending {
			close(ch)
		}
		if f := p.onClose.Load(); f != nil && *f != nil {
			(*f)()
		}
	})
}

// Close tears the connection down and fires OnClose.
func (p *Peer) Close() error {
	p.shutdown()
	return nil
}
