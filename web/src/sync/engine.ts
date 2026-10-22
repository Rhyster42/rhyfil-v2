// The only register code that talks to the network (docs/decisions/0001):
// it pushes the outbox and pulls the menu, staff, settings and ledger.
import { api, ApiError, errorMessage, NetworkError } from '../api/client';
import type { PullResponse } from '../api/types';
import type { MetaMap, PosDB, SyncStatus } from '../db/db';
import { nowIso, setClockOffset } from './clock';

export interface EngineOptions {
  /** How often to sync when nothing else triggers it. */
  intervalMs?: number;
  /** For tests: replaces Math.random in backoff jitter. */
  random?: () => number;
}

const MAX_BACKOFF_MS = 30_000;

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
    try {
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
    await db.transaction('rw', [db.meta, db.menus, db.staff, db.drafts], async () => {
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
    });
  }
}
