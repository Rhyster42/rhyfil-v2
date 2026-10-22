// Package server wires the HTTP routes to the feature packages.
package server

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"coffeepos/internal/httpx"
)

// Config holds what the server needs from the environment.
type Config struct {
	Pool   *pgxpool.Pool
	WebDir string // built PWA; empty disables static serving
}

// New returns the root handler.
func New(cfg Config) http.Handler {
	mux := http.NewServeMux()

	mux.Handle("GET /healthz", httpx.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		if err := cfg.Pool.Ping(r.Context()); err != nil {
			return httpx.Errorf(http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return nil
	}))

	mux.Handle("/api/", httpx.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		return httpx.ErrNotFound
	}))
	if cfg.WebDir != "" {
		mux.Handle("/", static(cfg.WebDir))
	}

	return httpx.Chain(mux, httpx.Recover, httpx.LogRequests, httpx.SecurityHeaders)
}
