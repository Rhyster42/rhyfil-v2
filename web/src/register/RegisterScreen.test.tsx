// Register flows through the real UI, including the tap budgets from
// docs/decisions/0018. A short undo window lets orders reach the outbox.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { engine } from '../app/services';
import { db } from '../db/db';
import type { OrderDoc } from '../domain/documents';
import { demoMenu, seedTablet, staffIds } from '../test/fixtures';
import { RegisterScreen } from './RegisterScreen';

beforeEach(() => {
  vi.spyOn(engine, 'syncNow').mockResolvedValue();
});

async function openRegister(undoWindowMs = 30) {
  await seedTablet(demoMenu());
  const user = userEvent.setup();
  let taps = 0;
  const view = render(<RegisterScreen staffId={staffIds.sam} options={{ undoWindowMs }} />);
  await screen.findByRole('button', { name: /^Latte/ });
  return {
    user,
    view,
    taps: () => taps,
    /** A tap the budget counts. */
    tap: async (name: string | RegExp) => {
      taps++;
      await user.click(screen.getByRole('button', { name }));
    },
  };
}

const orderPanel = () => screen.getByRole('region', { name: 'Order' });

async function sentOrders(n = 1): Promise<OrderDoc[]> {
  await waitFor(async () => expect(await db.outbox.count()).toBe(n));
  return (await db.outbox.toArray()).map((o) => o.doc as OrderDoc);
}

describe('tap budgets', () => {
  test('a medium latte by card is two taps', async () => {
    const r = await openRegister();
    await r.tap(/^Latte/);
    await r.tap(/^Card/);
    expect(r.taps()).toBe(2);
    const [order] = await sentOrders();
    expect(order).toMatchObject({ status: 'paid', number: 'A-001', total: 544, payments: [{ tender: 'card', amount: 544 }] });
    expect(order!.lines[0]!.mods.map((m) => m.optionName)).toEqual(['Medium', 'Hot', 'Whole']);
  });

  test('a large oat latte with an extra shot, paid with $10 cash, is five taps', async () => {
    const r = await openRegister();
    await r.tap(/^Latte/);
    await r.tap(/^Large/);
    await r.tap(/^Oat/);
    await r.tap(/^Extra shot/);
    await r.tap('$10');
    expect(r.taps()).toBe(5);
    expect(screen.getByRole('status')).toHaveTextContent('Change $2.27');
    const [order] = await sentOrders();
    expect(order).toMatchObject({ total: 773, payments: [{ tender: 'cash', amount: 773, tendered: 1000, change: 227 }] });
  });
});

describe('the register', () => {
  test('undo reopens the order; the record keeps the reversed payment', async () => {
    const r = await openRegister(60_000);
    await r.tap(/^Latte/);
    await r.tap(/^Card/);
    await r.tap('Undo');
    await r.tap(/^Exact/);
    // The next tap sends the closed order without waiting for the window.
    await r.tap(/^Cappuccino/);
    const [order] = await sentOrders();
    expect(order!.payments.map((p) => [p.tender, !!p.reversal])).toEqual([
      ['card', true],
      ['cash', false],
    ]);
    expect(screen.getByRole('heading', { name: 'Order A-002' })).toBeInTheDocument();
  });

  test('an open order survives a reload, and numbering continues', async () => {
    const r = await openRegister();
    await r.tap(/^Latte/);
    await r.tap(/^Card/);
    await sentOrders();
    await r.tap(/^Mocha/);
    await waitFor(async () => expect(await db.drafts.count()).toBe(1));
    r.view.unmount();

    render(<RegisterScreen staffId={staffIds.sam} />);
    expect(await screen.findByRole('heading', { name: 'Order A-002' })).toBeInTheDocument();
    expect(within(orderPanel()).getByRole('button', { name: /Mocha/ })).toBeInTheDocument();
  });

  test('an open order keeps its prices when a new menu arrives', async () => {
    const r = await openRegister();
    await r.tap(/^Latte/);
    const menu = demoMenu();
    menu.items.find((i) => i.id === 'latte')!.price = 999;
    await db.menus.put({ version: 2, doc: menu });
    await db.setMeta('menuVersion', 2);
    expect(await screen.findByRole('button', { name: /^Card \$5\.44/ })).toBeInTheDocument();
    await r.tap(/^Card/);
    await r.tap(/^Latte/);
    expect(await screen.findByRole('button', { name: /^Card \$11\.42/ })).toBeInTheDocument();
    const [order] = await sentOrders();
    expect(order!.menuVersion).toBe(1);
  });

  test('removing a line asks why and keeps it on the record', async () => {
    const r = await openRegister();
    await r.tap(/^Latte/);
    await r.tap(/^Mocha/);
    await r.tap('Remove');
    await r.tap('Made wrong');
    expect(within(orderPanel()).queryByRole('button', { name: /Mocha/ })).not.toBeInTheDocument();
    await r.tap(/^Card/);
    const [order] = await sentOrders();
    expect(order!.total).toBe(544);
    expect(order!.lines.map((l) => [l.itemName, l.void?.reason ?? null])).toEqual([
      ['Latte', null],
      ['Mocha', 'Made wrong'],
    ]);
  });

  test('voiding an order sends it as voided', async () => {
    const r = await openRegister();
    await r.tap(/^Latte/);
    await r.tap(/Split · custom/);
    await r.tap('Void order');
    await r.tap('Customer left');
    expect(screen.getByRole('status')).toHaveTextContent('Order voided');
    const [order] = await sentOrders();
    expect(order).toMatchObject({ status: 'voided', void: { reason: 'Customer left', by: staffIds.sam }, payments: [] });
  });

  test('an even three-way split takes three payments that add up to the total', async () => {
    const r = await openRegister();
    await r.tap(/^Latte/);
    await r.tap(/^Mocha/);
    await r.tap(/Split · custom/);
    await r.tap('3 ways');
    expect(screen.getByText('Split 3 ways · 1 of 3')).toBeInTheDocument();
    await r.tap(/^Card/);
    await r.tap(/^Exact/);
    // Lines are locked once a payment is taken.
    expect(screen.getByRole('button', { name: /^Cappuccino/ })).toBeDisabled();
    await r.tap(/^Card/);
    const [order] = await sentOrders();
    expect(order!.total).toBe(1143);
    expect(order!.payments.map((p) => [p.tender, p.amount])).toEqual([
      ['card', 381],
      ['cash', 381],
      ['card', 381],
    ]);
  });

  test('payment waits until required choices are made', async () => {
    const r = await openRegister();
    await r.user.click(screen.getByRole('tab', { name: 'Brewed & Tea' }));
    await r.tap(/^Hot Tea/);
    expect(screen.getByText('Finish the Hot Tea first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Card/ })).toBeDisabled();
    await r.tap(/^Mint/);
    expect(screen.getByRole('button', { name: /^Card/ })).toBeEnabled();
  });
});
