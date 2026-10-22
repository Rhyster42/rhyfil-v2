package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"coffeepos/internal/auth"
	"coffeepos/internal/db/dbtest"
	"coffeepos/internal/seed"
	"coffeepos/internal/server"
)

// api drives the real HTTP handler against a fresh database.
type api struct {
	t    *testing.T
	pool *pgxpool.Pool
	srv  *server.Server
	now  time.Time
}

// newAPI returns an empty system; seeded adds the demo menu and staff.
func newAPI(t *testing.T) *api {
	t.Helper()
	a := &api{t: t, pool: dbtest.New(t), now: time.Date(2026, 10, 22, 14, 0, 0, 0, time.UTC)}
	a.srv = server.New(server.Config{
		Pool: a.pool,
		Auth: auth.Options{PINIterations: 1000, DemoEnrollCode: "DEMO"},
		Now:  func() time.Time { return a.now },
	})
	return a
}

func seeded(t *testing.T) *api {
	t.Helper()
	a := newAPI(t)
	if _, err := seed.Demo(context.Background(), a.pool, 1000); err != nil {
		t.Fatal(err)
	}
	return a
}

// client is a device (and optionally a back-office session) talking to the API.
type client struct {
	a       *api
	token   string
	session string
}

func (a *api) anon() *client { return &client{a: a} }

type response struct {
	status int
	body   []byte
}

func (c *client) do(method, path string, body any) response {
	c.a.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			c.a.t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if c.session != "" {
		req.Header.Set("X-Session", c.session)
	}
	rec := httptest.NewRecorder()
	c.a.srv.Handler.ServeHTTP(rec, req)
	return response{status: rec.Code, body: rec.Body.Bytes()}
}

// call makes a request, fails the test unless it returns want, and decodes
// the body into out (if non-nil).
func (c *client) call(want int, method, path string, body, out any) {
	c.a.t.Helper()
	r := c.do(method, path, body)
	if r.status != want {
		c.a.t.Fatalf("%s %s = %d %s, want %d", method, path, r.status, r.body, want)
	}
	if out != nil {
		if err := json.Unmarshal(r.body, out); err != nil {
			c.a.t.Fatalf("%s %s: decode %s: %v", method, path, r.body, err)
		}
	}
}

// errorCode makes a request expecting an error and returns its code.
func (c *client) errorCode(want int, method, path string, body any) string {
	c.a.t.Helper()
	var e struct{ Code string }
	c.call(want, method, path, body, &e)
	return e.Code
}

// enroll enrolls a new device with the demo code.
func (a *api) enroll(name string) *client {
	a.t.Helper()
	var out struct {
		Device auth.Device
		Token  string
	}
	a.anon().call(http.StatusCreated, "POST", "/api/devices/enroll", map[string]string{"code": "DEMO", "name": name}, &out)
	return &client{a: a, token: out.Token}
}

func (a *api) staffID(name string) string {
	a.t.Helper()
	var id string
	if err := a.pool.QueryRow(context.Background(), "SELECT id FROM staff WHERE name = $1", name).Scan(&id); err != nil {
		a.t.Fatalf("staff %q: %v", name, err)
	}
	return id
}

// signIn opens a back-office session on c for the named manager.
func (c *client) signIn(name, pin string) *client {
	c.a.t.Helper()
	var out struct{ Token string }
	c.call(http.StatusCreated, "POST", "/api/sessions", map[string]string{"staffId": c.a.staffID(name), "pin": pin}, &out)
	c.session = out.Token
	return c
}

// manager returns a new device with Morgan signed in to the back office.
func (a *api) manager() *client {
	return a.enroll("Office").signIn("Morgan", "1234")
}
