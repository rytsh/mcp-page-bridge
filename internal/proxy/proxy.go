// Package proxy implements the stdio <-> WebSocket MCP proxy: the agent talks
// newline-delimited JSON-RPC on stdio and the proxy forwards raw frames to the
// bridge daemon's /agent endpoint. No parsing beyond framing — pure passthrough.
package proxy

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os"
	"strconv"

	"github.com/coder/websocket"

	"github.com/rytsh/mcp-page-bridge/internal/protocol"
)

const maxLineSize = 64 << 20

// Run connects to the daemon and pumps messages until stdin closes, the
// WebSocket closes, or ctx is cancelled.
func Run(ctx context.Context, host string, port int, token string) error {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	target := fmt.Sprintf("ws://%s/agent", addr)
	if token != "" {
		target += "?token=" + url.QueryEscape(token)
	}

	conn, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{
		Subprotocols: []string{protocol.WSSubprotocol},
	})
	if err != nil {
		return fmt.Errorf("dial bridge daemon; %w", err)
	}
	conn.SetReadLimit(maxLineSize)
	defer conn.Close(websocket.StatusNormalClosure, "")

	slog.Info(fmt.Sprintf("MCP stdio proxy ready → ws://%s/agent", addr))

	done := make(chan error, 2)

	// stdin -> websocket
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64*1024), maxLineSize)
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			if err := conn.Write(ctx, websocket.MessageText, line); err != nil {
				done <- fmt.Errorf("forward to daemon; %w", err)
				return
			}
		}
		if err := scanner.Err(); err != nil {
			done <- fmt.Errorf("read stdin; %w", err)
			return
		}
		done <- io.EOF // agent closed stdin: normal shutdown
	}()

	// websocket -> stdout
	go func() {
		out := bufio.NewWriter(os.Stdout)
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				done <- err
				return
			}
			if _, err := out.Write(data); err != nil {
				done <- fmt.Errorf("write stdout; %w", err)
				return
			}
			if err := out.WriteByte('\n'); err != nil {
				done <- fmt.Errorf("write stdout; %w", err)
				return
			}
			if err := out.Flush(); err != nil {
				done <- fmt.Errorf("flush stdout; %w", err)
				return
			}
		}
	}()

	select {
	case <-ctx.Done():
		return nil
	case err := <-done:
		if errors.Is(err, io.EOF) || websocket.CloseStatus(err) != -1 || errors.Is(err, context.Canceled) {
			return nil // normal teardown from either side
		}
		return err
	}
}
