import { useState, type ReactNode } from 'react';
import { addDays } from '../domain/businessDate';
import { formatMoney } from '../domain/money';
import { HourlyChart } from './HourlyChart';
import { useOffice } from './officeApi';
import type { ReasonRow, Report } from './types';

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

const PRESETS: [Preset, string][] = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'Last 7 days'],
  ['month', 'This month'],
  ['custom', 'Custom'],
];

function rangeFor(p: Preset, today: string, custom: { from: string; to: string }) {
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'week':
      return { from: addDays(today, -6), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'custom':
      return custom;
  }
}

function Tile({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {detail && <span className="tile-detail">{detail}</span>}
    </div>
  );
}

function Reasons({ title, rows }: { title: string; rows: ReasonRow[] }) {
  if (!rows.length) return null;
  return (
    <>
      <tr className="group-row">
        <th colSpan={3}>{title}</th>
      </tr>
      {rows.map((r) => (
        <tr key={title + r.reason}>
          <td>{r.reason}</td>
          <td className="num">{r.count}</td>
          <td className="num">{formatMoney(r.amount)}</td>
        </tr>
      ))}
    </>
  );
}

/** Sales for a range of business dates (docs/decisions/0017). */
export function ReportsTab({ today, onReviewFlags }: { today: string; onReviewFlags: () => void }) {
  const [preset, setPreset] = useState<Preset>('today');
  const [custom, setCustom] = useState({ from: today, to: today });
  const range = rangeFor(preset, today, custom);
  const { data: rep, error, loading } = useOffice<Report>(`/reports/sales?from=${range.from}&to=${range.to}`);
  const s = rep?.summary;
  const ex = rep?.exceptions;

  return (
    <div className="office-page">
      <div className="filter-row">
        <div className="segmented" role="tablist" aria-label="Date range">
          {PRESETS.map(([p, label]) => (
            <button key={p} type="button" role="tab" aria-selected={preset === p} onClick={() => setPreset(p)}>
              {label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <span className="date-range">
            <input className="input" type="date" aria-label="From" value={custom.from} max={today} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
            <span className="muted">to</span>
            <input className="input" type="date" aria-label="To" value={custom.to} max={today} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
          </span>
        )}
        <span className="muted range-note">
          {range.from === range.to ? range.from : `${range.from} – ${range.to}`} · business days start at the cutoff
        </span>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}

      {rep && s && ex && (
        <div className={loading ? 'refreshing' : undefined}>
          <section className="kpis" aria-label="Summary">
            <div className="hero">
              <span className="tile-label">Net sales</span>
              <span className="hero-value">{formatMoney(s.netSales)}</span>
              <span className="tile-detail">
                {s.orders} {s.orders === 1 ? 'order' : 'orders'} · {formatMoney(s.averageTicket)} average ticket
              </span>
            </div>
            <div className="tiles">
              <Tile label="Collected" value={formatMoney(s.collected)} detail="Payments kept, less refunds" />
              <Tile label="Sales tax" value={formatMoney(s.netTax)} detail={s.refundedTax ? `after ${formatMoney(s.refundedTax)} refunded` : 'net of refunds'} />
              <Tile label="Refunds" value={formatMoney(s.refunds)} detail={`${s.refundCount} ${s.refundCount === 1 ? 'refund' : 'refunds'}`} />
              <Tile label="Voids" value={s.voidedLines + s.voidedOrders} detail={`${s.voidedLines} lines · ${s.voidedOrders} orders · ${s.reversals} reversed payments`} />
              {s.openFlags > 0 && (
                <button type="button" className="tile tile-status-warn" onClick={onReviewFlags}>
                  <span className="tile-label">
                    <span aria-hidden="true">⚠</span> Needs review
                  </span>
                  <span className="tile-value">{s.openFlags}</span>
                  <span className="tile-detail">flagged {s.openFlags === 1 ? 'document' : 'documents'}</span>
                </button>
              )}
            </div>
          </section>

          <HourlyChart hours={rep.hours} />

          <div className="report-grid">
            <section>
              <h3>Payments</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Tender</th>
                    <th className="num">Payments</th>
                    <th className="num">Taken</th>
                    <th className="num">Refunded</th>
                    <th className="num">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {rep.tenders.map((t) => (
                    <tr key={t.tender}>
                      <td>{t.tender === 'card' ? 'Card' : 'Cash'}</td>
                      <td className="num">{t.payments}</td>
                      <td className="num">{formatMoney(t.taken)}</td>
                      <td className="num">{formatMoney(t.refunded)}</td>
                      <td className="num">{formatMoney(t.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section>
              <h3>Categories</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="num">Sold</th>
                    <th className="num">Net sales</th>
                  </tr>
                </thead>
                <tbody>
                  {rep.categories.map((c) => (
                    <tr key={c.category}>
                      <td>{c.category}</td>
                      <td className="num">{c.qty}</td>
                      <td className="num">{formatMoney(c.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="wide">
              <h3>Items</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Sold</th>
                    <th className="num">Gross</th>
                    <th className="num">Refunded</th>
                    <th className="num">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {rep.items.map((i) => (
                    <tr key={i.itemId}>
                      <td>
                        {i.name} <span className="muted">· {i.category}</span>
                      </td>
                      <td className="num">{i.qty}</td>
                      <td className="num">{formatMoney(i.gross)}</td>
                      <td className="num">{i.refundedQty ? `${i.refundedQty} · ${formatMoney(i.refunded)}` : '—'}</td>
                      <td className="num">{formatMoney(i.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section>
              <h3>Modifiers</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Option</th>
                    <th className="num">Chosen</th>
                    <th className="num">Added</th>
                  </tr>
                </thead>
                <tbody>
                  {rep.modifiers.map((m) => (
                    <tr key={m.optionId}>
                      <td>
                        {m.option} <span className="muted">· {m.group}</span>
                      </td>
                      <td className="num">{m.count}</td>
                      <td className="num">{formatMoney(m.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section>
              <h3>Voids, reversals and refunds</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Reason</th>
                    <th className="num">Count</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <Reasons title="Lines removed" rows={ex.lineVoids} />
                  <Reasons title="Orders voided" rows={ex.orderVoids} />
                  <Reasons title="Payments given back" rows={ex.reversals} />
                  <Reasons title="Refunds" rows={ex.refunds} />
                  {!ex.lineVoids.length && !ex.orderVoids.length && !ex.reversals.length && !ex.refunds.length && (
                    <tr>
                      <td colSpan={3} className="muted">
                        None.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>

            <section className="wide">
              <h3>Staff</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="num">Orders</th>
                    <th className="num">Sales</th>
                    <th className="num">Lines removed</th>
                    <th className="num">Orders voided</th>
                    <th className="num">Given back</th>
                    <th className="num">Refunds / approved</th>
                  </tr>
                </thead>
                <tbody>
                  {rep.staff.map((p) => (
                    <tr key={p.staffId}>
                      <td>{p.name}</td>
                      <td className="num">{p.orders}</td>
                      <td className="num">{formatMoney(p.gross)}</td>
                      <td className="num">{p.voidedLines ? `${p.voidedLines} · ${formatMoney(p.voidedLineAmount)}` : '—'}</td>
                      <td className="num">{p.voidedOrders || '—'}</td>
                      <td className="num">{p.reversals ? `${p.reversals} · ${formatMoney(p.reversalAmount)}` : '—'}</td>
                      <td className="num">
                        {p.refundsIssued || p.refundsApproved ? `${p.refundsIssued} / ${p.refundsApproved}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
