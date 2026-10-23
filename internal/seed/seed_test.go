package seed_test

import (
	"testing"
	"time"

	"coffeepos/internal/db/dbtest"
	"coffeepos/internal/seed"
	"coffeepos/internal/server"
)

// The demo history goes through real ingest; DemoSales fails on any
// rejection or flag, so this also checks the seeder prices like a tablet.
func TestDemoSalesAreStoredCleanly(t *testing.T) {
	pool := dbtest.New(t)
	ctx := t.Context()
	if seeded, err := seed.Demo(ctx, pool, 1000); err != nil || !seeded {
		t.Fatalf("Demo = %v, %v", seeded, err)
	}
	if seeded, _ := seed.Demo(ctx, pool, 1000); seeded {
		t.Fatal("Demo should only seed an empty database")
	}
	now := time.Date(2026, 10, 22, 15, 0, 0, 0, time.UTC)
	srv := server.New(server.Config{Pool: pool, Now: func() time.Time { return now }})
	if err := seed.DemoSales(ctx, pool, srv.Ledger, 3, now); err != nil {
		t.Fatal(err)
	}
	var days, orders, refunds int
	var revoked bool
	if err := pool.QueryRow(ctx, `
		SELECT (SELECT count(DISTINCT business_date) FROM orders), (SELECT count(*) FROM orders),
		       (SELECT count(*) FROM refunds), (SELECT revoked_at IS NOT NULL FROM devices WHERE code = 'DEMO')`,
	).Scan(&days, &orders, &refunds, &revoked); err != nil {
		t.Fatal(err)
	}
	if days != 3 || orders < 3*70 || !revoked {
		t.Fatalf("days %d, orders %d, refunds %d, device retired %v", days, orders, refunds, revoked)
	}
}
