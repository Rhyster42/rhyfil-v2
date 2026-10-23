import { useState } from 'react';
import { errorMessage } from '../api/client';
import { officeApi, useOffice } from './officeApi';
import type { FlagView } from './types';

/** What each flag means, in a manager's words (docs/decisions/0003). */
export const FLAG_TITLES: Record<string, string> = {
  menu_mismatch: "Prices don't match the menu",
  total_mismatch: "Totals don't add up",
  payment_mismatch: "Payments don't match the total",
  over_refund: 'Refunded more than was paid',
  approval_invalid: "Refund approved by someone who isn't a manager",
  unknown_staff: 'Names someone the system doesn’t know',
  after_closeout: 'Arrived after the day was closed out',
  clock_skew: "The tablet's clock looks wrong",
};

function FlagCard({ flag, onResolved }: { flag: FlagView; onResolved: () => void }) {
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const details = Array.isArray(flag.detail) ? (flag.detail as unknown[]).map(String) : [];

  async function resolve() {
    setError(null);
    try {
      await officeApi('POST', `/flags/${flag.id}/resolve`, { note });
      onResolved();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <li className="flag-card">
      <header>
        <strong>
          <span aria-hidden="true">⚠</span> {FLAG_TITLES[flag.kind] ?? flag.kind}
        </strong>
        <span className="muted">
          {flag.subjectKind === 'refund' ? 'Refund on ' : ''}
          {flag.number ? `order ${flag.number}` : flag.subjectId.slice(0, 8)} · tablet {flag.deviceCode} · {flag.businessDate}
        </span>
      </header>
      <p>{flag.message}</p>
      {details.length > 0 && (
        <ul className="flag-details">
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {flag.resolvedAt ? (
        <p className="ok-text">
          <span aria-hidden="true">✓</span> {flag.resolvedBy}: {flag.resolution}
        </p>
      ) : resolving ? (
        <div className="resolve-form">
          <textarea className="input textarea" aria-label="What did you find?" placeholder="What did you find?" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          {error && <p className="error-text">{error}</p>}
          <div className="button-row">
            <button type="button" className="btn btn-primary" disabled={!note.trim()} onClick={() => void resolve()}>
              Mark reviewed
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setResolving(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => setResolving(true)}>
          Review…
        </button>
      )}
    </li>
  );
}

/** Documents that were stored but broke a rule, for a manager to look at. */
export function FlagsTab() {
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const { data, error, loading, reload } = useOffice<FlagView[]>(`/flags?status=${status}`);
  return (
    <div className="office-page">
      <div className="filter-row">
        <div className="segmented" role="tablist" aria-label="Which flags">
          <button type="button" role="tab" aria-selected={status === 'open'} onClick={() => setStatus('open')}>
            To review
          </button>
          <button type="button" role="tab" aria-selected={status === 'resolved'} onClick={() => setStatus('resolved')}>
            Reviewed
          </button>
        </div>
      </div>
      <p className="muted">
        The server never throws away a sale or refund, even one that breaks a rule: money already changed hands. It keeps the record and flags it here.
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {data && (
        <ul className={`flag-list${loading ? ' refreshing' : ''}`}>
          {data.map((f) => (
            <FlagCard key={f.id} flag={f} onResolved={reload} />
          ))}
          {data.length === 0 && <li className="muted">{status === 'open' ? 'Nothing to review.' : 'Nothing reviewed yet.'}</li>}
        </ul>
      )}
    </div>
  );
}
