// Package menu defines the menu document, validates it, and indexes it for
// lookups. The whole menu is one JSON document and each save is a new
// immutable version (docs/decisions/0004). Selection rules mirror
// web/src/domain/menu.ts and are tested against testdata/vectors.
package menu

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// Doc is a complete menu, including the sales tax rate that applies to it.
type Doc struct {
	TaxRatePPM int64      `json:"taxRatePpm"`
	Categories []Category `json:"categories"`
	Items      []Item     `json:"items"`
	Groups     []Group    `json:"groups"`
}

// Category groups items on the register. Order in the document is display
// order.
type Category struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"` // "#rrggbb" or empty
}

// Item is something sold. GroupIDs lists the modifier groups that apply, in
// display order.
type Item struct {
	ID         string   `json:"id"`
	CategoryID string   `json:"categoryId"`
	Name       string   `json:"name"`
	Price      int64    `json:"price"`
	Taxable    bool     `json:"taxable"`
	GroupIDs   []string `json:"groupIds"`
}

// Group is a set of modifier options; a line must pick between Min and Max
// distinct options from it.
type Group struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Min     int      `json:"min"`
	Max     int      `json:"max"`
	Options []Option `json:"options"`
}

// Option is one modifier choice. Delta is added to the item price once per
// unit of quantity, up to MaxQty.
type Option struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Delta   int64  `json:"delta"`
	Default bool   `json:"default"`
	MaxQty  int    `json:"maxQty"`
}

// Selection is a modifier option chosen for a line.
type Selection struct {
	OptionID string `json:"optionId"`
	Qty      int    `json:"qty"`
}

// Limits on what a menu may contain.
const (
	MaxTaxRatePPM = 500_000   // 50%
	MaxItemPrice  = 1_000_000 // $10,000
	MaxDelta      = 100_000   // ±$1,000
	MaxOptionQty  = 20
	MaxNameLength = 60
)

var (
	idPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	colorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

// ValidationError lists everything wrong with a menu document.
type ValidationError struct {
	Problems []string
}

func (e *ValidationError) Error() string {
	return "invalid menu: " + strings.Join(e.Problems, "; ")
}

// Validate returns a *ValidationError describing every problem in doc, or
// nil if the menu is usable.
func Validate(doc *Doc) error {
	var problems []string
	add := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}
	checkID := func(kind, id string) {
		if !idPattern.MatchString(id) {
			add("%s id %q must be 1-64 letters, digits, '-' or '_'", kind, id)
		}
	}
	checkName := func(kind, id, name string) {
		if strings.TrimSpace(name) == "" {
			add("%s %q needs a name", kind, id)
		} else if utf8.RuneCountInString(name) > MaxNameLength {
			add("%s %q: name is longer than %d characters", kind, id, MaxNameLength)
		}
	}

	if doc.TaxRatePPM < 0 || doc.TaxRatePPM > MaxTaxRatePPM {
		add("tax rate must be between 0%% and 50%%")
	}

	categories := map[string]bool{}
	for _, c := range doc.Categories {
		checkID("category", c.ID)
		checkName("category", c.ID, c.Name)
		if categories[c.ID] {
			add("category id %q is used twice", c.ID)
		}
		categories[c.ID] = true
		if c.Color != "" && !colorPattern.MatchString(c.Color) {
			add("category %q: color must look like #a0522d", c.ID)
		}
	}

	groups := map[string]bool{}
	options := map[string]bool{}
	for _, g := range doc.Groups {
		checkID("group", g.ID)
		checkName("group", g.ID, g.Name)
		if groups[g.ID] {
			add("group id %q is used twice", g.ID)
		}
		groups[g.ID] = true
		if len(g.Options) == 0 {
			add("group %q has no options", g.ID)
		}
		if g.Min < 0 || g.Max < 1 || g.Min > g.Max || g.Max > len(g.Options) {
			add("group %q: need 0 ≤ min ≤ max, 1 ≤ max ≤ number of options (min %d, max %d, %d options)",
				g.ID, g.Min, g.Max, len(g.Options))
		}
		defaults := 0
		for _, o := range g.Options {
			checkID("option", o.ID)
			checkName("option", o.ID, o.Name)
			if options[o.ID] {
				add("option id %q is used twice", o.ID)
			}
			options[o.ID] = true
			if o.Delta < -MaxDelta || o.Delta > MaxDelta {
				add("option %q: price change must be within ±$%d", o.ID, MaxDelta/100)
			}
			if o.MaxQty < 1 || o.MaxQty > MaxOptionQty {
				add("option %q: max quantity must be between 1 and %d", o.ID, MaxOptionQty)
			}
			if o.Default {
				defaults++
			}
		}
		if defaults > g.Max {
			add("group %q has %d default options but allows at most %d", g.ID, defaults, g.Max)
		}
	}

	items := map[string]bool{}
	for _, it := range doc.Items {
		checkID("item", it.ID)
		checkName("item", it.ID, it.Name)
		if items[it.ID] {
			add("item id %q is used twice", it.ID)
		}
		items[it.ID] = true
		if !categories[it.CategoryID] {
			add("item %q: unknown category %q", it.ID, it.CategoryID)
		}
		if it.Price < 0 || it.Price > MaxItemPrice {
			add("item %q: price must be between $0 and $%d", it.ID, MaxItemPrice/100)
		}
		seen := map[string]bool{}
		for _, gid := range it.GroupIDs {
			if !groups[gid] {
				add("item %q: unknown modifier group %q", it.ID, gid)
			}
			if seen[gid] {
				add("item %q lists group %q twice", it.ID, gid)
			}
			seen[gid] = true
		}
	}

	if len(problems) > 0 {
		return &ValidationError{Problems: problems}
	}
	return nil
}

// OptionRef is an option together with the group it belongs to.
type OptionRef struct {
	Option *Option
	Group  *Group
}

// Index provides lookups by ID into a validated document.
type Index struct {
	Doc        *Doc
	Categories map[string]*Category
	Items      map[string]*Item
	Groups     map[string]*Group
	Options    map[string]OptionRef
}

// NewIndex indexes doc. The document should already be valid.
func NewIndex(doc *Doc) *Index {
	ix := &Index{
		Doc:        doc,
		Categories: map[string]*Category{},
		Items:      map[string]*Item{},
		Groups:     map[string]*Group{},
		Options:    map[string]OptionRef{},
	}
	for i := range doc.Categories {
		ix.Categories[doc.Categories[i].ID] = &doc.Categories[i]
	}
	for i := range doc.Items {
		ix.Items[doc.Items[i].ID] = &doc.Items[i]
	}
	for i := range doc.Groups {
		g := &doc.Groups[i]
		ix.Groups[g.ID] = g
		for j := range g.Options {
			ix.Options[g.Options[j].ID] = OptionRef{Option: &g.Options[j], Group: g}
		}
	}
	return ix
}

// CheckSelections returns the problems with choosing mods for itemID, as
// sorted codes like "min:size" or "qty:shot-extra". An empty result means the
// line is complete and valid.
func (ix *Index) CheckSelections(itemID string, mods []Selection) []string {
	item, ok := ix.Items[itemID]
	if !ok {
		return []string{"unknown-item:" + itemID}
	}
	allowed := map[string]bool{}
	for _, gid := range item.GroupIDs {
		allowed[gid] = true
	}

	problems := []string{}
	seen := map[string]bool{}
	chosen := map[string]int{} // group id → distinct options chosen
	for _, m := range mods {
		ref, ok := ix.Options[m.OptionID]
		switch {
		case !ok:
			problems = append(problems, "unknown:"+m.OptionID)
			continue
		case !allowed[ref.Group.ID]:
			problems = append(problems, "not-allowed:"+m.OptionID)
			continue
		case seen[m.OptionID]:
			problems = append(problems, "duplicate:"+m.OptionID)
			continue
		}
		seen[m.OptionID] = true
		chosen[ref.Group.ID]++
		if m.Qty < 1 || m.Qty > ref.Option.MaxQty {
			problems = append(problems, "qty:"+m.OptionID)
		}
	}
	for _, gid := range item.GroupIDs {
		g := ix.Groups[gid]
		if g == nil {
			continue
		}
		if chosen[gid] < g.Min {
			problems = append(problems, "min:"+gid)
		}
		if chosen[gid] > g.Max {
			problems = append(problems, "max:"+gid)
		}
	}
	sort.Strings(problems)
	return problems
}
