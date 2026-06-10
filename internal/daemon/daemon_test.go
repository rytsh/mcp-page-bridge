package daemon_test

import (
	"net"
	"net/http"
	"testing"

	"github.com/rytsh/mcp-page-bridge/internal/bridge"
	"github.com/rytsh/mcp-page-bridge/internal/daemon"
	"github.com/rytsh/mcp-page-bridge/internal/server"
)

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	return port
}

func startTestBridge(t *testing.T, token string) int {
	t.Helper()
	b := bridge.New(bridge.Options{Token: token})
	srv, err := server.Start(t.Context(), b, server.Options{Token: token})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv.Port()
}

func localDial(port int) daemon.Dial {
	return daemon.Dial{Host: "127.0.0.1", Port: port}
}

func TestProbeNone(t *testing.T) {
	probe := daemon.ProbeBridge(t.Context(), localDial(freePort(t)))
	if probe.Status != daemon.StatusNone {
		t.Fatalf("expected none, got %s", probe.Status)
	}
}

func TestProbeForeign(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"hello":"world"}`))
	})}
	go srv.Serve(listener) //nolint:errcheck
	defer srv.Close()

	probe := daemon.ProbeBridge(t.Context(), localDial(listener.Addr().(*net.TCPAddr).Port))
	if probe.Status != daemon.StatusForeign {
		t.Fatalf("expected foreign, got %s", probe.Status)
	}
}

func TestProbeRealBridge(t *testing.T) {
	port := startTestBridge(t, "")
	probe := daemon.ProbeBridge(t.Context(), localDial(port))
	if probe.Status != daemon.StatusBridge || probe.RequiresToken {
		t.Fatalf("unexpected probe: %+v", probe)
	}
}

func TestProbeTokenProtectedBridge(t *testing.T) {
	port := startTestBridge(t, "secret")
	probe := daemon.ProbeBridge(t.Context(), localDial(port))
	if probe.Status != daemon.StatusBridge || !probe.RequiresToken {
		t.Fatalf("unexpected probe: %+v", probe)
	}
}

func TestAssertCompatibleToken(t *testing.T) {
	ctx := t.Context()
	port := startTestBridge(t, "secret")
	probe := daemon.ProbeBridge(ctx, localDial(port))

	if err := daemon.AssertCompatibleToken(ctx, localDial(port), "", probe); err == nil {
		t.Fatal("expected an error without a token")
	}
	if err := daemon.AssertCompatibleToken(ctx, localDial(port), "wrong", probe); err == nil {
		t.Fatal("expected an error with a wrong token")
	}
	if err := daemon.AssertCompatibleToken(ctx, localDial(port), "secret", probe); err != nil {
		t.Fatalf("matching token rejected: %v", err)
	}
}

func TestAssertTokenAgainstTokenlessBridge(t *testing.T) {
	ctx := t.Context()
	port := startTestBridge(t, "")
	probe := daemon.ProbeBridge(ctx, localDial(port))
	if err := daemon.AssertCompatibleToken(ctx, localDial(port), "extra", probe); err != nil {
		t.Fatalf("tokenless bridge should tolerate a token: %v", err)
	}
}

func TestEnsureRejectsForeignPort(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	srv := &http.Server{Handler: http.NotFoundHandler()}
	go srv.Serve(listener) //nolint:errcheck
	defer srv.Close()

	port := listener.Addr().(*net.TCPAddr).Port
	if err := daemon.Ensure(t.Context(), daemon.EnsureOptions{Dial: localDial(port)}); err == nil {
		t.Fatal("expected an error for a foreign port")
	}
}
