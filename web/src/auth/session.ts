// Signing staff in and out of this tablet. Sign-in is checked locally so it
// works offline (docs/decisions/0010); managers also get a back-office
// session from the server when they can.
import { api } from '../api/client';
import type { ManagerSessionResponse, StaffMember } from '../api/types';
import { db } from '../db/db';
import { verifyPin } from '../domain/pin';
import { nowIso } from '../sync/clock';

export async function signIn(staff: StaffMember, pin: string): Promise<void> {
  await db.setMeta('session', { staffId: staff.id, signedInAt: nowIso() });
  if (staff.role === 'manager') void openManagerSession(staff.id, pin);
}

/** Asks the server for a back-office session. Returns false if it can't. */
export async function openManagerSession(staffId: string, pin: string): Promise<boolean> {
  const device = await db.getMeta('device');
  if (!device) return false;
  try {
    const res = await api<ManagerSessionResponse>('POST', '/sessions', {
      auth: { token: device.token },
      body: { staffId, pin },
    });
    await db.setMeta('managerSession', { token: res.token, staffId, expiresAt: res.expiresAt });
    return true;
  } catch {
    return false;
  }
}

export async function signOut(): Promise<void> {
  const [device, managerSession] = await Promise.all([db.getMeta('device'), db.getMeta('managerSession')]);
  await db.transaction('rw', db.meta, async () => {
    await db.deleteMeta('session');
    await db.deleteMeta('managerSession');
  });
  if (device && managerSession) {
    void api('DELETE', '/sessions', { auth: { token: device.token, session: managerSession.token } }).catch(() => {});
  }
}

/** Finds the active manager whose PIN this is, for approvals. */
export async function findManagerByPin(pin: string): Promise<StaffMember | null> {
  const managers = (await db.staff.toArray()).filter((s) => s.active && s.role === 'manager' && s.pinVerifier);
  for (const m of managers) {
    if (await verifyPin(m.pinVerifier!, pin)) return m;
  }
  return null;
}
