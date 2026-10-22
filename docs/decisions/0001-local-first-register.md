# 1. The tablet's IndexedDB is the register's database

Status: accepted · 2026-10-22

## Context

The register has to keep taking orders with no network, and it has to feel
instant during a rush. Coffee-shop Wi-Fi drops, and ISP outages pick the worst
moment.

## Decision

The register UI reads and writes local storage only (IndexedDB, through Dexie).
It never calls the server to take, price, pay, refund or look up an order. A
sync engine running in the page is the only register code that touches the
network: it drains an outbox of local documents to the server and pulls the
menu, staff list, settings and recent ledger back down.

Being offline is therefore not a mode. "Online" just means the outbox drains.

The back office (menu editing, staff, reports, close-out) is the exception. It
is online-only because it needs the server's view of every device.

## Alternatives rejected

- **Online-first with a retry queue.** Every screen needs an offline branch,
  and queued requests are opaque: the UI can't query what's waiting (for
  example, to refund an order that hasn't synced yet).
- **Service-worker request replay (Workbox background sync).** The same
  opacity, and it relies on the Background Sync API, which Safari doesn't
  implement.
- **SQLite compiled to WebAssembly, stored in OPFS.** SQL on both sides is
  attractive, but it's a ~1 MB download and OPFS has been the least predictable
  storage on iOS. IndexedDB holds a few days of orders easily.

## Consequences

- Pricing, split and refund rules must run in the browser ([0007](0007-pricing-in-two-languages.md)).
- Unsynced data lives only on the tablet. The app requests persistent storage,
  syncs within seconds when online, and always shows the pending count.
- An open (unpaid) order exists only on the tablet that started it.
