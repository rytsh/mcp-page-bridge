package server

import _ "embed"

// dashboardHTML is the single-file dashboard build produced by
// packages/dashboard (Svelte + vite-plugin-singlefile). Regenerate with:
//
//	pnpm --filter mcp-page-bridge-dashboard build
//
// The build output is committed so `go install` works from a clean checkout.
//
//go:embed assets/dashboard.html
var dashboardHTML []byte

//go:embed assets/favicon.svg
var faviconSVG []byte
