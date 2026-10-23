package menu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"coffeepos/internal/db"
	"coffeepos/internal/httpx"
)

// Version is a saved menu.
type Version struct {
	Version int64 `json:"version"`
	Doc     *Doc  `json:"doc"`
}

// Store saves menu versions and reads them back. Versions never change once
// saved, so they're cached forever.
type Store struct {
	pool  *pgxpool.Pool
	mu    sync.Mutex
	cache map[int64]*Doc
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool, cache: map[int64]*Doc{}}
}

// ErrConflict means someone saved a newer version since the editor loaded.
var ErrConflict = errors.New("menu changed since it was loaded")

// Normalize replaces nil slices with empty ones so the JSON has arrays.
func (d *Doc) Normalize() {
	if d.Categories == nil {
		d.Categories = []Category{}
	}
	if d.Items == nil {
		d.Items = []Item{}
	}
	if d.Groups == nil {
		d.Groups = []Group{}
	}
	for i := range d.Items {
		if d.Items[i].GroupIDs == nil {
			d.Items[i].GroupIDs = []string{}
		}
	}
	for i := range d.Groups {
		if d.Groups[i].Options == nil {
			d.Groups[i].Options = []Option{}
		}
	}
}

// Latest returns the live menu, or version 0 with an empty menu if none has
// been saved yet.
func (s *Store) Latest(ctx context.Context) (Version, error) {
	var v Version
	var raw []byte
	err := s.pool.QueryRow(ctx, "SELECT version, doc FROM menu_versions ORDER BY version DESC LIMIT 1").Scan(&v.Version, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		doc := &Doc{}
		doc.Normalize()
		return Version{Version: 0, Doc: doc}, nil
	} else if err != nil {
		return Version{}, err
	}
	v.Doc, err = s.decode(v.Version, raw)
	return v, err
}

// LatestVersion returns the live version number (0 if none).
func (s *Store) LatestVersion(ctx context.Context) (int64, error) {
	var v int64
	err := s.pool.QueryRow(ctx, "SELECT coalesce(max(version), 0) FROM menu_versions").Scan(&v)
	return v, err
}

// Get returns a specific version, or nil if it doesn't exist.
func (s *Store) Get(ctx context.Context, version int64) (*Doc, error) {
	s.mu.Lock()
	doc := s.cache[version]
	s.mu.Unlock()
	if doc != nil {
		return doc, nil
	}
	var raw []byte
	err := s.pool.QueryRow(ctx, "SELECT doc FROM menu_versions WHERE version = $1", version).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	return s.decode(version, raw)
}

func (s *Store) decode(version int64, raw []byte) (*Doc, error) {
	var doc Doc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("menu version %d: %w", version, err)
	}
	doc.Normalize()
	s.mu.Lock()
	s.cache[version] = &doc
	s.mu.Unlock()
	return &doc, nil
}

// Save validates doc and stores it as the version after base. If base isn't
// the latest version any more, it returns ErrConflict.
func (s *Store) Save(ctx context.Context, base int64, doc *Doc, staffID string) (int64, error) {
	doc.Normalize()
	if err := Validate(doc); err != nil {
		return 0, err
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		return 0, err
	}
	var version int64
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", db.LockMenu); err != nil {
			return err
		}
		var latest int64
		if err := tx.QueryRow(ctx, "SELECT coalesce(max(version), 0) FROM menu_versions").Scan(&latest); err != nil {
			return err
		}
		if latest != base {
			return ErrConflict
		}
		version = latest + 1
		var by *string
		if staffID != "" {
			by = &staffID
		}
		_, err := tx.Exec(ctx, "INSERT INTO menu_versions (version, doc, created_by) VALUES ($1, $2, $3)", version, raw, by)
		return err
	})
	return version, err
}

// HandleGet: GET /api/menu → the live version.
func (s *Store) HandleGet(w http.ResponseWriter, r *http.Request) error {
	v, err := s.Latest(r.Context())
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, v)
	return nil
}

// HandlePut: PUT /api/menu {baseVersion, doc} → {version}. The caller passes
// the version it edited so concurrent edits are caught.
func (s *Store) HandlePut(w http.ResponseWriter, r *http.Request, staffID string) error {
	var req struct {
		BaseVersion int64 `json:"baseVersion"`
		Doc         *Doc  `json:"doc"`
	}
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		return err
	}
	if req.Doc == nil {
		return httpx.BadRequest("doc is required")
	}
	version, err := s.Save(r.Context(), req.BaseVersion, req.Doc, staffID)
	var verr *ValidationError
	switch {
	case errors.As(err, &verr):
		return &httpx.Error{Status: http.StatusBadRequest, Code: "invalid_menu", Message: verr.Error(), Details: verr.Problems}
	case errors.Is(err, ErrConflict):
		return httpx.Errorf(http.StatusConflict, "conflict", "the menu was changed by someone else; reload it and try again")
	case err != nil:
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]int64{"version": version})
	return nil
}
