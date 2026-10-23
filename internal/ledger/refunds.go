package ledger

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"coffeepos/internal/bizdate"
	"coffeepos/internal/pricing"
)

// RefundLine is the part of a refund that returns units of one order line.
type RefundLine struct {
	LineID string `json:"lineId"`
	Qty    int    `json:"qty"`
	Amount int64  `json:"amount"` // tax included
	Tax    int64  `json:"tax"`
}

// Refund returns money from one of an order's payments (docs/decisions/0009).
type Refund struct {
	V            int          `json:"v"`
	ID           string       `json:"id"`
	OrderID      string       `json:"orderId"`
	PaymentID    string       `json:"paymentId"`
	Tender       string       `json:"tender"`
	DeviceID     string       `json:"deviceId"`
	StaffID      string       `json:"staffId"`
	ApprovedBy   string       `json:"approvedBy"`
	BusinessDate string       `json:"businessDate"`
	CreatedAt    time.Time    `json:"createdAt"`
	Amount       int64        `json:"amount"` // tax included
	Tax          int64        `json:"tax"`
	Reason       string       `json:"reason"`
	Lines        []RefundLine `json:"lines"`
}

func (r *Refund) validate(deviceID string) error {
	switch {
	case r.V != 1:
		return reject("unsupported document version %d", r.V)
	case !validUUID(r.ID) || !validUUID(r.OrderID) || !validUUID(r.PaymentID) ||
		!validUUID(r.DeviceID) || !validUUID(r.StaffID) || !validUUID(r.ApprovedBy):
		return reject("ids must be UUIDs")
	case r.DeviceID != deviceID:
		return reject("document belongs to device %s, not this one", r.DeviceID)
	case r.Tender != "cash" && r.Tender != "card":
		return reject("tender must be cash or card")
	case r.Amount <= 0 || r.Tax < 0 || r.Tax > r.Amount:
		return reject("a refund returns a positive amount, of which tax is a part")
	case r.Reason == "" || len(r.Reason) > 200:
		return reject("a refund needs a reason")
	case r.CreatedAt.IsZero():
		return reject("createdAt is required")
	case len(r.Lines) > maxLines:
		return reject("too many lines")
	}
	if _, err := bizdate.Parse(r.BusinessDate); err != nil {
		return reject("business date must be YYYY-MM-DD")
	}
	seen := map[string]bool{}
	for i, l := range r.Lines {
		switch {
		case !validUUID(l.LineID) || seen[l.LineID]:
			return reject("refund line %d: line id must be a unique UUID", i)
		case l.Qty < 1 || l.Qty > maxLineQty:
			return reject("refund line %d: quantity must be 1-%d", i, maxLineQty)
		case l.Amount < 0 || l.Tax < 0 || l.Tax > l.Amount:
			return reject("refund line %d: amounts don't fit together", i)
		}
		seen[l.LineID] = true
	}
	return nil
}

func (r *Refund) normalize() {
	if r.Lines == nil {
		r.Lines = []RefundLine{}
	}
}

// refundTarget is what the server knows about the order and payment a
// refund points at, including earlier refunds.
type refundTarget struct {
	paymentAmount   int64
	paymentTender   string
	paymentReversed bool
	refundedBefore  int64 // from this payment, by other refunds
	lines           map[string]lineState
}

type lineState struct {
	name         string
	qty          int
	amount       int64 // line total + its share of the order's tax
	tax          int64 // its share of the order's tax
	voided       bool
	refundedQty  int
	refundedAmt  int64
	refundedTax  int64
	belongsToOrd bool
}

// loadRefundTarget reads the order and payment a refund refers to, inside the
// ingest transaction (so earlier refunds are all visible). It rejects
// references that don't exist: the refund can't be stored without them.
func loadRefundTarget(ctx context.Context, tx pgx.Tx, r *Refund) (*refundTarget, error) {
	t := &refundTarget{lines: map[string]lineState{}}
	var orderOf string
	err := tx.QueryRow(ctx, `
		SELECT order_id::text, amount, tender, reversed_at IS NOT NULL FROM payments WHERE id = $1`, r.PaymentID,
	).Scan(&orderOf, &t.paymentAmount, &t.paymentTender, &t.paymentReversed)
	if errors.Is(err, pgx.ErrNoRows) {
		var orderKnown bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM orders WHERE id = $1)", r.OrderID).Scan(&orderKnown); err != nil {
			return nil, err
		}
		if !orderKnown {
			return nil, reject("refund for order %s, which the server hasn't received", r.OrderID)
		}
		return nil, reject("refund to payment %s, which isn't on the order", r.PaymentID)
	} else if err != nil {
		return nil, err
	}
	if orderOf != r.OrderID {
		return nil, reject("refund to payment %s, which isn't on the order", r.PaymentID)
	}
	if t.paymentTender != r.Tender {
		return nil, reject("refund says %s but the payment was %s", r.Tender, t.paymentTender)
	}
	if err := tx.QueryRow(ctx, "SELECT coalesce(sum(amount), 0) FROM refunds WHERE payment_id = $1", r.PaymentID).
		Scan(&t.refundedBefore); err != nil {
		return nil, err
	}

	// The order's lines, with each one's share of tax, the way the tablet
	// computed it (docs/decisions/0006), and what's been refunded so far.
	var raw []byte
	if err := tx.QueryRow(ctx, "SELECT doc FROM ledger WHERE id = $1 AND kind = 'order'", r.OrderID).Scan(&raw); err != nil {
		return nil, err
	}
	var o Order
	if err := decodeStrict(raw, &o); err != nil {
		return nil, err
	}
	shares := lineTaxShares(&o)
	for i, l := range o.Lines {
		t.lines[l.ID] = lineState{name: l.ItemName, qty: l.Qty, amount: l.LineTotal + shares[i], tax: shares[i], voided: l.Void != nil, belongsToOrd: true}
	}
	rows, err := tx.Query(ctx, `
		SELECT rl.line_id::text, sum(rl.qty), sum(rl.amount), sum(rl.tax)
		FROM refund_lines rl JOIN refunds rf ON rf.id = rl.refund_id
		WHERE rf.order_id = $1 GROUP BY rl.line_id`, r.OrderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var qty int
		var amt, tax int64
		if err := rows.Scan(&id, &qty, &amt, &tax); err != nil {
			return nil, err
		}
		s := t.lines[id]
		s.refundedQty, s.refundedAmt, s.refundedTax = qty, amt, tax
		t.lines[id] = s
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i, l := range r.Lines {
		if !t.lines[l.LineID].belongsToOrd {
			return nil, reject("refund line %d isn't on the order", i)
		}
	}
	return t, nil
}

// referencedStaff lists every person a refund names.
func (r *Refund) referencedStaff() []string { return []string{r.StaffID, r.ApprovedBy} }

// checks returns every business-rule problem with the refund.
func (r *Refund) checks(t *refundTarget, approverIsManager bool, c checkContext) []Flag {
	flags := unknownStaffFlag(r.referencedStaff(), c.knownStaff)
	if c.knownStaff[r.ApprovedBy] && !approverIsManager {
		flags = append(flags, Flag{Kind: FlagApprovalInvalid, Message: "approved by someone who isn't an active manager"})
	}

	var over []string
	if t.paymentReversed {
		over = append(over, "the payment it returns money to was reversed before the order closed")
	} else if left := t.paymentAmount - t.refundedBefore; r.Amount > left {
		over = append(over, fmt.Sprintf("returns %s but only %s of that payment was left to refund", cents(r.Amount), cents(left)))
	}
	for _, l := range r.Lines {
		s := t.lines[l.LineID]
		switch {
		case s.voided:
			over = append(over, fmt.Sprintf("refunds %s, which was voided and never paid for", s.name))
		case l.Qty > s.qty-s.refundedQty:
			over = append(over, fmt.Sprintf("refunds %d × %s; %d of %d were left", l.Qty, s.name, s.qty-s.refundedQty, s.qty))
		case l.Amount > s.amount-s.refundedAmt || l.Tax > s.tax-s.refundedTax:
			over = append(over, fmt.Sprintf("returns more for %s than it cost", s.name))
		}
	}
	if len(over) > 0 {
		flags = append(flags, Flag{Kind: FlagOverRefund, Message: "refunds more than was paid", Detail: over})
	}

	if len(r.Lines) > 0 {
		var amount, tax int64
		for _, l := range r.Lines {
			amount += l.Amount
			tax += l.Tax
		}
		if amount != r.Amount || tax != r.Tax {
			flags = append(flags, Flag{Kind: FlagTotalMismatch, Message: fmt.Sprintf(
				"lines add up to %s (%s tax) but the refund says %s (%s tax)", cents(amount), cents(tax), cents(r.Amount), cents(r.Tax))})
		}
	}

	flags = append(flags, timeFlags(r.CreatedAt, r.CreatedAt, r.BusinessDate, c)...)
	if c.closedOut {
		flags = append(flags, Flag{Kind: FlagAfterCloseout, Message: fmt.Sprintf("arrived after %s was closed out", r.BusinessDate)})
	}
	return flags
}

func insertRefund(ctx context.Context, tx pgx.Tx, r *Refund) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO refunds (id, order_id, payment_id, device_id, staff_id, approved_by, business_date,
			tender, amount, tax, reason, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		r.ID, r.OrderID, r.PaymentID, r.DeviceID, r.StaffID, r.ApprovedBy, r.BusinessDate,
		r.Tender, r.Amount, r.Tax, r.Reason, r.CreatedAt); err != nil {
		return err
	}
	for _, l := range r.Lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO refund_lines (refund_id, line_id, qty, amount, tax) VALUES ($1, $2, $3, $4, $5)`,
			r.ID, l.LineID, l.Qty, l.Amount, l.Tax); err != nil {
			return err
		}
	}
	return nil
}

// lineTaxShares divides an order's tax among its lines the way the tablet
// did (pricing.TaxShares), so refunds can be checked line by line.
func lineTaxShares(o *Order) []int64 {
	amounts := make([]pricing.Amount, len(o.Lines))
	for i, l := range o.Lines {
		amounts[i] = pricing.Amount{LineTotal: l.LineTotal, Taxable: l.Taxable, Voided: l.Void != nil}
	}
	return pricing.TaxShares(amounts, o.Tax)
}
