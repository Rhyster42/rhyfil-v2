# 2. Tablets sync immutable documents: closed orders and refunds

Status: accepted · 2026-10-22

## Context

Offline devices that edit shared records produce conflicts, and conflict
resolution is where offline systems get complicated and lose data.

## Decision

Shape the domain so that nothing is ever edited after it syncs:

- An order is built on one tablet and synced exactly once, when it closes
  (paid or voided), as a complete document: lines with modifiers and snapshot
  names and prices, voided lines with reasons, payments (including reversed
  ones), totals, staff, device and menu version.
- A refund is a separate document that references an order and the payment it
  returns money to.
- Every document has a UUIDv7 generated on the tablet, which doubles as its
  idempotency key.

On the server, the `ledger` table stores each document as received. It is the
canonical record and what other tablets pull. The same transaction writes
relational projections (`orders`, `order_lines`, `payments`, `refunds`, …) for
reporting.

Because synced records are never updated, two tablets can never edit the same
record. The only rule that spans documents ("don't refund more than was paid")
is handled by flagging ([0003](0003-accept-facts-flag-anomalies.md)).

## Alternatives rejected

- **An event per tap** (`LineAdded`, `ModifierChanged`, …). A counter order
  lives about 30 seconds on one tablet, so streaming each tap helps nobody, and
  both client and server would have to project event streams.
- **CRDTs (Automerge, Yjs).** They solve concurrent editing of one document,
  which doesn't happen here.
- **Sync engines (PowerSync, ElectricSQL, Zero).** Large dependencies and new
  infrastructure for what is two endpoints in this domain.
- **Syncing open orders.** That would allow paying at another tablet or a live
  bar display, at the cost of real conflicts. Counter service doesn't need it.
  Revisit with a bar display.

## Consequences

- An open order on a tablet that dies is lost; it gets rung again.
- Payments taken on an open order reach the server when the order closes.
- After close, changes are new documents (refunds). There is no "edit order".
