import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { Route } from '../app/route';
import { engine } from '../app/services';
import { db } from '../db/db';
import { businessDate } from '../domain/businessDate';
import type { OrderDoc, RefundDoc } from '../domain/documents';
import { seedTablet, staffIds, testSettings } from '../test/fixtures';
import { OrdersScreen } from './OrdersScreen';

const golden = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../testdata/documents/order.json'), 'utf8'),
) as OrderDoc;

beforeEach(() => {
  vi.spyOn(engine, 'syncNow').mockResolvedValue();
});

/** The golden order (latte by card; croissants, beans, a voided drip by cash), rung today by Sam. */
async function seedOrders() {
  await seedTablet();
  const today = businessDate(new Date(), testSettings.timezone, testSettings.dayCutoffMinutes);
  // The golden order was rung by the contract's Sam; make it this tablet's Sam.
  const order = JSON.parse(JSON.stringify(golden).replaceAll(golden.staffId, staffIds.sam)) as OrderDoc;
  order.businessDate = today;
  const other: OrderDoc = { ...golden, id: 'other', number: 'A-008', businessDate: today, lines: [golden.lines[2]!], total: 1600 };
  await db.orders.bulkPut([
    { ...order, seq: 4 },
    { ...other, seq: null },
  ]);
  return order;
}

function Harness({ initial }: { initial?: string }) {
  const [orderId, setOrderId] = useState(initial);
  const navigate = (r: Route) => r.screen === 'orders' && setOrderId(r.orderId);
  return <OrdersScreen staffId={staffIds.sam} orderId={orderId} navigate={navigate} />;
}

test("lists today's orders and finds them by number", async () => {
  await seedOrders();
  const user = userEvent.setup();
  render(<Harness />);
  const list = await screen.findByRole('region', { name: 'Orders' });
  expect(within(list).getByRole('button', { name: /A-007/ })).toBeInTheDocument();
  expect(within(list).getByRole('button', { name: /A-008/ })).toHaveTextContent('Not sent');
  await user.type(screen.getByLabelText('Search orders'), '008');
  expect(within(list).queryByRole('button', { name: /A-007/ })).not.toBeInTheDocument();
});

test('shows what happened, including voids', async () => {
  const order = await seedOrders();
  render(<Harness initial={order.id} />);
  const detail = await screen.findByRole('article', { name: 'Order A-007' });
  expect(detail).toHaveTextContent('Removed by Sam: Rang in error');
  expect(detail).toHaveTextContent('Large · Oat · Extra shot');
  expect(detail).toHaveTextContent('gave $50.00, change $25.83');
});

test('a manager approves a refund of one croissant, in cash', async () => {
  const order = await seedOrders();
  const user = userEvent.setup();
  render(<Harness initial={order.id} />);
  await user.click(await screen.findByRole('button', { name: 'Refund…' }));
  await user.click(screen.getByRole('button', { name: 'One more Croissant' }));
  await user.click(screen.getByRole('button', { name: 'Made wrong' }));
  expect(screen.getByText(/Refund/, { selector: '.refund-summary' })).toHaveTextContent('Refund $4.09 (incl. $0.34 tax) to cash');

  await user.click(screen.getByRole('button', { name: 'Manager approval' }));
  // Sam is a barista: Sam's PIN doesn't approve.
  for (const d of '1111') await user.click(screen.getByRole('button', { name: d }));
  await user.click(screen.getByRole('button', { name: 'OK' }));
  expect(await screen.findByText('Wrong PIN')).toBeInTheDocument();
  for (const d of '1234') await user.click(screen.getByRole('button', { name: d }));

  expect(await screen.findByText(/Give back/)).toHaveTextContent('Give back $4.09 in cash.');
  const [refund] = (await db.refunds.toArray()) as RefundDoc[];
  expect(refund).toMatchObject({ orderId: order.id, paymentId: order.payments[1]!.id, amount: 409, tax: 34, approvedBy: staffIds.morgan, staffId: staffIds.sam, reason: 'Made wrong' });
  expect((await db.outbox.toArray()).map((o) => o.kind)).toEqual(['refund']);

  await user.click(screen.getByRole('button', { name: 'Done' }));
  const list = screen.getByRole('region', { name: 'Orders' });
  await waitFor(() => expect(within(list).getByRole('button', { name: /A-007/ })).toHaveTextContent('Part refunded'));
});

test('a refund can only take what is left on the payment', async () => {
  const order = await seedOrders();
  const user = userEvent.setup();
  render(<Harness initial={order.id} />);
  await user.click(await screen.findByRole('button', { name: 'Refund…' }));
  // Everything left is more than either payment holds. The card paid for the
  // latte, so it's the suggested payment.
  await user.click(screen.getByRole('button', { name: 'Everything left' }));
  await user.click(screen.getByRole('button', { name: 'Customer unhappy' }));
  expect(screen.getByText(/more than the \$7\.73 left on this card payment/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Manager approval' })).toBeDisabled();
});
