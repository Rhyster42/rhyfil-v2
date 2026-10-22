# 18. Register UX: defaults first, tenders on the order panel

Status: accepted · 2026-10-22

## Decision

- **Layout (landscape):** categories and item tiles on the left. On the right,
  the order lines, the modifier panel for the selected line, totals and tender
  buttons.
- **Defaults first:** tapping an item adds it with its default modifiers and
  selects it, so its groups are already on screen. Single-select groups are
  segmented controls; multi-select groups are chips with counts. The common
  path has no modals.
- **Tenders on the order panel:** Card, Exact cash and the next useful bills for
  the current total. There's no separate payment screen. "More" holds split,
  custom amount and void.
- **Instant reset:** after a close, the register is ready for the next customer
  immediately. The change due stays on screen with Undo until the next tap.
- **Tested tap budgets:** a medium latte by card is 2 taps; a large oat latte
  with an extra shot, paid with $10 cash, is 5 taps.

## Alternatives rejected

- **A payment screen.** One extra tap per order, hundreds of times a day.
- **Modifier dialogs.** Two extra taps (open and confirm) per customized drink.
