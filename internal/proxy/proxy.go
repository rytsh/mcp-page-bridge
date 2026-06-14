// Package proxy implements the stdio <-> WebSocket MCP proxy: the agent talks
// newline-delimited JSON-RPC on stdio and the proxy forwards raw frames to the
// bridge daemon's /agent endpoint. No parsing beyond framing — pure passthrough.
package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"

	"github.com/coder/websocket"

	"github.com/rytsh/mcp-page-bridge/internal/protocol"
)

const maxLineSize = 64 << 20

// Options configures the stdio proxy connection to the bridge daemon.
type Options struct {
	Host  string
	Port  int
	Token string
	// Profile is the per-user secret (plaintext). The proxy hashes it locally
	// and sends only the digest as the ?profile= partition key.
	Profile string
	// Secure dials wss:// instead of ws:// (the daemon serves TLS).
	Secure bool
	// TLS optionally customises certificate verification (private CA,
	// skip-verify); nil means standard verification against system roots.
	TLS *tls.Config
}

// Run connects to the daemon and pumps messages until stdin closes, the
// WebSocket closes, or ctx is cancelled.
func Run(ctx context.Context, opts Options) error {
	addr := net.JoinHostPort(opts.Host, strconv.Itoa(opts.Port))
	scheme := "ws"
	if opts.Secure {
		scheme = "wss"
	}
	target := fmt.Sprintf("%s://%s/agent", scheme, addr)
	params := url.Values{}
	if opts.Token != "" {
		params.Set("token", opts.Token)
	}
	if opts.Profile != "" {
		// The raw secret is hashed by the daemon into the partition key.
		params.Set(protocol.ProfileQueryParam, opts.Profile)
	}
	if len(params) > 0 {
		target += "?" + params.Encode()
	}

	dialOpts := &websocket.DialOptions{
		Subprotocols: []string{protocol.WSSubprotocol},
	}
	if opts.TLS != nil {
		dialOpts.HTTPClient = &http.Client{
			Transport: &http.Transport{TLSClientConfig: opts.TLS.Clone()},
		}
	}
	conn, _, err := websocket.Dial(ctx, target, dialOpts)
	if err != nil {
		return fmt.Errorf("dial bridge daemon; %w", err)
	}
	conn.SetReadLimit(maxLineSize)
	defer conn.Close(websocket.StatusNormalClosure, "")

	slog.Info(fmt.Sprintf("MCP stdio proxy ready → %s://%s/agent", scheme, addr))

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
