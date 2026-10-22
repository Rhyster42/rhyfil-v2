// Package dbtest gives each test its own freshly migrated Postgres database.
package dbtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"coffeepos/internal/db"
)

// New creates an empty database, migrates it, and drops it when the test
// ends. Tests are skipped when POS_TEST_DATABASE_URL isn't set; `make test`
// starts Postgres and sets it.
func New(t testing.TB) *pgxpool.Pool {
	t.Helper()
	adminURL := os.Getenv("POS_TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("POS_TEST_DATABASE_URL not set (run `make test`)")
	}
	ctx := context.Background()

	suffix := make([]byte, 6)
	rand.Read(suffix)
	name := "pos_test_" + hex.EncodeToString(suffix)
	adminExec(t, adminURL, "CREATE DATABASE "+name)

	cfg, err := pgxpool.ParseConfig(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.Database = name
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		adminExec(t, adminURL, "DROP DATABASE "+name+" WITH (FORCE)")
	})
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

func adminExec(t testing.TB, url, sql string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect to test postgres: %v", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, sql); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}
