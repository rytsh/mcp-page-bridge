// Command mcp-page-bridge bridges live browser-page MCP servers to a coding
// agent. Default mode runs a stdio proxy (spawning a shared background daemon
// when needed); see also the internal --daemon mode and the `stop` command.
package main

import (
	"context"
	"os"

	"github.com/rakunlabs/into"
	"github.com/rakunlabs/logi"

	"github.com/rytsh/mcp-page-bridge/internal/cli"
	"github.com/rytsh/mcp-page-bridge/internal/config"
	"github.com/rytsh/mcp-page-bridge/internal/protocol"
)

// Injected at build time via -ldflags (protocol.Version carries the release
// version; these add VCS metadata to the banner).
var (
	commit = "-"
	date   = "-"
)

func main() {
	into.Init(run,
		into.WithLogger(logi.InitializeLog(logi.WithCaller(false))),
		into.WithMsgf("%s version:[%s] commit:[%s] date:[%s]",
			config.ServiceName, protocol.Version, commit, date),
	)
}

func run(ctx context.Context) error {
	return cli.Run(ctx, os.Args[1:])
}
