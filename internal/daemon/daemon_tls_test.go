package daemon_test

import (
	"crypto/tls"
	"testing"

	"github.com/rytsh/mcp-page-bridge/internal/bridge"
	"github.com/rytsh/mcp-page-bridge/internal/daemon"
	"github.com/rytsh/mcp-page-bridge/internal/server"
	"github.com/rytsh/mcp-page-bridge/internal/testcert"
)

// startTLSBridge runs a bridge that serves HTTPS/WSS with a throwaway
// self-signed certificate and returns its port plus a trusting client config.
func startTLSBridge(t *testing.T, token string) (int, *tls.Config) {
	t.Helper()
	certFile, keyFile, pool, err := testcert.Generate(t.TempDir())
	if err != nil {
		t.Fatalf("generate test certificate: %v", err)
	}
	b := bridge.New(bridge.Options{Token: token})
	srv, err := server.Start(t.Context(), b, server.Options{
		Token:   token,
		TLSCert: certFile,
		TLSKey:  keyFile,
	})
	if err != nil {
		t.Fatalf("start TLS server: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv.Port(), &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
}

func TestProbeTLSBridge(t *testing.T) {
	port, clientTLS := startTLSBridge(t, "")

	dial := daemon.Dial{Host: "127.0.0.1", Port: port, Secure: true, TLS: clientTLS}
	if probe := daemon.ProbeBridge(t.Context(), dial); probe.Status != daemon.StatusBridge {
		t.Fatalf("expected bridge over TLS, got %s", probe.Status)
	}

	// Without trusting the CA the handshake must fail (not silently attach).
	noTrust := daemon.Dial{Host: "127.0.0.1", Port: port, Secure: true}
	if probe := daemon.ProbeBridge(t.Context(), noTrust); probe.Status == daemon.StatusBridge {
		t.Fatal("untrusted certificate must not probe as a bridge")
	}

	// Explicit opt-in skip-verify still works (e.g. testing setups).
	skip := daemon.Dial{Host: "127.0.0.1", Port: port, Secure: true,
		TLS: &tls.Config{InsecureSkipVerify: true}} //nolint:gosec // test
	if probe := daemon.ProbeBridge(t.Context(), skip); probe.Status != daemon.StatusBridge {
		t.Fatalf("skip-verify probe failed: %s", probe.Status)
	}

	// Plain http against the TLS port must not be classified as a bridge.
	if probe := daemon.ProbeBridge(t.Context(), localDial(port)); probe.Status == daemon.StatusBridge {
		t.Fatal("plaintext probe against a TLS port must not report a bridge")
	}
}

func TestProbeTLSBridgeWithToken(t *testing.T) {
	port, clientTLS := startTLSBridge(t, "secret")
	dial := daemon.Dial{Host: "127.0.0.1", Port: port, Secure: true, TLS: clientTLS}

	probe := daemon.ProbeBridge(t.Context(), dial)
	if probe.Status != daemon.StatusBridge || !probe.RequiresToken {
		t.Fatalf("unexpected probe: %+v", probe)
	}
	if err := daemon.AssertCompatibleToken(t.Context(), dial, "wrong", probe); err == nil {
		t.Fatal("expected an error with a wrong token over TLS")
	}
	if err := daemon.AssertCompatibleToken(t.Context(), dial, "secret", probe); err != nil {
		t.Fatalf("matching token rejected over TLS: %v", err)
	}
}
