import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import type { StaffMember } from '../api/types';
import { SyncPill } from '../app/SyncPill';
import { db, useMeta } from '../db/db';
import { verifyPin } from '../domain/pin';
import { PinPad } from '../ui/PinPad';
import { Sheet } from '../ui/Sheet';
import { signIn } from './session';
import { DeviceRemovedBanner } from './DeviceRemovedBanner';

/** Tap your name, enter your PIN. Checked on the tablet, so it works offline. */
export function SignInScreen() {
  const staff = useLiveQuery(() => db.staff.toArray(), []);
  const settings = useMeta('settings');
  const [selected, setSelected] = useState<StaffMember | null>(null);
  const people = (staff ?? []).filter((s) => s.active && s.pinVerifier).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="signin-page">
      <DeviceRemovedBanner />
      <header className="signin-header">
        <h1>{settings?.storeName ?? 'Coffee POS'}</h1>
        <SyncPill />
      </header>
      <main className="center-page">
        {staff === undefined ? null : people.length === 0 ? (
          <div className="card">
            <h2>Waiting for the staff list</h2>
            <p className="muted">It arrives with the first sync. Check the connection if this takes more than a few seconds.</p>
          </div>
        ) : (
          <div className="staff-grid">
            {people.map((s) => (
              <button key={s.id} type="button" className="staff-tile" onClick={() => setSelected(s)}>
                <span className="avatar" aria-hidden="true">
                  {s.name.charAt(0).toUpperCase()}
                </span>
                {s.name}
                {s.role === 'manager' && <span className="muted tile-sub">Manager</span>}
              </button>
            ))}
          </div>
        )}
      </main>
      {selected && (
        <Sheet onClose={() => setSelected(null)}>
          <PinPad
            title={`Hi, ${selected.name}`}
            hint="Enter your PIN"
            check={(pin) => verifyPin(selected.pinVerifier!, pin)}
            onAccept={(pin) => void signIn(selected, pin)}
            onCancel={() => setSelected(null)}
          />
        </Sheet>
      )}
    </div>
  );
}
