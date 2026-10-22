// The tablet's database (docs/decisions/0001). Everything the register shows
// comes from here; the sync engine keeps it in step with the server.
import Dexie, { type Table } from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Device, Settings, StaffMember } from '../api/types';
import type { DocKind, OrderDoc, RefundDoc } from '../domain/documents';
import type { MenuDoc } from '../domain/menu';
import type { Draft } from '../domain/order';

/** A document in the local ledger; seq is null until the server confirms it. */
export type LocalOrder = OrderDoc & { seq: number | null };
export type LocalRefund = RefundDoc & { seq: number | null };

export interface OutboxItem {
  /** Auto-increment: the outbox is first in, first out. */
  seq?: number;
  id: string;
  kind: DocKind;
  doc: OrderDoc | RefundDoc;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

export interface DeadLetter {
  id: string;
  kind: DocKind;
  doc: OrderDoc | RefundDoc;
  error: string;
  rejectedAt: string;
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'unauthorized';

export interface SyncStatus {
  state: SyncState;
  lastSyncAt: string | null;
  lastError: string | null;
}

/** Typed key-value settings kept on the device. */
export interface MetaMap {
  device: Device & { token: string };
  /** Who is signed in on this tablet (verified locally). */
  session: { staffId: string; signedInAt: string };
  /** Back-office session from the server, for managers. */
  managerSession: { token: string; staffId: string; expiresAt: string };
  /** The newest menu version in the menus table. */
  menuVersion: number;
  settings: Settings;
  staffVersion: number;
  cursor: number;
  clockOffsetMs: number;
  orderCounter: { businessDate: string; n: number };
  syncStatus: SyncStatus;
}

interface MetaRow {
  key: keyof MetaMap;
  value: unknown;
}

/** A menu version; kept while it's the newest or an open order uses it. */
export interface StoredMenu {
  version: number;
  doc: MenuDoc;
}

export class PosDB extends Dexie {
  meta!: Table<MetaRow, keyof MetaMap>;
  menus!: Table<StoredMenu, number>;
  staff!: Table<StaffMember, string>;
  drafts!: Table<Draft, string>;
  orders!: Table<LocalOrder, string>;
  refunds!: Table<LocalRefund, string>;
  outbox!: Table<OutboxItem, number>;
  deadLetters!: Table<DeadLetter, string>;

  constructor(name = 'coffee-pos') {
    super(name);
    this.version(1).stores({
      meta: 'key',
      menus: 'version',
      staff: 'id',
      drafts: 'id',
      orders: 'id, businessDate, number',
      refunds: 'id, orderId, businessDate',
      outbox: '++seq, &id',
      deadLetters: 'id',
    });
  }

  async getMeta<K extends keyof MetaMap>(key: K): Promise<MetaMap[K] | undefined> {
    return (await this.meta.get(key))?.value as MetaMap[K] | undefined;
  }

  async setMeta<K extends keyof MetaMap>(key: K, value: MetaMap[K]): Promise<void> {
    await this.meta.put({ key, value });
  }

  async deleteMeta(key: keyof MetaMap): Promise<void> {
    await this.meta.delete(key);
  }
}

export const db = new PosDB();

/**
 * A meta value that re-renders when it changes: undefined while loading, null
 * when absent.
 */
export function useMeta<K extends keyof MetaMap>(key: K): MetaMap[K] | null | undefined {
  return useLiveQuery(async () => (await db.getMeta(key)) ?? null, [key]);
}

/** Clears every table (tests, and "reset this device"). */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
}
