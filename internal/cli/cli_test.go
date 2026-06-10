package cli

import (
	"testing"

	"github.com/rytsh/mcp-page-bridge/internal/config"
)

func baseConfig() *config.Config {
	return &config.Config{LogLevel: "info", Host: "127.0.0.1", Port: 8787}
}

func TestParseArgsDefaults(t *testing.T) {
	cfg := baseConfig()
	args, err := parseArgs(cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port != 8787 || args.daemon || args.command != "" {
		t.Fatalf("unexpected defaults: cfg=%+v args=%+v", cfg, args)
	}
}

func TestParseArgsOverrides(t *testing.T) {
	cfg := baseConfig()
	args, err := parseArgs(cfg, []string{"--port", "9000", "--token", "s", "--idle-timeout", "2.5", "--daemon"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port != 9000 || cfg.Token != "s" || cfg.IdleTimeout != 2.5 || !args.daemon {
		t.Fatalf("unexpected: cfg=%+v args=%+v", cfg, args)
	}
}

func TestParseArgsStopCommand(t *testing.T) {
	cfg := baseConfig()
	args, err := parseArgs(cfg, []string{"stop", "--port", "9000"})
	if err != nil {
		t.Fatal(err)
	}
	if args.command != "stop" || cfg.Port != 9000 {
		t.Fatalf("unexpected: cfg=%+v args=%+v", cfg, args)
	}
}

func TestParseArgsRejectsBadValues(t *testing.T) {
	for _, argv := range [][]string{
		{"--port", "8787.5"},
		{"--port", "0"},
		{"--port", "70000"},
		{"--port", "abc"},
		{"--idle-timeout", "-1"},
		{"--idle-timeout", "abc"},
		{"--unknown-flag"},
		{"stop", "extra-arg"},
	} {
		if _, err := parseArgs(baseConfig(), argv); err == nil {
			t.Fatalf("expected error for %v", argv)
		}
	}
}

func TestParseArgsHost(t *testing.T) {
	cfg := baseConfig()
	if _, err := parseArgs(cfg, []string{"--host", "0.0.0.0", "--token", "s"}); err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "0.0.0.0" {
		t.Fatalf("host = %q", cfg.Host)
	}
}

func TestParseArgsTokenlessHosts(t *testing.T) {
	// Non-loopback binds without a token are allowed (with a logged warning):
	// the user may deliberately run tokenless on a trusted network.
	for _, host := range []string{"0.0.0.0", "192.168.1.5", "::", "127.0.0.1", "localhost", "::1", "127.1.2.3"} {
		if _, err := parseArgs(baseConfig(), []string{"--host", host}); err != nil {
			t.Fatalf("unexpected error for host %s: %v", host, err)
		}
	}
}
