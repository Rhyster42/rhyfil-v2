import { useLiveQuery } from 'dexie-react-hooks';
import { db, useMeta } from '../db/db';
import { engine } from './services';

/** Always-visible sync state: are we online, and is anything waiting? */
export function SyncPill() {
  const status = useMeta('syncStatus');
  const pending = useLiveQuery(() => db.outbox.count(), []) ?? 0;
  const problems = useLiveQuery(() => db.deadLetters.count(), []) ?? 0;
  const state = status?.state ?? 'idle';

  let label: string;
  let tone: 'ok' | 'warn' | 'bad';
  switch (state) {
    case 'unauthorized':
      label = 'Device removed';
      tone = 'bad';
      break;
    case 'offline':
      label = pending ? `Offline · ${pending} waiting` : 'Offline';
      tone = 'warn';
      break;
    case 'error':
      label = pending ? `Sync error · ${pending} waiting` : 'Sync error';
      tone = 'bad';
      break;
    default:
      label = pending ? `Sending ${pending}…` : 'Synced';
      tone = 'ok';
  }
  if (problems) {
    label += ` · ${problems} rejected`;
    tone = 'bad';
  }
  const title = [
    status?.lastSyncAt ? `Last synced ${new Date(status.lastSyncAt).toLocaleTimeString()}` : 'Not synced yet',
    status?.lastError,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <button type="button" className={`pill pill-${tone}`} title={title} onClick={() => void engine.syncNow()}>
      <span className="pill-dot" aria-hidden="true" />
      {label}
    </button>
  );
}
