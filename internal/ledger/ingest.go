package ledger

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"coffeepos/internal/db"
	"coffeepos/internal/menu"
	"coffeepos/internal/settings"
)

// Service stores pushed documents and serves the ledger back.
type Service struct {
	Pool  *pgxpool.Pool
	Menus *menu.Store
	Now   func() time.Time
}

// Push outcomes.
const (
	Applied   = "applied"   // stored now
	Duplicate = "duplicate" // stored earlier; nothing to do
	Rejected  = "rejected"  // can never be stored (docs/decisions/0003)
	Retry     = "retry"     // the server had a problem; send it again later
)

// Result is what happened to one pushed document.
type Result struct {
	ID     string   `json:"id"`
	Status string   `json:"status"`
	Seq    int64    `json:"seq,omitempty"`
	Error  string   `json:"error,omitempty"`
	Flags  []string `json:"flags,omitempty"`
}

// Ingest stores one document pushed by a device.
func (s *Service) Ingest(ctx context.Context, deviceID, id, kind string, raw json.RawMessage) Result {
	res, err := s.ingest(ctx, deviceID, id, kind, raw)
	var rej *rejection
	switch {
	case errors.As(err, &rej):
		s.recordRejection(ctx, deviceID, id, kind, raw, rej.msg)
		return Result{ID: id, Status: Rejected, Error: rej.msg}
	case err != nil:
		slog.Error("ingest", "id", id, "kind", kind, "err", err)
		return Result{ID: id, Status: Retry, Error: "the server couldn't store this yet"}
	}
	res.ID = id
	return res
}

func (s *Service) ingest(ctx context.Context, deviceID, id, kind string, raw json.RawMessage) (Result, error) {
	switch kind {
	case "order":
		var o Order
		if err := decodeStrict(raw, &o); err != nil {
			return Result{}, err
		}
		if o.ID != id {
			return Result{}, reject("document id %s doesn't match the push id", o.ID)
		}
		if err := o.validate(deviceID); err != nil {
			return Result{}, err
		}
		o.normalize()
		return s.store(ctx, kind, o.ID, deviceID, o.BusinessDate, &o, func(tx pgx.Tx, c checkContext) ([]Flag, error) {
			doc, err := s.Menus.Get(ctx, o.MenuVersion)
			if err != nil {
				return nil, err
			}
			c.menu = doc
			return o.checks(c), insertOrder(ctx, tx, &o)
		}, o.referencedStaff())
	case "refund":
		var r Refund
		if err := decodeStrict(raw, &r); err != nil {
			return Result{}, err
		}
		if r.ID != id {
			return Result{}, reject("document id %s doesn't match the push id", r.ID)
		}
		if err := r.validate(deviceID); err != nil {
			return Result{}, err
		}
		r.normalize()
		return s.store(ctx, kind, r.ID, deviceID, r.BusinessDate, &r, func(tx pgx.Tx, c checkContext) ([]Flag, error) {
			target, err := loadRefundTarget(ctx, tx, &r)
			if err != nil {
				return nil, err
			}
			var approverIsManager bool
			if err := tx.QueryRow(ctx, `
				SELECT EXISTS (SELECT 1 FROM staff WHERE id = $1 AND active AND role = 'manager')`, r.ApprovedBy,
			).Scan(&approverIsManager); err != nil {
				return nil, err
			}
			return r.checks(target, approverIsManager, c), insertRefund(ctx, tx, &r)
		}, r.referencedStaff())
	default:
		return Result{}, reject("unknown document kind %q", kind)
	}
}

// store writes a validated document to the ledger, its projections and its
// flags in one transaction, under the ledger lock.
func (s *Service) store(ctx context.Context, kind, id, deviceID, businessDate string, doc any,
	project func(pgx.Tx, checkContext) ([]Flag, error), staffIDs []string) (Result, error) {
	normalized, err := json.Marshal(doc)
	if err != nil {
		return Result{}, err
	}
	received := s.Now()
	var res Result
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", db.LockLedger); err != nil {
			return err
		}
		var seq int64
		var same bool
		err := tx.QueryRow(ctx, "SELECT seq, doc = $2::jsonb FROM ledger WHERE id = $1", id, normalized).Scan(&seq, &same)
		if err == nil {
			if !same {
				return reject("a different document with this id was already received")
			}
			res = Result{Status: Duplicate, Seq: seq}
			return nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		c := checkContext{received: received, knownStaff: map[string]bool{}}
		if c.settings, err = settings.Load(ctx, tx); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, "SELECT id::text FROM staff WHERE id = ANY($1::uuid[])", staffIDs)
		if err != nil {
			return err
		}
		known, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		for _, k := range known {
			c.knownStaff[k] = true
		}
		if err := tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM closeouts WHERE business_date = $1)", businessDate).Scan(&c.closedOut); err != nil {
			return err
		}

		if err := tx.QueryRow(ctx, `
			INSERT INTO ledger (seq, id, kind, device_id, business_date, doc, received_at)
			VALUES (nextval('ledger_seq'), $1, $2, $3, $4, $5, $6) RETURNING seq`,
			id, kind, deviceID, businessDate, normalized, received).Scan(&seq); err != nil {
			return err
		}
		flags, err := project(tx, c)
		if err != nil {
			return err
		}
		kinds := make([]string, len(flags))
		for i, f := range flags {
			kinds[i] = f.Kind
			detail, err := json.Marshal(f.Detail)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO flags (kind, subject_kind, subject_id, device_id, business_date, message, detail)
				VALUES ($1, $2, $3, $4, $5, $6, coalesce($7::jsonb, '{}'))`,
				f.Kind, kind, id, deviceID, businessDate, f.Message, detail); err != nil {
				return err
			}
		}
		res = Result{Status: Applied, Seq: seq, Flags: kinds}
		return nil
	})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		// A line or payment id already belongs to another document.
		return Result{}, reject("an id in this document is already used by another document")
	}
	return res, err
}

func insertOrder(ctx context.Context, tx pgx.Tx, o *Order) error {
	var voidedAt *time.Time
	var voidedBy, voidReason *string
	if o.Void != nil {
		voidedAt, voidedBy, voidReason = &o.Void.At, &o.Void.By, &o.Void.Reason
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO orders (id, device_id, staff_id, number, business_date, status, menu_version,
			subtotal, tax, total, voided_at, voided_by, void_reason, created_at, closed_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
		o.ID, o.DeviceID, o.StaffID, o.Number, o.BusinessDate, o.Status, o.MenuVersion,
		o.Subtotal, o.Tax, o.Total, voidedAt, voidedBy, voidReason, o.CreatedAt, o.ClosedAt); err != nil {
		return err
	}
	for i, l := range o.Lines {
		var lAt *time.Time
		var lBy, lReason *string
		if l.Void != nil {
			lAt, lBy, lReason = &l.Void.At, &l.Void.By, &l.Void.Reason
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO order_lines (id, order_id, position, item_id, item_name, category, qty,
				unit_price, line_total, taxable, added_at, voided_at, voided_by, void_reason)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
			l.ID, o.ID, i, l.ItemID, l.ItemName, l.Category, l.Qty,
			l.UnitPrice, l.LineTotal, l.Taxable, l.AddedAt, lAt, lBy, lReason); err != nil {
			return err
		}
		for j, m := range l.Mods {
			if _, err := tx.Exec(ctx, `
				INSERT INTO order_line_mods (line_id, position, option_id, group_id, group_name, option_name, qty, delta)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				l.ID, j, m.OptionID, m.GroupID, m.GroupName, m.OptionName, m.Qty, m.Delta); err != nil {
				return err
			}
		}
	}
	for i, p := range o.Payments {
		var rAt *time.Time
		var rBy, rReason *string
		if p.Reversal != nil {
			rAt, rBy, rReason = &p.Reversal.At, &p.Reversal.By, &p.Reversal.Reason
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO payments (id, order_id, position, tender, amount, tendered, change, covers_line_ids,
				staff_id, created_at, reversed_at, reversed_by, reversal_reason)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
			p.ID, o.ID, i, p.Tender, p.Amount, p.Tendered, p.Change, p.CoversLineIDs,
			p.StaffID, p.CreatedAt, rAt, rBy, rReason); err != nil {
			return err
		}
	}
	return nil
}

// maxStoredRejection caps how much of a rejected payload is kept.
const maxStoredRejection = 64 << 10

func (s *Service) recordRejection(ctx context.Context, deviceID, id, kind string, raw json.RawMessage, reason string) {
	payload := string(raw)
	if len(payload) > maxStoredRejection {
		payload = payload[:maxStoredRejection]
	}
	if _, err := s.Pool.Exec(ctx, `
		INSERT INTO sync_rejections (device_id, doc_id, kind, payload, error) VALUES ($1, $2, $3, $4, $5)`,
		deviceID, id, kind, payload, reason); err != nil {
		slog.Error("record rejection", "id", id, "err", err)
	}
}
