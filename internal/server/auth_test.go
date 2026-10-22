package server_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"coffeepos/internal/syncapi"
)

func TestFirstRunSetup(t *testing.T) {
	a := newAPI(t)
	anon := a.anon()

	var status struct{ NeedsSetup bool }
	anon.call(http.StatusOK, "GET", "/api/setup", nil, &status)
	if !status.NeedsSetup {
		t.Fatal("empty system should need setup")
	}
	code, err := a.srv.Auth.EnsureSetupCode(context.Background())
	if err != nil || len(code) != 8 {
		t.Fatalf("setup code %q, %v", code, err)
	}

	req := map[string]string{"code": "00000000", "managerName": "Ada", "pin": "246810", "deviceName": "Front"}
	if got := anon.errorCode(http.StatusUnauthorized, "POST", "/api/setup", req); got != "bad_code" {
		t.Fatalf("wrong code: %s", got)
	}
	req["code"] = code[:4] + " - " + code[4:] // people type separators
	var out struct {
		Device struct{ ID, Name, Code string }
		Token  string
		Staff  struct{ ID, Name, Role string }
	}
	anon.call(http.StatusCreated, "POST", "/api/setup", req, &out)
	if out.Device.Code != "A" || out.Token == "" || out.Staff.Role != "manager" || out.Staff.Name != "Ada" {
		t.Fatalf("setup result %+v", out)
	}

	anon.call(http.StatusOK, "GET", "/api/setup", nil, &status)
	if status.NeedsSetup {
		t.Fatal("still needs setup")
	}
	if got := anon.errorCode(http.StatusConflict, "POST", "/api/setup", req); got != "already_set_up" {
		t.Fatalf("second setup: %s", got)
	}
	if code, _ := a.srv.Auth.EnsureSetupCode(context.Background()); code != "" {
		t.Fatal("no setup code once staff exist")
	}

	// The new device can pull and the manager can open the back office.
	dev := &client{a: a, token: out.Token}
	var pull syncapi.PullResponse
	dev.call(http.StatusOK, "GET", "/api/sync/pull", nil, &pull)
	if pull.Staff == nil || len(pull.Staff.Members) != 1 || pull.Staff.Members[0].PINVerifier == nil {
		t.Fatalf("staff after setup: %+v", pull.Staff)
	}
	dev.signIn("Ada", "246810").call(http.StatusOK, "GET", "/api/staff", nil, nil)
}

func TestEnrollment(t *testing.T) {
	a := seeded(t)
	mgr := a.manager() // device A

	var codeResp struct{ Code string }
	mgr.call(http.StatusCreated, "POST", "/api/devices/codes", nil, &codeResp)

	var out struct{ Device struct{ Code string } }
	a.anon().call(http.StatusCreated, "POST", "/api/devices/enroll", map[string]string{"code": codeResp.Code, "name": "Bar"}, &out)
	if out.Device.Code != "B" {
		t.Fatalf("second device letter = %s", out.Device.Code)
	}
	if got := a.anon().errorCode(http.StatusUnauthorized, "POST", "/api/devices/enroll",
		map[string]string{"code": codeResp.Code, "name": "Again"}); got != "bad_code" {
		t.Fatalf("reused code: %s", got)
	}

	mgr.call(http.StatusCreated, "POST", "/api/devices/codes", nil, &codeResp)
	a.now = a.now.Add(16 * time.Minute)
	if got := a.anon().errorCode(http.StatusUnauthorized, "POST", "/api/devices/enroll",
		map[string]string{"code": codeResp.Code, "name": "Late"}); got != "bad_code" {
		t.Fatalf("expired code: %s", got)
	}

	// The demo code works repeatedly.
	a.anon().call(http.StatusCreated, "POST", "/api/devices/enroll", map[string]string{"code": "demo", "name": "C"}, &out)
	if out.Device.Code != "C" {
		t.Fatalf("third device letter = %s", out.Device.Code)
	}
}

func TestDeviceAuthentication(t *testing.T) {
	a := seeded(t)
	if got := a.anon().errorCode(http.StatusUnauthorized, "GET", "/api/sync/pull", nil); got != "device_unknown" {
		t.Fatalf("no token: %s", got)
	}
	forged := &client{a: a, token: "not-a-real-token"}
	if got := forged.errorCode(http.StatusUnauthorized, "GET", "/api/sync/pull", nil); got != "device_unknown" {
		t.Fatalf("bad token: %s", got)
	}

	mgr := a.manager()
	tablet := a.enroll("Counter")
	var devices []struct{ ID, Code string }
	mgr.call(http.StatusOK, "GET", "/api/devices", nil, &devices)
	if len(devices) != 2 {
		t.Fatalf("devices = %+v", devices)
	}
	if got := mgr.errorCode(http.StatusConflict, "POST", "/api/devices/"+devices[0].ID+"/revoke", nil); got != "own_device" {
		t.Fatalf("revoke own device: %s", got)
	}
	mgr.call(http.StatusNoContent, "POST", "/api/devices/"+devices[1].ID+"/revoke", nil, nil)
	if got := tablet.errorCode(http.StatusUnauthorized, "GET", "/api/sync/pull", nil); got != "device_unknown" {
		t.Fatalf("revoked device: %s", got)
	}
	mgr.call(http.StatusNotFound, "POST", "/api/devices/"+devices[1].ID+"/revoke", nil, nil)
}

func TestManagerSessions(t *testing.T) {
	a := seeded(t)
	tablet := a.enroll("Counter")

	// The back office needs a session.
	if got := tablet.errorCode(http.StatusUnauthorized, "GET", "/api/staff", nil); got != "session_invalid" {
		t.Fatalf("no session: %s", got)
	}
	// Baristas can't open it, even with the right PIN.
	if got := tablet.errorCode(http.StatusForbidden, "POST", "/api/sessions",
		map[string]string{"staffId": a.staffID("Sam"), "pin": "1111"}); got != "not_manager" {
		t.Fatalf("barista: %s", got)
	}
	// Wrong PINs lock out after five tries.
	wrong := map[string]string{"staffId": a.staffID("Morgan"), "pin": "9999"}
	for range 5 {
		if got := tablet.errorCode(http.StatusUnauthorized, "POST", "/api/sessions", wrong); got != "wrong_pin" {
			t.Fatalf("wrong pin: %s", got)
		}
	}
	right := map[string]string{"staffId": a.staffID("Morgan"), "pin": "1234"}
	if got := tablet.errorCode(http.StatusTooManyRequests, "POST", "/api/sessions", right); got != "too_many_attempts" {
		t.Fatalf("locked out: %s", got)
	}
	a.now = a.now.Add(61 * time.Second)
	tablet.signIn("Morgan", "1234")
	tablet.call(http.StatusOK, "GET", "/api/staff", nil, nil)

	// A session only works on the device it was opened on.
	other := a.enroll("Bar")
	other.session = tablet.session
	if got := other.errorCode(http.StatusUnauthorized, "GET", "/api/staff", nil); got != "session_invalid" {
		t.Fatalf("session on another device: %s", got)
	}

	// Sessions expire.
	a.now = a.now.Add(13 * time.Hour)
	if got := tablet.errorCode(http.StatusUnauthorized, "GET", "/api/staff", nil); got != "session_invalid" {
		t.Fatalf("expired session: %s", got)
	}

	// Signing out ends the session.
	tablet.signIn("Morgan", "1234")
	tablet.call(http.StatusNoContent, "DELETE", "/api/sessions", nil, nil)
	tablet.call(http.StatusUnauthorized, "GET", "/api/staff", nil, nil)
}

func TestStaffManagement(t *testing.T) {
	a := seeded(t)
	mgr := a.manager()
	tablet := a.enroll("Counter")

	var pull syncapi.PullResponse
	tablet.call(http.StatusOK, "GET", "/api/sync/pull", nil, &pull)
	staffVersion := pull.Staff.Version
	tablet.call(http.StatusOK, "GET", "/api/sync/pull?staff="+itoa(staffVersion), nil, &pull)
	if pull.Staff != nil {
		t.Fatal("staff should be omitted when unchanged")
	}

	var jo struct{ ID, Role string }
	mgr.call(http.StatusCreated, "POST", "/api/staff", map[string]string{"name": "Jo", "role": "barista", "pin": "4321"}, &jo)
	mgr.call(http.StatusBadRequest, "POST", "/api/staff", map[string]string{"name": "Bad", "role": "barista", "pin": "12"}, nil)
	mgr.call(http.StatusBadRequest, "POST", "/api/staff", map[string]string{"name": "Bad", "role": "owner", "pin": "1234"}, nil)

	mgr.call(http.StatusOK, "PATCH", "/api/staff/"+jo.ID, map[string]any{"active": false}, nil)
	tablet.call(http.StatusOK, "GET", "/api/sync/pull?staff="+itoa(staffVersion), nil, &pull)
	if pull.Staff == nil || pull.Staff.Version <= staffVersion {
		t.Fatalf("staff version should move: %+v", pull.Staff)
	}
	for _, m := range pull.Staff.Members {
		if m.Name == "Jo" && (m.Active || m.PINVerifier != nil) {
			t.Fatalf("inactive staff should have no verifier: %+v", m)
		}
	}

	// Can't remove the last manager, by deactivation or demotion.
	morgan := a.staffID("Morgan")
	if got := mgr.errorCode(http.StatusConflict, "PATCH", "/api/staff/"+morgan, map[string]any{"role": "barista"}); got != "last_manager" {
		t.Fatalf("demote last manager: %s", got)
	}
	mgr.call(http.StatusNotFound, "PATCH", "/api/staff/not-a-uuid", map[string]any{"name": "X"}, nil)

	// Promote Sam, then Morgan may step down, which ends Morgan's session.
	mgr.call(http.StatusOK, "PATCH", "/api/staff/"+a.staffID("Sam"), map[string]any{"role": "manager"}, nil)
	mgr.call(http.StatusOK, "PATCH", "/api/staff/"+morgan, map[string]any{"active": false}, nil)
	mgr.call(http.StatusUnauthorized, "GET", "/api/staff", nil, nil)
}

func TestPullRecordsHeartbeat(t *testing.T) {
	a := seeded(t)
	tablet := a.enroll("Counter")
	tablet.call(http.StatusOK, "GET", "/api/sync/pull?pending=3&open=1", nil, nil)
	tablet.call(http.StatusBadRequest, "GET", "/api/sync/pull?cursor=-1", nil, nil)

	var devices []struct {
		Name            string
		LastSeenAt      *time.Time
		ReportedPending int
		ReportedOpen    int
	}
	a.manager().call(http.StatusOK, "GET", "/api/devices", nil, &devices)
	d := devices[0]
	if d.Name != "Counter" || d.LastSeenAt == nil || !d.LastSeenAt.Equal(a.now) || d.ReportedPending != 3 || d.ReportedOpen != 1 {
		t.Fatalf("heartbeat not recorded: %+v", d)
	}
}
