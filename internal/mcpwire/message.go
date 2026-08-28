// Package mcpwire implements a minimal MCP-flavoured JSON-RPC 2.0 peer over a
// WebSocket connection. The bridge is a router, not an endpoint: payloads are
// kept as json.RawMessage and forwarded verbatim so unknown fields (tool
// annotations, _meta, future spec additions) survive the round trip.
package mcpwire

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Message is a raw JSON-RPC 2.0 message (request, notification, or response).
type Message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// RPCError is a JSON-RPC 2.0 error object.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("jsonrpc error %d: %s", e.Code, e.Message)
}

// Standard JSON-RPC error codes used by the bridge.
const (
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603
)

var nullLiteral = []byte("null")

// HasID reports whether the message carries a non-null id.
func (m *Message) HasID() bool {
	return len(m.ID) > 0 && !bytes.Equal(m.ID, nullLiteral)
}

// IsRequest reports whether the message is a request expecting a response.
func (m *Message) IsRequest() bool { return m.Method != "" && m.HasID() }

// IsNotification reports whether the message is a fire-and-forget notification.
func (m *Message) IsNotification() bool { return m.Method != "" && !m.HasID() }

// IsResponse reports whether the message answers an outstanding request.
func (m *Message) IsResponse() bool {
	return m.Method == "" && m.HasID() && (m.Result != nil || m.Error != nil)
}

// EmptyResult is the canonical `{}` result payload.
var EmptyResult = json.RawMessage("{}")
