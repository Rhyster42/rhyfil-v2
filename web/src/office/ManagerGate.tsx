import { useLiveQuery } from 'dexie-react-hooks';
import type { ReactNode } from 'react';
import { requestManagerSession } from '../auth/session';
import { db, useMeta } from '../db/db';
import { PinPad } from '../ui/PinPad';

/**
 * The back office needs a manager session from the server. The PIN is
 * checked by the server (which counts wrong guesses), so it's only sent when
 * the manager taps OK.
 */
export function ManagerGate({ staffId, children }: { staffId: string; children: ReactNode }) {
  const session = useMeta('managerSession');
  const me = useLiveQuery(() => db.staff.get(staffId), [staffId]);
  if (session === undefined) return null;
  if (session && session.staffId === staffId && Date.parse(session.expiresAt) > Date.now()) return <>{children}</>;
  return (
    <div className="center-page">
      <div className="card gate-card">
        <PinPad
          auto={false}
          title="Back office"
          hint={`${me?.name ?? 'Manager'}, enter your PIN. The back office needs a connection.`}
          check={(pin) => requestManagerSession(staffId, pin)}
          onAccept={() => {}}
        />
      </div>
    </div>
  );
}
