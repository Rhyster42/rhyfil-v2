# 19. Testing strategy

Status: accepted · 2026-10-22

## Decision

- **Pure logic:** table-driven unit tests in Go and Vitest, with shared vectors
  in `testdata/vectors/` run by both.
- **Server:** integration tests against a real Postgres (the docker compose
  service on port 5433). Each test gets a fresh database. The database is never
  mocked.
- **Web:** Vitest with fake-indexeddb for storage and the sync engine; React
  Testing Library for register flows, including tap budgets.
- **End to end:** Playwright against the real container: ring orders offline,
  refund one, reconnect, and check the server's report.
- **Invariant tests:**
  - splits sum to the total;
  - pushing a batch twice creates no duplicates;
  - concurrent pushes never make the cursor skip a document;
  - collected = net sales + net tax;
  - an over-refund from two tablets is stored and flagged;
  - a document arriving after close-out is stored and flagged.

## Alternatives rejected

- **Mocking the database.** That tests the mock, not the SQL.
- **testcontainers-go.** A heavy dependency tree, and compose already runs
  Postgres.
