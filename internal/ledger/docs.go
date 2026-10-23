// Package ledger stores the documents tablets sync: closed orders and refunds
// (docs/decisions/0002). It rejects only documents it can't store and flags
// anything else that's wrong (0003).
package ledger

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"

	"coffeepos/internal/bizdate"
	"coffeepos/internal/pricing"
)

// The wire format mirrors web/src/domain/documents.ts.

// VoidInfo records who voided or reversed something, when, and why.
type VoidInfo struct {
	At     time.Time `json:"at"`
	By     string    `json:"by"`
	Reason string    `json:"reason"`
}

// Line is a line of a closed order, with the names and prices it was sold at.
type Line struct {
	ID        string              `json:"id"`
	ItemID    string              `json:"itemId"`
	ItemName  string              `json:"itemName"`
	Category  string              `json:"category"`
	Qty       int                 `json:"qty"`
	UnitPrice int64               `json:"unitPrice"`
	LineTotal int64               `json:"lineTotal"`
	Taxable   bool                `json:"taxable"`
	Mods      []pricing.PricedMod `json:"mods"`
	AddedAt   time.Time           `json:"addedAt"`
	Void      *VoidInfo           `json:"void"`
}

// Payment is a tender taken on an order; reversed ones stay on the record.
type Payment struct {
	ID            string    `json:"id"`
	Tender        string    `json:"tender"`
	Amount        int64     `json:"amount"`
	Tendered      int64     `json:"tendered"`
	Change        int64     `json:"change"`
	CoversLineIDs []string  `json:"coversLineIds"`
	StaffID       string    `json:"staffId"`
	CreatedAt     time.Time `json:"createdAt"`
	Reversal      *VoidInfo `json:"reversal"`
}

// Order is a closed order: paid, or voided.
type Order struct {
	V            int       `json:"v"`
	ID           string    `json:"id"`
	DeviceID     string    `json:"deviceId"`
	StaffID      string    `json:"staffId"`
	Number       string    `json:"number"`
	BusinessDate string    `json:"businessDate"`
	Status       string    `json:"status"`
	MenuVersion  int64     `json:"menuVersion"`
	CreatedAt    time.Time `json:"createdAt"`
	ClosedAt     time.Time `json:"closedAt"`
	Lines        []Line    `json:"lines"`
	Subtotal     int64     `json:"subtotal"`
	Tax          int64     `json:"tax"`
	Total        int64     `json:"total"`
	Payments     []Payment `json:"payments"`
	Void         *VoidInfo `json:"void"`
}

// Captured returns the payments that weren't reversed.
func (o *Order) Captured() []Payment {
	var out []Payment
	for _, p := range o.Payments {
		if p.Reversal == nil {
			out = append(out, p)
		}
	}
	return out
}

// Limits on a single order.
const (
	maxLines    = 200
	maxPayments = 50
	maxLineQty  = 99
)

// rejection is why a document can't be stored at all.
type rejection struct{ msg string }

func (r *rejection) Error() string { return r.msg }

func reject(format string, args ...any) error {
	return &rejection{fmt.Sprintf(format, args...)}
}

// decodeStrict decodes exactly one JSON value with no unknown fields.
func decodeStrict(raw []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return reject("malformed document: %v", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return reject("malformed document: trailing data")
	}
	return nil
}

func validUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil && len(s) == 36
}

func checkVoid(what string, v *VoidInfo) error {
	if v == nil {
		return nil
	}
	if !validUUID(v.By) || v.At.IsZero() || v.Reason == "" || len(v.Reason) > 200 {
		return reject("%s: a void needs who, when and a reason", what)
	}
	return nil
}

// validate checks everything the server needs to store the order; it
// doesn't judge whether the order followed the rules (that's checks.go).
func (o *Order) validate(deviceID string) error {
	switch {
	case o.V != 1:
		return reject("unsupported document version %d", o.V)
	case !validUUID(o.ID) || !validUUID(o.StaffID) || !validUUID(o.DeviceID):
		return reject("ids must be UUIDs")
	case o.DeviceID != deviceID:
		return reject("document belongs to device %s, not this one", o.DeviceID)
	case o.Number == "" || len(o.Number) > 20:
		return reject("order number must be 1-20 characters")
	case o.Status != "paid" && o.Status != "voided":
		return reject("status must be paid or voided")
	case (o.Status == "voided") != (o.Void != nil):
		return reject("a voided order, and only a voided order, has void details")
	case o.MenuVersion < 1:
		return reject("menu version must be positive")
	case o.CreatedAt.IsZero() || o.ClosedAt.IsZero():
		return reject("createdAt and closedAt are required")
	case len(o.Lines) == 0 || len(o.Lines) > maxLines:
		return reject("an order has 1-%d lines", maxLines)
	case len(o.Payments) > maxPayments:
		return reject("too many payments")
	case o.Subtotal < 0 || o.Tax < 0 || o.Total < 0:
		return reject("totals can't be negative")
	}
	if _, err := bizdate.Parse(o.BusinessDate); err != nil {
		return reject("business date must be YYYY-MM-DD")
	}
	if err := checkVoid("order", o.Void); err != nil {
		return err
	}

	lineIDs := map[string]bool{}
	for i, l := range o.Lines {
		switch {
		case !validUUID(l.ID) || lineIDs[l.ID]:
			return reject("line %d: id must be a unique UUID", i)
		case l.ItemID == "" || l.ItemName == "":
			return reject("line %d: item id and name are required", i)
		case l.Qty < 1 || l.Qty > maxLineQty:
			return reject("line %d: quantity must be 1-%d", i, maxLineQty)
		case l.UnitPrice < 0 || l.LineTotal < 0:
			return reject("line %d: prices can't be negative", i)
		case l.AddedAt.IsZero():
			return reject("line %d: addedAt is required", i)
		}
		for _, m := range l.Mods {
			if m.OptionID == "" || m.Qty < 1 {
				return reject("line %d: modifiers need an option and a positive quantity", i)
			}
		}
		if err := checkVoid(fmt.Sprintf("line %d", i), l.Void); err != nil {
			return err
		}
		lineIDs[l.ID] = true
	}

	paymentIDs := map[string]bool{}
	for i, p := range o.Payments {
		switch {
		case !validUUID(p.ID) || paymentIDs[p.ID]:
			return reject("payment %d: id must be a unique UUID", i)
		case p.Tender != "cash" && p.Tender != "card":
			return reject("payment %d: tender must be cash or card", i)
		case p.Amount <= 0 || p.Tendered < 0 || p.Change < 0 || p.Tendered-p.Change != p.Amount:
			return reject("payment %d: amount, tendered and change don't fit together", i)
		case p.Tender == "card" && p.Change != 0:
			return reject("payment %d: card payments give no change", i)
		case !validUUID(p.StaffID) || p.CreatedAt.IsZero():
			return reject("payment %d: who and when are required", i)
		}
		for _, id := range p.CoversLineIDs {
			if !lineIDs[id] {
				return reject("payment %d covers a line that isn't on the order", i)
			}
		}
		if err := checkVoid(fmt.Sprintf("payment %d", i), p.Reversal); err != nil {
			return err
		}
		paymentIDs[p.ID] = true
	}
	return nil
}

// normalize fills nil slices so the stored JSON always has arrays.
func (o *Order) normalize() {
	if o.Payments == nil {
		o.Payments = []Payment{}
	}
	for i := range o.Lines {
		if o.Lines[i].Mods == nil {
			o.Lines[i].Mods = []pricing.PricedMod{}
		}
	}
	for i := range o.Payments {
		if o.Payments[i].CoversLineIDs == nil {
			o.Payments[i].CoversLineIDs = []string{}
		}
	}
}
