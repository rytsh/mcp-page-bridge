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

	switch {
	case args.command == "stop":
		return daemon.Stop(ctx, dialHost, cfg.Port, cfg.Token)
	case args.command != "":
		return fmt.Errorf("unknown command %q (expected: stop)", args.command)
	case args.daemon:
		return runDaemon(ctx, cfg)
	default:
		if err := daemon.Ensure(ctx, daemon.EnsureOptions{
			BindHost:       cfg.Host,
			DialHost:       dialHost,
			Port:           cfg.Port,
			Token:          cfg.Token,
			IdleTimeoutSec: cfg.IdleTimeout,
		}); err != nil {
			return err
		}
		return proxy.Run(ctx, dialHost, cfg.Port, cfg.Token)
	}
}

// runDaemon hosts the bridge until ctx is cancelled (signal), an idle timeout
// fires, or the dashboard requests shutdown.
func runDaemon(ctx context.Context, cfg *config.Config) error {
	idleTimeout := time.Duration(cfg.IdleTimeout * float64(time.Second))

	b := bridge.New(bridge.Options{
		Token:       cfg.Token,
		IdleTimeout: idleTimeout,
		OnIdleShutdown: func() {
			slog.Info(fmt.Sprintf("idle for %s with no agents/providers; shutting down", idleTimeout))
			into.CtxCancel()
		},
	})

	srv, err := server.Start(ctx, b, server.Options{
		Host:       cfg.Host,
		Port:       cfg.Port,
		Token:      cfg.Token,
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
	banner := fmt.Sprintf("daemon v%s — ws://%s:%d · dashboard http://%s:%d/",
		protocol.Version, displayHost, srv.Port(), displayHost, srv.Port())
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
	command string
	daemon  bool
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
	fs.Float64Var(&cfg.IdleTimeout, "idle-timeout", cfg.IdleTimeout,
		"shut the daemon down after this many idle seconds; 0 disables (env MCP_PAGE_BRIDGE_IDLE_TIMEOUT)")
	fs.BoolVar(&args.daemon, "daemon", false, "run the bridge daemon in the foreground (internal)")
	if err := fs.Parse(argv); err != nil {
		return args, err
	}
	if fs.NArg() > 0 {
		return args, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	return args, cfg.Validate()
}
