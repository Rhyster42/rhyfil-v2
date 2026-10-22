# 8. A split check is several tenders on one order

Status: accepted · 2026-10-22

## Decision

An order has one or more payments, and it is paid when its non-reversed
payments equal the total. The register offers three ways to choose the amount
of the next payment:

- **Even split:** allocate the remaining balance N ways.
- **By item:** pick lines; the amount is their totals plus their allocated tax.
  The payment records `coversLineIds`, which is used on receipts and to pick
  the default payment for a later refund.
- **Custom amount.**

Once the first payment is taken, the order's lines are locked. To change them,
reverse the payments first ([0009](0009-voids-reversals-refunds.md)). This
keeps one simple invariant: payments are made against a fixed total.

## Alternatives rejected

- **Child checks** (the restaurant model: split an order into separate checks,
  each with its own lines and payments). More state and more UI, with no
  benefit at a counter where a group orders together and pays together.

## Consequences

- One ticket and one order number per group.
- Adding an item halfway through a split means reversing the payments taken so
  far. That's rare at a counter.
