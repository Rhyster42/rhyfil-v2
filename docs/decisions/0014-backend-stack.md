# 14. Backend: Go standard library, pgx, hand-written SQL

Status: accepted · 2026-10-22

## Decision

- **HTTP:** `net/http` with method and path patterns (Go 1.22+), and `log/slog`
  for structured logs. No framework.
- **Postgres:** pgx v5 with a connection pool. SQL is written by hand next to
  the code that uses it.
- **Migrations:** plain SQL files embedded in the binary and applied at startup
  under an advisory lock. Forward-only.
- **Layout:** packages by feature (`menu`, `auth`, `ledger`, `reports`, …), each
  owning its types, SQL and handlers. Pure logic (`money`, `pricing`,
  `bizdate`) does no I/O.

## Alternatives rejected

- **Gin, Echo or chi.** The standard router now covers what they were for.
- **GORM.** It hides the SQL, and reports need real SQL.
- **sqlc.** Good, but a code-generation step for about 40 queries. I'd adopt it
  as the query count grows.
- **goose or golang-migrate.** A 60-line runner does what's needed.
