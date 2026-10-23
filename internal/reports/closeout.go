package reports

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"coffeepos/internal/bizdate"
	"coffeepos/internal/db"
	"coffeepos/internal/httpx"
	"coffeepos/internal/settings"
)

// Drawer is one tablet's cash drawer at close-out.
type Drawer struct {
	DeviceID     string `json:"deviceId"`
	Name         string `json:"name"`
	Code         string `json:"code"`
	OpeningFloat int64  `json:"openingFloat"`
	CashIn       int64  `json:"cashIn"`
	CashOut      int64  `json:"cashOut"`
	Expected     int64  `json:"expected"` // float + in − out
	Counted      int64  `json:"counted"`
	OverShort    int64  `json:"overShort"` // counted − expected
}

// Closeout is a closed business day.
type Closeout struct {
	BusinessDate string    `json:"businessDate"`
	ClosedBy     string    `json:"closedBy"`
	ClosedAt     time.Time `json:"closedAt"`
	Note         string    `json:"note"`
	Drawers      []Drawer  `json:"drawers"`
	Snapshot     *Report   `json:"snapshot"`
}

// DeviceSync is what a close-out needs to know about each device: has it
// sent everything?
type DeviceSync struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Code            string     `json:"code"`
	LastSeenAt      *time.Time `json:"lastSeenAt"`
	ReportedPending int        `json:"reportedPending"`
	ReportedOpen    int        `json:"reportedOpen"`
}

// CloseoutStatus is everything the close-out screen shows for a day.
type CloseoutStatus struct {
	BusinessDate string       `json:"businessDate"`
	Closeout     *Closeout    `json:"closeout"`
	Live         *Report      `json:"live"`
	Changed      bool         `json:"changed"` // documents arrived after the close-out
	Devices      []DeviceSync `json:"devices"`
	DefaultFloat int64        `json:"defaultFloat"`
}

// CloseRequest is what the manager counted.
type CloseRequest struct {
	Drawers []struct {
		DeviceID     string `json:"deviceId"`
		OpeningFloat int64  `json:"openingFloat"`
		Counted      int64  `json:"counted"`
	} `json:"drawers"`
	Note string `json:"note"`
}

// sameMoney reports whether two summaries agree on everything but open
// flags (resolving a flag isn't a change to the day).
func sameMoney(a, b Summary) bool {
	a.OpenFlags, b.OpenFlags = 0, 0
	return a == b
}

func loadCloseout(ctx context.Context, q db.Querier, date string) (*Closeout, error) {
	c := Closeout{BusinessDate: date}
	var snapshot []byte
	err := q.QueryRow(ctx, `
		SELECT st.name, co.closed_at, co.note, co.snapshot
		FROM closeouts co JOIN staff st ON st.id = co.closed_by
		WHERE co.business_date = $1`, date).Scan(&c.ClosedBy, &c.ClosedAt, &c.Note, &snapshot)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(snapshot, &c.Snapshot); err != nil {
		return nil, err
	}
	c.Drawers, err = rows(ctx, q, `
		SELECT cd.device_id::text, d.name, d.code, cd.opening_float, cd.expected, cd.counted, cd.over_short
		FROM closeout_drawers cd JOIN devices d ON d.id = cd.device_id
		WHERE cd.business_date = $1 ORDER BY length(d.code), d.code`, []any{date}, func(r pgx.Row, v *Drawer) error {
		return r.Scan(&v.DeviceID, &v.Name, &v.Code, &v.OpeningFloat, &v.Expected, &v.Counted, &v.OverShort)
	})
	if err != nil {
		return nil, err
	}
	// Cash in and out come from the snapshot taken at the same moment.
	for i := range c.Drawers {
		for _, d := range c.Snapshot.Drawers {
			if d.DeviceID == c.Drawers[i].DeviceID {
				c.Drawers[i].CashIn, c.Drawers[i].CashOut = d.CashIn, d.CashOut
			}
		}
	}
	return &c, nil
}

// Status gathers the close-out screen for a business date.
func (s *Service) Status(ctx context.Context, date string) (*CloseoutStatus, error) {
	if _, err := bizdate.Parse(date); err != nil {
		return nil, httpx.BadRequest("date must be YYYY-MM-DD")
	}
	st := &CloseoutStatus{BusinessDate: date}
	err := pgx.BeginTxFunc(ctx, s.Pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		var err error
		if st.Live, err = build(ctx, tx, date, date); err != nil {
			return err
		}
		if st.Closeout, err = loadCloseout(ctx, tx, date); err != nil {
			return err
		}
		if st.Closeout != nil {
			st.Changed = !sameMoney(st.Closeout.Snapshot.Summary, st.Live.Summary)
		}
		cfg, err := settings.Load(ctx, tx)
		if err != nil {
			return err
		}
		st.DefaultFloat = cfg.DefaultFloat
		st.Devices, err = rows(ctx, tx, `
			SELECT id::text, name, code, last_seen_at, reported_pending, reported_open
			FROM devices WHERE revoked_at IS NULL ORDER BY length(code), code`, nil, func(r pgx.Row, v *DeviceSync) error {
			return r.Scan(&v.ID, &v.Name, &v.Code, &v.LastSeenAt, &v.ReportedPending, &v.ReportedOpen)
		})
		return err
	})
	return st, err
}

// Close closes out a business date: it stores the counted cash per drawer and
// a snapshot of the day's report. It holds the ledger lock, so every document
// is either in the snapshot or arrives later and is flagged after_closeout.
func (s *Service) Close(ctx context.Context, date, managerID string, req CloseRequest) (*Closeout, error) {
	d, err := bizdate.Parse(date)
	if err != nil {
		return nil, httpx.BadRequest("date must be YYYY-MM-DD")
	}
	seen := map[string]bool{}
	for _, dr := range req.Drawers {
		if dr.OpeningFloat < 0 || dr.Counted < 0 {
			return nil, httpx.BadRequest("cash amounts can't be negative")
		}
		if seen[dr.DeviceID] {
			return nil, httpx.BadRequest("each drawer can be counted once")
		}
		seen[dr.DeviceID] = true
	}
	if len(req.Note) > 1000 {
		return nil, httpx.BadRequest("the note is too long")
	}

	var out *Closeout
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", db.LockLedger); err != nil {
			return err
		}
		cfg, err := settings.Load(ctx, tx)
		if err != nil {
			return err
		}
		today, _ := bizdate.Parse(bizdate.Of(s.Now(), cfg.Location(), cfg.DayCutoffMinutes))
		if d.After(today) {
			return httpx.BadRequest("%s hasn't happened yet", date)
		}
		var closed bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM closeouts WHERE business_date = $1)", date).Scan(&closed); err != nil {
			return err
		}
		if closed {
			return httpx.Errorf(http.StatusConflict, "already_closed", "%s is already closed out", date)
		}

		rep, err := build(ctx, tx, date, date)
		if err != nil {
			return err
		}
		snapshot, err := json.Marshal(rep)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO closeouts (business_date, closed_by, closed_at, note, snapshot) VALUES ($1, $2, $3, $4, $5)`,
			date, managerID, s.Now(), req.Note, snapshot); err != nil {
			return err
		}
		for _, dr := range req.Drawers {
			var in, cashOut int64
			for _, r := range rep.Drawers {
				if r.DeviceID == dr.DeviceID {
					in, cashOut = r.CashIn, r.CashOut
				}
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO closeout_drawers (business_date, device_id, opening_float, expected, counted)
				SELECT $1, id, $3, $4, $5 FROM devices WHERE id::text = $2`,
				date, dr.DeviceID, dr.OpeningFloat, dr.OpeningFloat+in-cashOut, dr.Counted); err != nil {
				return err
			}
		}
		out, err = loadCloseout(ctx, tx, date)
		return err
	})
	return out, err
}
