// The point of the whole design: a tablet keeps selling (and refunding)
// with no network, and everything reaches the server, clean, when it's back.
import { expect, test } from '@playwright/test';
import { enrollAndSignIn, managerApi, tap, waitForUndoWindow } from './helpers';

test('sell and refund through an outage, then sync cleanly', async ({ page, context, request }) => {
  const tablet = `E2E ${Date.now()}`;
  await enrollAndSignIn(page, tablet, 'Sam', '1111');
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);

  // Online: a large oat latte with an extra shot, $10 cash (five taps).
  await tap(page, /^Latte/);
  await tap(page, /^Large/);
  await tap(page, /^Oat/);
  await tap(page, /^Extra shot/);
  await tap(page, '$10');
  await expect(page.getByRole('status')).toContainText('Change $2.27');
  await waitForUndoWindow(page);
  await expect(page.locator('.pill')).toHaveText('Synced');

  // The network goes. The app reloads from the service worker's cache.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: /^Latte/ })).toBeVisible();

  await tap(page, /^Mocha/);
  await tap(page, /^Card/);
  await page.getByRole('tab', { name: 'Bakery' }).click();
  await tap(page, /^Croissant/);
  await tap(page, 'One more');
  // Other runs' orders are on the server too: remember this one's number.
  const number = (await page.getByRole('heading', { name: /^Order / }).textContent())!.replace('Order ', '');
  await tap(page, /^Exact/);
  await waitForUndoWindow(page);
  await expect(page.locator('.pill')).toHaveText('Offline · 2 waiting');

  // Still offline: refund one croissant with the manager's PIN.
  await page.getByRole('button', { name: 'Orders' }).click();
  await page.getByLabel('Search orders').fill(number);
  await page.getByRole('button', { name: new RegExp(`^${number}`) }).click();
  await tap(page, 'Refund…');
  await tap(page, 'One more Croissant');
  await tap(page, 'Made wrong');
  await tap(page, 'Manager approval');
  for (const d of '1234') await tap(page, d);
  await expect(page.getByText(/Give back \$4\.09 in cash/)).toBeVisible();
  await tap(page, 'Done');
  await expect(page.locator('.pill')).toHaveText('Offline · 3 waiting');

  // The network comes back.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.pill')).toHaveText('Synced', { timeout: 20_000 });

  // The server has exactly what happened at the counter, with nothing flagged.
  const api = await managerApi(request);
  const devices = await api.get<{ id: string; name: string; code: string }[]>('/devices');
  const me = devices.find((d) => d.name === tablet)!;
  const mine = (await api.ledger()).filter((e) => e.doc.deviceId === me.id);
  expect(mine.filter((e) => e.kind === 'order').map((e) => [e.doc.status, e.doc.total])).toEqual([
    ['paid', 773],
    ['paid', 599],
    ['paid', 817],
  ]);
  // $3.75 plus the first unit's share of the croissants' 67¢ tax (34¢).
  expect(mine.filter((e) => e.kind === 'refund').map((e) => e.doc.amount)).toEqual([409]);
  const flags = await api.get<{ deviceCode: string }[]>('/flags?status=all');
  expect(flags.filter((f) => f.deviceCode === me.code)).toEqual([]);
});
