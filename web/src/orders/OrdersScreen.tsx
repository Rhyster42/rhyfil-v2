import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import type { Route } from '../app/route';
import { db, useMeta } from '../db/db';
import { addDays, businessDate } from '../domain/businessDate';
import { formatMoney, sum } from '../domain/money';
import { now } from '../sync/clock';
import { OrderDetail } from './OrderDetail';

interface OrdersScreenProps {
  staffId: string;
  orderId?: string;
  navigate: (r: Route) => void;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * Recent orders from every tablet, read from this tablet's ledger, so looking
 * one up (and refunding it) works offline.
 */
export function OrdersScreen({ staffId, orderId, navigate }: OrdersScreenProps) {
  const settings = useMeta('settings');
  const today = settings ? businessDate(now(), settings.timezone, settings.dayCutoffMinutes) : null;
  const [daysBack, setDaysBack] = useState(0);
  const [search, setSearch] = useState('');
  const day = today ? addDays(today, -daysBack) : null;

  const data = useLiveQuery(async () => {
    if (!day) return null;
    const orders = await db.orders.where('businessDate').equals(day).toArray();
    const selected = orderId ? await db.orders.get(orderId) : undefined;
    const ids = [...orders.map((o) => o.id), ...(selected ? [selected.id] : [])];
    const refunds = await db.refunds.where('orderId').anyOf(ids).toArray();
    const refused = new Set((await db.deadLetters.toArray()).map((d) => d.id));
    const staff = new Map((await db.staff.toArray()).map((s) => [s.id, s]));
    return { orders, selected, refunds, refused, staff };
  }, [day, orderId]);

  if (!data) return <div className="placeholder">Loading…</div>;
  const q = search.trim().toLowerCase();
  const orders = data.orders
    .filter((o) => !q || o.number.toLowerCase().includes(q) || o.lines.some((l) => l.itemName.toLowerCase().includes(q)))
    .sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  const refundedOf = (id: string) => sum(data.refunds.filter((r) => r.orderId === id).map((r) => r.amount));

  return (
    <div className="orders">
      <section className="orders-list" aria-label="Orders">
        <div className="orders-toolbar">
          <div className="segmented" role="tablist">
            {['Today', 'Yesterday', '2 days ago'].map((label, i) => (
              <button key={label} type="button" role="tab" aria-selected={daysBack === i} onClick={() => setDaysBack(i)}>
                {label}
              </button>
            ))}
          </div>
          <input className="input" type="search" placeholder="Order number or item" aria-label="Search orders" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <ul>
          {orders.map((o) => {
            const refunded = refundedOf(o.id);
            return (
              <li key={o.id}>
                <button
                  type="button"
                  className={`order-row${o.id === orderId ? ' selected' : ''}`}
                  onClick={() => navigate({ screen: 'orders', orderId: o.id })}
                >
                  <span className="order-row-number">{o.number}</span>
                  <span className="order-row-main">
                    <span>{o.lines.filter((l) => !l.void).map((l) => (l.qty > 1 ? `${l.itemName} ×${l.qty}` : l.itemName)).join(', ') || 'No items'}</span>
                    <small className="muted">
                      {time(o.closedAt)} · {data.staff.get(o.staffId)?.name ?? '—'}
                    </small>
                  </span>
                  <span className="order-row-side">
                    <span>{formatMoney(o.total)}</span>
                    {o.status === 'voided' && <span className="badge">Voided</span>}
                    {refunded > 0 && <span className="badge badge-warn">{refunded >= o.total ? 'Refunded' : 'Part refunded'}</span>}
                    {data.refused.has(o.id) ? <span className="badge badge-bad">Refused</span> : o.seq === null && <span className="badge">Not sent</span>}
                  </span>
                </button>
              </li>
            );
          })}
          {orders.length === 0 && <li className="order-empty">{q ? 'No matching orders.' : 'No orders yet.'}</li>}
        </ul>
      </section>
      <section className="orders-detail">
        {data.selected ? (
          <OrderDetail
            key={data.selected.id}
            order={data.selected}
            refunds={data.refunds.filter((r) => r.orderId === data.selected!.id)}
            staff={data.staff}
            refused={data.refused}
            staffId={staffId}
          />
        ) : (
          <div className="placeholder">
            {orderId ? "That order isn't on this tablet (tablets keep the last few days)." : 'Choose an order.'}
          </div>
        )}
      </section>
    </div>
  );
}
