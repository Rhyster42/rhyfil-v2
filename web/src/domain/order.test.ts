import { describe, expect, test } from 'vitest';
import { vectorMenu } from '../test/fixtures';
import { indexMenu } from './menu';
import { sum } from './money';
import {
  addItem,
  addPayment,
  captured,
  closeNoCharge,
  duplicateLine,
  isEditable,
  newDraft,
  priceDraft,
  reversePayment,
  selectLine,
  setLineQty,
  stepOption,
  toggleOption,
  toOrderDoc,
  undoClose,
  voidLine,
  voidOrder,
  type Draft,
} from './order';
import { amountForLines, cardPayment, cashPayment, cashSuggestions, evenSplit, unclaimedLineIds } from './tender';

const ix = indexMenu(vectorMenu());
const T = '2026-10-22T15:00:00.000Z';
const who = (reason: string) => ({ at: T, by: 'sam', reason });

function draft(): Draft {
  return newDraft({ id: 'o1', number: 'A-001', businessDate: '2026-10-22', deviceId: 'dev', staffId: 'sam', menuVersion: 1, createdAt: T });
}

const mods = (d: Draft, lineId: string) => d.lines.find((l) => l.id === lineId)!.mods.map((m) => (m.qty > 1 ? `${m.optionId}×${m.qty}` : m.optionId));

describe('building an order', () => {
  test('an item arrives with its default modifiers, selected', () => {
    const d = addItem(draft(), ix, 'latte', 'l1', T);
    expect(mods(d, 'l1')).toEqual(['size-m', 'milk-whole']);
    expect(d.selectedLineId).toBe('l1');
    expect(priceDraft(d, ix)).toMatchObject({ totals: { total: 544 }, ready: true });
  });

  test('pick-one groups replace; required ones cannot be emptied, optional ones can', () => {
    let d = addItem(draft(), ix, 'latte', 'l1', T);
    d = toggleOption(d, ix, 'l1', 'size-l');
    d = toggleOption(d, ix, 'l1', 'milk-oat');
    expect(mods(d, 'l1')).toEqual(['size-l', 'milk-oat']);
    expect(toggleOption(d, ix, 'l1', 'size-l')).toBe(d); // required: tapping the choice again does nothing

    d = addItem(d, ix, 'americano', 'l2', T);
    d = toggleOption(d, ix, 'l2', 'comp-full');
    expect(mods(d, 'l2')).toContain('comp-full');
    d = toggleOption(d, ix, 'l2', 'comp-full');
    expect(mods(d, 'l2')).not.toContain('comp-full');
  });

  test('pick-several groups toggle up to their maximum', () => {
    let d = addItem(draft(), ix, 'latte', 'l1', T);
    for (const s of ['syrup-mocha', 'syrup-vanilla', 'syrup-caramel', 'syrup-hazelnut']) d = toggleOption(d, ix, 'l1', s);
    // Max 3; listed in menu order regardless of tap order.
    expect(mods(d, 'l1')).toEqual(['size-m', 'milk-whole', 'syrup-vanilla', 'syrup-caramel', 'syrup-mocha']);
    d = toggleOption(d, ix, 'l1', 'syrup-vanilla');
    expect(mods(d, 'l1')).toEqual(['size-m', 'milk-whole', 'syrup-caramel', 'syrup-mocha']);
  });

  test('steppers count up to maxQty and back to nothing', () => {
    let d = addItem(draft(), ix, 'latte', 'l1', T);
    for (let i = 0; i < 6; i++) d = stepOption(d, ix, 'l1', 'shot-extra', 1);
    expect(mods(d, 'l1')).toEqual(['size-m', 'milk-whole', 'shot-extra×4']);
    for (let i = 0; i < 4; i++) d = stepOption(d, ix, 'l1', 'shot-extra', -1);
    expect(mods(d, 'l1')).toEqual(['size-m', 'milk-whole']);
  });

  test('quantity, duplicate and void', () => {
    let d = addItem(draft(), ix, 'croissant', 'l1', T);
    d = setLineQty(d, 'l1', 3);
    d = setLineQty(d, 'l1', 500);
    expect(d.lines[0]!.qty).toBe(99);
    d = setLineQty(d, 'l1', 1);

    d = addItem(d, ix, 'latte', 'l2', T);
    d = toggleOption(d, ix, 'l2', 'milk-oat');
    d = duplicateLine(d, 'l2', 'l3', T);
    expect(mods(d, 'l3')).toEqual(mods(d, 'l2'));
    expect(d.selectedLineId).toBe('l3');

    d = voidLine(d, 'l3', who('Rang in error'));
    expect(d.selectedLineId).toBe('l2');
    expect(d.lines).toHaveLength(3); // voided lines stay in the order
    expect(priceDraft(d, ix).lines.map((l) => l.id)).toEqual(['l1', 'l2']);
    expect(() => toggleOption(d, ix, 'l3', 'size-l')).toThrow();
  });

  test('a required group without a default makes the line incomplete', () => {
    // Every vector-menu group with min 1 has a default, so remove one.
    let d = addItem(draft(), ix, 'drip', 'l1', T);
    d = { ...d, lines: d.lines.map((l) => ({ ...l, mods: [] })) };
    const p = priceDraft(d, ix);
    expect(p.ready).toBe(false);
    expect(p.lines[0]!.problems).toEqual(['min:size']);
    expect(() => addPayment(d, p, cardPayment({ id: 'p', amount: p.remaining, staffId: 'sam', at: T }))).toThrow('incomplete');
  });
});

describe('paying', () => {
  function largeOatLatte() {
    let d = addItem(draft(), ix, 'latte', 'l1', T);
    d = toggleOption(d, ix, 'l1', 'size-l');
    d = toggleOption(d, ix, 'l1', 'milk-oat');
    return stepOption(d, ix, 'l1', 'shot-extra', 1);
  }

  test('cash with change closes the order', () => {
    const d = largeOatLatte();
    const p = priceDraft(d, ix);
    expect(p.totals).toEqual({ subtotal: 710, taxable: 710, tax: 63, total: 773 });
    const closed = addPayment(d, p, cashPayment({ id: 'p1', due: p.remaining, tendered: 1000, staffId: 'sam', at: T }));
    expect(closed.closedAt).toBe(T);
    expect(closed.payments[0]).toMatchObject({ tender: 'cash', amount: 773, tendered: 1000, change: 227 });
  });

  test('a partial payment locks the lines; reversing it unlocks them', () => {
    let d = largeOatLatte();
    d = addPayment(d, priceDraft(d, ix), cardPayment({ id: 'p1', amount: 300, staffId: 'sam', at: T }));
    expect(d.closedAt).toBeNull();
    expect(isEditable(d)).toBe(false);
    expect(priceDraft(d, ix)).toMatchObject({ paid: 300, remaining: 473 });
    expect(() => addItem(d, ix, 'croissant', 'l2', T)).toThrow('payments');
    expect(() => voidOrder(d, who('x'))).toThrow('reverse');
    expect(() => addPayment(d, priceDraft(d, ix), cardPayment({ id: 'p2', amount: 474, staffId: 'sam', at: T }))).toThrow();

    d = reversePayment(d, 'p1', who('Split fell through'));
    expect(isEditable(d)).toBe(true);
    expect(d.payments[0]!.reversal?.reason).toBe('Split fell through');
    expect(priceDraft(d, ix).remaining).toBe(773);
  });

  test('undo reopens a closed order by reversing the closing payment', () => {
    let d = largeOatLatte();
    d = addPayment(d, priceDraft(d, ix), cardPayment({ id: 'p1', amount: 773, staffId: 'sam', at: T }));
    d = undoClose(d, who('Undo'));
    expect(d.closedAt).toBeNull();
    expect(captured(d)).toHaveLength(0);
    d = addPayment(d, priceDraft(d, ix), cashPayment({ id: 'p2', due: 773, tendered: 773, staffId: 'sam', at: T }));
    const doc = toOrderDoc(d, ix);
    expect(doc.payments.map((p) => [p.tender, p.amount, !!p.reversal])).toEqual([
      ['card', 773, true],
      ['cash', 773, false],
    ]);
  });

  test('voiding an unpaid order, and undoing the void', () => {
    let d = largeOatLatte();
    d = voidOrder(d, who('Customer left'));
    expect(d.closedAt).toBe(T);
    expect(toOrderDoc(d, ix)).toMatchObject({ status: 'voided', void: { reason: 'Customer left' }, total: 773 });
    d = undoClose(d, who('Undo'));
    expect(d).toMatchObject({ closedAt: null, void: null });
  });

  test('a zero-total order closes without payment', () => {
    let d = addItem(draft(), ix, 'americano', 'l1', T);
    d = toggleOption(d, ix, 'l1', 'comp-full');
    const p = priceDraft(d, ix);
    expect(p.totals.total).toBe(0);
    expect(toOrderDoc(closeNoCharge(d, p, T), ix)).toMatchObject({ status: 'paid', total: 0, payments: [] });
  });
});

describe('the closed document', () => {
  test('snapshots names and prices and keeps voided lines', () => {
    let d = addItem(draft(), ix, 'latte', 'l1', T);
    d = toggleOption(d, ix, 'l1', 'milk-oat');
    d = addItem(d, ix, 'beans', 'l2', T);
    d = addItem(d, ix, 'croissant', 'l3', T);
    d = voidLine(d, 'l3', who('Changed mind'));
    const p = priceDraft(d, ix);
    d = addPayment(d, p, cardPayment({ id: 'p1', amount: p.remaining, staffId: 'sam', at: T }));
    const doc = toOrderDoc(d, ix);
    expect(doc).toMatchObject({ v: 1, status: 'paid', menuVersion: 1, number: 'A-001', subtotal: 570 + 1600, tax: 51, total: 2221 });
    expect(doc.lines[0]).toMatchObject({ itemName: 'Latte', category: 'Espresso', unitPrice: 570, taxable: true });
    expect(doc.lines[0]!.mods.map((m) => `${m.groupName}: ${m.optionName}`)).toEqual(['Size: Medium', 'Milk: Oat']);
    expect(doc.lines[1]).toMatchObject({ itemName: 'Whole Beans 12oz', taxable: false });
    expect(doc.lines[2]).toMatchObject({ itemName: 'Croissant', void: { reason: 'Changed mind' } });
    expect(() => toOrderDoc(selectLine(draft(), null), ix)).toThrow('still open');
  });
});

describe('split checks', () => {
  test('even splits and by-item amounts always add up to the total', () => {
    let seed = 7;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    const items = ['latte', 'americano', 'drip', 'croissant', 'beans'];
    for (let k = 0; k < 300; k++) {
      let d = draft();
      const n = 1 + rand(6);
      for (let i = 0; i < n; i++) {
        d = addItem(d, ix, items[rand(items.length)]!, `l${i}`, T);
        if (rand(2)) d = setLineQty(d, `l${i}`, 1 + rand(3));
      }
      const p = priceDraft(d, ix);
      if (p.totals.total === 0) continue;
      expect(sum(evenSplit(p.remaining, 1 + rand(5)))).toBe(p.totals.total);

      // Pay one line at a time; the last payment closes the order exactly.
      let cur = d;
      for (const id of p.lines.map((l) => l.id)) {
        const pp = priceDraft(cur, ix);
        const amount = amountForLines(pp, [id]);
        if (amount === 0) continue;
        cur = addPayment(cur, pp, cardPayment({ id: `p-${id}`, amount, staffId: 'sam', at: T, coversLineIds: [id] }));
      }
      expect(cur.closedAt, `order ${k}`).toBe(T);
      expect(unclaimedLineIds(cur, priceDraft(cur, ix))).toEqual([]);
    }
  });

  test('cash suggestions', () => {
    expect(cashSuggestions(773)).toEqual([800, 1000, 2000]);
    expect(cashSuggestions(544)).toEqual([600, 1000, 2000]);
    // A round total: "Exact" covers it, so the next bills up.
    expect(cashSuggestions(500)).toEqual([1000, 2000, 5000]);
    expect(cashSuggestions(1999)).toEqual([2000, 5000, 10000]);
    expect(cashSuggestions(4580)).toEqual([4600, 5000, 6000]);
  });
});
