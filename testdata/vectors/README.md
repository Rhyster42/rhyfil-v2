# Shared test vectors

Both test suites read these files: the Go tests (`internal/money`, `menu`,
`pricing`, `bizdate`, `auth`) and the web tests (`web/src/domain`). If a rule
changes in one language but not the other, a test fails
(docs/decisions/0007).

| File | Checks |
|---|---|
| `menu.json` | the menu every pricing and selection case uses |
| `money.json` | tax rounding and largest-remainder allocation |
| `pricing.json` | unit prices, line totals, order totals and per-line tax shares |
| `selections.json` | modifier selection rules (problem codes, sorted) |
| `business-dates.json` | business-day assignment, including DST changes |
| `pins.json` | PBKDF2 PIN verifiers (generated independently with Go's crypto/pbkdf2) |

Expected values were worked out by hand, not copied from either
implementation.
