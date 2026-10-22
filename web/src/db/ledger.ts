// Moving orders from "open on this tablet" to "in the ledger and on their
// way to the server".
import { useLiveQuery } from 'dexie-react-hooks';
import { indexMenu, type MenuIndex } from '../domain/menu';
import { toOrderDoc, type Draft } from '../domain/order';
import { nowIso } from '../sync/clock';
import { db, type LocalOrder } from './db';

const indexes = new Map<number, MenuIndex>();

/** A stored menu version, indexed. Versions never change, so it's cached. */
export async function menuIndex(version: number): Promise<MenuIndex | null> {
  const cached = indexes.get(version);
  if (cached) return cached;
  const m = await db.menus.get(version);
  if (!m) return null;
  const ix = indexMenu(m.doc);
  indexes.set(version, ix);
  return ix;
}

/** undefined while loading, null if that version isn't on the tablet. */
export function useMenuIndex(version: number | null | undefined): MenuIndex | null | undefined {
  return useLiveQuery(async () => (version == null ? null : menuIndex(version)), [version]);
}

/**
 * The order counter for a business date. If the stored counter is for
 * another day (or was lost), it resumes after the highest number this
 * device already used that day, so numbers don't repeat (docs/decisions/0011).
 */
export async function loadOrderCounter(deviceCode: string, businessDate: string): Promise<number> {
  const stored = await db.getMeta('orderCounter');
  if (stored?.businessDate === businessDate) return stored.n;
  const prefix = `${deviceCode}-`;
  const used = (await db.orders.where('businessDate').equals(businessDate).toArray())
    .filter((o) => o.number.startsWith(prefix))
    .map((o) => Number(o.number.slice(prefix.length)) || 0);
  return Math.max(0, ...used);
}

export function formatOrderNumber(deviceCode: string, n: number): string {
  return `${deviceCode}-${String(n).padStart(3, '0')}`;
}

/**
 * Turns a closed draft into a ledger entry and an outbox item, and removes
 * the draft, all in one transaction: an order is never both open and sent,
 * nor neither. Calling it twice is harmless.
 */
export async function finalizeOrder(d: Draft): Promise<LocalOrder | null> {
  if (!d.closedAt) throw new Error('only closed orders can be finalized');
  return db.transaction('rw', [db.drafts, db.orders, db.outbox, db.menus], async () => {
    if (await db.orders.get(d.id)) {
      await db.drafts.delete(d.id);
      return null;
    }
    const ix = await menuIndex(d.menuVersion);
    if (!ix) throw new Error(`menu version ${d.menuVersion} is missing from this tablet`);
    const doc = toOrderDoc(d, ix);
    await db.orders.add({ ...doc, seq: null });
    await db.outbox.add({ id: doc.id, kind: 'order', doc, createdAt: nowIso(), attempts: 0, lastError: null });
    await db.drafts.delete(d.id);
    return { ...doc, seq: null };
  });
}

/** Finalizes orders that closed more than graceMs ago and were left in their undo window. */
export async function finalizeStaleDrafts(graceMs = 0): Promise<void> {
  const cutoff = Date.now() - graceMs;
  const closed = await db.drafts.filter((d) => d.closedAt !== null && Date.parse(d.closedAt) <= cutoff).toArray();
  for (const d of closed) await finalizeOrder(d);
}
