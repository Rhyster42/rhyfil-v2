package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"coffeepos/internal/auth"
	"coffeepos/internal/ledger"
	"coffeepos/internal/menu"
	"coffeepos/internal/syncapi"
)

// The ids web/src/domain/contract.test.ts used for testdata/documents/order.json.
const (
	contractDevice = "0190f0d6-0000-7000-8000-00000000d001"
	contractSam    = "0190f0d6-0000-7000-8000-00000000c001"
)

// contractAPI is a system with the vector menu as version 1 and the
// contract's device and staff member, the clock at 15:00 UTC on 2026-10-22.
func contractAPI(t *testing.T) (*api, *client) {
	t.Helper()
	a := newAPI(t)
	a.now = time.Date(2026, 10, 22, 15, 0, 0, 0, time.UTC)
	ctx := context.Background()

	raw, err := os.ReadFile("../../testdata/vectors/menu.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc menu.Doc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if _, err := a.srv.Menus.Save(ctx, 0, &doc, ""); err != nil {
		t.Fatal(err)
	}
	verifier, _ := auth.HashPIN("1111", 1000)
	token, hash := auth.NewToken()
	if _, err := a.pool.Exec(ctx, `
		INSERT INTO staff (id, name, role, pin_verifier) VALUES ($1, 'Sam', 'barista', $2);
		`, contractSam, verifier); err != nil {
		t.Fatal(err)
	}
	if _, err := a.pool.Exec(ctx, `INSERT INTO devices (id, name, code, token_hash) VALUES ($1, 'Front', 'A', $2)`, contractDevice, hash); err != nil {
		t.Fatal(err)
	}
	return a, &client{a: a, token: token}
}

func goldenOrder(t *testing.T) ledger.Order {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/documents/order.json")
	if err != nil {
		t.Fatal(err)
	}
	var o ledger.Order
	if err := json.Unmarshal(raw, &o); err != nil {
		t.Fatal(err)
	}
	return o
}

// fresh gives an order new ids, so it's a different document.
func fresh(o ledger.Order) ledger.Order {
	newID := func() string { return uuid.Must(uuid.NewV7()).String() }
	o.ID = newID()
	lineIDs := map[string]string{}
	o.Lines = append([]ledger.Line(nil), o.Lines...)
	for i := range o.Lines {
		id := newID()
		lineIDs[o.Lines[i].ID] = id
		o.Lines[i].ID = id
	}
	o.Payments = append([]ledger.Payment(nil), o.Payments...)
	for i := range o.Payments {
		o.Payments[i].ID = newID()
		covers := []string{}
		for _, c := range o.Payments[i].CoversLineIDs {
			covers = append(covers, lineIDs[c])
		}
		o.Payments[i].CoversLineIDs = covers
	}
	return o
}

type mutation struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Doc  any    `json:"doc"`
}

func (c *client) push(docs ...mutation) []ledger.Result {
	c.a.t.Helper()
	var out struct{ Results []ledger.Result }
	c.call(http.StatusOK, "POST", "/api/sync/push", map[string]any{"mutations": docs}, &out)
	return out.Results
}

func orderMutation(o ledger.Order) mutation { return mutation{ID: o.ID, Kind: "order", Doc: o} }

func (a *api) count(sql string, args ...any) int {
	a.t.Helper()
	var n int
	if err := a.pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		a.t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func TestGoldenOrderFromTheWebAppIsStoredCleanly(t *testing.T) {
	a, tablet := contractAPI(t)
	o := goldenOrder(t)
	res := tablet.push(orderMutation(o))
	if res[0].Status != ledger.Applied || len(res[0].Flags) != 0 || res[0].Seq == 0 {
		t.Fatalf("push = %+v", res[0])
	}

	// Projections.
	var total, tax int64
	var status string
	if err := a.pool.QueryRow(t.Context(), "SELECT status, total, tax FROM orders WHERE id = $1", o.ID).Scan(&status, &total, &tax); err != nil {
		t.Fatal(err)
	}
	if status != "paid" || total != 3190 || tax != 130 {
		t.Fatalf("order row: %s %d %d", status, total, tax)
	}
	if n := a.count("SELECT count(*) FROM order_lines WHERE order_id = $1", o.ID); n != 4 {
		t.Fatalf("lines = %d", n)
	}
	if n := a.count("SELECT count(*) FROM order_lines WHERE order_id = $1 AND void_reason = 'Rang in error'", o.ID); n != 1 {
		t.Fatalf("voided lines = %d", n)
	}
	if n := a.count("SELECT count(*) FROM order_line_mods WHERE line_id = $1", o.Lines[0].ID); n != 3 {
		t.Fatalf("latte mods = %d", n)
	}
	if n := a.count("SELECT count(*) FROM payments WHERE order_id = $1 AND covers_line_ids = ARRAY[$2::uuid]", o.ID, o.Lines[0].ID); n != 1 {
		t.Fatalf("split-by-item payment not stored with its line")
	}

	// It comes back on pull, unchanged in meaning.
	var pull syncapi.PullResponse
	tablet.call(http.StatusOK, "GET", "/api/sync/pull", nil, &pull)
	if len(pull.Ledger.Entries) != 1 || pull.Ledger.Cursor != res[0].Seq {
		t.Fatalf("pull ledger = %+v", pull.Ledger)
	}
	var back ledger.Order
	if err := json.Unmarshal(pull.Ledger.Entries[0].Doc, &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, o) {
		t.Fatalf("pulled order differs:\n%+v\n%+v", back, o)
	}
}

func TestPushIsIdempotent(t *testing.T) {
	a, tablet := contractAPI(t)
	o := goldenOrder(t)
	first := tablet.push(orderMutation(o))[0]
	again := tablet.push(orderMutation(o))[0]
	if again.Status != ledger.Duplicate || again.Seq != first.Seq {
		t.Fatalf("second push = %+v, first = %+v", again, first)
	}
	if n := a.count("SELECT count(*) FROM order_lines"); n != 4 {
		t.Fatalf("lines after duplicate push = %d", n)
	}

	// The same id with different content is refused, and the original kept.
	changed := o
	changed.Number = "A-999"
	res := tablet.push(orderMutation(changed))[0]
	if res.Status != ledger.Rejected {
		t.Fatalf("conflicting duplicate = %+v", res)
	}
	if n := a.count("SELECT count(*) FROM orders WHERE number = 'A-007'"); n != 1 {
		t.Fatal("original order was replaced")
	}
	if n := a.count("SELECT count(*) FROM sync_rejections"); n != 1 {
		t.Fatalf("rejections recorded = %d", n)
	}
}

func TestPushRejectsWhatItCannotStore(t *testing.T) {
	a, tablet := contractAPI(t)
	base := goldenOrder(t)
	other := uuid.Must(uuid.NewV7()).String()

	cases := map[string]mutation{
		"another device's order": func() mutation { o := fresh(base); o.DeviceID = other; return orderMutation(o) }(),
		"unknown field":          {ID: other, Kind: "order", Doc: map[string]any{"id": other, "v": 1, "surprise": true}},
		"bad line id":            func() mutation { o := fresh(base); o.Lines[0].ID = "line-1"; return orderMutation(o) }(),
		"change doesn't add up": func() mutation {
			o := fresh(base)
			o.Payments[1].Change++
			return orderMutation(o)
		}(),
		"zero quantity":       func() mutation { o := fresh(base); o.Lines[1].Qty = 0; return orderMutation(o) }(),
		"covers a stray line": func() mutation { o := fresh(base); o.Payments[0].CoversLineIDs = []string{other}; return orderMutation(o) }(),
		"id mismatch":         func() mutation { o := fresh(base); m := orderMutation(o); m.ID = other; return m }(),
		"unknown kind":        {ID: other, Kind: "tip", Doc: map[string]any{}},
		"line id reused":      func() mutation { o := fresh(base); o.Lines[0].ID = base.Lines[0].ID; return orderMutation(o) }(),
	}
	// The golden order goes first, so "line id reused" collides with it.
	if res := tablet.push(orderMutation(base))[0]; res.Status != ledger.Applied {
		t.Fatalf("base order: %+v", res)
	}
	for name, m := range cases {
		res := tablet.push(m, orderMutation(fresh(base)))
		if res[0].Status != ledger.Rejected || res[0].Error == "" {
			t.Errorf("%s: %+v", name, res[0])
		}
		// A rejection doesn't hold up the documents behind it.
		if res[1].Status != ledger.Applied {
			t.Errorf("%s: the next document was %+v", name, res[1])
		}
	}
	if n := a.count("SELECT count(*) FROM sync_rejections"); n != len(cases) {
		t.Errorf("rejections recorded = %d, want %d", n, len(cases))
	}
}

func TestPushStoresAndFlagsRuleBreaks(t *testing.T) {
	a, tablet := contractAPI(t)
	base := goldenOrder(t)

	cases := []struct {
		name  string
		edit  func(o *ledger.Order)
		flags []string
	}{
		{"a discount the menu doesn't have", func(o *ledger.Order) {
			o.Lines[0].UnitPrice -= 100
			o.Lines[0].LineTotal -= 100
			o.Subtotal -= 100
			o.Tax = 121 // 8.875% of 1360
			o.Total = o.Subtotal + o.Tax
			o.Payments[0].Amount -= 109
			o.Payments[0].Tendered -= 109
		}, []string{ledger.FlagMenuMismatch}},
		{"totals that don't add up", func(o *ledger.Order) { o.Subtotal += 50; o.Total += 50; o.Payments[1].Amount += 50; o.Payments[1].Change -= 50 },
			[]string{ledger.FlagTotalMismatch}},
		{"paid less than the total", func(o *ledger.Order) { o.Payments[1].Amount -= 10; o.Payments[1].Change += 10 },
			[]string{ledger.FlagPaymentMismatch}},
		{"a reversed payment doesn't count", func(o *ledger.Order) {
			o.Payments[0].Reversal = &ledger.VoidInfo{At: o.ClosedAt, By: contractSam, Reason: "Wrong tender"}
		}, []string{ledger.FlagPaymentMismatch}},
		{"someone the server doesn't know", func(o *ledger.Order) { o.Payments[1].StaffID = uuid.Must(uuid.NewV7()).String() },
			[]string{ledger.FlagUnknownStaff}},
		{"a menu version that doesn't exist", func(o *ledger.Order) { o.MenuVersion = 42 },
			[]string{ledger.FlagMenuMismatch}},
		{"a clock running ahead", func(o *ledger.Order) {
			o.CreatedAt = o.CreatedAt.Add(time.Hour)
			o.ClosedAt = o.ClosedAt.Add(time.Hour)
		}, []string{ledger.FlagClockSkew}},
		{"the wrong business date", func(o *ledger.Order) { o.BusinessDate = "2026-10-21" },
			[]string{ledger.FlagClockSkew}},
		{"an incomplete line", func(o *ledger.Order) {
			o.Lines[0].Mods = o.Lines[0].Mods[1:] // no size
			o.Lines[0].UnitPrice -= 100
			o.Lines[0].LineTotal -= 100
			o.Subtotal -= 100
			o.Tax = 121
			o.Total = o.Subtotal + o.Tax
			o.Payments[0].Amount -= 109
			o.Payments[0].Tendered -= 109
		}, []string{ledger.FlagMenuMismatch}},
	}
	for _, tc := range cases {
		o := fresh(base)
		tc.edit(&o)
		res := tablet.push(orderMutation(o))[0]
		if res.Status != ledger.Applied || !reflect.DeepEqual(res.Flags, tc.flags) {
			t.Errorf("%s: %+v, want applied with %v", tc.name, res, tc.flags)
			continue
		}
		if n := a.count("SELECT count(*) FROM orders WHERE id = $1", o.ID); n != 1 {
			t.Errorf("%s: order not stored", tc.name)
		}
		if n := a.count("SELECT count(*) FROM flags WHERE subject_id = $1 AND resolved_at IS NULL", o.ID); n != len(tc.flags) {
			t.Errorf("%s: %d flag rows", tc.name, n)
		}
	}
}

func TestPullSendsOnlyRecentDays(t *testing.T) {
	a, tablet := contractAPI(t)
	old := fresh(goldenOrder(t))
	old.BusinessDate = "2026-10-15"
	old.CreatedAt = time.Date(2026, 10, 15, 14, 30, 0, 0, time.UTC)
	recent := fresh(goldenOrder(t))
	res := tablet.push(orderMutation(old), orderMutation(recent))

	var pull syncapi.PullResponse
	tablet.call(http.StatusOK, "GET", "/api/sync/pull", nil, &pull)
	if len(pull.Ledger.Entries) != 1 || pull.Ledger.Entries[0].Seq != res[1].Seq {
		t.Fatalf("entries = %+v", pull.Ledger.Entries)
	}
	if pull.Ledger.Cursor != res[1].Seq || pull.Ledger.HasMore {
		t.Fatalf("cursor %d hasMore %v", pull.Ledger.Cursor, pull.Ledger.HasMore)
	}
	// Caught up: nothing more, and the cursor stays put.
	tablet.call(http.StatusOK, "GET", fmt.Sprintf("/api/sync/pull?cursor=%d", pull.Ledger.Cursor), nil, &pull)
	if len(pull.Ledger.Entries) != 0 || pull.Ledger.Cursor != res[1].Seq {
		t.Fatalf("second pull = %+v", pull.Ledger)
	}
	_ = a
}

// Many tablets push at once while another pulls with a cursor. The puller
// must see every document exactly once (docs/decisions/0012).
func TestCursorNeverSkipsUnderConcurrentPushes(t *testing.T) {
	a, reader := contractAPI(t)
	const devices, perDevice = 6, 25
	base := goldenOrder(t)

	type tablet struct{ id, token string }
	tablets := make([]tablet, devices)
	for i := range tablets {
		token, hash := auth.NewToken()
		tablets[i] = tablet{id: uuid.Must(uuid.NewV7()).String(), token: token}
		if _, err := a.pool.Exec(t.Context(), `INSERT INTO devices (id, name, code, token_hash) VALUES ($1, $2, $2, $3)`,
			tablets[i].id, fmt.Sprintf("T%d", i), hash); err != nil {
			t.Fatal(err)
		}
	}

	pushed := make(chan string, devices*perDevice)
	var wg sync.WaitGroup
	errs := make(chan error, devices)
	for _, tb := range tablets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range perDevice {
				o := fresh(base)
				o.DeviceID = tb.id
				body, _ := json.Marshal(map[string]any{"mutations": []mutation{orderMutation(o)}})
				req := httptest.NewRequest("POST", "/api/sync/push", bytes.NewReader(body))
				req.Header.Set("Authorization", "Bearer "+tb.token)
				rec := httptest.NewRecorder()
				a.srv.Handler.ServeHTTP(rec, req)
				var out struct{ Results []ledger.Result }
				if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Results) != 1 || out.Results[0].Status != ledger.Applied {
					errs <- fmt.Errorf("push: %d %s", rec.Code, rec.Body.String())
					return
				}
				pushed <- o.ID
			}
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()

	seen := map[string]int{}
	var cursor, lastSeq int64
	pull := func() {
		for {
			var p syncapi.PullResponse
			reader.call(http.StatusOK, "GET", fmt.Sprintf("/api/sync/pull?cursor=%d&menu=1&staff=99&settings=99", cursor), nil, &p)
			for _, e := range p.Ledger.Entries {
				if e.Seq <= lastSeq {
					t.Fatalf("seq went backwards: %d after %d", e.Seq, lastSeq)
				}
				lastSeq = e.Seq
				var o ledger.Order
				json.Unmarshal(e.Doc, &o)
				seen[o.ID]++
			}
			cursor = p.Ledger.Cursor
			if !p.Ledger.HasMore {
				return
			}
		}
	}
	for running := true; running; {
		select {
		case <-done:
			running = false
		case err := <-errs:
			t.Fatal(err)
		default:
			pull()
		}
	}
	pull()
	close(pushed)
	count := 0
	for id := range pushed {
		count++
		if seen[id] != 1 {
			t.Fatalf("order %s seen %d times", id, seen[id])
		}
	}
	if count != devices*perDevice || len(seen) != count {
		t.Fatalf("pushed %d, pulled %d", count, len(seen))
	}
}
