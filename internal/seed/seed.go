// Package seed loads demo data into an empty database.
package seed

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"coffeepos/internal/auth"
	"coffeepos/internal/menu"
)

//go:embed demo_menu.json
var demoMenu []byte

// DemoStaff are the people the demo creates, with their PINs.
var DemoStaff = []struct{ Name, Role, PIN string }{
	{"Morgan", auth.RoleManager, "1234"},
	{"Sam", auth.RoleBarista, "1111"},
	{"Riley", auth.RoleBarista, "2222"},
}

// DemoMenu returns the demo menu document.
func DemoMenu() (*menu.Doc, error) {
	var doc menu.Doc
	if err := json.Unmarshal(demoMenu, &doc); err != nil {
		return nil, err
	}
	return &doc, menu.Validate(&doc)
}

// Demo fills a database that has no staff and no menu yet with a demo menu
// and staff. It reports whether it did anything.
func Demo(ctx context.Context, pool *pgxpool.Pool, pinIterations int) (bool, error) {
	doc, err := DemoMenu()
	if err != nil {
		return false, fmt.Errorf("demo menu: %w", err)
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		return false, err
	}
	seeded := false
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var staff, menus int
		if err := tx.QueryRow(ctx, "SELECT (SELECT count(*) FROM staff), (SELECT count(*) FROM menu_versions)").
			Scan(&staff, &menus); err != nil {
			return err
		}
		if staff > 0 || menus > 0 {
			return nil
		}
		for _, s := range DemoStaff {
			verifier, err := auth.HashPIN(s.PIN, pinIterations)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "INSERT INTO staff (id, name, role, pin_verifier) VALUES ($1, $2, $3, $4)",
				uuid.Must(uuid.NewV7()).String(), s.Name, s.Role, verifier); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, "UPDATE counters SET value = value + 1 WHERE name = 'staff'"); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "INSERT INTO menu_versions (version, doc) VALUES (1, $1)", raw); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE settings SET store_name = 'Demo Coffee', version = version + 1"); err != nil {
			return err
		}
		seeded = true
		return nil
	})
	return seeded, err
}
