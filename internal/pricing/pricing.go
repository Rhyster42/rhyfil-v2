// Package pricing computes line and order prices from a menu. It mirrors
// web/src/domain/pricing.ts; both are tested against
// testdata/vectors/pricing.json (docs/decisions/0007).
package pricing

import (
	"fmt"

	"coffeepos/internal/menu"
	"coffeepos/internal/money"
)

// Line is what the register knows about a line before pricing it.
type Line struct {
	ItemID string           `json:"itemId"`
	Qty    int              `json:"qty"`
	Mods   []menu.Selection `json:"mods"`
	Voided bool             `json:"voided"`
}

// PricedMod is a selected option with the names and price it had when sold.
type PricedMod struct {
	OptionID   string `json:"optionId"`
	GroupID    string `json:"groupId"`
	GroupName  string `json:"groupName"`
	OptionName string `json:"optionName"`
	Qty        int    `json:"qty"`
	Delta      int64  `json:"delta"`
}

// PricedLine is a line with the names and prices it had when sold.
type PricedLine struct {
	ItemID    string      `json:"itemId"`
	ItemName  string      `json:"itemName"`
	Category  string      `json:"category"`
	Qty       int         `json:"qty"`
	UnitPrice int64       `json:"unitPrice"`
	LineTotal int64       `json:"lineTotal"`
	Taxable   bool        `json:"taxable"`
	Mods      []PricedMod `json:"mods"`
}

// PriceLine prices one line. Unit price = item price + Σ(delta × qty),
// floored at zero. It fails only if the item or an option doesn't exist;
// selection rules are checked separately by menu.Index.CheckSelections.
func PriceLine(ix *menu.Index, l Line) (PricedLine, error) {
	item, ok := ix.Items[l.ItemID]
	if !ok {
		return PricedLine{}, fmt.Errorf("unknown item %q", l.ItemID)
	}
	if l.Qty < 1 {
		return PricedLine{}, fmt.Errorf("item %q: quantity must be at least 1", l.ItemID)
	}
	category := ""
	if c := ix.Categories[item.CategoryID]; c != nil {
		category = c.Name
	}
	unit := item.Price
	mods := make([]PricedMod, 0, len(l.Mods))
	for _, sel := range l.Mods {
		ref, ok := ix.Options[sel.OptionID]
		if !ok {
			return PricedLine{}, fmt.Errorf("unknown option %q", sel.OptionID)
		}
		unit += ref.Option.Delta * int64(sel.Qty)
		mods = append(mods, PricedMod{
			OptionID:   ref.Option.ID,
			GroupID:    ref.Group.ID,
			GroupName:  ref.Group.Name,
			OptionName: ref.Option.Name,
			Qty:        sel.Qty,
			Delta:      ref.Option.Delta,
		})
	}
	unit = max(unit, 0)
	return PricedLine{
		ItemID:    item.ID,
		ItemName:  item.Name,
		Category:  category,
		Qty:       l.Qty,
		UnitPrice: unit,
		LineTotal: unit * int64(l.Qty),
		Taxable:   item.Taxable,
		Mods:      mods,
	}, nil
}

// Amount is the part of a line that order totals depend on.
type Amount struct {
	LineTotal int64
	Taxable   bool
	Voided    bool
}

// Totals are an order's money figures. Taxable is the part of Subtotal that
// tax applies to.
type Totals struct {
	Subtotal int64 `json:"subtotal"`
	Taxable  int64 `json:"taxable"`
	Tax      int64 `json:"tax"`
	Total    int64 `json:"total"`
}

// OrderTotals adds up non-voided lines and computes tax once for the whole
// order (docs/decisions/0006).
func OrderTotals(lines []Amount, taxRatePPM int64) Totals {
	var t Totals
	for _, l := range lines {
		if l.Voided {
			continue
		}
		t.Subtotal += l.LineTotal
		if l.Taxable {
			t.Taxable += l.LineTotal
		}
	}
	t.Tax = money.Tax(t.Taxable, taxRatePPM)
	t.Total = t.Subtotal + t.Tax
	return t
}

// TaxShares divides an order's tax among its lines in proportion to their
// taxable totals. Voided and untaxed lines get nothing. Split-by-item and
// line refunds use these shares, so the pieces always add up to the order.
func TaxShares(lines []Amount, tax int64) []int64 {
	weights := make([]int64, len(lines))
	for i, l := range lines {
		if l.Taxable && !l.Voided {
			weights[i] = l.LineTotal
		}
	}
	return money.Allocate(tax, weights)
}
