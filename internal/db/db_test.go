package db_test

import (
	"context"
	"testing"

	"coffeepos/internal/db"
	"coffeepos/internal/db/dbtest"
)

func TestMigrateIsIdempotent(t *testing.T) {
	pool := dbtest.New(t) // already migrated once
	ctx := context.Background()
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	var settings int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM settings").Scan(&settings); err != nil {
		t.Fatal(err)
	}
	if settings != 1 {
		t.Fatalf("settings rows = %d, want 1", settings)
	}
}
