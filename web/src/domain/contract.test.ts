// The wire contract with the server: this test builds an order through the
// real domain functions and compares it with testdata/documents/order.json,
// which the Go tests push and expect to be stored without flags. Run with
// UPDATE_GOLDEN=1 to rewrite the file after an intended change.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { vectorMenu } from '../test/fixtures';
import { indexMenu } from './menu';
import * as order from './order';
import { amountForLines, cardPayment, cashPayment } from './tender';

export const contractIds = {
  device: '0190f0d6-0000-7000-8000-00000000d001',
  sam: '0190f0d6-0000-7000-8000-00000000c001',
  order: '0190f0d6-0000-7000-8000-00000000a001',
};

const golden = resolve(dirname(fileURLToPath(import.meta.url)), '../../../testdata/documents/order.json');

test('a closed order matches the server contract', () => {
  const ix = indexMenu(vectorMenu());
  const at = (min: number) => new Date(Date.UTC(2026, 9, 22, 14, 30 + min)).toISOString();
  const id = (n: number) => `0190f0d6-0000-7000-8000-00000000b00${n}`;
  const who = { at: at(1), by: contractIds.sam, reason: 'Rang in error' };

  let d = order.newDraft({
    id: contractIds.order,
    number: 'A-007',
    businessDate: '2026-10-22',
    deviceId: contractIds.device,
    staffId: contractIds.sam,
    menuVersion: 1,
    createdAt: at(0),
  });
  d = order.addItem(d, ix, 'latte', id(1), at(0));
  d = order.toggleOption(d, ix, id(1), 'size-l');
  d = order.toggleOption(d, ix, id(1), 'milk-oat');
  d = order.stepOption(d, ix, id(1), 'shot-extra', 1);
  d = order.addItem(d, ix, 'croissant', id(2), at(0));
  d = order.setLineQty(d, id(2), 2);
  d = order.addItem(d, ix, 'beans', id(3), at(1));
  d = order.addItem(d, ix, 'drip', id(4), at(1));
  d = order.voidLine(d, id(4), who);

  // Split by item: the latte by card, the rest in cash with change.
  let p = order.priceDraft(d, ix);
  d = order.addPayment(d, p, cardPayment({ id: id(5), amount: amountForLines(p, [id(1)]), staffId: contractIds.sam, at: at(2), coversLineIds: [id(1)] }));
  p = order.priceDraft(d, ix);
  d = order.addPayment(d, p, cashPayment({ id: id(6), due: p.remaining, tendered: 5000, staffId: contractIds.sam, at: at(3) }));

  const doc = order.toOrderDoc(d, ix);
  expect(doc).toMatchObject({ status: 'paid', subtotal: 3060, tax: 130, total: 3190 });

  const json = `${JSON.stringify(doc, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN || !existsSync(golden)) {
    mkdirSync(dirname(golden), { recursive: true });
    writeFileSync(golden, json);
  }
  expect(json).toBe(readFileSync(golden, 'utf8'));
});
