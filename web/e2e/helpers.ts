import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** Enrolls the page as a new tablet with the demo code and signs someone in. */
export async function enrollAndSignIn(page: Page, tablet: string, person: string, pin: string) {
  await page.goto('/');
  await page.getByLabel('Enrollment code').fill('DEMO');
  await page.getByLabel('Name this tablet').fill(tablet);
  await page.getByRole('button', { name: 'Add tablet' }).click();
  await page.getByRole('button', { name: new RegExp(person) }).click();
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
  await expect(page.getByRole('button', { name: /^Latte/ })).toBeVisible();
}

export const tap = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' }).click();

/** Waits for the undo window to pass so the last order is sent. */
export const waitForUndoWindow = (page: Page) => page.waitForTimeout(10_500);

/** A manager's view of the server, through its own enrolled API client. */
export async function managerApi(request: APIRequestContext) {
  const enroll = await request.post('/api/devices/enroll', { data: { code: 'DEMO', name: 'E2E checker' } });
  expect(enroll.ok()).toBeTruthy();
  const { token } = (await enroll.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };
  const pull = await (await request.get('/api/sync/pull', { headers: auth })).json();
  const morgan = pull.staff.members.find((m: { name: string }) => m.name === 'Morgan');
  const session = await request.post('/api/sessions', { headers: auth, data: { staffId: morgan.id, pin: '1234' } });
  expect(session.ok()).toBeTruthy();
  const headers = { ...auth, 'X-Session': ((await session.json()) as { token: string }).token };
  return {
    get: async <T>(path: string): Promise<T> => {
      const res = await request.get(`/api${path}`, { headers });
      expect(res.ok(), `${path}: ${res.status()}`).toBeTruthy();
      return (await res.json()) as T;
    },
    /** Every document in the server's ledger from the last two days. */
    ledger: async () => {
      const entries: { kind: string; doc: { deviceId: string; number?: string; status?: string; total?: number; amount?: number } }[] = [];
      let cursor = 0;
      for (;;) {
        const page = await (await request.get(`/api/sync/pull?cursor=${cursor}&menu=999&staff=999&settings=999`, { headers: auth })).json();
        entries.push(...page.ledger.entries);
        cursor = page.ledger.cursor;
        if (!page.ledger.hasMore) return entries;
      }
    },
  };
}
