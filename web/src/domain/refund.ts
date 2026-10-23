// Working out refunds against a closed order (docs/decisions/0009). The
// server checks the same limits and flags anything over them (0003).
import type { OrderDoc, OrderLineDoc, PaymentDoc, RefundDoc, RefundLineDoc } from './documents';
import { allocate, sum } from './money';
import { taxShares } from './pricing';

export interface LineRefundState {
  line: OrderLineDoc;
  /** Each unit's share of the line's tax, so refunding every unit returns it exactly. */
  unitTax: number[];
  refundedQty: number;
  remainingQty: number;
}

export interface PaymentRefundState {
  payment: PaymentDoc;
  refunded: number;
  remaining: number;
}

export interface RefundState {
  /** Lines that were paid for (voided lines can't be refunded). */
  lines: LineRefundState[];
  /** Payments that weren't reversed. */
  payments: PaymentRefundState[];
  refunded: number;
  remaining: number;
}

/** What's been refunded on an order so far, and what's left. */
export function refundState(order: OrderDoc, refunds: readonly RefundDoc[]): RefundState {
  const mine = refunds.filter((r) => r.orderId === order.id);
  const shares = taxShares(
    order.lines.map((l) => ({ lineTotal: l.lineTotal, taxable: l.taxable, voided: !!l.void })),
    order.tax,
  );
  const lines = order.lines.flatMap((line, i): LineRefundState[] => {
    if (line.void) return [];
    const refundedQty = sum(mine.flatMap((r) => r.lines.filter((x) => x.lineId === line.id).map((x) => x.qty)));
    return [
      {
        line,
        unitTax: allocate(shares[i]!, Array.from({ length: line.qty }, () => 1)),
        refundedQty,
        remainingQty: Math.max(0, line.qty - refundedQty),
      },
    ];
  });
  const payments = order.payments
    .filter((p) => !p.reversal)
    .map((payment) => {
      const refunded = sum(mine.filter((r) => r.paymentId === payment.id).map((r) => r.amount));
      return { payment, refunded, remaining: Math.max(0, payment.amount - refunded) };
    });
  const refunded = sum(mine.map((r) => r.amount));
  return { lines, payments, refunded, remaining: sum(payments.map((p) => p.remaining)) };
}

/** The money for refunding qty more units of a line, after those already refunded. */
export function lineRefund(s: LineRefundState, qty: number): RefundLineDoc {
  const tax = sum(s.unitTax.slice(s.refundedQty, s.refundedQty + qty));
  return { lineId: s.line.id, qty, amount: s.line.unitPrice * qty + tax, tax };
}

/** The tax part of a refund of a custom amount, in proportion to the order. */
export function customRefundTax(order: OrderDoc, amount: number): number {
  if (order.total === 0) return 0;
  return allocate(amount, [order.subtotal, order.tax])[1]!;
}

/**
 * The payment a refund should go back to: the one that paid for those items
 * (split by item), otherwise the one with the most left to refund.
 */
export function defaultPayment(state: RefundState, lineIds: readonly string[]): PaymentRefundState | null {
  const open = state.payments.filter((p) => p.remaining > 0);
  const covering = open.find((p) => p.payment.coversLineIds.some((id) => lineIds.includes(id)));
  return covering ?? [...open].sort((a, b) => b.remaining - a.remaining)[0] ?? null;
}

export function buildRefund(p: {
  id: string;
  order: OrderDoc;
  payment: PaymentDoc;
  lines: RefundLineDoc[];
  /** For a custom-amount refund (no lines). */
  amount?: number;
  reason: string;
  staffId: string;
  approvedBy: string;
  deviceId: string;
  at: string;
  businessDate: string;
}): RefundDoc {
  const amount = p.lines.length ? sum(p.lines.map((l) => l.amount)) : (p.amount ?? 0);
  const tax = p.lines.length ? sum(p.lines.map((l) => l.tax)) : customRefundTax(p.order, amount);
  if (amount <= 0) throw new Error('a refund must return something');
  return {
    v: 1,
    id: p.id,
    orderId: p.order.id,
    paymentId: p.payment.id,
    tender: p.payment.tender,
    deviceId: p.deviceId,
    staffId: p.staffId,
    approvedBy: p.approvedBy,
    businessDate: p.businessDate,
    createdAt: p.at,
    amount,
    tax,
    reason: p.reason,
    lines: p.lines,
  };
}
