package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestStatic(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("index.html", "INDEX")
	write("sw.js", "SW")
	write("assets/app-123.js", "APP")
	h := static(dir)

	tests := []struct {
		path, body, cache string
		status            int
	}{
		{"/", "INDEX", "no-cache", 200},
		{"/register", "INDEX", "no-cache", 200}, // client-side route
		{"/assets", "INDEX", "no-cache", 200},   // no directory listings
		{"/sw.js", "SW", "no-cache", 200},
		{"/assets/app-123.js", "APP", "public, max-age=31536000, immutable", 200},
		{"/api/unknown", "404 page not found\n", "", 404},
	}
	for _, tc := range tests {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if rec.Code != tc.status || rec.Body.String() != tc.body {
			t.Errorf("GET %s = %d %q, want %d %q", tc.path, rec.Code, rec.Body.String(), tc.status, tc.body)
		}
		if got := rec.Header().Get("Cache-Control"); got != tc.cache {
			t.Errorf("GET %s Cache-Control = %q, want %q", tc.path, got, tc.cache)
		}
	}
}
