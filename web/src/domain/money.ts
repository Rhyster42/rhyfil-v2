// Integer-cent arithmetic behind tax, split checks and refunds. Mirrors
// internal/money; both are tested against testdata/vectors/money.json
// (docs/decisions/0006). BigInt keeps intermediate products exact.

const PPM = 1_000_000n;

/** amount × ratePpm / 1,000,000, rounded half away from zero. */
export function taxFor(amount: number, ratePpm: number): number {
  if (amount < 0) return -taxFor(-amount, ratePpm);
  return Number((BigInt(amount) * BigInt(ratePpm) + PPM / 2n) / PPM);
}

/**
 * Splits total into weights.length parts in proportion to weights. Each part
 * gets the floor of its share; leftover cents go one each to the largest
 * remainders, earlier parts winning ties. Parts always sum to total. All-zero
 * weights split evenly.
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (total < 0 || weights.some((w) => w < 0)) throw new Error('allocate: negative input');
  let w = weights.map((x) => BigInt(x));
  let sum = w.reduce((a, b) => a + b, 0n);
  if (sum === 0n) {
    w = w.map(() => 1n);
    sum = BigInt(n);
  }
  const t = BigInt(total);
  const parts = w.map((wi) => (t * wi) / sum);
  const order = w
    .map((wi, i) => ({ i, r: (t * wi) % sum }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  let left = t - parts.reduce((a, b) => a + b, 0n);
  for (let k = 0; left > 0n; k++, left--) parts[order[k]!.i]! += 1n;
  return parts.map(Number);
}

export function sum(amounts: readonly number[]): number {
  return amounts.reduce((a, b) => a + b, 0);
}

const formatters = new Map<string, Intl.NumberFormat>();

/** Formats cents for display, e.g. 1234 → "$12.34". */
export function formatMoney(cents: number, currency = 'USD'): string {
  let f = formatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    formatters.set(currency, f);
  }
  return f.format(cents / 100);
}

/** Parses "12.34" or "12" into cents; null if it isn't an amount. */
export function parseMoney(text: string): number | null {
  const m = /^\s*\$?(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}
