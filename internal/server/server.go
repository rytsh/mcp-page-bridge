// Package server hosts the bridge's HTTP surface: the WebSocket endpoint for
// browsers/agents, the status dashboard, and the local JSON API.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/rakunlabs/ada"
	mlog "github.com/rakunlabs/ada/middleware/log"
	mrecover "github.com/rakunlabs/ada/middleware/recover"
	mrequestid "github.com/rakunlabs/ada/middleware/requestid"
	mserver "github.com/rakunlabs/ada/middleware/server"

	"github.com/rytsh/mcp-page-bridge/internal/bridge"
	"github.com/rytsh/mcp-page-bridge/internal/config"
	"github.com/rytsh/mcp-page-bridge/internal/protocol"
)

// Options configures the HTTP server.
type Options struct {
	Host  string
	Port  int
	Token string
	// OnShutdown is invoked (async) after POST /api/shutdown is accepted.
	OnShutdown func()
	Logger     *slog.Logger
}

// Server is the bridge's HTTP + WebSocket front.
type Server struct {
	bridge     *bridge.Bridge
	opts       Options
	port       int
	httpServer *http.Server
	logger     *slog.Logger
}

// Start listens (supporting port 0 for tests), wires routes, and serves in the
// background until Close.
func Start(ctx context.Context, b *bridge.Bridge, opts Options) (*Server, error) {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	host := opts.Host
	if host == "" {
		host = "127.0.0.1"
	}

	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, opts.Port))
	if err != nil {
		return nil, fmt.Errorf("listen on %s:%d; %w", host, opts.Port, err)
	}

	s := &Server{
		bridge: b,
		opts:   opts,
		port:   listener.Addr().(*net.TCPAddr).Port,
		logger: logger,
	}

	mux := ada.NewMux()
	mux.Use(
		mrecover.Middleware(), // panic -> 500, keep the daemon alive
		mserver.Middleware(protocol.ServiceID),
		mrequestid.Middleware(),
		mlog.Middleware(),
		// NOTE: deliberately no CORS middleware — this API is local-only and
		// actively rejects cross-origin via Host/Origin validation; permissive
		// CORS headers would weaken that defense.
	)
	s.routes(mux)

	// WebSocket upgrades may target any path (providers connect to "/", agents
	// to "/agent"), so split them off before the HTTP router.
	root := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			b.HandleWS(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})

	s.httpServer = &http.Server{
		Handler:           root,
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	go func() {
		if err := s.httpServer.Serve(listener); err != nil && err != http.ErrServerClosed {
			logger.Error("http server error", "error", err)
		}
	}()

	return s, nil
}

// Port returns the actual bound port (useful when 0 was requested).
func (s *Server) Port() int { return s.port }

// Close shuts the HTTP server and the bridge down.
func (s *Server) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := s.httpServer.Shutdown(ctx)
	s.bridge.Close()
	return err
}

// ---- routes -----------------------------------------------------------------

func (s *Server) routes(mux *ada.Mux) {
	mux.GET("/", s.handleDashboard)
	mux.GET("/ui", s.handleDashboard)
	mux.GET("/favicon.svg", s.handleFavicon)
	mux.GET("/api/health", s.handleHealth)
	mux.GET("/api/providers", s.handleProviders)
	mux.GET("/providers.json", s.handleProviders)
	mux.POST("/api/shutdown", s.handleShutdown)
	mux.POST("/api/providers/{label}/{action}", s.handleProviderAction)
	mux.NotFound(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
	})
}

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	if !s.hostAllowed(r) {
		s.denyJSON(w, http.StatusForbidden, "request is not local (bad Host/Origin)")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(dashboardHTML)
}

func (s *Server) handleFavicon(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "max-age=86400")
	_, _ = w.Write(faviconSVG)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if !s.hostAllowed(r) {
		s.denyJSON(w, http.StatusForbidden, "request is not local (bad Host/Origin)")
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"service":       protocol.ServiceID,
		"version":       protocol.Version,
		"requiresToken": s.opts.Token != "",
		"port":          s.port,
	})
}

func (s *Server) handleProviders(w http.ResponseWriter, r *http.Request) {
	if !s.hostAllowed(r) {
		s.denyJSON(w, http.StatusForbidden, "request is not local (bad Host/Origin)")
		return
	}
	if !s.tokenOK(r) {
		s.denyJSON(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"service":   protocol.ServiceID,
		"version":   protocol.Version,
		"port":      s.port,
		"providers": s.bridge.ProviderSummary(),
	})
}

func (s *Server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeStateChange(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "close")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"ok":true}`))

	go func() {
		// Let the response flush before tearing the server down.
		time.Sleep(50 * time.Millisecond)
		if err := s.Close(); err != nil {
			s.logger.Error("shutdown failed", "error", err)
		}
		if s.opts.OnShutdown != nil {
			s.opts.OnShutdown()
		}
	}()
}

func (s *Server) handleProviderAction(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeStateChange(w, r) {
		return
	}
	label, err := url.PathUnescape(r.PathValue("label"))
	if err != nil {
		label = r.PathValue("label")
	}
	action := r.PathValue("action")
	if action != "activate" && action != "close" {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
		return
	}

	if err := s.bridge.DashboardAction(label, action); err != nil {
		var nf *bridge.NotFoundError
		var nt *bridge.NoTabError
		switch {
		case errors.As(err, &nf):
			s.writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": err.Error()})
		case errors.As(err, &nt):
			s.writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": err.Error()})
		default:
			s.writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		}
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---- helpers ------------------------------------------------------------------

// hostAllowed rejects requests whose Host/Origin is not the local bridge: the
// primary defense against DNS rebinding and cross-origin pages reaching the
// JSON API.
//
// When the bridge is deliberately bound to a non-loopback host (which requires
// a token), strict authority matching is impossible — the machine may be
// reachable under many addresses — so the check relaxes to a port match and
// the token carries the authorization.
func (s *Server) hostAllowed(r *http.Request) bool {
	if !config.IsLoopbackHost(s.opts.Host) && s.opts.Host != "" {
		return s.portMatches(r.Host) && s.originPortMatches(r)
	}

	allowed := map[string]bool{
		fmt.Sprintf("127.0.0.1:%d", s.port): true,
		fmt.Sprintf("localhost:%d", s.port): true,
		fmt.Sprintf("[::1]:%d", s.port):     true,
	}
	if r.Host == "" || !allowed[r.Host] {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin != "" && origin != "null" {
		u, err := url.Parse(origin)
		if err != nil || !allowed[u.Host] {
			return false
		}
	}
	return true
}

func (s *Server) portMatches(authority string) bool {
	_, port, err := net.SplitHostPort(authority)
	return err == nil && port == strconv.Itoa(s.port)
}

func (s *Server) originPortMatches(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || origin == "null" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return s.portMatches(u.Host)
}

func (s *Server) tokenOK(r *http.Request) bool {
	if s.opts.Token == "" {
		return true
	}
	if r.Header.Get(protocol.TokenHeader) == s.opts.Token {
		return true
	}
	return r.URL.Query().Get("token") == s.opts.Token
}

// authorizeStateChange guards state-changing POSTs (shutdown / provider action).
func (s *Server) authorizeStateChange(w http.ResponseWriter, r *http.Request) bool {
	if !s.hostAllowed(r) {
		s.denyJSON(w, http.StatusForbidden, "request is not local (bad Host/Origin)")
		return false
	}
	if r.Header.Get(protocol.DashboardHeader) != protocol.DashboardHeaderValue {
		s.denyJSON(w, http.StatusForbidden, "missing dashboard header")
		return false
	}
	if !s.tokenOK(r) {
		s.denyJSON(w, http.StatusUnauthorized, "missing or invalid token")
		return false
	}
	return true
}

func (s *Server) denyJSON(w http.ResponseWriter, status int, msg string) {
	s.writeJSON(w, status, map[string]any{"ok": false, "error": msg})
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
