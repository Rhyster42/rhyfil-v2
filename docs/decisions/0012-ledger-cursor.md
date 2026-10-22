# 12. Pull cursor: a sequence with serialized ingest

Status: accepted · 2026-10-22

## Context

Tablets pull other devices' orders and refunds with a cursor ("everything after
seq N"). Postgres sequences hand out numbers before commit. Transaction A can
take seq 10, transaction B take 11 and commit first; a reader that sees 11
moves its cursor past 10 and never sees it.

## Decision

Every ledger write takes a transaction-level advisory lock before drawing from
`ledger_seq`. The lock is held until commit, so sequence order equals commit
order and the visible ledger is always a prefix. A coffee shop ingests a few
documents a minute, so serializing ingest costs nothing. The duplicate check
also runs under the lock, so idempotency has no race.

## Alternatives rejected

- **Timestamps as cursors.** Limited clock resolution, and the same visibility
  race.
- **Overlapping windows with client-side dedupe.** Usually works, which isn't
  the same as always.
- **Cursors based on `pg_snapshot_xmin`.** Correct without serializing, but
  subtle. Worth it only at much higher write volume.

## Consequences

- A test pushes from many goroutines at once while a reader pulls, and asserts
  the reader sees every document exactly once.
