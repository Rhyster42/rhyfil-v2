// Line and order pricing. Mirrors internal/pricing; both are tested against
// testdata/vectors/pricing.json (docs/decisions/0007).
import type { MenuIndex, Selection } from './menu';
import { allocate, taxFor } from './money';

export interface PricedMod {
  optionId: string;
  groupId: string;
  groupName: string;
  optionName: string;
  qty: number;
  delta: number;
}

export interface PricedLine {
  itemId: string;
  itemName: string;
  category: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  taxable: boolean;
  mods: PricedMod[];
}

/**
 * Prices one line: item price + Σ(delta × qty), floored at zero. Throws only
 * for an unknown item or option; selection rules are checkSelections' job.
 */
export function priceLine(ix: MenuIndex, line: { itemId: string; qty: number; mods: readonly Selection[] }): PricedLine {
  const item = ix.items.get(line.itemId);
  if (!item) throw new Error(`unknown item "${line.itemId}"`);
  if (line.qty < 1) throw new Error(`item "${line.itemId}": quantity must be at least 1`);
  let unit = item.price;
  const mods = line.mods.map((sel): PricedMod => {
    const ref = ix.options.get(sel.optionId);
    if (!ref) throw new Error(`unknown option "${sel.optionId}"`);
    unit += ref.option.delta * sel.qty;
    return {
      optionId: ref.option.id,
      groupId: ref.group.id,
      groupName: ref.group.name,
      optionName: ref.option.name,
      qty: sel.qty,
      delta: ref.option.delta,
    };
  });
  unit = Math.max(unit, 0);
  return {
    itemId: item.id,
    itemName: item.name,
    category: ix.categories.get(item.categoryId)?.name ?? '',
    qty: line.qty,
    unitPrice: unit,
    lineTotal: unit * line.qty,
    taxable: item.taxable,
    mods,
  };
}

/** The part of a line that order totals depend on. */
export interface Amount {
  lineTotal: number;
  taxable: boolean;
  voided: boolean;
}

export interface Totals {
  subtotal: number;
  taxable: number;
  tax: number;
  total: number;
}

/** Adds up non-voided lines and computes tax once for the order. */
export function orderTotals(lines: readonly Amount[], taxRatePpm: number): Totals {
  let subtotal = 0;
  let taxable = 0;
  for (const l of lines) {
    if (l.voided) continue;
    subtotal += l.lineTotal;
    if (l.taxable) taxable += l.lineTotal;
  }
  const tax = taxFor(taxable, taxRatePpm);
  return { subtotal, taxable, tax, total: subtotal + tax };
}

/** Divides the order's tax among lines by taxable total (see internal/pricing). */
export function taxShares(lines: readonly Amount[], tax: number): number[] {
  return allocate(
    tax,
    lines.map((l) => (l.taxable && !l.voided ? l.lineTotal : 0)),
  );
}
