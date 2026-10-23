package server_test

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/google/uuid"

	"coffeepos/internal/auth"
	"coffeepos/internal/ledger"
)

func goldenRefund(t *testing.T) ledger.Refund {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/documents/refund.json")
	if err != nil {
		t.Fatal(err)
	}
	var r ledger.Refund
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func refundMutation(r ledger.Refund) mutation { return mutation{ID: r.ID, Kind: "refund", Doc: r} }

func newRefund(r ledger.Refund) ledger.Refund {
	r.ID = uuid.Must(uuid.NewV7()).String()
	r.Lines = append([]ledger.RefundLine(nil), r.Lines...)
	return r
}

// secondTablet enrolls another device and returns it and its id.
func secondTablet(t *testing.T, a *api) (*client, string) {
	t.Helper()
	token, hash := auth.NewToken()
	id := uuid.Must(uuid.NewV7()).String()
	if _, err := a.pool.Exec(t.Context(), `INSERT INTO devices (id, name, code, token_hash) VALUES ($1, 'Bar', 'B', $2)`, id, hash); err != nil {
		t.Fatal(err)
	}
	return &client{a: a, token: token}, id
}

func TestGoldenRefundFromTheWebAppIsStoredCleanly(t *testing.T) {
	a, tablet := contractAPI(t)
	res := tablet.push(orderMutation(goldenOrder(t)), refundMutation(goldenRefund(t)))
	for _, r := range res {
		if r.Status != ledger.Applied || len(r.Flags) != 0 {
			t.Fatalf("push = %+v", res)
		}
	}
	var amount, tax int64
	var tender string
	if err := a.pool.QueryRow(t.Context(), "SELECT amount, tax, tender FROM refunds").Scan(&amount, &tax, &tender); err != nil {
		t.Fatal(err)
	}
	if amount != 409 || tax != 34 || tender != "cash" {
		t.Fatalf("refund row: %d %d %s", amount, tax, tender)
	}
	if n := a.count("SELECT count(*) FROM refund_lines WHERE qty = 1 AND amount = 409"); n != 1 {
		t.Fatalf("refund lines = %d", n)
	}
}

func TestRefundsThatCannotBeStored(t *testing.T) {
	a, tablet := contractAPI(t)
	order := goldenOrder(t)

	// Before its order arrives, a refund has nothing to refer to.
	if res := tablet.push(refundMutation(goldenRefund(t)))[0]; res.Status != ledger.Rejected {
		t.Fatalf("refund before order: %+v", res)
	}
	tablet.push(orderMutation(order))

	other := fresh(order)
	tablet.push(orderMutation(other))
	cases := map[string]func(r *ledger.Refund){
		"another order's payment":   func(r *ledger.Refund) { r.PaymentID = other.Payments[1].ID },
		"a line from another order": func(r *ledger.Refund) { r.Lines[0].LineID = other.Lines[1].ID },
		"the wrong tender":          func(r *ledger.Refund) { r.Tender = "card" },
		"no reason":                 func(r *ledger.Refund) { r.Reason = "" },
		"tax bigger than amount":    func(r *ledger.Refund) { r.Tax = r.Amount + 1 },
	}
	for name, edit := range cases {
		r := newRefund(goldenRefund(t))
		edit(&r)
		if res := tablet.push(refundMutation(r))[0]; res.Status != ledger.Rejected {
			t.Errorf("%s: %+v", name, res)
		}
	}
	if n := a.count("SELECT count(*) FROM refunds"); n != 0 {
		t.Fatalf("refunds stored = %d", n)
	}
}

// Two tablets, both offline, refund the same croissants. Both refunds are
// real money that left a drawer, so both are stored; the second is flagged.
func TestOverRefundsFromTwoTabletsAreStoredAndFlagged(t *testing.T) {
	a, front := contractAPI(t)
	bar, barID := secondTablet(t, a)
	front.push(orderMutation(goldenOrder(t)))

	both := newRefund(goldenRefund(t))
	both.Lines[0].Qty, both.Lines[0].Amount, both.Lines[0].Tax = 2, 817, 67
	both.Amount, both.Tax = 817, 67
	if res := front.push(refundMutation(both))[0]; res.Status != ledger.Applied || len(res.Flags) != 0 {
		t.Fatalf("first refund: %+v", res)
	}

	again := newRefund(both)
	again.DeviceID = barID
	res := bar.push(refundMutation(again))[0]
	if res.Status != ledger.Applied || !reflect.DeepEqual(res.Flags, []string{ledger.FlagOverRefund}) {
		t.Fatalf("second refund: %+v", res)
	}
	if n := a.count("SELECT count(*) FROM refunds"); n != 2 {
		t.Fatalf("refunds stored = %d", n)
	}
	var detail string
	if err := a.pool.QueryRow(t.Context(), "SELECT detail::text FROM flags WHERE kind = 'over_refund'").Scan(&detail); err != nil {
		t.Fatal(err)
	}
	t.Log(detail)
}

func TestRefundRuleBreaksAreFlagged(t *testing.T) {
	_, tablet := contractAPI(t)

	cases := []struct {
		name  string
		edit  func(r *ledger.Refund, o ledger.Order)
		flags []string
	}{
		{"approved by a barista", func(r *ledger.Refund, _ ledger.Order) { r.ApprovedBy = contractSam }, []string{ledger.FlagApprovalInvalid}},
		{"approved by a stranger", func(r *ledger.Refund, _ ledger.Order) { r.ApprovedBy = uuid.Must(uuid.NewV7()).String() }, []string{ledger.FlagUnknownStaff}},
		{"more than the payment", func(r *ledger.Refund, _ ledger.Order) { r.Lines = nil; r.Amount, r.Tax = 5000, 100 }, []string{ledger.FlagOverRefund}},
		{"a voided line", func(r *ledger.Refund, o ledger.Order) { r.Lines[0].LineID = o.Lines[3].ID }, []string{ledger.FlagOverRefund}},
		{"lines that don't add up", func(r *ledger.Refund, _ ledger.Order) { r.Amount++ }, []string{ledger.FlagTotalMismatch}},
		{"the wrong day", func(r *ledger.Refund, _ ledger.Order) { r.BusinessDate = "2026-10-20" }, []string{ledger.FlagClockSkew}},
	}
	for _, tc := range cases {
		// Each case refunds a croissant from its own copy of the golden order.
		o := fresh(goldenOrder(t))
		tablet.push(orderMutation(o))
		r := newRefund(goldenRefund(t))
		r.OrderID, r.PaymentID, r.Lines[0].LineID = o.ID, o.Payments[1].ID, o.Lines[1].ID
		tc.edit(&r, o)
		res := tablet.push(refundMutation(r))[0]
		if res.Status != ledger.Applied || !reflect.DeepEqual(res.Flags, tc.flags) {
			t.Errorf("%s: %+v, want applied with %v", tc.name, res, tc.flags)
		}
	}
}
