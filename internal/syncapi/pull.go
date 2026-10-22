// Package syncapi is the tablets' sync protocol: push closed documents, pull
// everything else (docs/decisions/0001, 0002, 0012).
package syncapi

import (
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"coffeepos/internal/auth"
	"coffeepos/internal/httpx"
	"coffeepos/internal/menu"
	"coffeepos/internal/settings"
)

// Service serves /api/sync.
type Service struct {
	Pool  *pgxpool.Pool
	Auth  *auth.Service
	Menus *menu.Store
	Now   func() time.Time
}

// StaffList is the staff a tablet needs for sign-in and approvals.
type StaffList struct {
	Version int64              `json:"version"`
	Members []auth.StaffMember `json:"members"`
}

// PullResponse carries the menu, staff and settings when they've changed
// since the versions the tablet sent, and the ledger after its cursor.
type PullResponse struct {
	ServerTime time.Time          `json:"serverTime"`
	Menu       *menu.Version      `json:"menu"`
	Staff      *StaffList         `json:"staff"`
	Settings   *settings.Settings `json:"settings"`
	Ledger     LedgerPage         `json:"ledger"`
}

// LedgerPage is a slice of other devices' (and this device's) documents.
type LedgerPage struct {
	Entries []LedgerEntry `json:"entries"`
	Cursor  int64         `json:"cursor"`
	HasMore bool          `json:"hasMore"`
}

// LedgerEntry is one document as the server stored it.
type LedgerEntry struct {
	Seq  int64  `json:"seq"`
	Kind string `json:"kind"`
	Doc  any    `json:"doc"`
}

func intParam(r *http.Request, name string) (int64, error) {
	s := r.URL.Query().Get(name)
	if s == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return 0, httpx.BadRequest("%s must be a non-negative integer", name)
	}
	return n, nil
}

// HandlePull: GET /api/sync/pull?menu=&staff=&settings=&cursor=&pending=&open=
func (s *Service) HandlePull(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	params := map[string]int64{}
	for _, name := range []string{"menu", "staff", "settings", "cursor", "pending", "open"} {
		v, err := intParam(r, name)
		if err != nil {
			return err
		}
		params[name] = v
	}
	device := auth.DeviceFrom(ctx)
	if err := s.Auth.Heartbeat(ctx, device.ID, int(params["pending"]), int(params["open"])); err != nil {
		return err
	}

	resp := PullResponse{ServerTime: s.Now().UTC(), Ledger: LedgerPage{Entries: []LedgerEntry{}, Cursor: params["cursor"]}}

	latest, err := s.Menus.LatestVersion(ctx)
	if err != nil {
		return err
	}
	if latest > params["menu"] {
		v, err := s.Menus.Latest(ctx)
		if err != nil {
			return err
		}
		resp.Menu = &v
	}

	staffVersion, err := s.Auth.StaffVersion(ctx)
	if err != nil {
		return err
	}
	if staffVersion > params["staff"] {
		version, members, err := s.Auth.StaffSnapshot(ctx)
		if err != nil {
			return err
		}
		resp.Staff = &StaffList{Version: version, Members: members}
	}

	st, err := settings.Load(ctx, s.Pool)
	if err != nil {
		return err
	}
	if st.Version > params["settings"] {
		resp.Settings = &st
	}

	httpx.WriteJSON(w, http.StatusOK, resp)
	return nil
}
