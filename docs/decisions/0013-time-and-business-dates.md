# 13. Time and business dates

Status: accepted · 2026-10-22

## Decision

- Each pull returns the server's time. The tablet estimates its clock offset
  from the midpoint of the round trip (as NTP does) and stamps documents with
  corrected time.
- A business date is the calendar date in the store's time zone after
  subtracting a cutoff (default 04:00), so a 1 a.m. sale belongs to the
  previous day. The tablet assigns it, because it's part of the order number.
  The server flags `clock_skew` when a timestamp is implausible.
- Refunds belong to the business date on which they happen.
- Timestamps are RFC 3339 UTC strings on the wire and `timestamptz` in
  Postgres. Business dates are `YYYY-MM-DD` strings and `date`.

## Alternatives rejected

- **Using the server's receive time as the sale time.** Orders rung up offline
  would land on the wrong day.

## Consequences

- A tablet that has never synced since its clock went wrong will stamp wrong
  times. Enrollment requires a connection, so every tablet has at least one
  offset measurement.
