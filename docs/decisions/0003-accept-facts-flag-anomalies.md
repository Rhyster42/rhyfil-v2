# 3. The server records facts and flags anomalies

Status: accepted · 2026-10-22

## Context

By the time an offline tablet syncs, the coffee has been drunk and the money
has changed hands. A server that rejects a document over a business rule
doesn't undo the sale; it just loses the record of it, or leaves it stuck in
an outbox forever.

## Decision

The server rejects only what it can't store meaningfully:

- malformed documents or unsupported schema versions;
- references the document can't exist without (a refund for an order or
  payment the server has never seen);
- a device pushing documents that claim to come from another device;
- unauthenticated or revoked devices (the whole request fails).

Everything else is stored, and anything suspicious raises a flag for a manager
to review and resolve:

| Kind | Raised when |
|---|---|
| `menu_mismatch` | line prices or modifiers don't match the menu version the order used |
| `total_mismatch` | line totals, subtotal, tax and total don't add up |
| `payment_mismatch` | a paid order's payments don't equal its total, or a voided order kept a payment |
| `over_refund` | refunds exceed what was paid, or return more units than were sold |
| `approval_invalid` | a refund's approver isn't an active manager |
| `unknown_staff` | the document names staff the server doesn't know |
| `after_closeout` | the document's business date was already closed out |
| `clock_skew` | the timestamp is in the future, or days older than its arrival |

Rejected documents are kept server-side (`sync_rejections`) and moved to a
dead-letter list on the tablet that managers can see. Nothing is dropped
silently.

## Alternatives rejected

- **Reject on any rule violation.** It looks correct, but it loses real sales
  and refunds.
- **Re-price on the server and overwrite.** The customer paid what the tablet
  showed. Overwriting would make the records lie.

## Consequences

- Reports reflect what happened; flags show where it deviated from the rules.
- Someone has to review flags. The close-out page shows the unresolved count.
