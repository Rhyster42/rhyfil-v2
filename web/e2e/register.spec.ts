import { expect, test } from '@playwright/test';
import { enrollAndSignIn, tap } from './helpers';

test('a barista can split a check and undo a mis-tap', async ({ page }) => {
  await enrollAndSignIn(page, `E2E ${Date.now()}`, 'Riley', '2222');
  await tap(page, /^Latte/);
  await tap(page, /^Americano/);
  // Mis-tapped Card: undo, then split two ways.
  await tap(page, /^Card/);
  await tap(page, 'Undo');
  await tap(page, /Split · custom/);
  await tap(page, '2 ways');
  await expect(page.getByText('Split 2 ways · 1 of 2')).toBeVisible();
  await tap(page, /^Card/);
  await tap(page, /^Exact/);
  await expect(page.getByRole('status')).toContainText('Paid');
});
