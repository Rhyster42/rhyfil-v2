# 9. Voids, payment reversals and refunds

Status: accepted · 2026-10-22

## Decision

| Action | When | Money moves? | Needs |
|---|---|---|---|
| **Line void** | order has no payments yet | no | a reason |
| **Order void** | order has no non-reversed payments | no | a reason |
| **Payment reversal** | order still open | yes, back to the customer | a reason |
| **Refund** | after close | yes, to one of the order's payments | a manager PIN |

- A voided line stays in the document, marked voided, so it appears on the
  void report. Reasons are quick picks: rang in error, changed mind, made
  wrong.
- A voided order syncs like any closed order, with status `voided`.
- A reversed payment stays in the document, marked reversed. Closing an order
  starts a short undo window (until the next tap, or 10 seconds); Undo
  reverses the payment that closed the order and reopens it.
- A refund covers the whole order, selected lines (with quantities) or a
  custom amount, and is a new document. It counts on the business date it
  happens, because that's the day the cash leaves the drawer, not the date of
  the sale.

Voids, reversals and refunds are all reported per staff member and approver.
That reporting is the real loss-prevention control.

## Alternatives rejected

- **Deleting lines freely before payment.** One tap faster, but it hides
  "sweethearting" (ringing items up for friends and removing them).
- **Voiding paid orders as a separate concept from refunds.** Card processors
  distinguish the two, but this POS doesn't talk to the processor. One
  money-back concept is simpler.

**Revised 2026-10-22:**
- A refund returns money to one payment. Fully refunding an order that was
  split across payments takes one refund per payment; the refund sheet
  suggests the payment that covered the chosen items and says how much is
  left on each.
- Line refunds return each unit's price plus that unit's share of the order's
  tax, allocated per unit. Refunding a line in pieces always adds up to
  exactly what was paid for it.
- A manager PIN is required even when a manager is the one signed in, so a
  tablet left signed in as a manager can't be used for refunds.
