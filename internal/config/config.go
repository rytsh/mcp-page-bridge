// Package config loads the bridge configuration the rakunlabs way: chu layers
// default -> file -> env (MCP_PAGE_BRIDGE_*), then explicit CLI flags override.
package config

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"net"
	"os"

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

	// TLS switches clients (stdio proxy, stop, probes) to https/wss; it is
	// implied when TLSCert+TLSKey are set, so it is mainly for attaching to a
	// remote bridge that already serves TLS.
	TLS bool `cfg:"tls"`
	// TLSCert/TLSKey are PEM file paths; when both are set the daemon serves
	// HTTPS/WSS on its port.
	TLSCert string `cfg:"tls_cert"`
	TLSKey  string `cfg:"tls_key"`
	// TLSCA is an optional PEM CA bundle clients use to verify the bridge
	// certificate (e.g. a self-signed or private CA).
	TLSCA string `cfg:"tls_ca"`
	// TLSInsecureSkipVerify disables client certificate verification.
	// Testing only — the connection stays encrypted but is not authenticated.
	TLSInsecureSkipVerify bool `cfg:"tls_insecure_skip_verify"`
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
	if (c.TLSCert == "") != (c.TLSKey == "") {
		return fmt.Errorf("tls-cert and tls-key must be set together (got cert=%q key=%q)", c.TLSCert, c.TLSKey)
	}
	if !c.LoopbackOnly() && c.Token == "" {
		// Deliberately a warning, not an error: the user may want a
		// tokenless bridge on a trusted/isolated network.
		slog.Warn(fmt.Sprintf(
			"binding %s without a token: page tools (eval etc.) are exposed to the network; "+
				"pass --token <secret> (or set MCP_PAGE_BRIDGE_TOKEN) unless this is intentional", c.Host))
	}
	if !c.LoopbackOnly() && !c.ServesTLS() {
		slog.Warn(fmt.Sprintf(
			"binding %s without TLS: traffic (including the token) crosses the network in cleartext; "+
				"pass --tls-cert/--tls-key unless this is intentional", c.Host))
	}
	if c.TLSInsecureSkipVerify {
		slog.Warn("tls-insecure is set: the bridge certificate is NOT verified (testing only)")
	}
	return nil
}

// ServesTLS reports whether the daemon should serve HTTPS/WSS.
func (c *Config) ServesTLS() bool {
	return c.TLSCert != "" && c.TLSKey != ""
}

// TLSEnabled reports whether clients should dial the bridge with https/wss.
func (c *Config) TLSEnabled() bool {
	return c.TLS || c.ServesTLS()
}

// ClientTLS builds the client-side TLS configuration (nil when TLS is off).
func (c *Config) ClientTLS() (*tls.Config, error) {
	if !c.TLSEnabled() {
		return nil, nil
	}
	tc := &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: c.TLSInsecureSkipVerify, //nolint:gosec // explicit opt-in for testing
	}
	if c.TLSCA != "" {
		pem, err := os.ReadFile(c.TLSCA)
		if err != nil {
			return nil, fmt.Errorf("read tls-ca %s; %w", c.TLSCA, err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("tls-ca %s: no PEM certificates found", c.TLSCA)
		}
		tc.RootCAs = pool
	}
	return tc, nil
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
