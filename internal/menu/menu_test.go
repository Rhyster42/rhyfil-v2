package menu

import (
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
)

func loadJSON(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile("../../testdata/vectors/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

func testMenu(t *testing.T) *Doc {
	t.Helper()
	var doc Doc
	loadJSON(t, "menu.json", &doc)
	return &doc
}

func TestVectorMenuIsValid(t *testing.T) {
	if err := Validate(testMenu(t)); err != nil {
		t.Fatal(err)
	}
}

func TestSelectionVectors(t *testing.T) {
	var v struct {
		Cases []struct {
			Name   string
			ItemID string
			Mods   []Selection
			Expect []string
		}
	}
	loadJSON(t, "selections.json", &v)
	ix := NewIndex(testMenu(t))
	for _, tc := range v.Cases {
		got := ix.CheckSelections(tc.ItemID, tc.Mods)
		if !slices.Equal(got, tc.Expect) {
			t.Errorf("%s: got %v, want %v", tc.Name, got, tc.Expect)
		}
	}
}

func TestValidateReportsEveryProblem(t *testing.T) {
	doc := testMenu(t)
	doc.TaxRatePPM = 600_000
	doc.Categories = append(doc.Categories, Category{ID: "bakery", Name: "Again", Color: "brown"})
	doc.Items = append(doc.Items,
		Item{ID: "ghost", CategoryID: "nowhere", Name: "Ghost", Price: -1, GroupIDs: []string{"size", "size", "nope"}},
		Item{ID: "has space", CategoryID: "bakery", Name: " "},
	)
	doc.Groups = append(doc.Groups,
		Group{ID: "empty", Name: "Empty", Min: 2, Max: 1},
		Group{ID: "greedy", Name: "Greedy", Min: 0, Max: 1, Options: []Option{
			{ID: "g1", Name: "One", Default: true, MaxQty: 1},
			{ID: "g2", Name: "Two", Default: true, MaxQty: 0, Delta: 200_000},
			{ID: "size-m", Name: "Clash", MaxQty: 1},
		}},
	)

	err := Validate(doc)
	var verr *ValidationError
	if !errors.As(err, &verr) {
		t.Fatalf("Validate = %v, want *ValidationError", err)
	}
	want := []string{
		"tax rate",
		`category id "bakery" is used twice`,
		`category "bakery": color`,
		`group "empty" has no options`,
		`group "empty": need 0 ≤ min ≤ max`,
		`option "g2": price change`,
		`option "g2": max quantity`,
		`option id "size-m" is used twice`,
		`group "greedy" has 2 default options`,
		`item "ghost": unknown category "nowhere"`,
		`item "ghost": price`,
		`item "ghost" lists group "size" twice`,
		`item "ghost": unknown modifier group "nope"`,
		`item id "has space" must be`,
		`item "has space" needs a name`,
	}
	all := strings.Join(verr.Problems, "\n")
	for _, w := range want {
		if !strings.Contains(all, w) {
			t.Errorf("missing problem %q in:\n%s", w, all)
		}
	}
	if len(verr.Problems) != len(want) {
		t.Errorf("got %d problems, want %d:\n%s", len(verr.Problems), len(want), all)
	}
}

func TestEmptyMenuIsValid(t *testing.T) {
	if err := Validate(&Doc{TaxRatePPM: 0}); err != nil {
		t.Fatal(err)
	}
}
