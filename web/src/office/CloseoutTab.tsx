import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { formatMoney } from '../domain/money';
import { MoneyInput } from '../ui/MoneyInput';
import { Sheet } from '../ui/Sheet';
import { officeApi, useOffice } from './officeApi';
import type { CloseoutStatus, DeviceSync, Summary } from './types';

const STALE_MS = 15 * 60 * 1000;

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Status with an icon and words, never color alone. */
function DeviceState({ d }: { d: DeviceSync }) {
  if (d.reportedPending > 0 || d.reportedOpen > 0) {
    return (
      <span className="status status-warn">
        <span aria-hidden="true">⚠</span> {d.reportedPending ? `${d.reportedPending} not sent` : ''}
        {d.reportedPending && d.reportedOpen ? ' · ' : ''}
        {d.reportedOpen ? `${d.reportedOpen} order open` : ''}
      </span>
    );
  }
  if (!d.lastSeenAt || Date.now() - Date.parse(d.lastSeenAt) > STALE_MS) {
    return (
      <span className="status status-warn">
        <span aria-hidden="true">⚠</span> Not seen {ago(d.lastSeenAt)}
      </span>
    );
  }
  return (
    <span className="status status-ok">
      <span aria-hidden="true">✓</span> Everything sent
    </span>
  );
}

const CHANGES: [keyof Summary, string, boolean][] = [
  ['orders', 'Orders', false],
  ['netSales', 'Net sales', true],
  ['netTax', 'Sales tax', true],
  ['refunds', 'Refunds', true],
  ['collected', 'Collected', true],
];

/** Close out a business day: count the drawers, keep a snapshot (docs/decisions/0017). */
export function CloseoutTab({ today, onReviewFlags }: { today: string; onReviewFlags: () => void }) {
  const [date, setDate] = useState(today);
  const { data: st, error, loading, reload } = useOffice<CloseoutStatus>(`/closeouts/${date}`);
  const [floats, setFloats] = useState<Record<string, number>>({});
  const [counted, setCounted] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // A new day starts with fresh counts.
  useEffect(() => {
    setFloats({});
    setCounted({});
    setNote('');
  }, [date]);

  async function close() {
    if (!st) return;
    setSaving(true);
    setSaveError(null);
    try {
      await officeApi('POST', `/closeouts/${date}`, {
        drawers: st.live.drawers.map((d) => ({
          deviceId: d.deviceId,
          openingFloat: floats[d.deviceId] ?? st.defaultFloat,
          counted: counted[d.deviceId] ?? 0,
        })),
        note,
      });
      setConfirming(false);
      reload();
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const s = st?.live.summary;
  const cardNet = st?.live.tenders.find((t) => t.tender === 'card')?.net ?? 0;
  const uncounted = st ? st.live.drawers.filter((d) => counted[d.deviceId] === undefined) : [];

  return (
    <div className="office-page">
      <div className="filter-row">
        <label className="date-range">
          <span className="muted">Business day</span>
          <input className="input" type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}

      {st && s && (
        <div className={loading ? 'refreshing' : undefined}>
          {st.closeout ? (
            <>
              <p className="banner banner-ok">
                Closed out by {st.closeout.closedBy} on {new Date(st.closeout.closedAt).toLocaleString()}.
                {st.closeout.note && ` “${st.closeout.note}”`}
              </p>
              {st.changed && (
                <section className="banner banner-warn changed">
                  <div>
                    <strong>
                      <span aria-hidden="true">⚠</span> Sales arrived after this day was closed out.
                    </strong>{' '}
                    A tablet that was offline synced late. The figures below are live; the close-out kept what it saw.
                  </div>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th />
                        <th className="num">At close-out</th>
                        <th className="num">Now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {CHANGES.filter(([k]) => st.closeout!.snapshot.summary[k] !== s[k]).map(([k, label, money]) => (
                        <tr key={k}>
                          <td>{label}</td>
                          <td className="num">{money ? formatMoney(st.closeout!.snapshot.summary[k]) : st.closeout!.snapshot.summary[k]}</td>
                          <td className="num">{money ? formatMoney(s[k]) : s[k]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button type="button" className="btn btn-sm" onClick={onReviewFlags}>
                    Review flags
                  </button>
                </section>
              )}
              <h3>Drawers</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Tablet</th>
                    <th className="num">Float</th>
                    <th className="num">Cash in</th>
                    <th className="num">Cash out</th>
                    <th className="num">Expected</th>
                    <th className="num">Counted</th>
                    <th className="num">Over / short</th>
                  </tr>
                </thead>
                <tbody>
                  {st.closeout.drawers.map((d) => (
                    <tr key={d.deviceId}>
                      <td>
                        {d.name} ({d.code})
                      </td>
                      <td className="num">{formatMoney(d.openingFloat)}</td>
                      <td className="num">{formatMoney(d.cashIn)}</td>
                      <td className="num">{formatMoney(d.cashOut)}</td>
                      <td className="num">{formatMoney(d.expected)}</td>
                      <td className="num">{formatMoney(d.counted)}</td>
                      <td className={`num ${d.overShort === 0 ? '' : 'status-warn'}`}>
                        {d.overShort === 0 ? 'Balanced' : `${d.overShort > 0 ? 'Over' : 'Short'} ${formatMoney(Math.abs(d.overShort))}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <>
              <section className="checklist" aria-label="Before you close">
                <h3>Before you close</h3>
                <ul>
                  {st.devices.map((d) => (
                    <li key={d.id}>
                      <span>
                        {d.name} ({d.code}) <span className="muted">· last synced {ago(d.lastSeenAt)}</span>
                      </span>
                      <DeviceState d={d} />
                    </li>
                  ))}
                  <li>
                    <span>Flagged documents for this day</span>
                    {s.openFlags ? (
                      <button type="button" className="status status-warn link-button" onClick={onReviewFlags}>
                        <span aria-hidden="true">⚠</span> {s.openFlags} to review
                      </button>
                    ) : (
                      <span className="status status-ok">
                        <span aria-hidden="true">✓</span> None
                      </span>
                    )}
                  </li>
                </ul>
                <p className="muted">
                  You can close with warnings. Anything that arrives afterwards is still recorded, flagged, and shown here as a change.
                </p>
              </section>

              <div className="tiles">
                <div className="tile">
                  <span className="tile-label">Net sales</span>
                  <span className="tile-value">{formatMoney(s.netSales)}</span>
                  <span className="tile-detail">{s.orders} orders</span>
                </div>
                <div className="tile">
                  <span className="tile-label">Collected</span>
                  <span className="tile-value">{formatMoney(s.collected)}</span>
                  <span className="tile-detail">{formatMoney(cardNet)} by card</span>
                </div>
                <div className="tile">
                  <span className="tile-label">Sales tax</span>
                  <span className="tile-value">{formatMoney(s.netTax)}</span>
                </div>
              </div>

              <h3>Count the drawers</h3>
              <table className="data-table drawer-table">
                <thead>
                  <tr>
                    <th>Tablet</th>
                    <th className="num">Cash in</th>
                    <th className="num">Cash out</th>
                    <th className="num">Float</th>
                    <th className="num">Expected</th>
                    <th className="num">Counted</th>
                    <th className="num">Over / short</th>
                  </tr>
                </thead>
                <tbody>
                  {st.live.drawers.map((d) => {
                    const float = floats[d.deviceId] ?? st.defaultFloat;
                    const expected = float + d.cashIn - d.cashOut;
                    const count = counted[d.deviceId];
                    const diff = count === undefined ? null : count - expected;
                    return (
                      <tr key={d.deviceId}>
                        <td>
                          {d.name} ({d.code})
                        </td>
                        <td className="num">{formatMoney(d.cashIn)}</td>
                        <td className="num">{formatMoney(d.cashOut)}</td>
                        <td className="num">
                          <MoneyInput label={`Float for ${d.name}`} value={float} onChange={(v) => setFloats({ ...floats, [d.deviceId]: v })} />
                        </td>
                        <td className="num">{formatMoney(expected)}</td>
                        <td className="num">
                          <MoneyInput label={`Counted in ${d.name}`} value={count ?? 0} onChange={(v) => setCounted({ ...counted, [d.deviceId]: v })} />
                        </td>
                        <td className={`num ${diff ? 'status-warn' : ''}`}>
                          {diff === null ? '—' : diff === 0 ? 'Balanced' : `${diff > 0 ? 'Over' : 'Short'} ${formatMoney(Math.abs(diff))}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="field">
                <label htmlFor="closeout-note">Note (optional)</label>
                <textarea id="closeout-note" className="input textarea" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
              </div>
              <button type="button" className="btn btn-primary btn-lg" onClick={() => setConfirming(true)}>
                Close out {date}
              </button>
            </>
          )}
        </div>
      )}

      {confirming && st && (
        <Sheet title={`Close out ${date}?`} onClose={() => setConfirming(false)}>
          <p>This keeps a copy of the day's figures and the drawer counts. It can't be undone.</p>
          {uncounted.length > 0 && (
            <p className="status status-warn">
              <span aria-hidden="true">⚠</span> Not counted: {uncounted.map((d) => d.name).join(', ')} (recorded as $0.00).
            </p>
          )}
          {saveError && <p className="error-text" role="alert">{saveError}</p>}
          <button type="button" className="btn btn-primary btn-block" disabled={saving} onClick={() => void close()}>
            {saving ? 'Closing…' : 'Close out'}
          </button>
        </Sheet>
      )}
    </div>
  );
}
