// Behaviour of the TypeScript-only domain helpers.
import { describe, expect, test } from 'vitest';
import { addDays } from './businessDate';
import { uuidv7 } from './ids';
import { allocate, formatMoney, parseMoney, sum } from './money';
import { hashPin, isValidPin, verifyPin } from './pin';

describe('allocate properties', () => {
  test('parts always sum to the total and stay within a cent of the exact share', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let k = 0; k < 2000; k++) {
      const total = rand(1_000_000);
      const weights = Array.from({ length: 1 + rand(8) }, () => (rand(4) ? rand(10_000) : 0));
      const parts = allocate(total, weights);
      expect(sum(parts)).toBe(total);
      const ws = sum(weights);
      if (ws === 0) continue;
      parts.forEach((p, i) => expect(Math.abs(p - (total * weights[i]!) / ws)).toBeLessThan(1));
    }
  });

  test('rejects negative input', () => {
    expect(() => allocate(-1, [1])).toThrow();
    expect(() => allocate(1, [-1, 2])).toThrow();
  });
});

test('formatMoney and parseMoney', () => {
  expect(formatMoney(1234)).toBe('$12.34');
  expect(formatMoney(-50)).toBe('-$0.50');
  expect(parseMoney('12.5')).toBe(1250);
  expect(parseMoney('$7')).toBe(700);
  expect(parseMoney('0.05')).toBe(5);
  expect(parseMoney('1.234')).toBeNull();
  expect(parseMoney('abc')).toBeNull();
});

test('uuidv7 is a version-7 UUID that sorts by time', () => {
  const a = uuidv7(1_700_000_000_000);
  const b = uuidv7(1_700_000_000_001);
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a < b).toBe(true);
  expect(a.slice(0, 13)).toBe('018bcfe5-6800');
});

test('addDays crosses months and years', () => {
  expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
});

test('hashPin round-trips through verifyPin', async () => {
  const v = await hashPin('482913', 1000);
  expect(await verifyPin(v, '482913')).toBe(true);
  expect(await verifyPin(v, '482914')).toBe(false);
  expect(isValidPin('1234')).toBe(true);
  expect(isValidPin('123')).toBe(false);
});
