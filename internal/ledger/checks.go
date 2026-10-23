package ledger

import (
	"fmt"
	"time"

	"coffeepos/internal/bizdate"
	"coffeepos/internal/menu"
	"coffeepos/internal/money"
	"coffeepos/internal/pricing"
	"coffeepos/internal/settings"
)

// Flag is a business-rule problem with a document that was stored anyway
// (docs/decisions/0003).
type Flag struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Detail  any    `json:"detail,omitempty"`
}

// Flag kinds.
const (
	FlagMenuMismatch    = "menu_mismatch"
	FlagTotalMismatch   = "total_mismatch"
	FlagPaymentMismatch = "payment_mismatch"
	FlagOverRefund      = "over_refund"
	FlagApprovalInvalid = "approval_invalid"
	FlagUnknownStaff    = "unknown_staff"
	FlagAfterCloseout   = "after_closeout"
	FlagClockSkew       = "clock_skew"
)

// futureTolerance is how far ahead of the server a tablet's clock may run
// before its documents are flagged.
const futureTolerance = 5 * time.Minute

// checkContext is what the rules need to know about the world.
type checkContext struct {
	menu       *menu.Doc       // the order's menu version; nil if it doesn't exist
	knownStaff map[string]bool // every staff id the server knows
	settings   settings.Settings
	received   time.Time
	closedOut  bool // the document's business date was already closed out
}

func cents(n int64) string {
	sign := ""
	if n < 0 {
		sign, n = "-", -n
	}
	return fmt.Sprintf("%s$%d.%02d", sign, n/100, n%100)
}

// referencedStaff lists every person an order names.
func (o *Order) referencedStaff() []string {
	ids := []string{o.StaffID}
	if o.Void != nil {
		ids = append(ids, o.Void.By)
	}
	for _, l := range o.Lines {
		if l.Void != nil {
			ids = append(ids, l.Void.By)
		}
	}
	for _, p := range o.Payments {
		ids = append(ids, p.StaffID)
		if p.Reversal != nil {
			ids = append(ids, p.Reversal.By)
		}
	}
	return ids
}

func unknownStaffFlag(ids []string, known map[string]bool) []Flag {
	var unknown []string
	seen := map[string]bool{}
	for _, id := range ids {
		if !known[id] && !seen[id] {
			unknown = append(unknown, id)
			seen[id] = true
		}
	}
	if len(unknown) == 0 {
		return nil
	}
	return []Flag{{Kind: FlagUnknownStaff, Message: fmt.Sprintf("names %d staff member(s) the server doesn't know", len(unknown)), Detail: unknown}}
}

// checks returns every business-rule problem with the order.
func (o *Order) checks(c checkContext) []Flag {
	flags := unknownStaffFlag(o.referencedStaff(), c.knownStaff)

	// Prices and modifiers against the menu version the tablet used.
	if c.menu == nil {
		flags = append(flags, Flag{Kind: FlagMenuMismatch, Message: fmt.Sprintf("priced with menu version %d, which the server doesn't have", o.MenuVersion)})
	} else {
		ix := menu.NewIndex(c.menu)
		var problems []string
		for i, l := range o.Lines {
			n := i + 1
			sels := make([]menu.Selection, len(l.Mods))
			for j, m := range l.Mods {
				sels[j] = menu.Selection{OptionID: m.OptionID, Qty: m.Qty}
			}
			p, err := pricing.PriceLine(ix, pricing.Line{ItemID: l.ItemID, Qty: l.Qty, Mods: sels})
			if err != nil {
				problems = append(problems, fmt.Sprintf("line %d: %v", n, err))
				continue
			}
			if p.UnitPrice != l.UnitPrice {
				problems = append(problems, fmt.Sprintf("line %d (%s): sold at %s, the menu says %s", n, l.ItemName, cents(l.UnitPrice), cents(p.UnitPrice)))
			}
			if p.ItemName != l.ItemName || p.Taxable != l.Taxable {
				problems = append(problems, fmt.Sprintf("line %d (%s): name or taxability differs from the menu", n, l.ItemName))
			}
			for j, m := range l.Mods {
				if m != p.Mods[j] {
					problems = append(problems, fmt.Sprintf("line %d (%s): modifier %q differs from the menu", n, l.ItemName, m.OptionName))
				}
			}
			if l.Void == nil {
				for _, code := range ix.CheckSelections(l.ItemID, sels) {
					problems = append(problems, fmt.Sprintf("line %d (%s): %s", n, l.ItemName, code))
				}
			}
		}
		if len(problems) > 0 {
			flags = append(flags, Flag{Kind: FlagMenuMismatch, Message: "doesn't match its menu version", Detail: problems})
		}
	}

	// Arithmetic.
	var problems []string
	var subtotal, taxable int64
	for i, l := range o.Lines {
		if l.LineTotal != l.UnitPrice*int64(l.Qty) {
			problems = append(problems, fmt.Sprintf("line %d: %d × %s isn't %s", i+1, l.Qty, cents(l.UnitPrice), cents(l.LineTotal)))
		}
		if l.Void == nil {
			subtotal += l.LineTotal
			if l.Taxable {
				taxable += l.LineTotal
			}
		}
	}
	if subtotal != o.Subtotal {
		problems = append(problems, fmt.Sprintf("lines add up to %s, subtotal says %s", cents(subtotal), cents(o.Subtotal)))
	}
	if c.menu != nil {
		if tax := money.Tax(taxable, c.menu.TaxRatePPM); tax != o.Tax {
			problems = append(problems, fmt.Sprintf("tax should be %s, the order says %s", cents(tax), cents(o.Tax)))
		}
	}
	if o.Subtotal+o.Tax != o.Total {
		problems = append(problems, fmt.Sprintf("%s + %s tax isn't %s", cents(o.Subtotal), cents(o.Tax), cents(o.Total)))
	}
	if len(problems) > 0 {
		flags = append(flags, Flag{Kind: FlagTotalMismatch, Message: "totals don't add up", Detail: problems})
	}

	// Payments.
	var paid int64
	for _, p := range o.Captured() {
		paid += p.Amount
	}
	if o.Status == "paid" && paid != o.Total {
		flags = append(flags, Flag{Kind: FlagPaymentMismatch, Message: fmt.Sprintf("paid %s of %s", cents(paid), cents(o.Total))})
	}
	if o.Status == "voided" && paid != 0 {
		flags = append(flags, Flag{Kind: FlagPaymentMismatch, Message: fmt.Sprintf("voided with %s still paid", cents(paid))})
	}

	flags = append(flags, timeFlags(o.CreatedAt, o.ClosedAt, o.BusinessDate, c)...)
	if c.closedOut {
		flags = append(flags, Flag{Kind: FlagAfterCloseout, Message: fmt.Sprintf("arrived after %s was closed out", o.BusinessDate)})
	}
	return flags
}

// timeFlags checks a document's timestamps against the server's clock and
// its business date against the store's day boundary (docs/decisions/0013).
func timeFlags(created, closed time.Time, businessDate string, c checkContext) []Flag {
	var flags []Flag
	if latest := c.received.Add(futureTolerance); created.After(latest) || closed.After(latest) {
		flags = append(flags, Flag{Kind: FlagClockSkew, Message: "timestamps are in the future: the tablet's clock is probably wrong",
			Detail: map[string]any{"createdAt": created, "receivedAt": c.received}})
	}
	if expected := bizdate.Of(created, c.settings.Location(), c.settings.DayCutoffMinutes); expected != businessDate {
		flags = append(flags, Flag{Kind: FlagClockSkew, Message: fmt.Sprintf("dated %s but created on business day %s", businessDate, expected)})
	}
	return flags
}
