package server_test

import (
	"math/rand/v2"
	"net/http"
	"reflect"
	"testing"

	"coffeepos/internal/ledger"
	"coffeepos/internal/reports"
)

// reportDay pushes a known day of business on 2026-10-22 (all hand-checked):
//   - G: the golden order. Latte $7.10 (card $7.73), 2 croissants $7.50 and
//     beans $16.00 (cash $24.17), a voided drip coffee. $30.60 + $1.30 tax.
//   - V: the same order, voided ("Customer left") before payment.
//   - R: the same order, paid, after a $5.00 card payment was reversed ("Wrong tender").
//   - A refund of one croissant from G: $4.09 cash, of which $0.34 tax.
func reportDay(t *testing.T) (*api, *client, *client) {
	t.Helper()
	a, tablet := contractAPI(t)
	g := goldenOrder(t)

	v := fresh(g)
	v.Status = "voided"
	v.Void = &ledger.VoidInfo{At: v.ClosedAt, By: contractSam, Reason: "Customer left"}
	v.Payments = nil

	r := fresh(g)
	wrong := r.Payments[0]
	wrong.ID, wrong.Amount, wrong.Tendered = "0190f0d6-0000-7000-8000-0000000ff001", 500, 500
	wrong.CoversLineIDs = nil
	wrong.Reversal = &ledger.VoidInfo{At: wrong.CreatedAt, By: contractSam, Reason: "Wrong tender"}
	r.Payments = append([]ledger.Payment{wrong}, r.Payments...)

	for _, res := range tablet.push(orderMutation(g), orderMutation(v), orderMutation(r), refundMutation(goldenRefund(t))) {
		if res.Status != ledger.Applied || len(res.Flags) != 0 {
			t.Fatalf("fixture push: %+v", res)
		}
	}
	office := a.enroll("Office").signIn("Morgan", "1111")
	return a, tablet, office
}

func TestSalesReport(t *testing.T) {
	_, _, office := reportDay(t)
	var rep reports.Report
	office.call(http.StatusOK, "GET", "/api/reports/sales?from=2026-10-22&to=2026-10-22", nil, &rep)

	want := reports.Summary{
		Orders:        2,
		GrossSales:    6120,
		Tax:           260,
		Refunds:       409,
		RefundCount:   1,
		RefundedTax:   34,
		NetSales:      5745, // 6120 − (409 − 34)
		NetTax:        226,  // 260 − 34
		Collected:     5971, // (3190 + 3190) − 409
		AverageTicket: 3190,
		VoidedOrders:  1,
		VoidedLines:   3,
		Reversals:     1,
	}
	if rep.Summary != want {
		t.Errorf("summary\n got %+v\nwant %+v", rep.Summary, want)
	}
	if rep.Summary.Collected != rep.Summary.NetSales+rep.Summary.NetTax {
		t.Error("collected should equal net sales plus net tax")
	}

	check := func(name string, got, want any) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s\n got %+v\nwant %+v", name, got, want)
		}
	}
	check("tenders", rep.Tenders, []reports.TenderRow{
		{Tender: "card", Payments: 2, Taken: 1546, Net: 1546},
		{Tender: "cash", Payments: 2, Taken: 4834, RefundCount: 1, Refunded: 409, Net: 4425},
	})
	check("items", rep.Items, []reports.ItemRow{
		{ItemID: "beans", Name: "Whole Beans 12oz", Category: "Retail", Qty: 2, Gross: 3200, Net: 3200},
		{ItemID: "croissant", Name: "Croissant", Category: "Bakery", Qty: 4, Gross: 1500, RefundedQty: 1, Refunded: 375, Net: 1125},
		{ItemID: "latte", Name: "Latte", Category: "Espresso", Qty: 2, Gross: 1420, Net: 1420},
	})
	check("categories", rep.Categories, []reports.CategoryRow{
		{Category: "Retail", Qty: 2, Gross: 3200, Net: 3200},
		{Category: "Bakery", Qty: 4, Gross: 1500, Refunded: 375, Net: 1125},
		{Category: "Espresso", Qty: 2, Gross: 1420, Net: 1420},
	})
	check("modifiers", rep.Modifiers, []reports.ModifierRow{
		{OptionID: "shot-extra", Group: "Extra shots", Option: "Extra shot", Count: 2, Revenue: 180},
		{OptionID: "milk-oat", Group: "Milk", Option: "Oat", Count: 2, Revenue: 140},
		{OptionID: "size-l", Group: "Size", Option: "Large", Count: 2, Revenue: 200},
	})
	// 14:33 UTC is 10:33 in New York.
	check("hours", rep.Hours, []reports.HourRow{{Hour: 10, Orders: 2, Gross: 6120}})
	check("staff", rep.Staff, []reports.StaffRow{
		{StaffID: contractSam, Name: "Sam", Orders: 2, Gross: 6120, VoidedLines: 3, VoidedLineAmount: 975,
			VoidedOrders: 1, Reversals: 1, ReversalAmount: 500, RefundsIssued: 1, RefundedAmount: 409},
		{StaffID: contractMorgan, Name: "Morgan", RefundsApproved: 1},
	})
	check("exceptions", rep.Exceptions, reports.Exceptions{
		LineVoids:  []reports.ReasonRow{{Reason: "Rang in error", Count: 3, Amount: 975}},
		OrderVoids: []reports.ReasonRow{{Reason: "Customer left", Count: 1, Amount: 3190}},
		Reversals:  []reports.ReasonRow{{Reason: "Wrong tender", Count: 1, Amount: 500}},
		Refunds:    []reports.ReasonRow{{Reason: "Dropped on the floor", Count: 1, Amount: 409}},
	})
	if len(rep.Drawers) != 2 || rep.Drawers[0].Code != "A" || rep.Drawers[0].CashIn != 4834 || rep.Drawers[0].CashOut != 409 ||
		rep.Drawers[1].CashIn != 0 {
		t.Errorf("drawers = %+v", rep.Drawers)
	}

	// Another day is empty, and bad ranges are refused.
	office.call(http.StatusOK, "GET", "/api/reports/sales?from=2026-10-23&to=2026-10-23", nil, &rep)
	if rep.Summary != (reports.Summary{}) || len(rep.Items) != 0 {
		t.Errorf("empty day: %+v", rep.Summary)
	}
	office.call(http.StatusBadRequest, "GET", "/api/reports/sales?from=2026-10-23&to=2026-10-22", nil, nil)
	office.call(http.StatusBadRequest, "GET", "/api/reports/sales?from=yesterday&to=2026-10-22", nil, nil)
}

func TestCloseoutAndLateArrivals(t *testing.T) {
	a, tablet, office := reportDay(t)
	var st reports.CloseoutStatus
	office.call(http.StatusOK, "GET", "/api/closeouts/2026-10-22", nil, &st)
	if st.Closeout != nil || st.DefaultFloat != 15000 || st.Live.Summary.Orders != 2 || len(st.Devices) != 2 {
		t.Fatalf("before close: %+v", st)
	}

	// The drawer is $1.25 short.
	deviceA := st.Live.Drawers[0].DeviceID
	req := map[string]any{
		"drawers": []map[string]any{{"deviceId": deviceA, "openingFloat": 15000, "counted": 15000 + 4425 - 125}},
		"note":    "Busy morning",
	}
	var c reports.Closeout
	office.call(http.StatusCreated, "POST", "/api/closeouts/2026-10-22", req, &c)
	want := reports.Drawer{DeviceID: deviceA, Name: "Front", Code: "A", OpeningFloat: 15000, CashIn: 4834, CashOut: 409,
		Expected: 19425, Counted: 19300, OverShort: -125}
	if len(c.Drawers) != 1 || c.Drawers[0] != want || c.ClosedBy != "Morgan" || c.Note != "Busy morning" {
		t.Fatalf("closeout = %+v", c)
	}
	if got := office.errorCode(http.StatusConflict, "POST", "/api/closeouts/2026-10-22", req); got != "already_closed" {
		t.Fatalf("closing twice: %s", got)
	}
	office.call(http.StatusBadRequest, "POST", "/api/closeouts/2026-10-25", req, nil) // the future

	office.call(http.StatusOK, "GET", "/api/closeouts/2026-10-22", nil, &st)
	if st.Closeout == nil || st.Changed {
		t.Fatalf("right after close: changed=%v", st.Changed)
	}

	// A tablet that was offline syncs a sale from that day: stored, flagged,
	// and the close-out shows that the day changed.
	late := fresh(goldenOrder(t))
	res := tablet.push(orderMutation(late))[0]
	if res.Status != ledger.Applied || !reflect.DeepEqual(res.Flags, []string{ledger.FlagAfterCloseout}) {
		t.Fatalf("late order: %+v", res)
	}
	office.call(http.StatusOK, "GET", "/api/closeouts/2026-10-22", nil, &st)
	if !st.Changed || st.Live.Summary.Orders != 3 || st.Closeout.Snapshot.Summary.Orders != 2 {
		t.Fatalf("after late order: changed=%v live=%d snapshot=%d", st.Changed, st.Live.Summary.Orders, st.Closeout.Snapshot.Summary.Orders)
	}

	// The manager reviews the flag.
	var flags []reports.FlagView
	office.call(http.StatusOK, "GET", "/api/flags", nil, &flags)
	if len(flags) != 1 || flags[0].Kind != ledger.FlagAfterCloseout || flags[0].Number != "A-007" || flags[0].DeviceCode != "A" {
		t.Fatalf("flags = %+v", flags)
	}
	office.call(http.StatusBadRequest, "POST", "/api/flags/"+itoa(flags[0].ID)+"/resolve", map[string]string{"note": " "}, nil)
	office.call(http.StatusNoContent, "POST", "/api/flags/"+itoa(flags[0].ID)+"/resolve", map[string]string{"note": "Tablet B was offline all morning"}, nil)
	office.call(http.StatusConflict, "POST", "/api/flags/"+itoa(flags[0].ID)+"/resolve", map[string]string{"note": "again"}, nil)
	office.call(http.StatusOK, "GET", "/api/flags", nil, &flags)
	if len(flags) != 0 {
		t.Fatalf("open flags after resolving: %+v", flags)
	}
	office.call(http.StatusOK, "GET", "/api/flags?status=resolved", nil, &flags)
	if len(flags) != 1 || *flags[0].ResolvedBy != "Morgan" || *flags[0].Resolution != "Tablet B was offline all morning" {
		t.Fatalf("resolved flags = %+v", flags)
	}
	_ = a
}

// Whatever happens in a day, the money adds up: collected = net sales + net
// tax, and the drawers hold the cash that was collected.
func TestReportIdentityOnRandomDays(t *testing.T) {
	_, tablet := contractAPI(t)
	office := tablet.a.enroll("Office").signIn("Morgan", "1111")
	rng := rand.New(rand.NewPCG(3, 4))
	g := goldenOrder(t)
	for range 25 {
		o := fresh(g)
		switch rng.IntN(4) {
		case 0:
			o.Status, o.Payments = "voided", nil
			o.Void = &ledger.VoidInfo{At: o.ClosedAt, By: contractSam, Reason: "Customer left"}
		case 1:
			extra := o.Payments[1]
			extra.ID = fresh(g).Payments[1].ID
			extra.Reversal = &ledger.VoidInfo{At: extra.CreatedAt, By: contractSam, Reason: "Wrong tender"}
			o.Payments = append(o.Payments, extra)
		}
		tablet.push(orderMutation(o))
		if o.Status == "paid" && rng.IntN(2) == 0 {
			r := newRefund(goldenRefund(t))
			r.OrderID, r.PaymentID, r.Lines[0].LineID = o.ID, o.Payments[1].ID, o.Lines[1].ID
			tablet.push(refundMutation(r))
		}
	}
	var rep reports.Report
	office.call(http.StatusOK, "GET", "/api/reports/sales?from=2026-10-22&to=2026-10-22", nil, &rep)
	s := rep.Summary
	if s.Collected != s.NetSales+s.NetTax {
		t.Fatalf("collected %d ≠ net sales %d + net tax %d", s.Collected, s.NetSales, s.NetTax)
	}
	var cash, card int64
	for _, d := range rep.Drawers {
		cash += d.CashIn - d.CashOut
	}
	for _, tr := range rep.Tenders {
		if tr.Tender == "card" {
			card = tr.Net
		}
	}
	if cash+card != s.Collected {
		t.Fatalf("drawers %d + card %d ≠ collected %d", cash, card, s.Collected)
	}
}
