package server

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// static serves the built PWA from dir. Unknown paths fall back to
// index.html so client-side routes work on reload. Vite's hashed assets are
// cached forever; everything else (index.html, the service worker, the
// manifest) must be revalidated so updates are noticed.
func static(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	index := filepath.Join(dir, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := path.Clean("/" + r.URL.Path)
		if strings.HasPrefix(p, "/api/") {
			http.NotFound(w, r)
			return
		}
		info, err := os.Stat(filepath.Join(dir, filepath.FromSlash(p)))
		if p == "/" || err != nil || info.IsDir() {
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFile(w, r, index)
			return
		}
		if strings.HasPrefix(p, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}
