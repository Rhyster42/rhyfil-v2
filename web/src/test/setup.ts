import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetDatabase } from '../db/db';
import { setClockOffset } from '../sync/clock';

// jsdom doesn't provide WebCrypto's subtle API; Node's implementation is the
// same standard API the browser has.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

beforeEach(async () => {
  await resetDatabase();
  setClockOffset(0);
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
