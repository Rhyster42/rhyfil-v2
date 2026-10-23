import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { OrderDoc, RefundDoc } from './documents';
import { sum } from './money';
import { buildRefund, customRefundTax, defaultPayment, lineRefund, refundState } from './refund';

const documents = resolve(dirname(fileURLToPath(import.meta.url)), '../../../testdata/documents');
// The golden order from contract.test.ts: latte (card, by item), 2 croissants,
// beans (untaxed) and a voided drip coffee (cash). Total $31.90, tax $1.30.
const order = JSON.parse(readFileSync(resolve(documents, 'order.json'), 'utf8')) as OrderDoc;
const [latte, croissants, beans] = order.lines;
const [card, cash] = order.payments;

function refund(lines: ReturnType<typeof lineRefund>[], payment = cash!, id = 'r1'): RefundDoc {
  return buildRefund({
    id,
    order,
    payment,
    lines,
    reason: 'Made wrong',
    staffId: 's',
    approvedBy: 'm',
    deviceId: 'd',
    at: '2026-10-22T16:00:00.000Z',
    businessDate: '2026-10-22',
  });
}

describe('refund state', () => {
  test('voided lines and reversed payments are not refundable', () => {
    const s = refundState(order, []);
    expect(s.lines.map((l) => l.line.itemName)).toEqual(['Latte', 'Croissant', 'Whole Beans 12oz']);
    expect(s.payments.map((p) => [p.payment.tender, p.remaining])).toEqual([
      ['card', 773],
      ['cash', 2417],
    ]);
    expect(s.remaining).toBe(order.total);
  });

  test('refunding every unit returns exactly what was paid', () => {
    const s = refundState(order, []);
    const all = s.lines.map((l) => lineRefund(l, l.remainingQty));
    expect(sum(all.map((l) => l.amount))).toBe(order.total);
    expect(sum(all.map((l) => l.tax))).toBe(order.tax);
    expect(all.find((l) => l.lineId === beans!.id)?.tax).toBe(0); // untaxed
  });

  test('refunding a line one unit at a time adds up to the whole line', () => {
    const one = lineRefund(refundState(order, []).lines[1]!, 1);
    const r1 = refund([one]);
    const two = lineRefund(refundState(order, [r1]).lines[1]!, 1);
    const whole = lineRefund(refundState(order, []).lines[1]!, 2);
    expect(one.amount + two.amount).toBe(whole.amount);
    expect(one.tax + two.tax).toBe(whole.tax);
    expect(refundState(order, [r1, refund([two], cash, 'r2')]).lines[1]!.remainingQty).toBe(0);
  });

  test('refunds reduce what is left on their payment', () => {
    const r = refund([lineRefund(refundState(order, []).lines[0]!, 1)], card!);
    const s = refundState(order, [r]);
    expect(s.payments[0]).toMatchObject({ refunded: 773, remaining: 0 });
    expect(s.remaining).toBe(order.total - 773);
  });

  test('the default payment is the one that paid for the items', () => {
    const s = refundState(order, []);
    expect(defaultPayment(s, [latte!.id])?.payment.id).toBe(card!.id);
    expect(defaultPayment(s, [croissants!.id])?.payment.id).toBe(cash!.id); // most left
  });

  test('a custom amount carries a proportional share of tax', () => {
    expect(customRefundTax(order, 500)).toBe(20); // 500 × 130/3190 = 20.4
    const r = buildRefund({ ...{ id: 'r', order, payment: cash!, lines: [], amount: 500 }, reason: 'Goodwill', staffId: 's', approvedBy: 'm', deviceId: 'd', at: 'x', businessDate: 'y' });
    expect(r).toMatchObject({ amount: 500, tax: 20, lines: [] });
  });
});

// The wire contract: refunding one croissant from the golden order, in cash.
// The Go tests push testdata/documents/refund.json after order.json and
// expect no flags. UPDATE_GOLDEN=1 rewrites it.
test('a refund matches the server contract', () => {
  const s = refundState(order, []);
  const doc = buildRefund({
    id: '0190f0d6-0000-7000-8000-00000000e001',
    order,
    payment: cash!,
    lines: [lineRefund(s.lines[1]!, 1)],
    reason: 'Dropped on the floor',
    staffId: '0190f0d6-0000-7000-8000-00000000c001',
    approvedBy: '0190f0d6-0000-7000-8000-00000000c002',
    deviceId: order.deviceId,
    at: '2026-10-22T14:50:00.000Z',
    businessDate: '2026-10-22',
  });
  // The croissants' tax share is 67¢ (largest remainder), so the first unit carries 34¢.
  expect(doc).toMatchObject({ tender: 'cash', amount: 409, tax: 34 });
  const golden = resolve(documents, 'refund.json');
  const json = `${JSON.stringify(doc, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN || !existsSync(golden)) writeFileSync(golden, json);
  expect(json).toBe(readFileSync(golden, 'utf8'));
});
