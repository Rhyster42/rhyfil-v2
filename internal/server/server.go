// Package server wires the HTTP routes to the feature packages. Every route
// is listed in New, so this file is the API's table of contents.
package server

import (
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"coffeepos/internal/auth"
	"coffeepos/internal/httpx"
	"coffeepos/internal/menu"
	"coffeepos/internal/settings"
	"coffeepos/internal/syncapi"
)

// Config holds what the server needs from the environment.
type Config struct {
	Pool   *pgxpool.Pool
	WebDir string // built PWA; empty disables static serving
	Auth   auth.Options
	Now    func() time.Time
}

// Server is the root handler plus the services main needs.
type Server struct {
	Handler http.Handler
	Auth    *auth.Service
	Menus   *menu.Store
}

// New builds the services and routes.
func New(cfg Config) *Server {
	if cfg.Now == nil {
		cfg.Now = func() time.Time { return time.Now().UTC() }
	}
	if cfg.Auth.Now == nil {
		cfg.Auth.Now = cfg.Now
	}
	a := auth.New(cfg.Pool, cfg.Auth)
	menus := menu.NewStore(cfg.Pool)
	settingsAPI := settings.Handlers{Pool: cfg.Pool}
	sync := &syncapi.Service{Pool: cfg.Pool, Auth: a, Menus: menus, Now: cfg.Now}

	type handler = httpx.HandlerFunc
	device := a.RequireDevice   // an enrolled tablet
	manager := a.RequireManager // an enrolled tablet with a manager signed in to the back office

	mux := http.NewServeMux()
	mux.Handle("GET /healthz", handler(func(w http.ResponseWriter, r *http.Request) error {
		if err := cfg.Pool.Ping(r.Context()); err != nil {
			return httpx.Errorf(http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return nil
	}))

	// First run and enrollment.
	mux.Handle("GET /api/setup", handler(a.HandleSetupStatus))
	mux.Handle("POST /api/setup", handler(a.HandleSetup))
	mux.Handle("POST /api/devices/enroll", handler(a.HandleEnroll))

	// Tablets.
	mux.Handle("GET /api/sync/pull", device(handler(sync.HandlePull)))
	mux.Handle("POST /api/sessions", device(handler(a.HandleCreateSession)))
	mux.Handle("DELETE /api/sessions", device(handler(a.HandleDeleteSession)))

	// Back office.
	mux.Handle("GET /api/menu", manager(handler(menus.HandleGet)))
	mux.Handle("PUT /api/menu", manager(handler(func(w http.ResponseWriter, r *http.Request) error {
		return menus.HandlePut(w, r, auth.ManagerFrom(r.Context()).ID)
	})))
	mux.Handle("GET /api/settings", manager(handler(settingsAPI.HandleGet)))
	mux.Handle("PUT /api/settings", manager(handler(settingsAPI.HandlePut)))
	mux.Handle("GET /api/staff", manager(handler(a.HandleListStaff)))
	mux.Handle("POST /api/staff", manager(handler(a.HandleCreateStaff)))
	mux.Handle("PATCH /api/staff/{id}", manager(handler(a.HandleUpdateStaff)))
	mux.Handle("GET /api/devices", manager(handler(a.HandleListDevices)))
	mux.Handle("POST /api/devices/codes", manager(handler(a.HandleCreateCode)))
	mux.Handle("POST /api/devices/{id}/revoke", manager(handler(a.HandleRevokeDevice)))

	mux.Handle("/api/", handler(func(w http.ResponseWriter, r *http.Request) error {
		return httpx.ErrNotFound
	}))
	if cfg.WebDir != "" {
		mux.Handle("/", static(cfg.WebDir))
	}

	return &Server{
		Handler: httpx.Chain(mux, httpx.Recover, httpx.LogRequests, httpx.SecurityHeaders),
		Auth:    a,
		Menus:   menus,
	}
}
