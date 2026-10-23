package seed

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"coffeepos/internal/auth"
	"coffeepos/internal/bizdate"
	"coffeepos/internal/ledger"
	"coffeepos/internal/menu"
	"coffeepos/internal/money"
	"coffeepos/internal/pricing"
	"coffeepos/internal/settings"
)

// Ingester stores a pushed document, as the sync endpoint does.
type Ingester interface {
	Ingest(ctx context.Context, deviceID, id, kind string, raw json.RawMessage) ledger.Result
}

// What a day at the demo shop sells, and how much.
var (
	demoItems = []struct {
		id     string
		weight int
	}{
		{"latte", 24}, {"cappuccino", 9}, {"americano", 10}, {"drip", 12}, {"mocha", 6}, {"flat-white", 4},
		{"cold-brew", 8}, {"chai", 5}, {"tea", 4}, {"matcha", 3}, {"croissant", 8}, {"muffin", 6},
		{"banana-bread", 3}, {"cookie", 3}, {"pain-chocolat", 3}, {"beans", 1},
	}
	// Orders per opening hour, 7 a.m. to 4 p.m.: the morning rush.
	demoHours        = []int{11, 15, 12, 8, 7, 9, 7, 5, 4}
	demoLineVoids    = []string{"Rang in error", "Customer changed mind", "Made wrong"}
	demoOrderVoids   = []string{"Customer left", "Rang in error"}
	demoRefundReason = []string{"Made wrong", "Customer unhappy", "Charged by mistake"}
)

func weighted[T any](rng *rand.Rand, items []T, weight func(T) int) T {
	total := 0
	for _, it := range items {
		total += weight(it)
	}
	n := rng.IntN(total)
	for _, it := range items {
		if n -= weight(it); n < 0 {
			return it
		}
	}
	return items[len(items)-1]
}

// DemoSales fills the days before today with plausible sales, so the back
// office has something to show. Documents go through ingest exactly like a
// tablet's; any rejection or flag is an error, which also keeps the
// seeder's pricing honest. Today is left empty for real use.
func DemoSales(ctx context.Context, pool *pgxpool.Pool, ing Ingester, days int, now time.Time) error {
	cfg, err := settings.Load(ctx, pool)
	if err != nil {
		return err
	}
	loc := cfg.Location()
	doc, err := DemoMenu()
	if err != nil {
		return err
	}
	ix := menu.NewIndex(doc)
	staff := map[string]string{}
	rows, err := pool.Query(ctx, "SELECT name, id::text FROM staff")
	if err != nil {
		return err
	}
	for rows.Next() {
		var name, id string
		if err := rows.Scan(&name, &id); err != nil {
			return err
		}
		staff[name] = id
	}
	if rows.Err() != nil {
		return rows.Err()
	}
	baristas := []string{staff["Sam"], staff["Riley"], staff["Sam"], staff["Riley"], staff["Morgan"]}

	// A device of its own, retired afterwards so it never looks like a tablet
	// that stopped syncing.
	deviceID := uuid.Must(uuid.NewV7()).String()
	_, hash := auth.NewToken()
	if _, err := pool.Exec(ctx, `INSERT INTO devices (id, name, code, token_hash) VALUES ($1, 'Demo history', 'DEMO', $2)`, deviceID, hash); err != nil {
		return err
	}

	rng := rand.New(rand.NewPCG(2026, 10))
	today, _ := bizdate.Parse(bizdate.Of(now, loc, cfg.DayCutoffMinutes))
	push := func(kind, id string, v any) error {
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		res := ing.Ingest(ctx, deviceID, id, kind, raw)
		if res.Status != ledger.Applied || len(res.Flags) > 0 {
			return fmt.Errorf("demo %s %s: %s %s %v", kind, id, res.Status, res.Error, res.Flags)
		}
		return nil
	}

	for d := days; d >= 1; d-- {
		day := today.AddDate(0, 0, -d)
		date := day.Format(bizdate.Layout)
		orders := 70 + rng.IntN(40)
		for n := 1; n <= orders; n++ {
			hour := 7 + weighted(rng, []int{0, 1, 2, 3, 4, 5, 6, 7, 8}, func(i int) int { return demoHours[i] })
			at := time.Date(day.Year(), day.Month(), day.Day(), hour, rng.IntN(60), rng.IntN(60), 0, loc).UTC()
			o, err := demoOrder(rng, ix, deviceID, baristas[rng.IntN(len(baristas))], fmt.Sprintf("DEMO-%03d", n), date, at)
			if err != nil {
				return err
			}
			if err := push("order", o.ID, o); err != nil {
				return err
			}
			if o.Status == "paid" && rng.IntN(60) == 0 {
				r := demoRefund(rng, o, staff["Morgan"], baristas[rng.IntN(2)])
				if err := push("refund", r.ID, r); err != nil {
					return err
				}
			}
		}
	}
	_, err = pool.Exec(ctx, "UPDATE devices SET revoked_at = $2 WHERE id = $1", deviceID, now)
	return err
}

func newID() string { return uuid.Must(uuid.NewV7()).String() }

func demoSelections(rng *rand.Rand, ix *menu.Index, itemID string) []menu.Selection {
	var mods []menu.Selection
	for _, gid := range ix.Items[itemID].GroupIDs {
		g := ix.Groups[gid]
		var def *menu.Option
		for i := range g.Options {
			if g.Options[i].Default {
				def = &g.Options[i]
			}
		}
		switch {
		case g.Min > 0 && def != nil && rng.IntN(10) < 7:
			mods = append(mods, menu.Selection{OptionID: def.ID, Qty: 1})
		case g.Min > 0:
			mods = append(mods, menu.Selection{OptionID: g.Options[rng.IntN(len(g.Options))].ID, Qty: 1})
		case def != nil && rng.IntN(10) < 8:
			mods = append(mods, menu.Selection{OptionID: def.ID, Qty: 1})
		case rng.IntN(5) == 0:
			o := g.Options[rng.IntN(len(g.Options))]
			qty := 1
			if o.MaxQty > 1 && rng.IntN(4) == 0 {
				qty = 2
			}
			mods = append(mods, menu.Selection{OptionID: o.ID, Qty: qty})
		}
	}
	return mods
}

func demoOrder(rng *rand.Rand, ix *menu.Index, deviceID, staffID, number, date string, at time.Time) (*ledger.Order, error) {
	o := &ledger.Order{V: 1, ID: newID(), DeviceID: deviceID, StaffID: staffID, Number: number, BusinessDate: date,
		Status: "paid", MenuVersion: 1, CreatedAt: at, ClosedAt: at.Add(time.Duration(40+rng.IntN(120)) * time.Second)}
	lines := 1 + rng.IntN(3)
	var amounts []pricing.Amount
	for range lines {
		item := weighted(rng, demoItems, func(i struct {
			id     string
			weight int
		}) int {
			return i.weight
		})
		qty := 1
		if rng.IntN(8) == 0 {
			qty = 2
		}
		p, err := pricing.PriceLine(ix, pricing.Line{ItemID: item.id, Qty: qty, Mods: demoSelections(rng, ix, item.id)})
		if err != nil {
			return nil, err
		}
		l := ledger.Line{ID: newID(), ItemID: p.ItemID, ItemName: p.ItemName, Category: p.Category, Qty: p.Qty,
			UnitPrice: p.UnitPrice, LineTotal: p.LineTotal, Taxable: p.Taxable, Mods: p.Mods, AddedAt: at}
		if rng.IntN(30) == 0 && len(o.Lines) > 0 {
			l.Void = &ledger.VoidInfo{At: at, By: staffID, Reason: demoLineVoids[rng.IntN(len(demoLineVoids))]}
		}
		o.Lines = append(o.Lines, l)
		amounts = append(amounts, pricing.Amount{LineTotal: l.LineTotal, Taxable: l.Taxable, Voided: l.Void != nil})
	}
	t := pricing.OrderTotals(amounts, ix.Doc.TaxRatePPM)
	o.Subtotal, o.Tax, o.Total = t.Subtotal, t.Tax, t.Total

	if rng.IntN(70) == 0 {
		o.Status = "voided"
		o.Void = &ledger.VoidInfo{At: o.ClosedAt, By: staffID, Reason: demoOrderVoids[rng.IntN(len(demoOrderVoids))]}
		o.Payments = []ledger.Payment{}
		return o, nil
	}
	p := ledger.Payment{ID: newID(), Tender: "card", Amount: o.Total, Tendered: o.Total, CoversLineIDs: []string{}, StaffID: staffID, CreatedAt: o.ClosedAt}
	if rng.IntN(3) == 0 {
		p.Tender = "cash"
		for _, bill := range []int64{100, 500, 1000, 2000} {
			if v := (o.Total + bill - 1) / bill * bill; rng.IntN(2) == 0 || bill == 2000 {
				p.Tendered = max(v, o.Total)
				break
			}
		}
		p.Change = p.Tendered - p.Amount
	}
	o.Payments = []ledger.Payment{p}
	return o, nil
}

// demoRefund refunds one unit of the order's first line, the way the
// register works it out (web/src/domain/refund.ts).
func demoRefund(rng *rand.Rand, o *ledger.Order, managerID, staffID string) *ledger.Refund {
	amounts := make([]pricing.Amount, len(o.Lines))
	for i, l := range o.Lines {
		amounts[i] = pricing.Amount{LineTotal: l.LineTotal, Taxable: l.Taxable, Voided: l.Void != nil}
	}
	shares := pricing.TaxShares(amounts, o.Tax)
	l := o.Lines[0]
	units := make([]int64, l.Qty)
	for i := range units {
		units[i] = 1
	}
	tax := money.Allocate(shares[0], units)[0]
	amount := l.UnitPrice + tax
	at := o.ClosedAt.Add(time.Duration(20+rng.IntN(90)) * time.Minute)
	return &ledger.Refund{V: 1, ID: newID(), OrderID: o.ID, PaymentID: o.Payments[0].ID, Tender: o.Payments[0].Tender,
		DeviceID: o.DeviceID, StaffID: staffID, ApprovedBy: managerID, BusinessDate: o.BusinessDate, CreatedAt: at,
		Amount: amount, Tax: tax, Reason: demoRefundReason[rng.IntN(len(demoRefundReason))],
		Lines: []ledger.RefundLine{{LineID: l.ID, Qty: 1, Amount: amount, Tax: tax}}}
}
