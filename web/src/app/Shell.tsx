import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect } from 'react';
import { DeviceRemovedBanner } from '../auth/DeviceRemovedBanner';
import { signOut } from '../auth/session';
import { db, useMeta } from '../db/db';
import { useRoute } from './route';
import { SyncPill } from './SyncPill';

/** The signed-in frame: navigation, sync state, who's on the tablet. */
export function Shell({ staffId }: { staffId: string }) {
  const [route, navigate] = useRoute();
  const me = useLiveQuery(() => db.staff.get(staffId), [staffId]);
  const settings = useMeta('settings');
  const device = useMeta('device');

  // Someone deactivated since they signed in gets signed out.
  useEffect(() => {
    if (me && !me.active) void signOut();
  }, [me]);

  const isManager = me?.role === 'manager';
  return (
    <div className="shell">
      <DeviceRemovedBanner />
      <header className="topbar">
        <span className="brand">{settings?.storeName ?? 'Coffee POS'}</span>
        <nav className="topnav">
          <button type="button" className="nav-btn" aria-current={route.screen === 'register' ? 'page' : undefined} onClick={() => navigate({ screen: 'register' })}>
            Register
          </button>
          <button type="button" className="nav-btn" aria-current={route.screen === 'orders' ? 'page' : undefined} onClick={() => navigate({ screen: 'orders' })}>
            Orders
          </button>
          {isManager && (
            <button type="button" className="nav-btn" aria-current={route.screen === 'office' ? 'page' : undefined} onClick={() => navigate({ screen: 'office', tab: 'reports' })}>
              Back office
            </button>
          )}
        </nav>
        <SyncPill />
        <span className="who" title={device ? `${device.name} (${device.code})` : undefined}>
          {me?.name}
        </span>
        <button type="button" className="nav-btn" onClick={() => void signOut()}>
          Lock
        </button>
      </header>
      <main className="main">
        {route.screen === 'register' && <div className="placeholder">The register arrives in milestone 4.</div>}
        {route.screen === 'orders' && <div className="placeholder">Order history arrives in milestone 6.</div>}
        {route.screen === 'office' && <div className="placeholder">The back office arrives in milestone 7.</div>}
      </main>
    </div>
  );
}
