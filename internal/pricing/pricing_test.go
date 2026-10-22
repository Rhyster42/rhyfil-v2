package pricing

import (
	"encoding/json"
	"os"
	"slices"
	"testing"

	"coffeepos/internal/menu"
)

func load(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile("../../testdata/vectors/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

func TestPricingVectors(t *testing.T) {
	var doc menu.Doc
	load(t, "menu.json", &doc)
	ix := menu.NewIndex(&doc)

	var v struct {
		Cases []struct {
			Name   string
			Lines  []Line
			Expect struct {
				Lines []struct{ UnitPrice, LineTotal int64 }
				Totals
				TaxShares []int64
			}
		}
	}
	load(t, "pricing.json", &v)

	for _, tc := range v.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			amounts := make([]Amount, len(tc.Lines))
			for i, l := range tc.Lines {
				p, err := PriceLine(ix, l)
				if err != nil {
					t.Fatal(err)
				}
				want := tc.Expect.Lines[i]
				if p.UnitPrice != want.UnitPrice || p.LineTotal != want.LineTotal {
					t.Errorf("line %d: unit %d total %d, want unit %d total %d",
						i, p.UnitPrice, p.LineTotal, want.UnitPrice, want.LineTotal)
				}
				amounts[i] = Amount{LineTotal: p.LineTotal, Taxable: p.Taxable, Voided: l.Voided}
			}
			totals := OrderTotals(amounts, doc.TaxRatePPM)
			if totals != tc.Expect.Totals {
				t.Errorf("totals = %+v, want %+v", totals, tc.Expect.Totals)
			}
			if shares := TaxShares(amounts, totals.Tax); !slices.Equal(shares, tc.Expect.TaxShares) {
				t.Errorf("tax shares = %v, want %v", shares, tc.Expect.TaxShares)
			}
		})
	}
}

func TestPriceLineSnapshotsNames(t *testing.T) {
	var doc menu.Doc
	load(t, "menu.json", &doc)
	p, err := PriceLine(menu.NewIndex(&doc), Line{ItemID: "latte", Qty: 2, Mods: []menu.Selection{
		{OptionID: "milk-oat", Qty: 1},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if p.ItemName != "Latte" || p.Category != "Espresso" || !p.Taxable {
		t.Errorf("snapshot = %+v", p)
	}
	want := PricedMod{OptionID: "milk-oat", GroupID: "milk", GroupName: "Milk", OptionName: "Oat", Qty: 1, Delta: 70}
	if len(p.Mods) != 1 || p.Mods[0] != want {
		t.Errorf("mods = %+v, want [%+v]", p.Mods, want)
	}
	if p.LineTotal != 2*(450+70) {
		t.Errorf("line total = %d", p.LineTotal)
	}
}

func TestPriceLineErrors(t *testing.T) {
	var doc menu.Doc
	load(t, "menu.json", &doc)
	ix := menu.NewIndex(&doc)
	for _, l := range []Line{
		{ItemID: "unicorn", Qty: 1},
		{ItemID: "latte", Qty: 0},
		{ItemID: "latte", Qty: 1, Mods: []menu.Selection{{OptionID: "sprinkles", Qty: 1}}},
	} {
		if _, err := PriceLine(ix, l); err == nil {
			t.Errorf("PriceLine(%+v) succeeded, want an error", l)
		}
	}
}
