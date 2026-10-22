import { useLiveQuery } from 'dexie-react-hooks';
import { db, useMeta } from '../db/db';

/**
 * Shown when the server no longer recognizes this tablet. Re-enrolling gives
 * it a new identity; documents it never sent stay visible as rejected so
 * nothing disappears silently.
 */
export function DeviceRemovedBanner() {
  const status = useMeta('syncStatus');
  const pending = useLiveQuery(() => db.outbox.count(), []) ?? 0;
  if (status?.state !== 'unauthorized') return null;

  async function reenroll() {
    const warning = pending
      ? `${pending} order(s) haven't reached the server and will be marked as rejected. Continue?`
      : 'Re-enroll this tablet?';
    if (!window.confirm(warning)) return;
    await db.transaction('rw', db.meta, async () => {
      await db.deleteMeta('device');
      await db.deleteMeta('session');
      await db.deleteMeta('managerSession');
      await db.deleteMeta('syncStatus');
      await db.deleteMeta('cursor');
    });
  }

  return (
    <div className="banner banner-danger" role="alert">
      This tablet was removed from the POS, so it can't sync.
      <button type="button" className="btn btn-sm" onClick={() => void reenroll()}>
        Re-enroll
      </button>
    </div>
  );
}
