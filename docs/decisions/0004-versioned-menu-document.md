# 4. The menu is a versioned JSON document

Status: accepted · 2026-10-22

## Context

Tablets need a complete, consistent menu offline. The server needs to verify
prices on orders that may have been rung up against an older menu.

## Decision

The whole menu (categories, items, modifier groups and options, and the sales
tax rate) is one JSON document. Each save inserts a new immutable row in
`menu_versions`. A save names the version it was based on; if someone saved in
between, it gets `409 Conflict`. Tablets cache the latest version, and every
order records the version it was priced with, so the server re-prices it
against exactly that version.

The tax rate lives in the menu document rather than in settings because it is
part of pricing: an order's menu version pins both its prices and its tax.

Menu IDs are short strings (`latte`, `milk-oat`); the editor generates random
ones for new entries. Order lines snapshot names, category and prices, so
history never depends on today's menu.

## Alternatives rejected

- **Normalized tables (categories, items, groups, options, join tables) with
  CRUD endpoints.** About 15 endpoints plus the matching UI plumbing. Offline
  tablets would still need a snapshot, and re-pricing old orders would need
  temporal tables.

## Consequences

- Integrity (unique IDs, valid references, sane limits) is checked in Go code
  rather than by foreign keys.
- If two managers edit at once, the second save gets a conflict and must
  reload. Fine for one coffee shop.
- A menu is a few KB, so keeping every version forever is cheap.

**Revised 2026-10-22:** tablets keep every menu version that an open order
still uses (a `menus` table keyed by version), not just the newest. An order
stays on the version it started with even if a new menu arrives mid-order, so
prices don't change while the customer is at the counter, and the server
re-prices against that same version.
