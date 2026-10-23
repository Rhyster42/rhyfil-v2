import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { engine } from '../app/services';
import { db } from '../db/db';
import type { MenuDoc } from '../domain/menu';
import { fakeServer, offline, seedTablet, staffIds, vectorMenu } from '../test/fixtures';
import { CloseoutTab } from './CloseoutTab';
import { FlagsTab } from './FlagsTab';
import { ManagerGate } from './ManagerGate';
import { MenuTab } from './MenuTab';
import { ReportsTab } from './ReportsTab';
import { StaffTab } from './StaffTab';
import type { CloseoutStatus, FlagView, Report } from './types';

beforeEach(async () => {
  vi.spyOn(engine, 'syncNow').mockResolvedValue();
  await seedTablet();
});

async function signedInManager() {
  await db.setMeta('managerSession', { token: 'office', staffId: staffIds.morgan, expiresAt: '2099-01-01T00:00:00Z' });
}

function report(patch: Partial<Report> = {}): Report {
  return {
    from: '2026-10-22',
    to: '2026-10-22',
    timezone: 'America/New_York',
    summary: {
      orders: 2, grossSales: 6120, tax: 260, refunds: 409, refundCount: 1, refundedTax: 34, netSales: 5745,
      netTax: 226, collected: 5971, averageTicket: 3190, voidedOrders: 1, voidedLines: 3, reversals: 1, openFlags: 2,
    },
    tenders: [
      { tender: 'card', payments: 2, taken: 1546, refundCount: 0, refunded: 0, net: 1546 },
      { tender: 'cash', payments: 2, taken: 4834, refundCount: 1, refunded: 409, net: 4425 },
    ],
    items: [{ itemId: 'latte', name: 'Latte', category: 'Espresso', qty: 2, gross: 1420, refundedQty: 0, refunded: 0, net: 1420 }],
    categories: [{ category: 'Espresso', qty: 2, gross: 1420, refunded: 0, net: 1420 }],
    modifiers: [{ optionId: 'milk-oat', group: 'Milk', option: 'Oat', count: 2, revenue: 140 }],
    hours: [
      { hour: 8, orders: 1, gross: 3060 },
      { hour: 10, orders: 1, gross: 3060 },
    ],
    staff: [],
    exceptions: { lineVoids: [{ reason: 'Rang in error', count: 3, amount: 975 }], orderVoids: [], reversals: [], refunds: [] },
    drawers: [{ deviceId: 'dev-a', name: 'Front', code: 'A', cashIn: 4834, cashOut: 409 }],
    ...patch,
  };
}

describe('manager gate', () => {
  test('sends the PIN only on OK, and explains failures', async () => {
    let attempts = 0;
    const { requests } = fakeServer({
      'POST /api/sessions': ({ body }) => {
        attempts++;
        return (body as { pin: string }).pin === '123456'
          ? { status: 201, body: { token: 'office', expiresAt: '2099-01-01T00:00:00Z', staff: {} } }
          : { status: 401, body: { code: 'wrong_pin', message: 'wrong PIN' } };
      },
    });
    const user = userEvent.setup();
    render(
      <ManagerGate staffId={staffIds.morgan}>
        <p>The back office</p>
      </ManagerGate>,
    );
    for (const d of '1234') await user.click(await screen.findByRole('button', { name: d }));
    expect(attempts).toBe(0); // no silent guesses against the server's lockout
    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong PIN');
    for (const d of '123456') await user.click(screen.getByRole('button', { name: d }));
    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByText('The back office')).toBeInTheDocument();
    expect(requests.map((r) => (r.body as { pin: string }).pin)).toEqual(['1234', '123456']);
  });

  test('says when the server is out of reach', async () => {
    fakeServer({ 'POST /api/sessions': offline });
    const user = userEvent.setup();
    render(
      <ManagerGate staffId={staffIds.morgan}>
        <p>The back office</p>
      </ManagerGate>,
    );
    for (const d of '1234') await user.click(await screen.findByRole('button', { name: d }));
    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the server");
  });
});

describe('reports', () => {
  test('shows the figures, the hourly chart and its table', async () => {
    await signedInManager();
    const { requests } = fakeServer({ 'GET /api/reports/sales': () => ({ body: report() }) });
    const user = userEvent.setup();
    render(<ReportsTab today="2026-10-22" onReviewFlags={() => {}} />);

    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(within(summary).getByText('$57.45')).toBeInTheDocument();
    expect(within(summary).getByText('$59.71')).toBeInTheDocument();
    expect(within(summary).getByRole('button', { name: /Needs review/ })).toHaveTextContent('2');
    expect(requests[0]!.headers['X-Session']).toBe('office');

    // Quiet hours show as empty slots between the first and last sale.
    const slots = screen.getAllByRole('img');
    expect(slots.map((s) => s.getAttribute('aria-label'))).toEqual(['8am: $30.60, 1 orders', '9am: $0.00, 0 orders', '10am: $30.60, 1 orders']);
    await user.click(screen.getByRole('button', { name: 'Show table' }));
    expect(screen.getByRole('cell', { name: '9am–10am' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Last 7 days' }));
    await waitFor(() => expect(requests.at(-1)!.query.get('from')).toBe('2026-10-16'));
    expect(requests.at(-1)!.query.get('to')).toBe('2026-10-22');
  });
});

describe('close-out', () => {
  function status(patch: Partial<CloseoutStatus> = {}): CloseoutStatus {
    return {
      businessDate: '2026-10-22',
      closeout: null,
      live: report(),
      changed: false,
      devices: [{ id: 'dev-a', name: 'Front', code: 'A', lastSeenAt: new Date().toISOString(), reportedPending: 2, reportedOpen: 0 }],
      defaultFloat: 15000,
      ...patch,
    };
  }

  test('works out over/short as the drawer is counted, then closes the day', async () => {
    await signedInManager();
    const { requests } = fakeServer({
      'GET /api/closeouts/2026-10-22': () => ({ body: status() }),
      'POST /api/closeouts/2026-10-22': () => ({ status: 201, body: {} }),
    });
    const user = userEvent.setup();
    render(<CloseoutTab today="2026-10-22" onReviewFlags={() => {}} />);

    expect(await screen.findByText(/2 not sent/)).toBeInTheDocument();
    // Expected: $150 float + $48.34 in − $4.09 out = $194.25.
    const counted = screen.getByLabelText('Counted in Front');
    await user.clear(counted);
    await user.type(counted, '190.00');
    const row = screen.getByRole('row', { name: /Front/ });
    expect(row).toHaveTextContent('$194.25');
    expect(row).toHaveTextContent('Short $4.25');

    await user.click(screen.getByRole('button', { name: 'Close out 2026-10-22' }));
    await user.click(screen.getByRole('button', { name: 'Close out' }));
    await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
    expect(requests.find((r) => r.method === 'POST')!.body).toEqual({
      drawers: [{ deviceId: 'dev-a', openingFloat: 15000, counted: 19000 }],
      note: '',
    });
  });

  test('a closed day that changed afterwards says so', async () => {
    await signedInManager();
    const closed = { businessDate: '2026-10-22', closedBy: 'Morgan', closedAt: '2026-10-22T22:00:00Z', note: '', drawers: [], snapshot: report() };
    const live = report({ summary: { ...report().summary, orders: 3, netSales: 8805 } });
    fakeServer({ 'GET /api/closeouts/2026-10-22': () => ({ body: status({ closeout: closed, live, changed: true }) }) });
    render(<CloseoutTab today="2026-10-22" onReviewFlags={() => {}} />);
    expect(await screen.findByText(/Sales arrived after this day was closed out/)).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Net sales/ })).toHaveTextContent('$57.45$88.05');
  });
});

describe('menu editor', () => {
  test('saves a price change against the version it started from', async () => {
    await signedInManager();
    let saved: { baseVersion: number; doc: MenuDoc } | undefined;
    fakeServer({
      'GET /api/menu': () => ({ body: { version: 3, doc: vectorMenu() } }),
      'PUT /api/menu': ({ body }) => {
        saved = body as typeof saved;
        return { body: { version: 4 } };
      },
    });
    const user = userEvent.setup();
    render(<MenuTab />);
    await user.click(await screen.findByRole('button', { name: /^Latte/ }));
    const price = screen.getByLabelText('Price');
    await user.clear(price);
    await user.type(price, '4.75');
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    expect(await screen.findByText(/Saved as version 4/)).toBeInTheDocument();
    expect(saved!.baseVersion).toBe(3);
    expect(saved!.doc.items.find((i) => i.id === 'latte')!.price).toBe(475);
  });

  test("shows the server's problems, and a conflict, without losing edits", async () => {
    await signedInManager();
    let reply: { status: number; body: unknown } = { status: 400, body: { code: 'invalid_menu', message: 'invalid', details: ['item "latte" needs a name'] } };
    fakeServer({
      'GET /api/menu': () => ({ body: { version: 3, doc: vectorMenu() } }),
      'PUT /api/menu': () => reply,
    });
    const user = userEvent.setup();
    render(<MenuTab />);
    await user.click(await screen.findByRole('button', { name: /^Latte/ }));
    await user.clear(screen.getByLabelText('Name'));
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('item "latte" needs a name');

    reply = { status: 409, body: { code: 'conflict', message: 'changed' } };
    await user.type(screen.getByLabelText('Name'), 'Latte');
    await user.click(screen.getByRole('button', { name: 'Save menu' }));
    expect(await screen.findByText(/Someone else saved the menu/)).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });
});

describe('staff', () => {
  test('adds a person, insisting on a real PIN', async () => {
    await signedInManager();
    const { requests } = fakeServer({
      'GET /api/staff': () => ({ body: [{ id: 's1', name: 'Sam', role: 'barista', active: true, createdAt: '', updatedAt: '' }] }),
      'POST /api/staff': () => ({ status: 201, body: {} }),
    });
    const user = userEvent.setup();
    render(<StaffTab />);
    expect(await screen.findByRole('cell', { name: 'Sam' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a person' }));
    await user.type(screen.getByLabelText('Name'), 'Jo');
    await user.click(screen.getByRole('radio', { name: 'Manager' }));
    await user.type(screen.getByLabelText(/^PIN/), '123');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('4 to 8 digits');
    await user.type(screen.getByLabelText(/^PIN/), '456');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ name: 'Jo', role: 'manager', pin: '123456' }));
  });
});

describe('flags', () => {
  test('a manager reviews a flag with a note', async () => {
    await signedInManager();
    const flag: FlagView = {
      id: 7, kind: 'over_refund', subjectKind: 'refund', subjectId: 'r1', orderId: 'o1', number: 'A-007', deviceCode: 'B',
      businessDate: '2026-10-22', message: 'refunds more than was paid', detail: ['refunds 2 × Croissant; 0 of 2 were left'],
      createdAt: '', resolvedAt: null, resolvedBy: null, resolution: null,
    };
    let open = [flag];
    const { requests } = fakeServer({
      'GET /api/flags': () => ({ body: open }),
      'POST /api/flags/7/resolve': () => {
        open = [];
        return { status: 204 };
      },
    });
    const user = userEvent.setup();
    render(<FlagsTab />);
    expect(await screen.findByText('Refunded more than was paid')).toBeInTheDocument();
    expect(screen.getByText('refunds 2 × Croissant; 0 of 2 were left')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review…' }));
    await user.type(screen.getByLabelText('What did you find?'), 'Both tablets were offline; customer was given $4.09 twice');
    await user.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    expect(await screen.findByText('Nothing to review.')).toBeInTheDocument();
    expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ note: 'Both tablets were offline; customer was given $4.09 twice' });
  });
});
