// Package daemon manages the background bridge process: probing the port,
// spawning a detached daemon, pid files, and the stop command.
package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/rytsh/mcp-page-bridge/internal/protocol"
)

const (
	probeTimeout      = 500 * time.Millisecond
	shutdownTimeout   = 2 * time.Second
	readyTimeout      = 5 * time.Second
	readyPollInterval = 100 * time.Millisecond
	pidFileEnv        = "MCP_PAGE_BRIDGE_DAEMON_PID_FILE"
	daemonFlag        = "--daemon"
)

// ProbeStatus classifies what listens on the bridge port.
type ProbeStatus string

const (
	StatusNone    ProbeStatus = "none"    // nothing listening
	StatusForeign ProbeStatus = "foreign" // some non-bridge HTTP server
	StatusBridge  ProbeStatus = "bridge"  // a real mcp-page-bridge
)

// Probe is the result of inspecting the bridge port.
type Probe struct {
	Status        ProbeStatus
	RequiresToken bool
}

// apiURL builds a bridge API URL with correct IPv6 bracketing.
func apiURL(host string, port int, path string) string {
	return "http://" + net.JoinHostPort(host, strconv.Itoa(port)) + path
}

// PIDFilePath returns the daemon pid file path for a port (env override for tests).
func PIDFilePath(port int) string {
	if p := os.Getenv(pidFileEnv); p != "" {
		return p
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("mcp-page-bridge-%d.pid", port))
}

// WritePIDFile records the current process pid; failures are non-fatal.
func WritePIDFile(path string) {
	if err := os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o644); err != nil {
		slog.Warn("failed to write pid file", "error", err)
	}
}

// RemovePIDFile best-effort removes the pid file.
func RemovePIDFile(path string) {
	_ = os.Remove(path)
}

func readPIDFile(port int) (int, bool) {
	data, err := os.ReadFile(PIDFilePath(port))
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

func getWithTimeout(ctx context.Context, url string, headers map[string]string, timeout time.Duration) (*http.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	// Bound body lifetime to this helper's callers; they must close it.
	return resp, nil //nolint:bodyclose
}

// ProbeBridge identifies what (if anything) is listening on the bridge HTTP port.
func ProbeBridge(ctx context.Context, host string, port int) Probe {
	resp, err := getWithTimeout(ctx, apiURL(host, port, "/api/health"), nil, probeTimeout)
	if err != nil {
		return Probe{Status: StatusNone}
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		var body struct {
			Service       string `json:"service"`
			RequiresToken bool   `json:"requiresToken"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&body)
		if body.Service == protocol.ServiceID {
			return Probe{Status: StatusBridge, RequiresToken: body.RequiresToken}
		}
		return Probe{Status: StatusForeign}
	}
	if resp.StatusCode == http.StatusNotFound {
		// Possibly an older bridge without /api/health: fall back to /api/providers.
		legacy, err := getWithTimeout(ctx, apiURL(host, port, "/api/providers"), nil, probeTimeout)
		if err != nil {
			return Probe{Status: StatusNone}
		}
		defer legacy.Body.Close()
		if legacy.StatusCode == http.StatusUnauthorized {
			return Probe{Status: StatusBridge, RequiresToken: true}
		}
		if legacy.StatusCode == http.StatusOK {
			var body struct {
				Providers []json.RawMessage `json:"providers"`
			}
			if json.NewDecoder(legacy.Body).Decode(&body) == nil && body.Providers != nil {
				return Probe{Status: StatusBridge}
			}
		}
		return Probe{Status: StatusForeign}
	}
	return Probe{Status: StatusForeign}
}

func tokenAccepted(ctx context.Context, host string, port int, token string) bool {
	resp, err := getWithTimeout(ctx, apiURL(host, port, "/api/providers"),
		map[string]string{protocol.TokenHeader: token}, probeTimeout)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// AssertCompatibleToken verifies an already-running bridge accepts this
// agent's token before attaching.
func AssertCompatibleToken(ctx context.Context, host string, port int, token string, probe Probe) error {
	if probe.Status != StatusBridge {
		return nil
	}
	if probe.RequiresToken {
		if token == "" {
			return fmt.Errorf(
				"a bridge is already running on port %d and requires a token; "+
					"pass --token <secret> (or set MCP_PAGE_BRIDGE_TOKEN) to attach", port)
		}
		if !tokenAccepted(ctx, host, port, token) {
			return fmt.Errorf(
				"a bridge is already running on port %d but rejected the provided token; "+
					"every agent on this port must use the same --token", port)
		}
		return nil
	}
	if token != "" {
		slog.Info(fmt.Sprintf(
			"note: a tokenless bridge is already running on port %d; the provided token is ignored for this attach", port))
	}
	return nil
}

// EnsureOptions configures Ensure.
type EnsureOptions struct {
	// BindHost is what the spawned daemon binds (e.g. "0.0.0.0").
	BindHost string
	// DialHost is where this process reaches the daemon (e.g. "127.0.0.1").
	DialHost string
	Port     int
	Token    string
	// IdleTimeoutSec > 0 makes the daemon exit after that many idle seconds.
	IdleTimeoutSec float64
}

// Ensure attaches to a running bridge or spawns a detached daemon and waits
// until it is ready.
func Ensure(ctx context.Context, opts EnsureOptions) error {
	port := opts.Port
	existing := ProbeBridge(ctx, opts.DialHost, port)
	switch existing.Status {
	case StatusBridge:
		return AssertCompatibleToken(ctx, opts.DialHost, port, opts.Token, existing)
	case StatusForeign:
		return fmt.Errorf("port %d is in use by a non-mcp-page-bridge server; choose another port with --port <n>", port)
	}

	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable; %w", err)
	}
	args := []string{daemonFlag, "--port", strconv.Itoa(port)}
	if opts.BindHost != "" {
		args = append(args, "--host", opts.BindHost)
	}
	if opts.IdleTimeoutSec > 0 {
		args = append(args, "--idle-timeout", strconv.FormatFloat(opts.IdleTimeoutSec, 'f', -1, 64))
	}

	cmd := exec.Command(executable, args...)
	cmd.Env = append(os.Environ(), "MCP_PAGE_BRIDGE_PORT="+strconv.Itoa(port))
	if opts.BindHost != "" {
		cmd.Env = append(cmd.Env, "MCP_PAGE_BRIDGE_HOST="+opts.BindHost)
	}
	if opts.Token != "" {
		cmd.Env = append(cmd.Env, "MCP_PAGE_BRIDGE_TOKEN="+opts.Token)
	}
	cmd.SysProcAttr = detachedProcAttr()
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("spawn bridge daemon; %w", err)
	}

	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	deadline := time.Now().Add(readyTimeout)
	for time.Now().Before(deadline) {
		select {
		case err := <-exited:
			return fmt.Errorf("bridge daemon exited before it was ready (%v)", err)
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(readyPollInterval):
		}
		if ProbeBridge(ctx, opts.DialHost, port).Status == StatusBridge {
			slog.Info(fmt.Sprintf("started background bridge daemon on port %d", port))
			return nil
		}
	}
	return fmt.Errorf("timed out waiting for bridge daemon on port %d", port)
}

// Stop shuts down a running daemon on the given host/port.
func Stop(ctx context.Context, host string, port int, token string) error {
	probe := ProbeBridge(ctx, host, port)
	if probe.Status == StatusNone {
		slog.Info(fmt.Sprintf("no bridge is running on port %d", port))
		return nil
	}
	if probe.Status == StatusForeign {
		return fmt.Errorf("port %d is held by a non-mcp-page-bridge server; refusing to stop it", port)
	}
	if probe.RequiresToken && token == "" {
		return fmt.Errorf("the bridge on port %d requires a token; pass --token <secret> to stop it", port)
	}

	reqCtx, cancel := context.WithTimeout(ctx, shutdownTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost,
		apiURL(host, port, "/api/shutdown"), nil)
	if err != nil {
		return err
	}
	req.Header.Set(protocol.DashboardHeader, protocol.DashboardHeaderValue)
	if token != "" {
		req.Header.Set(protocol.TokenHeader, token)
	}

	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			slog.Info(fmt.Sprintf("shutdown requested on port %d", port))
			return nil
		}
		err = fmt.Errorf("shutdown endpoint returned %d", resp.StatusCode)
	}

	// Fall back to a PID signal if the HTTP request failed.
	if pid, ok := readPIDFile(port); ok {
		if killErr := terminateProcess(pid); killErr == nil {
			slog.Info(fmt.Sprintf("sent SIGTERM to daemon pid %d on port %d", pid, port))
			return nil
		}
	}
	return err
}
