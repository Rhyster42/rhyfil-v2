import { useState } from 'react';
import type { StaffMember } from '../api/types';
import type { OrderDoc, RefundDoc } from '../domain/documents';
import { formatMoney } from '../domain/money';
import { modSummary } from '../domain/order';
import { refundState } from '../domain/refund';
import { RefundSheet } from './RefundSheet';

interface OrderDetailProps {
  order: OrderDoc & { seq: number | null };
  refunds: (RefundDoc & { seq: number | null })[];
  staff: Map<string, StaffMember>;
  refused: Set<string>;
  staffId: string;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Everything that happened to an order, including what was voided, reversed and refunded. */
export function OrderDetail({ order, refunds, staff, refused, staffId }: OrderDetailProps) {
  const [refunding, setRefunding] = useState(false);
  const name = (id: string) => staff.get(id)?.name ?? 'Someone';
  const state = refundState(order, refunds);
  const canRefund = order.status === 'paid' && state.remaining > 0;

  return (
    <article className="order-detail" aria-label={`Order ${order.number}`}>
      <header className="detail-header">
        <div>
          <h2>{order.number}</h2>
          <p className="muted">
            {order.status === 'voided' ? 'Voided' : 'Closed'} {time(order.closedAt)} · {name(order.staffId)}
            {refused.has(order.id) ? ' · refused by the server' : order.seq === null ? ' · not sent yet' : ''}
          </p>
        </div>
        {canRefund && (
          <button type="button" className="btn btn-primary" onClick={() => setRefunding(true)}>
            Refund…
          </button>
        )}
      </header>

      {order.void && (
        <p className="banner banner-warn">
          Voided by {name(order.void.by)}: {order.void.reason}
        </p>
      )}

      <ul className="detail-lines">
        {order.lines.map((l) => (
          <li key={l.id} className={l.void ? 'voided' : undefined}>
            <span>
              {l.qty > 1 && `${l.qty}× `}
              {l.itemName}
              {l.mods.length > 0 && <small>{modSummary({ priced: l })}</small>}
              {l.void && (
                <small className="void-note">
                  Removed by {name(l.void.by)}: {l.void.reason}
                </small>
              )}
            </span>
            <span>{formatMoney(l.lineTotal)}</span>
          </li>
        ))}
      </ul>

      <dl className="detail-totals">
        <dt>Subtotal</dt>
        <dd>{formatMoney(order.subtotal)}</dd>
        <dt>Tax</dt>
        <dd>{formatMoney(order.tax)}</dd>
        <dt className="grand">Total</dt>
        <dd className="grand">{formatMoney(order.total)}</dd>
      </dl>

      {order.payments.length > 0 && (
        <section>
          <h3>Payments</h3>
          <ul className="detail-list">
            {order.payments.map((p) => (
              <li key={p.id} className={p.reversal ? 'voided' : undefined}>
                <span>
                  {p.tender === 'card' ? 'Card' : 'Cash'} {formatMoney(p.amount)}
                  {p.change > 0 && ` · gave ${formatMoney(p.tendered)}, change ${formatMoney(p.change)}`}
                  {p.reversal && (
                    <small className="void-note">
                      Given back by {name(p.reversal.by)}: {p.reversal.reason}
                    </small>
                  )}
                </span>
                <span className="muted">{time(p.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {refunds.length > 0 && (
        <section>
          <h3>Refunds</h3>
          <ul className="detail-list">
            {refunds.map((r) => (
              <li key={r.id}>
                <span>
                  −{formatMoney(r.amount)} {r.tender}
                  {r.lines.length > 0 &&
                    ` · ${r.lines.map((rl) => `${rl.qty}× ${order.lines.find((l) => l.id === rl.lineId)?.itemName ?? 'item'}`).join(', ')}`}
                  <small>
                    {r.reason} · {name(r.staffId)}, approved by {name(r.approvedBy)}
                    {refused.has(r.id) ? ' · refused by the server' : r.seq === null ? ' · not sent yet' : ''}
                  </small>
                </span>
                <span className="muted">{time(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {refunding && <RefundSheet order={order} refunds={refunds} staffId={staffId} onClose={() => setRefunding(false)} />}
    </article>
  );
}
