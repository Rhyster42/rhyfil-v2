import type { ReactNode } from 'react';
import { captured, modSummary, type Draft, type PricedDraft } from '../domain/order';
import { formatMoney } from '../domain/money';
import type { MenuIndex } from '../domain/menu';
import type { CloseSummary } from './useRegister';

interface OrderPanelProps {
  ix: MenuIndex | null;
  draft: Draft | null;
  priced: PricedDraft | null;
  lastClose: CloseSummary | null;
  canUndo: boolean;
  error: string | null;
  /** Split by item: lines that can be picked, and which are picked. */
  pickable: string[] | null;
  picked: string[];
  onSelect: (lineId: string) => void;
  onPick: (lineId: string) => void;
  onUndo: () => void;
  onDismissError: () => void;
  tenders: ReactNode;
}

function problemText(ix: MenuIndex | null, problems: string[]): string | null {
  const missing = problems.find((p) => p.startsWith('min:'));
  if (!missing) return problems.length ? 'Check the options' : null;
  return `Choose ${ix?.groups.get(missing.slice(4))?.name.toLowerCase() ?? 'an option'}`;
}

function CloseBanner({ summary, canUndo, onUndo }: { summary: CloseSummary; canUndo: boolean; onUndo: () => void }) {
  let main: ReactNode;
  if (summary.status === 'voided') main = 'Order voided';
  else if (summary.change > 0) main = <>Change <strong>{formatMoney(summary.change)}</strong></>;
  else if (summary.tender === 'none') main = 'Done, no charge';
  else main = `Paid ${summary.tender === 'card' ? 'by card' : summary.tender === 'cash' ? 'in cash' : ''} · ${formatMoney(summary.total)}`;
  return (
    <div className={`close-banner close-${summary.status}`} role="status">
      <div>
        <div className="close-number">{summary.number}</div>
        <div className="close-main">{main}</div>
      </div>
      {canUndo && (
        <button type="button" className="btn" onClick={onUndo}>
          Undo
        </button>
      )}
    </div>
  );
}

export function OrderPanel(props: OrderPanelProps) {
  const { ix, draft, priced, lastClose, canUndo, pickable, picked } = props;
  const closed = !!draft?.closedAt;
  const claimed = new Set(draft ? captured(draft).flatMap((p) => p.coversLineIds) : []);

  return (
    <section className="order" aria-label="Order">
      <header className="order-header">
        <h2>{draft && !closed ? `Order ${draft.number}` : 'New order'}</h2>
        {priced && !closed && <span className="muted">{priced.lines.length} {priced.lines.length === 1 ? 'item' : 'items'}</span>}
      </header>

      {lastClose && (closed || !draft) && <CloseBanner summary={lastClose} canUndo={canUndo} onUndo={props.onUndo} />}

      <ul className="order-lines">
        {!closed &&
          priced?.lines.map((l) => {
            const problem = problemText(ix, l.problems);
            const canPick = pickable?.includes(l.id) ?? false;
            const isPicked = picked.includes(l.id);
            return (
              <li key={l.id}>
                <button
                  type="button"
                  className={`order-line${draft?.selectedLineId === l.id && !pickable ? ' selected' : ''}${isPicked ? ' picked' : ''}`}
                  aria-pressed={pickable ? isPicked : undefined}
                  disabled={!!pickable && !canPick}
                  onClick={() => (pickable ? props.onPick(l.id) : props.onSelect(l.id))}
                >
                  <span className="line-qty">{pickable ? (claimed.has(l.id) ? '✓' : isPicked ? '☑' : '☐') : l.qty > 1 ? `${l.qty}×` : ''}</span>
                  <span className="line-main">
                    <span className="line-name">{l.priced.itemName}</span>
                    {l.priced.mods.length > 0 && <span className="line-mods">{modSummary(l)}</span>}
                    {problem && <span className="line-problem">{problem}</span>}
                    {claimed.has(l.id) && <span className="line-paid">Paid</span>}
                  </span>
                  <span className="line-total">{formatMoney(l.priced.lineTotal)}</span>
                </button>
              </li>
            );
          })}
        {!draft && !lastClose && <li className="order-empty">Tap an item to start an order.</li>}
        {!draft && lastClose && <li className="order-empty">Tap an item to start the next order.</li>}
      </ul>

      {props.error && (
        <div className="order-error" role="alert">
          <span>{props.error}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={props.onDismissError} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {priced && !closed && (
        <div className="totals">
          <div>
            <span>Subtotal</span>
            <span>{formatMoney(priced.totals.subtotal)}</span>
          </div>
          <div>
            <span>Tax</span>
            <span>{formatMoney(priced.totals.tax)}</span>
          </div>
          <div className="grand">
            <span>Total</span>
            <span>{formatMoney(priced.totals.total)}</span>
          </div>
          {priced.paid > 0 && (
            <>
              {captured(draft!).map((p) => (
                <div key={p.id} className="paid-row">
                  <span>
                    {p.tender === 'card' ? 'Card' : 'Cash'}
                    {p.change > 0 && ` · change ${formatMoney(p.change)}`}
                  </span>
                  <span>−{formatMoney(p.amount)}</span>
                </div>
              ))}
              <div className="grand balance">
                <span>Balance</span>
                <span>{formatMoney(priced.remaining)}</span>
              </div>
            </>
          )}
        </div>
      )}

      {draft && !closed && props.tenders}
    </section>
  );
}
