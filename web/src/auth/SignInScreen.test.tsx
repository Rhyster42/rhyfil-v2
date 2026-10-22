import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { db } from '../db/db';
import { fakeServer, seedTablet, staffIds } from '../test/fixtures';
import { SignInScreen } from './SignInScreen';

async function typePin(user: ReturnType<typeof userEvent.setup>, pin: string) {
  for (const d of pin) await user.click(screen.getByRole('button', { name: d }));
}

test('shows active staff only', async () => {
  await seedTablet();
  render(<SignInScreen />);
  expect(await screen.findByRole('button', { name: /Sam/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Morgan/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Jo/ })).not.toBeInTheDocument();
});

test('a wrong PIN is rejected; the right one signs in without pressing OK', async () => {
  await seedTablet();
  const user = userEvent.setup();
  render(<SignInScreen />);
  await user.click(await screen.findByRole('button', { name: /Sam/ }));

  await typePin(user, '1112');
  await user.click(screen.getByRole('button', { name: 'OK' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Wrong PIN');
  expect(await db.getMeta('session')).toBeUndefined();

  await typePin(user, '1111');
  await waitFor(async () => expect((await db.getMeta('session'))?.staffId).toBe(staffIds.sam));
});

test('managers also get a back-office session when online', async () => {
  await seedTablet();
  const { requests } = fakeServer({
    'POST /api/sessions': () => ({ status: 201, body: { token: 'office', expiresAt: '2030-01-01T00:00:00Z', staff: {} } }),
  });
  const user = userEvent.setup();
  render(<SignInScreen />);
  await user.click(await screen.findByRole('button', { name: /Morgan/ }));
  await typePin(user, '1234');
  await waitFor(async () => expect((await db.getMeta('managerSession'))?.token).toBe('office'));
  expect(requests[0]!.body).toEqual({ staffId: staffIds.morgan, pin: '1234' });
  expect((await db.getMeta('session'))?.staffId).toBe(staffIds.morgan);
});
