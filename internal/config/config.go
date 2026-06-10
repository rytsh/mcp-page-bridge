// Package config loads the bridge configuration the rakunlabs way: chu layers
// default -> file -> env (MCP_PAGE_BRIDGE_*), then explicit CLI flags override.
package config

import (
	"context"
	"fmt"
	"log/slog"
	"net"

	"github.com/rakunlabs/chu"
	"github.com/rakunlabs/chu/loader/loaderenv"
	"github.com/rakunlabs/logi"

	"github.com/rytsh/mcp-page-bridge/internal/protocol"
)

// ServiceName is the chu config name (file lookup) and the env prefix base.
const ServiceName = "mcp-page-bridge"

// Config is the full bridge/CLI configuration.
type Config struct {
	LogLevel string `cfg:"log_level" default:"info"`
	Host     string `cfg:"host"      default:"127.0.0.1"`
	Port     int    `cfg:"port"      default:"8787"`
	Token    string `cfg:"token"     log:"-"`
	// IdleTimeout is in seconds; 0 disables idle auto-shutdown.
	IdleTimeout float64 `cfg:"idle_timeout"`
}

// Load resolves configuration from defaults, an optional
// mcp-page-bridge.{toml,yaml,yml,json} file, and MCP_PAGE_BRIDGE_* env vars.
func Load(ctx context.Context) (*Config, error) {
	var cfg Config
	if err := chu.Load(ctx, ServiceName, &cfg,
		chu.WithLoaderOption(loaderenv.New(
			loaderenv.WithPrefix("MCP_PAGE_BRIDGE_"),
		)),
		chu.WithVersion(protocol.Version),
	); err != nil {
		return nil, fmt.Errorf("load config; %w", err)
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	if err := logi.SetLogLevel(cfg.LogLevel); err != nil {
		return nil, fmt.Errorf("set log level %s; %w", cfg.LogLevel, err)
	}

	// MarshalMap honours log:"-" so the token stays out of the log.
	slog.Debug("loaded configuration", "config", chu.MarshalMap(cfg))

	return &cfg, nil
}

// Validate enforces the same bounds as the TypeScript CLI.
func (c *Config) Validate() error {
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("invalid port %d: expected an integer in 1..65535", c.Port)
	}
	if c.IdleTimeout < 0 {
		return fmt.Errorf("invalid idle-timeout %v: expected a non-negative number of seconds", c.IdleTimeout)
	}
	if !c.LoopbackOnly() && c.Token == "" {
		// Deliberately a warning, not an error: the user may want a
		// tokenless bridge on a trusted/isolated network.
		slog.Warn(fmt.Sprintf(
			"binding %s without a token: page tools (eval etc.) are exposed to the network; "+
				"pass --token <secret> (or set MCP_PAGE_BRIDGE_TOKEN) unless this is intentional", c.Host))
	}
	return nil
}

// LoopbackOnly reports whether the configured bind host is loopback-only.
func (c *Config) LoopbackOnly() bool {
	return IsLoopbackHost(c.Host)
}

// IsLoopbackHost reports whether host refers to the loopback interface only.
func IsLoopbackHost(host string) bool {
	if host == "" || host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// DialHost returns the address clients on this machine should dial to reach a
// bridge bound to host: loopback for loopback/unspecified binds (0.0.0.0 and
// :: also listen on loopback), otherwise the specific address.
func DialHost(host string) string {
	if IsLoopbackHost(host) {
		return "127.0.0.1"
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsUnspecified() {
		return "127.0.0.1"
	}
	return host
}
