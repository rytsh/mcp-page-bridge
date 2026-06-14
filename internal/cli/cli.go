// Package cli dispatches the mcp-page-bridge subcommands: the default stdio
// proxy mode, the internal --daemon mode, and `stop`.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/rakunlabs/into"

	"github.com/rytsh/mcp-page-bridge/internal/bridge"
	"github.com/rytsh/mcp-page-bridge/internal/config"
	"github.com/rytsh/mcp-page-bridge/internal/daemon"
	"github.com/rytsh/mcp-page-bridge/internal/protocol"
	"github.com/rytsh/mcp-page-bridge/internal/proxy"
	"github.com/rytsh/mcp-page-bridge/internal/server"
)

// Run is the into.Init entrypoint.
func Run(ctx context.Context, argv []string) error {
	cfg, err := config.Load(ctx)
	if err != nil {
		return err
	}
	args, err := parseArgs(cfg, argv)
	if errors.Is(err, flag.ErrHelp) {
		return nil // usage already printed by the flag package
	}
	if err != nil {
		return err
	}

	dialHost := config.DialHost(cfg.Host)
	clientTLS, err := cfg.ClientTLS()
	if err != nil {
		return err
	}
	dial := daemon.Dial{
		Host:   dialHost,
		Port:   cfg.Port,
		Secure: cfg.TLSEnabled(),
		TLS:    clientTLS,
	}

	switch {
	case args.command == "stop":
		return daemon.Stop(ctx, dial, cfg.Token)
	case args.command == "profile-hash":
		return runProfileHash(args.positional, cfg.Profile)
	case args.command != "":
		return fmt.Errorf("unknown command %q (expected: stop, profile-hash)", args.command)
	case args.daemon:
		return runDaemon(ctx, cfg)
	default:
		if err := daemon.Ensure(ctx, daemon.EnsureOptions{
			BindHost:       cfg.Host,
			Dial:           dial,
			Token:          cfg.Token,
			RequireProfile: cfg.RequireProfile,
			IdleTimeoutSec: cfg.IdleTimeout,
			TLSCert:        cfg.TLSCert,
			TLSKey:         cfg.TLSKey,
		}); err != nil {
			return err
		}
		return proxy.Run(ctx, proxy.Options{
			Host:    dialHost,
			Port:    cfg.Port,
			Token:   cfg.Token,
			Profile: cfg.Profile,
			Secure:  cfg.TLSEnabled(),
			TLS:     clientTLS,
		})
	}
}

// runProfileHash prints the partition key for a profile secret so it can be
// pasted into a remote /mcp client's x-mcp-page-bridge-profile header (the
// stdio proxy and the extension compute it for you).
func runProfileHash(positional, flagProfile string) error {
	secret := positional
	if secret == "" {
		secret = flagProfile
	}
	if secret == "" {
		return fmt.Errorf("usage: mcp-page-bridge profile-hash <secret>  (or pass --profile <secret>)")
	}
	fmt.Println(protocol.HashProfile(secret))
	return nil
}

// runDaemon hosts the bridge until ctx is cancelled (signal), an idle timeout
// fires, or the dashboard requests shutdown.
func runDaemon(ctx context.Context, cfg *config.Config) error {
	idleTimeout := time.Duration(cfg.IdleTimeout * float64(time.Second))

	b := bridge.New(bridge.Options{
		Token:          cfg.Token,
		RequireProfile: cfg.RequireProfile,
		IdleTimeout:    idleTimeout,
		OnIdleShutdown: func() {
			slog.Info(fmt.Sprintf("idle for %s with no agents/providers; shutting down", idleTimeout))
			into.CtxCancel()
		},
	})

	srv, err := server.Start(ctx, b, server.Options{
		Host:       cfg.Host,
		Port:       cfg.Port,
		Token:      cfg.Token,
		TLSCert:    cfg.TLSCert,
		TLSKey:     cfg.TLSKey,
		OnShutdown: into.CtxCancel,
	})
	if err != nil {
		return fmt.Errorf("start bridge server; %w", err)
	}
	defer func() {
		_ = srv.Close()
	}()

	pidFile := daemon.PIDFilePath(srv.Port())
	daemon.WritePIDFile(pidFile)
	defer daemon.RemovePIDFile(pidFile)

	displayHost := cfg.Host
	if displayHost == "" {
		displayHost = "127.0.0.1"
	}
	wsScheme, httpScheme := "ws", "http"
	if cfg.ServesTLS() {
		wsScheme, httpScheme = "wss", "https"
	}
	banner := fmt.Sprintf("daemon v%s — %s://%s:%d · dashboard %s://%s:%d/",
		protocol.Version, wsScheme, displayHost, srv.Port(), httpScheme, displayHost, srv.Port())
	if cfg.Token != "" {
		banner += " (token required)"
	}
	if idleTimeout > 0 {
		banner += " · idle-timeout " + strconv.FormatFloat(cfg.IdleTimeout, 'f', -1, 64) + "s"
	}
	slog.Info(banner)

	<-ctx.Done()
	return nil
}

// ---- flag handling -------------------------------------------------------------

type cliArgs struct {
	command    string
	positional string
	daemon     bool
}

// parseArgs reads an optional leading subcommand, then parses flags with the
// standard flag package. Defaults come from the chu-loaded config, so the
// precedence is: flag > env > config file > default.
func parseArgs(cfg *config.Config, argv []string) (cliArgs, error) {
	var args cliArgs
	if len(argv) > 0 && !strings.HasPrefix(argv[0], "-") {
		args.command = argv[0]
		argv = argv[1:]
	}

	fs := flag.NewFlagSet(config.ServiceName, flag.ContinueOnError)
	fs.StringVar(&cfg.Host, "host", cfg.Host,
		"bind host; non-loopback (e.g. 0.0.0.0) requires --token (env MCP_PAGE_BRIDGE_HOST)")
	fs.IntVar(&cfg.Port, "port", cfg.Port, "bridge port (env MCP_PAGE_BRIDGE_PORT)")
	fs.StringVar(&cfg.Token, "token", cfg.Token, "shared auth token (env MCP_PAGE_BRIDGE_TOKEN)")
	fs.StringVar(&cfg.Profile, "profile", cfg.Profile,
		"per-user profile secret; only see tabs sharing it, hashed locally (env MCP_PAGE_BRIDGE_PROFILE)")
	fs.BoolVar(&cfg.RequireProfile, "require-profile", cfg.RequireProfile,
		"daemon: reject connections without a profile key — multi-user mode (env MCP_PAGE_BRIDGE_REQUIRE_PROFILE)")
	fs.Float64Var(&cfg.IdleTimeout, "idle-timeout", cfg.IdleTimeout,
		"shut the daemon down after this many idle seconds; 0 disables (env MCP_PAGE_BRIDGE_IDLE_TIMEOUT)")
	fs.BoolVar(&cfg.TLS, "tls", cfg.TLS,
		"dial the bridge with https/wss; implied by --tls-cert/--tls-key (env MCP_PAGE_BRIDGE_TLS)")
	fs.StringVar(&cfg.TLSCert, "tls-cert", cfg.TLSCert,
		"PEM certificate file; with --tls-key the daemon serves TLS (env MCP_PAGE_BRIDGE_TLS_CERT)")
	fs.StringVar(&cfg.TLSKey, "tls-key", cfg.TLSKey,
		"PEM private key file for --tls-cert (env MCP_PAGE_BRIDGE_TLS_KEY)")
	fs.StringVar(&cfg.TLSCA, "tls-ca", cfg.TLSCA,
		"PEM CA bundle used to verify the bridge certificate, e.g. a private CA (env MCP_PAGE_BRIDGE_TLS_CA)")
	fs.BoolVar(&cfg.TLSInsecureSkipVerify, "tls-insecure", cfg.TLSInsecureSkipVerify,
		"skip TLS certificate verification — testing only (env MCP_PAGE_BRIDGE_TLS_INSECURE_SKIP_VERIFY)")
	fs.BoolVar(&args.daemon, "daemon", false, "run the bridge daemon in the foreground (internal)")
	if err := fs.Parse(argv); err != nil {
		return args, err
	}
	if fs.NArg() > 0 {
		// `profile-hash <secret>` takes a single positional secret.
		if args.command == "profile-hash" && fs.NArg() == 1 {
			args.positional = fs.Arg(0)
		} else {
			return args, fmt.Errorf("unexpected argument %q", fs.Arg(0))
		}
	}
	return args, cfg.Validate()
}
