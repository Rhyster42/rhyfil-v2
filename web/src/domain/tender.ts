// Building payments and choosing the amount of the next one: quick cash
// buttons and split checks (docs/decisions/0008).
import type { PaymentDoc } from './documents';
import { allocate, sum } from './money';
import { captured, type Draft, type PricedDraft } from './order';

interface PaymentBase {
  id: string;
  staffId: string;
  at: string;
  coversLineIds?: string[];
}

/** Cash: applies up to the amount due; the rest is change. */
export function cashPayment(p: PaymentBase & { due: number; tendered: number }): PaymentDoc {
  const amount = Math.min(p.tendered, p.due);
  return {
    id: p.id,
    tender: 'cash',
    amount,
    tendered: p.tendered,
    change: p.tendered - amount,
    coversLineIds: p.coversLineIds ?? [],
    staffId: p.staffId,
    createdAt: p.at,
    reversal: null,
  };
}

/** Card: run on the separate terminal; the POS records it. */
export function cardPayment(p: PaymentBase & { amount: number }): PaymentDoc {
  return {
    id: p.id,
    tender: 'card',
    amount: p.amount,
    tendered: p.amount,
    change: 0,
    coversLineIds: p.coversLineIds ?? [],
    staffId: p.staffId,
    createdAt: p.at,
    reversal: null,
  };
}

/**
 * The cash amounts a customer is likely to hand over for a balance: the next
 * dollar, then the next $5, $10, $20, $50 and $100, keeping the first three
 * above the balance. "Exact" is always offered separately.
 */
export function cashSuggestions(due: number): number[] {
  const out = new Set<number>();
  for (const step of [100, 500, 1000, 2000, 5000, 10000]) {
    const v = Math.ceil(due / step) * step;
    if (v > due) out.add(v);
  }
  return [...out].sort((a, b) => a - b).slice(0, 3);
}

/** An even split of the balance; the earliest parts carry the odd cents. */
export function evenSplit(remaining: number, ways: number): number[] {
  return allocate(remaining, Array.from({ length: ways }, () => 1));
}

/** Lines no payment has claimed yet (for split-by-item). */
export function unclaimedLineIds(d: Draft, priced: PricedDraft): string[] {
  const claimed = new Set(captured(d).flatMap((p) => p.coversLineIds));
  return priced.lines.filter((l) => !claimed.has(l.id)).map((l) => l.id);
}

/**
 * What the chosen lines cost, tax share included. Capped at the balance in
 * case earlier payments weren't by item.
 */
export function amountForLines(priced: PricedDraft, lineIds: readonly string[]): number {
  const chosen = new Set(lineIds);
  const amount = sum(priced.lines.filter((l) => chosen.has(l.id)).map((l) => l.priced.lineTotal + l.taxShare));
  return Math.min(amount, priced.remaining);
}
