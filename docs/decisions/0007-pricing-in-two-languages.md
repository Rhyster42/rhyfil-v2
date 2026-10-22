# 7. Pricing in Go and TypeScript, locked together by shared vectors

Status: accepted · 2026-10-22

## Context

The tablet must price orders offline, and the server must verify them. That
means two implementations of the same rules.

## Decision

Keep the duplicated logic small and pure, and drive both test suites from the
same JSON files in `testdata/vectors/`:

| Concern | Go | TypeScript |
|---|---|---|
| Rounding and allocation | `internal/money` | `web/src/domain/money.ts` |
| Line and order pricing | `internal/pricing` | `web/src/domain/pricing.ts` |
| Business dates | `internal/bizdate` | `web/src/domain/businessDate.ts` |
| PIN verifiers | `internal/auth/pin.go` | `web/src/domain/pin.ts` |

A change to these rules that isn't made in both languages fails a test.

## Alternatives rejected

- **Pricing only on the server.** Breaks offline.
- **Compiling Go to WebAssembly for the browser.** Megabytes of runtime for a
  few functions, and awkward debugging.
- **Generating one implementation from the other.** No mature tool, and the
  code is small.

## Consequences

- Any new pricing rule (discounts, size-dependent prices) needs code in both
  languages plus new vectors.
