# 17. Reports are computed live; close-out stores a snapshot

Status: accepted · 2026-10-22

## Decision

- Reports are SQL over the projection tables for a range of business dates:
  summary, tenders, items, categories, modifiers, hours, staff, voids,
  reversals and refunds.
- Definitions:
  - **Gross sales:** non-voided line totals on paid orders.
  - **Net sales:** gross sales minus refunded sales (refund amount minus its
    tax portion).
  - **Collected:** payments minus refunds.
  - The identity *collected = net sales + net tax* holds for consistent data,
    and a test checks it.
- **Close-out** is per business date. The manager sees each device's sync
  status, unresolved flags and the live report, then enters the opening float
  and counted cash for each drawer (one drawer per tablet). The server computes
  expected cash (float + cash payments − cash refunds on that device), stores
  counted, expected and over/short, and keeps a JSON snapshot of the report.
- A document that arrives after close-out is accepted and flagged
  `after_closeout`. The close-out page shows the difference between the
  snapshot and the live numbers.

## Alternatives rejected

- **Locking a closed day and rejecting late data.** Loses sales.
- **Pre-aggregated reporting tables.** Premature: a coffee shop's whole year is
  a few hundred thousand rows.

**Revised 2026-10-22:**
- Close-out takes the same advisory lock as ingest (`db.LockLedger`), so every
  document is either in the snapshot or flagged `after_closeout`, never
  neither.
- "Changed since close-out" compares the money figures and counts. Resolving
  a flag doesn't count as a change.
- With `POS_DEMO=1`, an empty database also gets six past days of sales,
  pushed through the real ingest path. The seeder fails on any rejection or
  flag, so it also tests that the server agrees with tablet-style pricing.
