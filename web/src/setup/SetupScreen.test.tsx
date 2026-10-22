import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { db } from '../db/db';
import { fakeServer, offline } from '../test/fixtures';
import { SetupScreen } from './SetupScreen';

const enrolledDevice = { device: { id: 'dev-1', name: 'Bar', code: 'B' }, token: 'tok' };

test('enrolls a tablet with a code', async () => {
  const { requests } = fakeServer({
    'GET /api/setup': () => ({ body: { needsSetup: false } }),
    'POST /api/devices/enroll': () => ({ status: 201, body: enrolledDevice }),
  });
  const user = userEvent.setup();
  render(<SetupScreen />);
  await user.type(await screen.findByLabelText('Enrollment code'), '1234 5678');
  await user.clear(screen.getByLabelText('Name this tablet'));
  await user.type(screen.getByLabelText('Name this tablet'), 'Bar');
  await user.click(screen.getByRole('button', { name: 'Add tablet' }));

  await waitFor(async () => expect(await db.getMeta('device')).toEqual({ ...enrolledDevice.device, token: 'tok' }));
  expect(requests[1]!.body).toEqual({ code: '1234 5678', name: 'Bar' });
});

test('shows why enrollment failed', async () => {
  fakeServer({
    'GET /api/setup': () => ({ body: { needsSetup: false } }),
    'POST /api/devices/enroll': () => ({ status: 401, body: { code: 'bad_code', message: "that code isn't valid" } }),
  });
  const user = userEvent.setup();
  render(<SetupScreen />);
  await user.type(await screen.findByLabelText('Enrollment code'), '0000');
  await user.click(screen.getByRole('button', { name: 'Add tablet' }));
  expect(await screen.findByRole('alert')).toHaveTextContent("That code isn't valid");
  expect(await db.getMeta('device')).toBeUndefined();
});

test('first run creates the manager and signs them in', async () => {
  const { requests } = fakeServer({
    'GET /api/setup': () => ({ body: { needsSetup: true } }),
    'POST /api/setup': () => ({ status: 201, body: { ...enrolledDevice, staff: { id: 'mgr-1', name: 'Ada', role: 'manager' } } }),
    'POST /api/sessions': () => ({ status: 201, body: { token: 'office', expiresAt: '2030-01-01T00:00:00Z', staff: {} } }),
  });
  const user = userEvent.setup();
  render(<SetupScreen />);
  await user.type(await screen.findByLabelText('Setup code'), '48312290');
  await user.type(screen.getByLabelText('Your name'), 'Ada');
  await user.type(screen.getByLabelText(/Choose a PIN/), '246810');
  await user.type(screen.getByLabelText('Repeat PIN'), '246811');
  await user.click(screen.getByRole('button', { name: 'Set up' }));
  expect(await screen.findByRole('alert')).toHaveTextContent("PINs don't match");

  await user.clear(screen.getByLabelText('Repeat PIN'));
  await user.type(screen.getByLabelText('Repeat PIN'), '246810');
  await user.click(screen.getByRole('button', { name: 'Set up' }));
  await waitFor(async () => expect((await db.getMeta('session'))?.staffId).toBe('mgr-1'));
  expect((await db.getMeta('device'))?.token).toBe('tok');
  expect(requests[1]!.body).toEqual({ code: '48312290', managerName: 'Ada', pin: '246810', deviceName: 'Register' });
});

test('explains that setup needs a connection', async () => {
  fakeServer({ 'GET /api/setup': offline });
  render(<SetupScreen />);
  expect(await screen.findByRole('heading', { name: "Can't reach the server" })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
});
