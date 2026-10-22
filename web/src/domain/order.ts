// An open order on this tablet, as pure functions over a Draft. The order is
// built here and synced once, when it closes (docs/decisions/0002). Rules:
// lines can change only until the first payment (0008); voids, reversals and
// undo keep their history in the document (0009).
import type { OrderDoc, PaymentDoc, VoidInfo } from './documents';
import { checkSelections, defaultSelections, type MenuIndex, type Selection } from './menu';
import { sum } from './money';
import { orderTotals, priceLine, taxShares, type PricedLine, type Totals } from './pricing';

export interface DraftLine {
  id: string;
  itemId: string;
  qty: number;
  mods: Selection[];
  addedAt: string;
  void: VoidInfo | null;
}

export interface Draft {
  id: string;
  number: string;
  businessDate: string;
  deviceId: string;
  /** Who started the order. */
  staffId: string;
  /**
   * The menu version this order is priced with. It stays fixed while the
   * order is open, so a menu edit never changes a price mid-order, and the
   * server re-prices against the same version.
   */
  menuVersion: number;
  createdAt: string;
  lines: DraftLine[];
  payments: PaymentDoc[];
  selectedLineId: string | null;
  /** Set when fully paid or voided; the order waits here during the undo window. */
  closedAt: string | null;
  void: VoidInfo | null;
}

export const MAX_LINE_QTY = 99;

export function newDraft(p: Pick<Draft, 'id' | 'number' | 'businessDate' | 'deviceId' | 'staffId' | 'menuVersion' | 'createdAt'>): Draft {
  return { ...p, lines: [], payments: [], selectedLineId: null, closedAt: null, void: null };
}

/** Payments that haven't been reversed. */
export function captured(d: Draft): PaymentDoc[] {
  return d.payments.filter((p) => !p.reversal);
}

/** Lines can change only before any payment is taken. */
export function isEditable(d: Draft): boolean {
  return d.closedAt === null && captured(d).length === 0;
}

function assertEditable(d: Draft): void {
  if (d.closedAt) throw new Error('the order is closed');
  if (captured(d).length) throw new Error('the order has payments; reverse them to change it');
}

/** Applies f to a line; returns d itself when nothing changed, so no-op taps don't re-render or re-save. */
function updateLine(d: Draft, lineId: string, f: (l: DraftLine) => DraftLine): Draft {
  const i = d.lines.findIndex((l) => l.id === lineId && !l.void);
  if (i < 0) throw new Error(`no line ${lineId}`);
  const next = f(d.lines[i]!);
  return next === d.lines[i] ? d : { ...d, lines: d.lines.with(i, next) };
}

/** Puts selections in menu order, so documents don't depend on tap order. */
function sortMods(ix: MenuIndex, itemId: string, mods: Selection[]): Selection[] {
  const rank = new Map<string, number>();
  ix.items.get(itemId)?.groupIds.forEach((gid, gi) =>
    ix.groups.get(gid)?.options.forEach((o, oi) => rank.set(o.id, gi * 1000 + oi)),
  );
  return [...mods].sort((a, b) => (rank.get(a.optionId) ?? 1e9) - (rank.get(b.optionId) ?? 1e9));
}

/** Adds an item with its default modifiers and selects it. */
export function addItem(d: Draft, ix: MenuIndex, itemId: string, lineId: string, at: string): Draft {
  assertEditable(d);
  if (!ix.items.has(itemId)) throw new Error(`unknown item ${itemId}`);
  const line: DraftLine = { id: lineId, itemId, qty: 1, mods: defaultSelections(ix, itemId), addedAt: at, void: null };
  return { ...d, lines: [...d.lines, line], selectedLineId: lineId };
}

export function selectLine(d: Draft, lineId: string | null): Draft {
  return { ...d, selectedLineId: lineId };
}

/**
 * Taps an option. In a pick-one group it replaces the current choice (and
 * an optional choice can be tapped off); in a pick-several group it toggles,
 * up to the group's maximum.
 */
export function toggleOption(d: Draft, ix: MenuIndex, lineId: string, optionId: string): Draft {
  assertEditable(d);
  const ref = ix.options.get(optionId);
  if (!ref) throw new Error(`unknown option ${optionId}`);
  const { group } = ref;
  const inGroup = new Set(group.options.map((o) => o.id));
  return updateLine(d, lineId, (line) => {
    const selected = line.mods.some((m) => m.optionId === optionId);
    const chosen = line.mods.filter((m) => inGroup.has(m.optionId)).length;
    let mods = line.mods;
    if (group.max === 1) {
      if (!selected) mods = [...mods.filter((m) => !inGroup.has(m.optionId)), { optionId, qty: 1 }];
      else if (group.min === 0) mods = mods.filter((m) => m.optionId !== optionId);
    } else if (selected) {
      mods = mods.filter((m) => m.optionId !== optionId);
    } else if (chosen < group.max) {
      mods = [...mods, { optionId, qty: 1 }];
    }
    return mods === line.mods ? line : { ...line, mods: sortMods(ix, line.itemId, mods) };
  });
}

/** Steps an option's quantity (extra shots, syrup pumps) within its limits. */
export function stepOption(d: Draft, ix: MenuIndex, lineId: string, optionId: string, delta: 1 | -1): Draft {
  assertEditable(d);
  const ref = ix.options.get(optionId);
  if (!ref) throw new Error(`unknown option ${optionId}`);
  const { group, option } = ref;
  const inGroup = new Set(group.options.map((o) => o.id));
  return updateLine(d, lineId, (line) => {
    const current = line.mods.find((m) => m.optionId === optionId)?.qty ?? 0;
    const next = Math.max(0, Math.min(option.maxQty, current + delta));
    if (next === current) return line;
    let mods: Selection[];
    if (next === 0) {
      mods = line.mods.filter((m) => m.optionId !== optionId);
    } else if (current > 0) {
      mods = line.mods.map((m) => (m.optionId === optionId ? { ...m, qty: next } : m));
    } else if (group.max === 1) {
      mods = [...line.mods.filter((m) => !inGroup.has(m.optionId)), { optionId, qty: next }];
    } else if (line.mods.filter((m) => inGroup.has(m.optionId)).length < group.max) {
      mods = [...line.mods, { optionId, qty: next }];
    } else {
      return line;
    }
    return { ...line, mods: sortMods(ix, line.itemId, mods) };
  });
}

export function setLineQty(d: Draft, lineId: string, qty: number): Draft {
  assertEditable(d);
  const q = Math.max(1, Math.min(MAX_LINE_QTY, Math.round(qty)));
  return updateLine(d, lineId, (l) => ({ ...l, qty: q }));
}

/** Copies a line (same modifiers) right after it and selects the copy. */
export function duplicateLine(d: Draft, lineId: string, newId: string, at: string): Draft {
  assertEditable(d);
  const i = d.lines.findIndex((l) => l.id === lineId && !l.void);
  if (i < 0) throw new Error(`no line ${lineId}`);
  const copy: DraftLine = { ...d.lines[i]!, id: newId, addedAt: at, mods: d.lines[i]!.mods.map((m) => ({ ...m })) };
  return { ...d, lines: [...d.lines.slice(0, i + 1), copy, ...d.lines.slice(i + 1)], selectedLineId: newId };
}

/** Voids a line. It stays in the order (for the void report) but stops counting. */
export function voidLine(d: Draft, lineId: string, info: VoidInfo): Draft {
  assertEditable(d);
  const next = updateLine(d, lineId, (l) => ({ ...l, void: info }));
  if (next.selectedLineId !== lineId) return next;
  return { ...next, selectedLineId: next.lines.filter((l) => !l.void).at(-1)?.id ?? null };
}

export interface LineView extends DraftLine {
  priced: PricedLine;
  /** This line's share of the order's tax. */
  taxShare: number;
  /** Selection problems (see menu.checkSelections); empty when complete. */
  problems: string[];
}

export interface PricedDraft {
  /** Lines that count (not voided), in order. */
  lines: LineView[];
  totals: Totals;
  paid: number;
  remaining: number;
  /** There's something to pay for and every line is complete. */
  ready: boolean;
}

export function priceDraft(d: Draft, ix: MenuIndex): PricedDraft {
  const priced = d.lines.map((l) => priceLine(ix, l));
  const amounts = priced.map((p, i) => ({ lineTotal: p.lineTotal, taxable: p.taxable, voided: !!d.lines[i]!.void }));
  const totals = orderTotals(amounts, ix.doc.taxRatePpm);
  const shares = taxShares(amounts, totals.tax);
  const lines = d.lines
    .map((l, i) => ({ ...l, priced: priced[i]!, taxShare: shares[i]!, problems: checkSelections(ix, l.itemId, l.mods) }))
    .filter((l) => !l.void);
  const paid = sum(captured(d).map((p) => p.amount));
  return {
    lines,
    totals,
    paid,
    remaining: totals.total - paid,
    ready: lines.length > 0 && lines.every((l) => l.problems.length === 0),
  };
}

/** Takes a payment. When it covers the balance, the order closes. */
export function addPayment(d: Draft, priced: PricedDraft, payment: PaymentDoc): Draft {
  if (d.closedAt) throw new Error('the order is closed');
  if (!priced.ready) throw new Error('the order is incomplete');
  if (payment.amount <= 0 || payment.amount > priced.remaining) throw new Error('the payment must be between 1¢ and the balance');
  const next = { ...d, payments: [...d.payments, payment], selectedLineId: null };
  return payment.amount === priced.remaining ? { ...next, closedAt: payment.createdAt } : next;
}

/** Closes an order that costs nothing (everything on the house). */
export function closeNoCharge(d: Draft, priced: PricedDraft, at: string): Draft {
  if (d.closedAt || !priced.ready || priced.totals.total !== 0 || captured(d).length) {
    throw new Error('only a complete order with a zero total can close without payment');
  }
  return { ...d, closedAt: at, selectedLineId: null };
}

/** Gives a payment back while the order is still open (or being undone). */
export function reversePayment(d: Draft, paymentId: string, info: VoidInfo): Draft {
  const p = d.payments.find((x) => x.id === paymentId);
  if (!p || p.reversal) throw new Error(`no payment ${paymentId} to reverse`);
  return { ...d, payments: d.payments.map((x) => (x.id === paymentId ? { ...x, reversal: info } : x)), closedAt: null };
}

/** Cancels an order that has no payments. It still syncs, as voided. */
export function voidOrder(d: Draft, info: VoidInfo): Draft {
  if (d.closedAt) throw new Error('the order is closed');
  if (captured(d).length) throw new Error('reverse the payments before voiding the order');
  return { ...d, void: info, closedAt: info.at, selectedLineId: null };
}

/** Undo during the undo window: reopens the order, reversing the payment that closed it. */
export function undoClose(d: Draft, info: VoidInfo): Draft {
  if (!d.closedAt) return d;
  if (d.void) return { ...d, void: null, closedAt: null };
  const last = captured(d).at(-1);
  return last ? reversePayment(d, last.id, info) : { ...d, closedAt: null };
}

/** The document a closed order syncs as. */
export function toOrderDoc(d: Draft, ix: MenuIndex): OrderDoc {
  if (!d.closedAt) throw new Error('the order is still open');
  const priced = d.lines.map((l) => priceLine(ix, l));
  const totals = orderTotals(
    priced.map((p, i) => ({ lineTotal: p.lineTotal, taxable: p.taxable, voided: !!d.lines[i]!.void })),
    ix.doc.taxRatePpm,
  );
  return {
    v: 1,
    id: d.id,
    deviceId: d.deviceId,
    staffId: d.staffId,
    number: d.number,
    businessDate: d.businessDate,
    status: d.void ? 'voided' : 'paid',
    menuVersion: d.menuVersion,
    createdAt: d.createdAt,
    closedAt: d.closedAt,
    lines: d.lines.map((l, i) => {
      const p = priced[i]!;
      return {
        id: l.id,
        itemId: p.itemId,
        itemName: p.itemName,
        category: p.category,
        qty: p.qty,
        unitPrice: p.unitPrice,
        lineTotal: p.lineTotal,
        taxable: p.taxable,
        mods: p.mods,
        addedAt: l.addedAt,
        void: l.void,
      };
    }),
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
    payments: d.payments,
    void: d.void,
  };
}

/** A short description of a line's modifiers, e.g. "Large · Oat · 2× Extra shot". */
export function modSummary(line: { priced: PricedLine }): string {
  return line.priced.mods.map((m) => (m.qty > 1 ? `${m.qty}× ${m.optionName}` : m.optionName)).join(' · ');
}
