// The only register code that talks to the network (docs/decisions/0001):
// it pushes the outbox and pulls the menu, staff, settings and ledger.
import { api, ApiError, errorMessage, NetworkError } from '../api/client';
import type { PullResponse, PushRequest, PushResult } from '../api/types';
import type { MetaMap, PosDB, SyncStatus } from '../db/db';
import { finalizeStaleDrafts } from '../db/ledger';
import { addDays, businessDate } from '../domain/businessDate';
import { now, nowIso, setClockOffset } from './clock';

/** Longer than the register's undo window, so the engine never races it. */
const UNDO_GRACE_MS = 30_000;

export interface EngineOptions {
  /** How often to sync when nothing else triggers it. */
  intervalMs?: number;
  /** For tests: replaces Math.random in backoff jitter. */
  random?: () => number;
}

const MAX_BACKOFF_MS = 30_000;
const PUSH_BATCH = 50;
/** Synced documents older than this many business days are dropped from the tablet. */
const KEEP_DAYS = 3;

/** The server stored some documents but asked for the rest again later. */
class RetryLater extends Error {}

export class SyncEngine {
  private running: Promise<void> | null = null;
  private rerun = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private stopped = true;
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly db: PosDB,
    private readonly opts: EngineOptions = {},
  ) {}

  /** Starts syncing now, on reconnect, when the app comes back to the foreground, and on a timer. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const kick = () => void this.syncNow();
    const onVisible = () => document.visibilityState === 'visible' && kick();
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', onVisible);
    this.cleanup = [
      () => window.removeEventListener('online', kick),
      () => document.removeEventListener('visibilitychange', onVisible),
    ];
    kick();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
  }

  /** Syncs now. If a sync is already running, another runs right after it. */
  syncNow(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async loop(): Promise<void> {
    do {
      this.rerun = false;
      await this.once();
    } while (this.rerun);
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const interval = this.opts.intervalMs ?? 30_000;
    let delay = interval;
    if (this.failures > 0) {
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.failures - 1));
      delay = Math.min(interval, backoff * (0.5 + (this.opts.random ?? Math.random)()));
    }
    this.timer = setTimeout(() => void this.syncNow(), delay);
  }

  private async once(): Promise<void> {
    const device = await this.db.getMeta('device');
    if (!device) return;
    // An order left in its undo window (the app was closed, say) still ships.
    await finalizeStaleDrafts(UNDO_GRACE_MS).catch(() => {});
    try {
      await this.push(device.token);
      await this.pull(device.token);
      this.failures = 0;
      await this.setStatus({ state: 'idle', lastSyncAt: nowIso(), lastError: null });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // The device was revoked. Keep its data; a manager can re-enroll it.
        this.failures = 0;
        await this.setStatus({ state: 'unauthorized', lastError: e.message });
      } else {
        this.failures++;
        await this.setStatus({ state: e instanceof NetworkError ? 'offline' : 'error', lastError: errorMessage(e) });
      }
    }
  }

  private async setStatus(patch: Partial<SyncStatus>): Promise<void> {
    const prev = (await this.db.getMeta('syncStatus')) ?? { state: 'idle', lastSyncAt: null, lastError: null };
    await this.db.setMeta('syncStatus', { ...prev, ...patch });
  }

  /**
   * Sends the outbox, oldest first. Stored documents leave the outbox (and
   * get their server sequence number); rejected ones move to the dead-letter
   * list; anything the server asks to retry stays, in order.
   */
  private async push(token: string): Promise<void> {
    const { db } = this;
    for (let round = 0; round < 20; round++) {
      const batch = await db.outbox.orderBy('seq').limit(PUSH_BATCH).toArray();
      if (batch.length === 0) return;
      const body: PushRequest = { mutations: batch.map((m) => ({ id: m.id, kind: m.kind, doc: m.doc })) };
      const res = await api<{ results: PushResult[] }>('POST', '/sync/push', { auth: { token }, body });
      const results = new Map(res.results.map((r) => [r.id, r]));
      let retry: string | null = null;
      await db.transaction('rw', [db.outbox, db.deadLetters, db.orders, db.refunds], async () => {
        for (const item of batch) {
          const r = results.get(item.id);
          if (!r || r.status === 'retry') {
            retry ??= r?.error ?? 'the server skipped this document';
            await db.outbox.update(item.seq!, { attempts: item.attempts + 1, lastError: retry });
            continue;
          }
          await db.outbox.delete(item.seq!);
          if (r.status === 'rejected') {
            await db.deadLetters.put({ id: item.id, kind: item.kind, doc: item.doc, error: r.error ?? 'rejected', rejectedAt: nowIso() });
          } else {
            await (item.kind === 'order' ? db.orders : db.refunds).update(item.id, { seq: r.seq ?? null });
          }
        }
      });
      if (retry) throw new RetryLater(retry);
    }
  }

  private async pull(token: string): Promise<void> {
    // A page limit keeps a huge backlog from monopolizing the loop.
    for (let page = 0; page < 20; page++) {
      const [menuVersion, staffVersion, settings, cursor, pending, open] = await Promise.all([
        this.db.getMeta('menuVersion'),
        this.db.getMeta('staffVersion'),
        this.db.getMeta('settings'),
        this.db.getMeta('cursor'),
        this.db.outbox.count(),
        this.db.drafts.count(),
      ]);
      const params = new URLSearchParams({
        menu: String(menuVersion ?? 0),
        staff: String(staffVersion ?? 0),
        settings: String(settings?.version ?? 0),
        cursor: String(cursor ?? 0),
        pending: String(pending),
        open: String(open),
      });
      const sent = Date.now();
      const res = await api<PullResponse>('GET', `/sync/pull?${params}`, { auth: { token } });
      // Assume the server stamped its time halfway through the round trip.
      const offset = Date.parse(res.serverTime) - (sent + Date.now()) / 2;
      setClockOffset(offset);
      await this.applyPull(res, offset);
      if (!res.ledger.hasMore) return;
    }
  }

  private async applyPull(res: PullResponse, offset: number): Promise<void> {
    const { db } = this;
    await db.transaction('rw', [db.meta, db.menus, db.staff, db.drafts, db.orders, db.refunds], async () => {
      const meta: Partial<MetaMap> = { clockOffsetMs: offset, cursor: res.ledger.cursor };
      if (res.menu) {
        await db.menus.put(res.menu);
        meta.menuVersion = res.menu.version;
        // Keep older versions only while an open order still uses them.
        const inUse = new Set((await db.drafts.toArray()).map((d) => d.menuVersion));
        const stale = (await db.menus.toCollection().primaryKeys()).filter(
          (v) => v < res.menu!.version && !inUse.has(v),
        );
        await db.menus.bulkDelete(stale);
      }
      if (res.staff) {
        await db.staff.clear();
        await db.staff.bulkPut(res.staff.members);
        meta.staffVersion = res.staff.version;
      }
      if (res.settings) meta.settings = res.settings;
      await db.meta.bulkPut(Object.entries(meta).map(([key, value]) => ({ key: key as keyof MetaMap, value })));

      // Every device's documents, as the server stored them.
      for (const e of res.ledger.entries) {
        if (e.kind === 'order') await db.orders.put({ ...e.doc, seq: e.seq });
        else await db.refunds.put({ ...e.doc, seq: e.seq });
      }

      // Forget synced documents from long ago; unsynced ones always stay.
      const settings = res.settings ?? (await db.getMeta('settings'));
      if (settings) {
        const cutoff = addDays(businessDate(now(), settings.timezone, settings.dayCutoffMinutes), -KEEP_DAYS);
        await db.orders.where('businessDate').below(cutoff).filter((o) => o.seq !== null).delete();
        await db.refunds.where('businessDate').below(cutoff).filter((r) => r.seq !== null).delete();
      }
    });
  }
}
