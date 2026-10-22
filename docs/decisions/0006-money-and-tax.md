# 6. Integer cents; tax in parts per million, rounded once per order

Status: accepted · 2026-10-22

## Decision

- All amounts are integer cents: `int64` in Go, `bigint` in Postgres, and
  integer `number` in TypeScript (exact below 2^53).
- The tax rate is stored in parts per million (8.875% = 88,750), so rates like
  New York City's are exact.
- Tax = round-half-up(taxable subtotal × rate ÷ 1,000,000), computed once per
  order, not per line.
- When an amount must be divided (an even split, or giving each line its
  share of tax for split-by-item and refunds), we use largest-remainder
  allocation, with ties going to the earliest part. The pieces always add up
  exactly to the whole.

## Alternatives rejected

- **Floating point.** Wrong for money.
- **Decimal libraries.** No exact counterpart in the browser without another
  dependency; integer cents are simpler and faster.
- **Rounding tax per line.** The sum of rounded lines drifts from the
  order-level tax.

## Consequences

- One currency whose minor unit is 1/100 (fine for USD, EUR and GBP; JPY would
  need a scale field).
- Tax-inclusive pricing, common outside the US, isn't supported yet.
