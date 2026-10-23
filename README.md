# Coffee POS

A point of sale for a coffee shop that keeps working when the internet doesn't.
Baristas ring orders on a tablet (a PWA); a Go server with PostgreSQL keeps the
books, runs the reports and closes out the day.

- **The register** is built for a rush: tap an item and it's on the order with
  its usual options; a medium latte by card is 2 taps. Modifiers (size, milk,
  shots, syrups) are always on screen, and the tender buttons sit on the order
  itself. Split checks evenly, by item or by amount; void lines and orders;
  give a payment back; undo a mis-tap.
- **Offline is the normal case.** The register reads and writes only the
  tablet's own database. A tablet with no network keeps selling, looking up
  orders and doing manager-approved refunds, and syncs when it can.
- **The back office** (managers, online) has sales reports, close-out with
  drawer counts, flags to review, and editors for the menu, staff, tablets and
  settings.

How it's built, and why, is in [docs/decisions](docs/decisions/): one short
note per decision, with the alternatives rejected.

## Try it

You need Docker.

```sh
make up        # builds the image and starts Postgres + the app
```

Open <http://localhost:8080> and:

1. **Add this tablet** with the code `DEMO` (any name).
2. Tap **Sam** and enter **1111**, then ring some orders.
3. To see offline mode, open DevTools → Network → **Offline**, keep selling and
   refunding, then go back online and watch the sync pill go back to
   "Synced".
4. Tap **Lock**, sign in as **Morgan** (manager, **1234**) and open **Back
   office**. The demo comes with six past days of sales, so the reports have
   something to show.

Riley (barista, 2222) is there too. Open a second browser profile to act as a
second tablet: it gets the next order letter (B-001, …) and sees the first
tablet's orders.

`make down` stops it. `docker compose down -v` also deletes the data.

### On a real tablet

Service workers (and so offline mode) need HTTPS anywhere except `localhost`.
The `lan` profile puts Caddy in front with its own certificate authority:

```sh
POS_LAN_HOST=192.168.1.20 docker compose --profile lan up -d
```

Then open `https://192.168.1.20:8443` on the tablet. It has to trust Caddy's
root certificate once. Copy it out of the volume with
`docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .` and
install it on the device.

## How it works

```
TABLET (PWA)                                    SERVER (one Go binary + PostgreSQL 18)
React UI ⇄ IndexedDB (Dexie)                    POST /api/sync/push   validate → ledger + projections, flags
  menu versions, staff PIN verifiers            GET  /api/sync/pull   menu/staff/settings if changed,
  open orders, recent ledger, outbox                                  every tablet's last 2 days of documents
Sync engine: the only network client  ⇄ HTTPS   /api/*                back office (manager session, online)
Service worker: precached app shell             /                     the built PWA, same origin
```

Three decisions carry most of the design:

1. **The tablet is the register's database** ([0001](docs/decisions/0001-local-first-register.md)).
   The UI never waits on the network; a sync engine drains an outbox in the
   background.
2. **Tablets only create immutable documents** ([0002](docs/decisions/0002-immutable-documents.md)):
   a closed order, synced once; a refund, as a separate document. Nothing is
   edited after it syncs, so two tablets can't conflict.
3. **The server records facts and flags problems** ([0003](docs/decisions/0003-accept-facts-flag-anomalies.md)).
   It rejects only what it can't store. A refund made twice by two offline
   tablets really happened, so both are stored and the second is flagged for
   a manager.

Some details that matter:

- Money is integer cents. Tax is in parts per million, rounded once per order.
  Splits and refunds use largest-remainder allocation, so the pieces always add
  up ([0006](docs/decisions/0006-money-and-tax.md)).
- Pricing runs in TypeScript (offline) and Go (to check). Both are driven by
  the same test vectors in [testdata/vectors](testdata/vectors/)
  ([0007](docs/decisions/0007-pricing-in-two-languages.md)).
- An order keeps the menu version it started with, and the server re-prices it
  against exactly that version ([0004](docs/decisions/0004-versioned-menu-document.md)).
- The pull cursor can't skip a document, because ingest is serialized so
  sequence order equals commit order. There's a test that fails without that
  ([0012](docs/decisions/0012-ledger-cursor.md)).

## Repository layout

```
cmd/posd/            the server binary: serve | migrate | health
internal/
  money, pricing,    pure logic shared (in spirit) with web/src/domain
  bizdate, menu
  auth/              devices, enrollment, staff PINs, manager sessions
  ledger/            ingest: validation, flags, projections; the pull cursor
  syncapi/           /api/sync/push and /pull
  reports/           sales reports, close-out, flag review
  settings/, seed/   store settings; demo data (menu, staff, past sales)
  server/            every route in one place, plus the API tests
  db/                pool, embedded migrations, per-test databases
web/src/
  domain/            money, pricing, orders, splits, refunds, business dates, PINs
  db/                the IndexedDB schema and the local ledger
  sync/              the sync engine and the clock offset
  register/, orders/, office/, auth/, setup/, app/, ui/
web/e2e/             Playwright tests against the running stack
testdata/            vectors and documents both languages test against
docs/decisions/      architecture decision notes
```

## Development

You need Go 1.25+, Node 22+ and Docker (for Postgres).

```sh
make dev-server   # Go on :8080 with demo data, against the compose Postgres on :5433
                  #   (`make down` first: the Docker app also uses :8080)
make dev-web      # Vite on :5173, proxying /api to :8080
make test         # Go unit + integration tests and the web tests
make check        # go vet and the TypeScript compiler
make e2e          # Playwright against `make up` (first: cd web && npx playwright install chromium)
```

- Go integration tests run against real Postgres. Each test gets its own fresh
  database (`internal/db/dbtest`), and the tests skip themselves when
  `POS_TEST_DATABASE_URL` isn't set (`make test` sets it).
- `testdata/documents/order.json` and `refund.json` are written by the web
  tests and pushed by the Go tests, to keep the wire format honest. After an
  intended change to the format, regenerate them with
  `UPDATE_GOLDEN=1 npm test` (in `web/`).
- Set `POS_TEST_LOGS=1` to see request logs from the Go API tests.

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| `POS_ADDR` | `:8080` | listen address |
| `POS_WEB_DIR` | `web/dist` | the built PWA |
| `POS_DEMO` | off | `1` seeds a demo menu, staff and past sales into an empty database |
| `POS_DEMO_ENROLL_CODE` | off | a reusable enrollment code. Demos only: anyone who knows it can add a tablet |

## Running it for real

1. Turn off `POS_DEMO` and `POS_DEMO_ENROLL_CODE`.
2. On first start the server logs a one-time setup code. Open the app, choose
   "Set up your POS", and create the first manager with that code.
3. Add the other tablets from **Back office → Tablets → Add a tablet** (a
   one-time code that's valid for 15 minutes).
4. Serve it over HTTPS (the `lan` profile, or your own proxy), and back up the
   Postgres volume.

## Known weaknesses

These are in order of how much they'd worry me in a real shop.

- **Card payments aren't integrated.** "Card" records a payment the barista
  ran on a separate terminal. Nothing reconciles the two, and there are no
  tips.
- **PINs identify people; they don't protect anything.** Verifiers live on the
  tablet so sign-in and approvals work offline, and a 4-digit PIN can be
  brute-forced by anyone with the tablet and developer tools. The real
  controls are per-person reports of voids, reversals and refunds, and
  revoking lost tablets.
- **A tampered tablet can underprice consistently.** The server re-prices
  each order against the menu version it claims. An order that claims an old,
  cheaper (but genuine) version isn't flagged.
- **An open order lives on one tablet.** If a tablet dies mid-order, that
  order and any partial payment on it are gone from the record.
- **Browser storage can be evicted.** The app asks for persistent storage, but
  a tablet left offline long enough on a platform that ignores the request
  could lose orders it hasn't sent. The pending count is always visible, and
  only Chromium has been tested; real iPads and Android tablets haven't.
- **Re-enrolling a removed tablet strands its unsent documents.** They're
  kept, as refused, and can be downloaded, but nothing re-imports them.
- **Close-out assumes one drawer per tablet.** It has no paid-outs, cash
  drops, or denomination counting, and a close-out can't be reopened.
- **Narrow money model.** One store, one tax rate, tax added at checkout,
  two-decimal currencies only.
- **The back office needs an enrolled device**, so a manager can't check
  reports from their phone without making it a tablet.
- **Other gaps:** a refund goes to one payment at a time, order lookup only
  covers the last few days on the tablet, there's no dark mode, and the PIN
  lockout lives in memory (one server instance only).

## What I'd do next

1. Card-terminal integration (Stripe Terminal or Square) with tips, then email
   receipts and a cup-label printer or bar display.
2. Real hardware: iPad Safari and Android Chrome through the `lan` profile,
   kiosk/MDM setup, a soak test with tablets going on and offline.
3. Close the tampering gap: record which menu version each tablet has pulled,
   and flag orders priced with an older one afterwards. Add an audit log of
   back-office actions and rotate device tokens.
4. Counter features: an "86" (sold out) toggle from the register, discounts
   and comps (new pricing rules in both languages, plus vectors), cash drops
   and paid-outs.
5. Operations: backups with a restore drill, metrics and alerts (a tablet
   with unsent orders, unreviewed flags), a manager login that works without
   an enrolled device.
