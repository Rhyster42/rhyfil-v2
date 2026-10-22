// Shared test helpers: a fake server, seeded devices and staff, menus.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import type { Settings, StaffMember } from '../api/types';
import { db } from '../db/db';
import type { MenuDoc } from '../domain/menu';
import { hashPin } from '../domain/pin';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The menu the shared vectors use (testdata/vectors/menu.json). */
export function vectorMenu(): MenuDoc {
  return JSON.parse(readFileSync(resolve(root, 'testdata/vectors/menu.json'), 'utf8')) as MenuDoc;
}

/** The demo menu the server seeds (internal/seed/demo_menu.json). */
export function demoMenu(): MenuDoc {
  return JSON.parse(readFileSync(resolve(root, 'internal/seed/demo_menu.json'), 'utf8')) as MenuDoc;
}

export const testSettings: Settings = {
  storeName: 'Test Coffee',
  timezone: 'America/New_York',
  currency: 'USD',
  dayCutoffMinutes: 240,
  defaultFloat: 15000,
  version: 1,
};

export const device = { id: '0190f0d6-0000-7000-8000-00000000000a', name: 'Front', code: 'A', token: 'device-token' };

// Cheap verifiers keep tests fast; production uses 100,000 iterations.
const verifiers = new Map<string, Promise<string>>();
function verifier(pin: string) {
  if (!verifiers.has(pin)) verifiers.set(pin, hashPin(pin, 1000));
  return verifiers.get(pin)!;
}

export const staffIds = {
  sam: '0190f0d6-0000-7000-8000-000000000001',
  morgan: '0190f0d6-0000-7000-8000-000000000002',
  jo: '0190f0d6-0000-7000-8000-000000000003',
};

/** Sam (barista, 1111), Morgan (manager, 1234) and Jo (inactive). */
export async function seedStaff(): Promise<StaffMember[]> {
  const staff: StaffMember[] = [
    { id: staffIds.sam, name: 'Sam', role: 'barista', active: true, pinVerifier: await verifier('1111') },
    { id: staffIds.morgan, name: 'Morgan', role: 'manager', active: true, pinVerifier: await verifier('1234') },
    { id: staffIds.jo, name: 'Jo', role: 'barista', active: false, pinVerifier: null },
  ];
  await db.staff.bulkPut(staff);
  return staff;
}

/** An enrolled tablet with a menu, settings and staff, nobody signed in. */
export async function seedTablet(menu: MenuDoc = vectorMenu(), menuVersion = 1): Promise<void> {
  await db.setMeta('device', device);
  await db.setMeta('settings', testSettings);
  await db.menus.put({ version: menuVersion, doc: menu });
  await db.setMeta('menuVersion', menuVersion);
  await seedStaff();
}

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

export type FakeHandler = (req: FakeRequest) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

/**
 * Replaces fetch with a fake server. Routes are "METHOD /api/path"; a handler
 * that throws simulates a network failure.
 */
export function fakeServer(routes: Record<string, FakeHandler>) {
  const requests: FakeRequest[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://pos.test');
    const req: FakeRequest = {
      method: init.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: { ...(init.headers as Record<string, string>) },
    };
    requests.push(req);
    const handler = routes[`${req.method} ${req.path}`];
    if (!handler) {
      return new Response(JSON.stringify({ code: 'not_found', message: `no fake for ${req.method} ${req.path}` }), { status: 404 });
    }
    let res;
    try {
      res = await handler(req);
    } catch {
      throw new TypeError('fetch failed');
    }
    const status = res.status ?? 200;
    return new Response(status === 204 || res.body === undefined ? null : JSON.stringify(res.body), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, fetchMock };
}

/** A network that's down. */
export function offline(): never {
  throw new Error('offline');
}
