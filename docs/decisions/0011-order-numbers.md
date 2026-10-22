# 11. Order numbers: device letter plus a daily counter

Status: accepted · 2026-10-22

## Decision

Customers need a short number to hear called out, and a shared sequence is
impossible offline. Each tablet gets a letter when it's enrolled (A, B, … Z,
AA, …). Its order numbers are `A-001`, `A-002`, …, restarting each business
day.

The number is assigned when an order starts, so it can go on the cup. It is
for display only; an order's identity is its UUID. Voided orders leave gaps.

## Alternatives rejected

- **A global sequence.** Needs connectivity at the moment of sale.
- **Random short codes.** Hard to call out across a busy room, and they can
  collide.

## Consequences

- If a tablet's storage is wiped mid-day, its counter restarts and a number can
  repeat that day. Harmless, since numbers aren't identity, but confusing at
  the bar. The counter is rebuilt from the local ledger on startup to make this
  unlikely.
