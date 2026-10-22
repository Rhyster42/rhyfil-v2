import { useLiveQuery } from 'dexie-react-hooks';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { db } from '../db/db';

const HOUR = 60 * 60 * 1000;

/**
 * Offers a downloaded app update, but only while no order is open: a reload
 * mid-order would interrupt a customer (docs/decisions/0015).
 */
export function UpdateBanner() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (registration) setInterval(() => void registration.update(), HOUR);
    },
  });
  const openOrders = useLiveQuery(() => db.drafts.count(), []);
  if (!needRefresh || openOrders !== 0) return null;
  return (
    <div className="banner banner-ok" role="status">
      <span>A new version of the app is ready.</span>
      <button type="button" className="btn btn-sm" onClick={() => void updateServiceWorker(true)}>
        Update now
      </button>
    </div>
  );
}
