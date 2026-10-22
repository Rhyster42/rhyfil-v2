# 5. One modifier concept: groups with selection rules

Status: accepted · 2026-10-22

## Decision

Every customization is an option in a modifier group.

- A group has `min` and `max` counts of distinct options: Size 1–1, Milk 1–1,
  Extra shots 0–1, Syrups 0–3.
- An option has a price `delta` in cents (it may be negative), a `default`
  flag, and a `maxQty` (for example, up to 4 extra shots).
- Items list the groups that apply to them, in display order.

Unit price = item price + Σ(delta × qty), floored at zero. Default options are
pre-selected when an item is added, so the most common order is a single tap.
A required group without a default makes the line incomplete until the barista
picks something (use this for "Hot or iced?").

## Alternatives rejected

- **Square-style variations** (each size is a separate price on the item).
  Realistic for retail SKUs, but a second concept with its own UI path, and the
  brief describes size as a modifier.
- **Size-dependent modifier prices** (a syrup costs more in a large). Needs a
  price matrix per option per size; not worth it for v1.

## Consequences

- "How many large drinks" comes from the modifier report (option `size-l`), not
  from a variation report.
- Per-item default overrides (cold brew defaulting to no milk) aren't
  supported; give such items a different group.
