import { describe, expect, test } from 'vitest';
import type { PullResponse } from '../api/types';
import { db } from '../db/db';
import { device, fakeServer, offline, testSettings, vectorMenu } from '../test/fixtures';
import { now } from './clock';
import { SyncEngine } from './engine';

function pullResponse(patch: Partial<PullResponse> = {}): PullResponse {
  return {
    serverTime: new Date().toISOString(),
    menu: null,
    staff: null,
    settings: null,
    ledger: { entries: [], cursor: 0, hasMore: false },
    ...patch,
  };
}

const sam = { id: 's1', name: 'Sam', role: 'barista' as const, active: true, pinVerifier: 'v' };

async function enrolled() {
  await db.setMeta('device', device);
  return new SyncEngine(db);
}

describe('pull', () => {
  test('stores the catalog, then sends the versions it has', async () => {
    const engine = await enrolled();
    const { requests } = fakeServer({
      'GET /api/sync/pull': ({ query }) =>
        query.get('menu') === '0'
          ? {
              body: pullResponse({
                menu: { version: 3, doc: vectorMenu() },
                staff: { version: 2, members: [sam] },
                settings: { ...testSettings, version: 5 },
              }),
            }
          : { body: pullResponse() },
    });

    await engine.syncNow();
    expect(requests[0]!.headers.Authorization).toBe('Bearer device-token');
    expect(Object.fromEntries(requests[0]!.query)).toEqual({ menu: '0', staff: '0', settings: '0', cursor: '0', pending: '0', open: '0' });
    expect(await db.getMeta('menuVersion')).toBe(3);
    expect((await db.menus.get(3))?.doc.items).toHaveLength(5);
    expect(await db.staff.toArray()).toEqual([sam]);
    expect((await db.getMeta('settings'))?.version).toBe(5);
    expect((await db.getMeta('syncStatus'))?.state).toBe('idle');

    await engine.syncNow();
    expect(Object.fromEntries(requests[1]!.query)).toMatchObject({ menu: '3', staff: '2', settings: '5' });
    expect(await db.staff.count()).toBe(1);
  });

  test('replaces the staff list rather than merging it', async () => {
    const engine = await enrolled();
    await db.staff.put({ ...sam, id: 'gone' });
    fakeServer({ 'GET /api/sync/pull': () => ({ body: pullResponse({ staff: { version: 9, members: [sam] } }) }) });
    await engine.syncNow();
    expect((await db.staff.toArray()).map((s) => s.id)).toEqual(['s1']);
  });

  test('measures the clock offset from the server time', async () => {
    const engine = await enrolled();
    fakeServer({
      'GET /api/sync/pull': () => ({ body: pullResponse({ serverTime: new Date(Date.now() + 60_000).toISOString() }) }),
    });
    await engine.syncNow();
    const offset = (await db.getMeta('clockOffsetMs'))!;
    expect(offset).toBeGreaterThan(59_000);
    expect(offset).toBeLessThan(61_000);
    expect(now().getTime() - Date.now()).toBeGreaterThan(59_000);
  });

  test('keeps older menus only while an open order uses them', async () => {
    const engine = await enrolled();
    let version = 3;
    fakeServer({ 'GET /api/sync/pull': () => ({ body: pullResponse({ menu: { version, doc: vectorMenu() } }) }) });
    await engine.syncNow();
    await db.drafts.put({ id: 'd1', menuVersion: 3 } as never);

    version = 4;
    await engine.syncNow();
    expect(await db.menus.toCollection().primaryKeys()).toEqual([3, 4]);

    await db.drafts.clear();
    version = 5;
    await engine.syncNow();
    expect(await db.menus.toCollection().primaryKeys()).toEqual([5]);
  });

  test('follows the ledger cursor across pages', async () => {
    const engine = await enrolled();
    const { requests } = fakeServer({
      'GET /api/sync/pull': ({ query }) => ({
        body: pullResponse({
          ledger: query.get('cursor') === '0' ? { entries: [], cursor: 100, hasMore: true } : { entries: [], cursor: 150, hasMore: false },
        }),
      }),
    });
    await engine.syncNow();
    expect(requests.map((r) => r.query.get('cursor'))).toEqual(['0', '100']);
    expect(await db.getMeta('cursor')).toBe(150);
  });
});

describe('failures', () => {
  test('no network means offline, not an error', async () => {
    const engine = await enrolled();
    fakeServer({ 'GET /api/sync/pull': offline });
    await engine.syncNow();
    expect((await db.getMeta('syncStatus'))?.state).toBe('offline');
  });

  test('a revoked device is unauthorized and keeps its data', async () => {
    const engine = await enrolled();
    await db.setMeta('menuVersion', 1);
    fakeServer({ 'GET /api/sync/pull': () => ({ status: 401, body: { code: 'device_unknown', message: 'removed' } }) });
    await engine.syncNow();
    expect((await db.getMeta('syncStatus'))?.state).toBe('unauthorized');
    expect(await db.getMeta('menuVersion')).toBe(1);
  });

  test('does nothing before the device is enrolled', async () => {
    const { requests } = fakeServer({});
    await new SyncEngine(db).syncNow();
    expect(requests).toHaveLength(0);
  });
});
