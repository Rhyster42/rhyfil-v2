// Package reports computes sales reports and close-outs from the ledger's
// projection tables (docs/decisions/0017). Everything is computed live; a
// close-out also keeps a snapshot.
package reports

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"coffeepos/internal/bizdate"
	"coffeepos/internal/db"
	"coffeepos/internal/settings"
)

// Service serves reports, close-outs and flag review.
type Service struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

// Summary is the headline of a report. For consistent data,
// Collected = NetSales + NetTax.
type Summary struct {
	Orders        int   `json:"orders"`        // paid orders
	GrossSales    int64 `json:"grossSales"`    // non-voided lines on paid orders, before tax
	Tax           int64 `json:"tax"`           // charged on paid orders
	Refunds       int64 `json:"refunds"`       // returned, tax included
	RefundCount   int   `json:"refundCount"`   //
	RefundedTax   int64 `json:"refundedTax"`   // the tax part of Refunds
	NetSales      int64 `json:"netSales"`      // GrossSales − (Refunds − RefundedTax)
	NetTax        int64 `json:"netTax"`        // Tax − RefundedTax
	Collected     int64 `json:"collected"`     // payments kept − refunds
	AverageTicket int64 `json:"averageTicket"` // (GrossSales + Tax) / Orders
	VoidedOrders  int   `json:"voidedOrders"`
	VoidedLines   int   `json:"voidedLines"`
	Reversals     int   `json:"reversals"`
	OpenFlags     int   `json:"openFlags"`
}

// TenderRow is money in and out by tender.
type TenderRow struct {
	Tender      string `json:"tender"`
	Payments    int    `json:"payments"`
	Taken       int64  `json:"taken"`
	RefundCount int    `json:"refundCount"`
	Refunded    int64  `json:"refunded"`
	Net         int64  `json:"net"`
}

// ItemRow is one item's sales. Refunds count in the range they happened.
type ItemRow struct {
	ItemID      string `json:"itemId"`
	Name        string `json:"name"`
	Category    string `json:"category"`
	Qty         int    `json:"qty"`
	Gross       int64  `json:"gross"`
	RefundedQty int    `json:"refundedQty"`
	Refunded    int64  `json:"refunded"` // before tax
	Net         int64  `json:"net"`
}

// CategoryRow is one category's sales.
type CategoryRow struct {
	Category string `json:"category"`
	Qty      int    `json:"qty"`
	Gross    int64  `json:"gross"`
	Refunded int64  `json:"refunded"` // before tax
	Net      int64  `json:"net"`
}

// ModifierRow is how often an option was chosen and what it added.
type ModifierRow struct {
	OptionID string `json:"optionId"`
	Group    string `json:"group"`
	Option   string `json:"option"`
	Count    int    `json:"count"`
	Revenue  int64  `json:"revenue"`
}

// HourRow is sales by the store's local hour.
type HourRow struct {
	Hour   int   `json:"hour"`
	Orders int   `json:"orders"`
	Gross  int64 `json:"gross"`
}

// StaffRow is what each person did, for loss prevention as much as sales.
type StaffRow struct {
	StaffID          string `json:"staffId"`
	Name             string `json:"name"`
	Orders           int    `json:"orders"`
	Gross            int64  `json:"gross"`
	VoidedLines      int    `json:"voidedLines"`
	VoidedLineAmount int64  `json:"voidedLineAmount"`
	VoidedOrders     int    `json:"voidedOrders"`
	Reversals        int    `json:"reversals"`
	ReversalAmount   int64  `json:"reversalAmount"`
	RefundsIssued    int    `json:"refundsIssued"`
	RefundsApproved  int    `json:"refundsApproved"`
	RefundedAmount   int64  `json:"refundedAmount"` // issued
}

// ReasonRow counts voids, reversals or refunds by their reason.
type ReasonRow struct {
	Reason string `json:"reason"`
	Count  int    `json:"count"`
	Amount int64  `json:"amount"`
}

// Exceptions groups everything that took money or items back.
type Exceptions struct {
	LineVoids  []ReasonRow `json:"lineVoids"`
	OrderVoids []ReasonRow `json:"orderVoids"`
	Reversals  []ReasonRow `json:"reversals"`
	Refunds    []ReasonRow `json:"refunds"`
}

// DrawerRow is the cash a device's drawer took in and paid out.
type DrawerRow struct {
	DeviceID string `json:"deviceId"`
	Name     string `json:"name"`
	Code     string `json:"code"`
	CashIn   int64  `json:"cashIn"`
	CashOut  int64  `json:"cashOut"`
}

// Report covers a range of business dates, inclusive.
type Report struct {
	From       string        `json:"from"`
	To         string        `json:"to"`
	Timezone   string        `json:"timezone"`
	Summary    Summary       `json:"summary"`
	Tenders    []TenderRow   `json:"tenders"`
	Items      []ItemRow     `json:"items"`
	Categories []CategoryRow `json:"categories"`
	Modifiers  []ModifierRow `json:"modifiers"`
	Hours      []HourRow     `json:"hours"`
	Staff      []StaffRow    `json:"staff"`
	Exceptions Exceptions    `json:"exceptions"`
	Drawers    []DrawerRow   `json:"drawers"`
}

// MaxRangeDays limits how much one report covers.
const MaxRangeDays = 366

// checkRange validates a from/to pair of business dates.
func checkRange(from, to string) error {
	f, err := bizdate.Parse(from)
	if err != nil {
		return fmt.Errorf("from must be YYYY-MM-DD")
	}
	t, err := bizdate.Parse(to)
	if err != nil {
		return fmt.Errorf("to must be YYYY-MM-DD")
	}
	if t.Before(f) {
		return fmt.Errorf("to is before from")
	}
	if t.Sub(f) > MaxRangeDays*24*time.Hour {
		return fmt.Errorf("a report covers at most %d days", MaxRangeDays)
	}
	return nil
}

// Sales builds a report in one consistent snapshot.
func (s *Service) Sales(ctx context.Context, from, to string) (*Report, error) {
	var rep *Report
	err := pgx.BeginTxFunc(ctx, s.Pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		var err error
		rep, err = build(ctx, tx, from, to)
		return err
	})
	return rep, err
}

// rows runs a query and scans each row with scan. The result is never nil,
// so it encodes as a JSON array.
func rows[T any](ctx context.Context, q db.Querier, sql string, args []any, scan func(pgx.Row, *T) error) ([]T, error) {
	r, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	out := []T{}
	for r.Next() {
		var v T
		if err := scan(r, &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, r.Err()
}

// build runs every report query on q, which should be a single snapshot.
func build(ctx context.Context, q db.Querier, from, to string) (*Report, error) {
	st, err := settings.Load(ctx, q)
	if err != nil {
		return nil, err
	}
	rep := &Report{From: from, To: to, Timezone: st.Timezone}
	args := []any{from, to}
	s := &rep.Summary

	// Headline figures.
	if err := q.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status = 'paid'),
		       coalesce(sum(subtotal) FILTER (WHERE status = 'paid'), 0),
		       coalesce(sum(tax) FILTER (WHERE status = 'paid'), 0),
		       count(*) FILTER (WHERE status = 'voided')
		FROM orders WHERE business_date BETWEEN $1 AND $2`, args...,
	).Scan(&s.Orders, &s.GrossSales, &s.Tax, &s.VoidedOrders); err != nil {
		return nil, err
	}
	if err := q.QueryRow(ctx, `
		SELECT count(*), coalesce(sum(amount), 0), coalesce(sum(tax), 0)
		FROM refunds WHERE business_date BETWEEN $1 AND $2`, args...,
	).Scan(&s.RefundCount, &s.Refunds, &s.RefundedTax); err != nil {
		return nil, err
	}
	var kept int64
	if err := q.QueryRow(ctx, `
		SELECT coalesce(sum(p.amount) FILTER (WHERE p.reversed_at IS NULL), 0),
		       count(*) FILTER (WHERE p.reversed_at IS NOT NULL)
		FROM payments p JOIN orders o ON o.id = p.order_id
		WHERE o.business_date BETWEEN $1 AND $2`, args...,
	).Scan(&kept, &s.Reversals); err != nil {
		return nil, err
	}
	if err := q.QueryRow(ctx, `
		SELECT count(*) FROM order_lines l JOIN orders o ON o.id = l.order_id
		WHERE o.business_date BETWEEN $1 AND $2 AND l.voided_at IS NOT NULL`, args...,
	).Scan(&s.VoidedLines); err != nil {
		return nil, err
	}
	if err := q.QueryRow(ctx, `
		SELECT count(*) FROM flags WHERE resolved_at IS NULL AND business_date BETWEEN $1 AND $2`, args...,
	).Scan(&s.OpenFlags); err != nil {
		return nil, err
	}
	s.NetSales = s.GrossSales - (s.Refunds - s.RefundedTax)
	s.NetTax = s.Tax - s.RefundedTax
	s.Collected = kept - s.Refunds
	if s.Orders > 0 {
		s.AverageTicket = (s.GrossSales + s.Tax) / int64(s.Orders)
	}

	if rep.Tenders, err = rows(ctx, q, `
		WITH pay AS (
			SELECT p.tender, count(*) AS n, sum(p.amount) AS amount
			FROM payments p JOIN orders o ON o.id = p.order_id
			WHERE o.business_date BETWEEN $1 AND $2 AND p.reversed_at IS NULL GROUP BY p.tender
		), ref AS (
			SELECT tender, count(*) AS n, sum(amount) AS amount
			FROM refunds WHERE business_date BETWEEN $1 AND $2 GROUP BY tender
		)
		SELECT t.tender, coalesce(pay.n, 0), coalesce(pay.amount, 0), coalesce(ref.n, 0), coalesce(ref.amount, 0)
		FROM (VALUES ('card'), ('cash')) AS t (tender)
		LEFT JOIN pay USING (tender) LEFT JOIN ref USING (tender)
		ORDER BY t.tender`, args, func(r pgx.Row, v *TenderRow) error {
		err := r.Scan(&v.Tender, &v.Payments, &v.Taken, &v.RefundCount, &v.Refunded)
		v.Net = v.Taken - v.Refunded
		return err
	}); err != nil {
		return nil, err
	}

	// Lines on paid orders that weren't voided; names from the latest sale.
	const sold = `
		SELECT l.*, o.closed_at FROM order_lines l JOIN orders o ON o.id = l.order_id
		WHERE o.business_date BETWEEN $1 AND $2 AND o.status = 'paid' AND l.voided_at IS NULL`
	// Refunded lines, counted on the date of the refund.
	const refunded = `
		SELECT l.item_id, l.item_name, l.category, rl.qty, rl.amount - rl.tax AS amount, r.created_at
		FROM refund_lines rl JOIN refunds r ON r.id = rl.refund_id JOIN order_lines l ON l.id = rl.line_id
		WHERE r.business_date BETWEEN $1 AND $2`

	if rep.Items, err = rows(ctx, q, `
		WITH sold AS (`+sold+`), refunded AS (`+refunded+`),
		s AS (
			SELECT item_id, (array_agg(item_name ORDER BY closed_at DESC))[1] AS name,
			       (array_agg(category ORDER BY closed_at DESC))[1] AS category,
			       sum(qty) AS qty, sum(line_total) AS gross
			FROM sold GROUP BY item_id
		), f AS (
			SELECT item_id, (array_agg(item_name ORDER BY created_at DESC))[1] AS name,
			       (array_agg(category ORDER BY created_at DESC))[1] AS category,
			       sum(qty) AS qty, sum(amount) AS amount
			FROM refunded GROUP BY item_id
		)
		SELECT coalesce(s.item_id, f.item_id), coalesce(s.name, f.name), coalesce(s.category, f.category),
		       coalesce(s.qty, 0), coalesce(s.gross, 0), coalesce(f.qty, 0), coalesce(f.amount, 0)
		FROM s FULL JOIN f ON f.item_id = s.item_id
		ORDER BY coalesce(s.gross, 0) DESC, 2`, args, func(r pgx.Row, v *ItemRow) error {
		err := r.Scan(&v.ItemID, &v.Name, &v.Category, &v.Qty, &v.Gross, &v.RefundedQty, &v.Refunded)
		v.Net = v.Gross - v.Refunded
		return err
	}); err != nil {
		return nil, err
	}

	if rep.Categories, err = rows(ctx, q, `
		WITH sold AS (`+sold+`), refunded AS (`+refunded+`),
		s AS (SELECT category, sum(qty) AS qty, sum(line_total) AS gross FROM sold GROUP BY category),
		f AS (SELECT category, sum(amount) AS amount FROM refunded GROUP BY category)
		SELECT coalesce(s.category, f.category), coalesce(s.qty, 0), coalesce(s.gross, 0), coalesce(f.amount, 0)
		FROM s FULL JOIN f ON f.category = s.category
		ORDER BY coalesce(s.gross, 0) DESC, 1`, args, func(r pgx.Row, v *CategoryRow) error {
		err := r.Scan(&v.Category, &v.Qty, &v.Gross, &v.Refunded)
		v.Net = v.Gross - v.Refunded
		return err
	}); err != nil {
		return nil, err
	}

	if rep.Modifiers, err = rows(ctx, q, `
		SELECT m.option_id,
		       (array_agg(m.group_name ORDER BY o.closed_at DESC))[1],
		       (array_agg(m.option_name ORDER BY o.closed_at DESC))[1],
		       sum(m.qty * l.qty), sum(m.delta * m.qty * l.qty)
		FROM order_line_mods m JOIN order_lines l ON l.id = m.line_id JOIN orders o ON o.id = l.order_id
		WHERE o.business_date BETWEEN $1 AND $2 AND o.status = 'paid' AND l.voided_at IS NULL
		GROUP BY m.option_id ORDER BY 4 DESC, 2, 3`, args, func(r pgx.Row, v *ModifierRow) error {
		return r.Scan(&v.OptionID, &v.Group, &v.Option, &v.Count, &v.Revenue)
	}); err != nil {
		return nil, err
	}

	if rep.Hours, err = rows(ctx, q, `
		SELECT extract(hour FROM closed_at AT TIME ZONE $3)::int, count(*), sum(subtotal)
		FROM orders WHERE business_date BETWEEN $1 AND $2 AND status = 'paid'
		GROUP BY 1 ORDER BY 1`, append(args, st.Timezone), func(r pgx.Row, v *HourRow) error {
		return r.Scan(&v.Hour, &v.Orders, &v.Gross)
	}); err != nil {
		return nil, err
	}

	if rep.Staff, err = staffRows(ctx, q, args); err != nil {
		return nil, err
	}

	reasons := func(sql string) ([]ReasonRow, error) {
		return rows(ctx, q, sql, args, func(r pgx.Row, v *ReasonRow) error { return r.Scan(&v.Reason, &v.Count, &v.Amount) })
	}
	if rep.Exceptions.LineVoids, err = reasons(`
		SELECT l.void_reason, count(*), sum(l.line_total)
		FROM order_lines l JOIN orders o ON o.id = l.order_id
		WHERE o.business_date BETWEEN $1 AND $2 AND l.voided_at IS NOT NULL
		GROUP BY 1 ORDER BY 2 DESC, 1`); err != nil {
		return nil, err
	}
	if rep.Exceptions.OrderVoids, err = reasons(`
		SELECT void_reason, count(*), sum(total) FROM orders
		WHERE business_date BETWEEN $1 AND $2 AND status = 'voided'
		GROUP BY 1 ORDER BY 2 DESC, 1`); err != nil {
		return nil, err
	}
	if rep.Exceptions.Reversals, err = reasons(`
		SELECT p.reversal_reason, count(*), sum(p.amount)
		FROM payments p JOIN orders o ON o.id = p.order_id
		WHERE o.business_date BETWEEN $1 AND $2 AND p.reversed_at IS NOT NULL
		GROUP BY 1 ORDER BY 2 DESC, 1`); err != nil {
		return nil, err
	}
	if rep.Exceptions.Refunds, err = reasons(`
		SELECT reason, count(*), sum(amount) FROM refunds
		WHERE business_date BETWEEN $1 AND $2
		GROUP BY 1 ORDER BY 2 DESC, 1`); err != nil {
		return nil, err
	}

	// Cash per drawer: payments kept on the device's orders, refunds paid out
	// on that device (docs/decisions/0017).
	if rep.Drawers, err = rows(ctx, q, `
		WITH cash_in AS (
			SELECT o.device_id, sum(p.amount) AS amount
			FROM payments p JOIN orders o ON o.id = p.order_id
			WHERE o.business_date BETWEEN $1 AND $2 AND p.tender = 'cash' AND p.reversed_at IS NULL
			GROUP BY o.device_id
		), cash_out AS (
			SELECT device_id, sum(amount) AS amount FROM refunds
			WHERE business_date BETWEEN $1 AND $2 AND tender = 'cash' GROUP BY device_id
		)
		SELECT d.id, d.name, d.code, coalesce(i.amount, 0), coalesce(c.amount, 0)
		FROM devices d LEFT JOIN cash_in i ON i.device_id = d.id LEFT JOIN cash_out c ON c.device_id = d.id
		WHERE i.amount IS NOT NULL OR c.amount IS NOT NULL OR d.revoked_at IS NULL
		ORDER BY length(d.code), d.code`, args, func(r pgx.Row, v *DrawerRow) error {
		return r.Scan(&v.DeviceID, &v.Name, &v.Code, &v.CashIn, &v.CashOut)
	}); err != nil {
		return nil, err
	}
	return rep, nil
}

// staffRows gathers each person's activity from several tables.
func staffRows(ctx context.Context, q db.Querier, args []any) ([]StaffRow, error) {
	byID := map[string]*StaffRow{}
	get := func(id string) *StaffRow {
		if byID[id] == nil {
			byID[id] = &StaffRow{StaffID: id}
		}
		return byID[id]
	}
	type tally struct {
		sql string
		add func(r *StaffRow, n int, amount int64)
	}
	for _, t := range []tally{
		{`SELECT staff_id::text, count(*), sum(subtotal) FROM orders
			WHERE business_date BETWEEN $1 AND $2 AND status = 'paid' GROUP BY 1`,
			func(r *StaffRow, n int, a int64) { r.Orders, r.Gross = n, a }},
		{`SELECT l.voided_by::text, count(*), sum(l.line_total) FROM order_lines l JOIN orders o ON o.id = l.order_id
			WHERE o.business_date BETWEEN $1 AND $2 AND l.voided_at IS NOT NULL GROUP BY 1`,
			func(r *StaffRow, n int, a int64) { r.VoidedLines, r.VoidedLineAmount = n, a }},
		{`SELECT voided_by::text, count(*), 0::bigint FROM orders
			WHERE business_date BETWEEN $1 AND $2 AND status = 'voided' GROUP BY 1`,
			func(r *StaffRow, n int, _ int64) { r.VoidedOrders = n }},
		{`SELECT p.reversed_by::text, count(*), sum(p.amount) FROM payments p JOIN orders o ON o.id = p.order_id
			WHERE o.business_date BETWEEN $1 AND $2 AND p.reversed_at IS NOT NULL GROUP BY 1`,
			func(r *StaffRow, n int, a int64) { r.Reversals, r.ReversalAmount = n, a }},
		{`SELECT staff_id::text, count(*), sum(amount) FROM refunds WHERE business_date BETWEEN $1 AND $2 GROUP BY 1`,
			func(r *StaffRow, n int, a int64) { r.RefundsIssued, r.RefundedAmount = n, a }},
		{`SELECT approved_by::text, count(*), 0::bigint FROM refunds WHERE business_date BETWEEN $1 AND $2 GROUP BY 1`,
			func(r *StaffRow, n int, _ int64) { r.RefundsApproved = n }},
	} {
		rs, err := q.Query(ctx, t.sql, args...)
		if err != nil {
			return nil, err
		}
		var id string
		var n int
		var amount int64
		_, err = pgx.ForEachRow(rs, []any{&id, &n, &amount}, func() error {
			t.add(get(id), n, amount)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	ids := make([]string, 0, len(byID))
	for id := range byID {
		ids = append(ids, id)
	}
	names := map[string]string{}
	rs, err := q.Query(ctx, "SELECT id::text, name FROM staff WHERE id = ANY($1::uuid[])", ids)
	if err != nil {
		return nil, err
	}
	var id, name string
	if _, err := pgx.ForEachRow(rs, []any{&id, &name}, func() error { names[id] = name; return nil }); err != nil {
		return nil, err
	}
	out := make([]StaffRow, 0, len(byID))
	for _, r := range byID {
		r.Name = names[r.StaffID]
		if r.Name == "" {
			r.Name = "Unknown (" + r.StaffID[:8] + ")"
		}
		out = append(out, *r)
	}
	sortStaff(out)
	return out, nil
}

// sortStaff puts the biggest sellers first, then everyone else by name.
func sortStaff(rows []StaffRow) {
	slices.SortFunc(rows, func(a, b StaffRow) int {
		if a.Gross != b.Gross {
			return cmp.Compare(b.Gross, a.Gross)
		}
		return strings.Compare(a.Name, b.Name)
	})
}
