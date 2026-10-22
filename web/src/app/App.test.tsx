import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { db } from '../db/db';
import { fakeServer, seedTablet, staffIds } from '../test/fixtures';
import { App } from './App';
import { engine } from './services';

vi.spyOn(engine, 'start').mockImplementation(() => {});

test('an unenrolled tablet starts at setup', async () => {
  fakeServer({ 'GET /api/setup': () => ({ body: { needsSetup: false } }) });
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Add this tablet' })).toBeInTheDocument();
});

test('an enrolled tablet asks who is working', async () => {
  await seedTablet();
  render(<App />);
  expect(await screen.findByRole('button', { name: /Sam/ })).toBeInTheDocument();
  expect(engine.start).toHaveBeenCalled();
});

test('a signed-in barista sees the register but not the back office', async () => {
  await seedTablet();
  await db.setMeta('session', { staffId: staffIds.sam, signedInAt: new Date().toISOString() });
  render(<App />);
  expect(await screen.findByText('Sam')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Register' })).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByRole('button', { name: 'Back office' })).not.toBeInTheDocument();
});

test('a manager also sees the back office', async () => {
  await seedTablet();
  await db.setMeta('session', { staffId: staffIds.morgan, signedInAt: new Date().toISOString() });
  render(<App />);
  expect(await screen.findByRole('button', { name: 'Back office' })).toBeInTheDocument();
});
