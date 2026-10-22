package server_test

import (
	"net/http"
	"strconv"
	"strings"
	"testing"

	"coffeepos/internal/menu"
	"coffeepos/internal/settings"
	"coffeepos/internal/syncapi"
)

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestMenuVersions(t *testing.T) {
	a := seeded(t)
	mgr := a.manager()
	tablet := a.enroll("Counter")

	var live menu.Version
	mgr.call(http.StatusOK, "GET", "/api/menu", nil, &live)
	if live.Version != 1 || len(live.Doc.Items) == 0 {
		t.Fatalf("seeded menu: version %d, %d items", live.Version, len(live.Doc.Items))
	}

	var pull syncapi.PullResponse
	tablet.call(http.StatusOK, "GET", "/api/sync/pull?menu=1", nil, &pull)
	if pull.Menu != nil {
		t.Fatal("menu should be omitted when the tablet has the latest")
	}

	live.Doc.Items[0].Price += 25
	var saved struct{ Version int64 }
	mgr.call(http.StatusOK, "PUT", "/api/menu", map[string]any{"baseVersion": 1, "doc": live.Doc}, &saved)
	if saved.Version != 2 {
		t.Fatalf("saved version %d", saved.Version)
	}
	// A second editor working from version 1 is told to reload.
	if got := mgr.errorCode(http.StatusConflict, "PUT", "/api/menu", map[string]any{"baseVersion": 1, "doc": live.Doc}); got != "conflict" {
		t.Fatalf("stale save: %s", got)
	}

	tablet.call(http.StatusOK, "GET", "/api/sync/pull?menu=1", nil, &pull)
	if pull.Menu == nil || pull.Menu.Version != 2 || pull.Menu.Doc.Items[0].Price != live.Doc.Items[0].Price {
		t.Fatalf("tablet should receive version 2: %+v", pull.Menu)
	}

	// Old versions stay available for re-pricing old orders.
	old, err := a.srv.Menus.Get(t.Context(), 1)
	if err != nil || old == nil || old.Items[0].Price != live.Doc.Items[0].Price-25 {
		t.Fatalf("version 1: %v", err)
	}

	// Invalid menus come back with every problem listed.
	live.Doc.Items[0].CategoryID = "nowhere"
	live.Doc.TaxRatePPM = -1
	var bad struct {
		Code    string
		Details []string
	}
	mgr.call(http.StatusBadRequest, "PUT", "/api/menu", map[string]any{"baseVersion": 2, "doc": live.Doc}, &bad)
	if bad.Code != "invalid_menu" || len(bad.Details) != 2 || !strings.Contains(bad.Details[1], "unknown category") {
		t.Fatalf("invalid menu response: %+v", bad)
	}
}

func TestEmptyMenuBeforeFirstSave(t *testing.T) {
	a := newAPI(t)
	var v menu.Version
	m, err := a.srv.Menus.Latest(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	v = m
	if v.Version != 0 || v.Doc.Items == nil || len(v.Doc.Items) != 0 {
		t.Fatalf("empty menu = %+v", v)
	}
}

func TestSettings(t *testing.T) {
	a := seeded(t)
	mgr := a.manager()
	var s settings.Settings
	mgr.call(http.StatusOK, "GET", "/api/settings", nil, &s)
	if s.StoreName != "Demo Coffee" || s.Timezone != "America/New_York" || s.DayCutoffMinutes != 240 {
		t.Fatalf("defaults: %+v", s)
	}
	before := s.Version
	s.Timezone = "Europe/London"
	s.DefaultFloat = 20000
	mgr.call(http.StatusOK, "PUT", "/api/settings", s, &s)
	if s.Version != before+1 || s.Timezone != "Europe/London" {
		t.Fatalf("after save: %+v", s)
	}
	for _, bad := range []func(*settings.Settings){
		func(s *settings.Settings) { s.Timezone = "Mars/Olympus" },
		func(s *settings.Settings) { s.Currency = "dollars" },
		func(s *settings.Settings) { s.DayCutoffMinutes = 800 },
		func(s *settings.Settings) { s.StoreName = "  " },
	} {
		c := s
		bad(&c)
		mgr.call(http.StatusBadRequest, "PUT", "/api/settings", c, nil)
	}
}
