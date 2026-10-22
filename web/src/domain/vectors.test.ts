// Runs the shared vectors in testdata/vectors (also run by the Go tests).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { businessDate } from './businessDate';
import { checkSelections, indexMenu, type MenuDoc, type Selection } from './menu';
import { allocate, taxFor } from './money';
import { verifyPin } from './pin';
import { orderTotals, priceLine, taxShares } from './pricing';

const vectorDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../testdata/vectors');

function vectors<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(vectorDir, name), 'utf8')) as T;
}

const menu = indexMenu(vectors<MenuDoc>('menu.json'));

describe('money', () => {
  const v = vectors<{
    tax: { amount: number; ppm: number; expect: number; note?: string }[];
    allocate: { total: number; weights: number[]; expect: number[]; note?: string }[];
  }>('money.json');

  test.each(v.tax)('tax $amount at $ppm ppm = $expect', ({ amount, ppm, expect: want }) => {
    expect(taxFor(amount, ppm)).toBe(want);
  });

  test.each(v.allocate)('allocate $total over $weights', ({ total, weights, expect: want }) => {
    expect(allocate(total, weights)).toEqual(want);
  });
});

describe('pricing', () => {
  const v = vectors<{
    cases: {
      name: string;
      lines: { itemId: string; qty: number; voided: boolean; mods: Selection[] }[];
      expect: {
        lines: { unitPrice: number; lineTotal: number }[];
        subtotal: number;
        taxable: number;
        tax: number;
        total: number;
        taxShares: number[];
      };
    }[];
  }>('pricing.json');

  test.each(v.cases)('$name', ({ lines, expect: want }) => {
    const priced = lines.map((l) => priceLine(menu, l));
    expect(priced.map((p) => ({ unitPrice: p.unitPrice, lineTotal: p.lineTotal }))).toEqual(want.lines);
    const amounts = priced.map((p, i) => ({ lineTotal: p.lineTotal, taxable: p.taxable, voided: lines[i]!.voided }));
    const totals = orderTotals(amounts, menu.doc.taxRatePpm);
    expect(totals).toEqual({ subtotal: want.subtotal, taxable: want.taxable, tax: want.tax, total: want.total });
    expect(taxShares(amounts, totals.tax)).toEqual(want.taxShares);
  });
});

describe('selections', () => {
  const v = vectors<{ cases: { name: string; itemId: string; mods: Selection[]; expect: string[] }[] }>(
    'selections.json',
  );
  test.each(v.cases)('$name', ({ itemId, mods, expect: want }) => {
    expect(checkSelections(menu, itemId, mods)).toEqual(want);
  });
});

describe('business dates', () => {
  const v = vectors<{
    cases: { instant: string; timeZone: string; cutoffMinutes: number; expect: string; note?: string }[];
  }>('business-dates.json');
  test.each(v.cases)('$instant in $timeZone → $expect', ({ instant, timeZone, cutoffMinutes, expect: want }) => {
    expect(businessDate(instant, timeZone, cutoffMinutes)).toBe(want);
  });
});

describe('PIN verifiers', () => {
  const v = vectors<{ cases: { name: string; pin: string; verifier: string; valid: boolean }[] }>('pins.json');
  test.each(v.cases)('$name', async ({ pin, verifier, valid }) => {
    expect(await verifyPin(verifier, pin)).toBe(valid);
  });
});
