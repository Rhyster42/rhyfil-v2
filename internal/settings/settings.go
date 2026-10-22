// Package settings stores the store-wide settings row.
package settings

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"

	"coffeepos/internal/db"
	"coffeepos/internal/httpx"
)

// Settings apply to the whole store. Version changes on every save so tablets
// download them only when they move.
type Settings struct {
	StoreName        string `json:"storeName"`
	Timezone         string `json:"timezone"`
	Currency         string `json:"currency"`
	DayCutoffMinutes int    `json:"dayCutoffMinutes"`
	DefaultFloat     int64  `json:"defaultFloat"`
	Version          int64  `json:"version"`
}

// Location returns the store's time zone.
func (s Settings) Location() *time.Location {
	loc, err := time.LoadLocation(s.Timezone)
	if err != nil {
		return time.UTC
	}
	return loc
}

// Load reads the settings.
func Load(ctx context.Context, q db.Querier) (Settings, error) {
	var s Settings
	err := q.QueryRow(ctx, `
		SELECT store_name, timezone, currency, day_cutoff_minutes, default_float, version FROM settings`,
	).Scan(&s.StoreName, &s.Timezone, &s.Currency, &s.DayCutoffMinutes, &s.DefaultFloat, &s.Version)
	return s, err
}

var currencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)

func (s *Settings) validate() error {
	s.StoreName = strings.TrimSpace(s.StoreName)
	switch {
	case s.StoreName == "" || utf8.RuneCountInString(s.StoreName) > 60:
		return httpx.BadRequest("store name must be 1-60 characters")
	case !currencyPattern.MatchString(s.Currency):
		return httpx.BadRequest("currency must be a three-letter code like USD")
	case s.DayCutoffMinutes < 0 || s.DayCutoffMinutes > 720:
		return httpx.BadRequest("the business day must start between midnight and noon")
	case s.DefaultFloat < 0:
		return httpx.BadRequest("default float can't be negative")
	}
	if _, err := time.LoadLocation(s.Timezone); err != nil || s.Timezone == "" || s.Timezone == "Local" {
		return httpx.BadRequest("unknown time zone %q", s.Timezone)
	}
	return nil
}

// Handlers serves the settings endpoints.
type Handlers struct{ Pool *pgxpool.Pool }

// HandleGet: GET /api/settings
func (h Handlers) HandleGet(w http.ResponseWriter, r *http.Request) error {
	s, err := Load(r.Context(), h.Pool)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, s)
	return nil
}

// HandlePut: PUT /api/settings. Version in the body is ignored.
func (h Handlers) HandlePut(w http.ResponseWriter, r *http.Request) error {
	var s Settings
	if err := httpx.DecodeJSON(w, r, &s); err != nil {
		return err
	}
	if err := s.validate(); err != nil {
		return err
	}
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE settings SET store_name = $1, timezone = $2, currency = $3,
			day_cutoff_minutes = $4, default_float = $5, version = version + 1
		RETURNING version`,
		s.StoreName, s.Timezone, s.Currency, s.DayCutoffMinutes, s.DefaultFloat).Scan(&s.Version)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, s)
	return nil
}
