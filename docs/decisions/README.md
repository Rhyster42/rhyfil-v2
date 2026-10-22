# Architecture decisions

One short note per significant choice: the context, what was chosen, what was
rejected and why, and the consequences accepted. When building teaches us
something, the note gets a dated **Revised** line rather than a silent edit.

| # | Decision |
|---|---|
| [0001](0001-local-first-register.md) | The tablet's IndexedDB is the register's database |
| [0002](0002-immutable-documents.md) | Tablets sync immutable documents: closed orders and refunds |
| [0003](0003-accept-facts-flag-anomalies.md) | The server records facts and flags anomalies |
| [0004](0004-versioned-menu-document.md) | The menu is a versioned JSON document |
| [0005](0005-uniform-modifier-groups.md) | One modifier concept: groups with selection rules |
| [0006](0006-money-and-tax.md) | Integer cents; tax in parts per million, rounded once per order |
| [0007](0007-pricing-in-two-languages.md) | Pricing in Go and TypeScript, locked together by shared vectors |
| [0008](0008-split-checks-as-tenders.md) | A split check is several tenders on one order |
| [0009](0009-voids-reversals-refunds.md) | Voids, payment reversals and refunds |
| [0010](0010-devices-and-pins.md) | Enrolled devices and staff PINs |
| [0011](0011-order-numbers.md) | Order numbers: device letter plus a daily counter |
| [0012](0012-ledger-cursor.md) | Pull cursor: a sequence with serialized ingest |
| [0013](0013-time-and-business-dates.md) | Time and business dates |
| [0014](0014-backend-stack.md) | Backend: Go standard library, pgx, hand-written SQL |
| [0015](0015-frontend-stack.md) | Frontend: React, TypeScript, Vite, Dexie |
| [0016](0016-deployment.md) | One container serves the API and the PWA |
| [0017](0017-reports-and-closeout.md) | Reports are computed live; close-out stores a snapshot |
| [0018](0018-register-ux.md) | Register UX: defaults first, tenders on the order panel |
| [0019](0019-testing.md) | Testing strategy |
