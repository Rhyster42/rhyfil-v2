// The back office talks to the server directly: it needs every device's
// data, so it is online-only (docs/decisions/0001).
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from '../api/client';
import { db } from '../db/db';

/** The manager session ended; the gate asks for the PIN again. */
export class SessionExpired extends Error {
  constructor() {
    super('Your back-office session ended. Enter your PIN again.');
  }
}

export async function officeApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const [device, session] = await Promise.all([db.getMeta('device'), db.getMeta('managerSession')]);
  if (!device) throw new Error('This tablet is not enrolled.');
  if (!session || Date.parse(session.expiresAt) <= Date.now()) {
    await db.deleteMeta('managerSession');
    throw new SessionExpired();
  }
  try {
    return await api<T>(method, path, { body, auth: { token: device.token, session: session.token } });
  } catch (e) {
    if (e instanceof ApiError && e.code === 'session_invalid') {
      await db.deleteMeta('managerSession');
      throw new SessionExpired();
    }
    throw e;
  }
}

export interface OfficeData<T> {
  data?: T;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads back-office data. While it reloads, the previous data stays on
 * screen (dimmed by the caller) rather than flashing empty.
 */
export function useOffice<T>(path: string | null): OfficeData<T> {
  const [state, setState] = useState<{ data?: T; error: string | null; loading: boolean }>({ error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    officeApi<T>('GET', path).then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e: unknown) => live && setState((s) => ({ ...s, error: errorMessage(e), loading: false })),
    );
    return () => {
      live = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
