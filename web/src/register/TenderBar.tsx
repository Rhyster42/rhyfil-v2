import { formatMoney } from '../domain/money';
import { cashSuggestions } from '../domain/tender';

interface TenderBarProps {
  /** What the next payment is for. */
  due: number;
  /** Why paying isn't possible yet, if it isn't. */
  blocked: string | null;
  /** Describes a split in progress. */
  splitLabel: string | null;
  zeroTotal: boolean;
  onCard: () => void;
  onCash: (tendered: number) => void;
  onNoCharge: () => void;
  onMore: () => void;
  onCancelSplit: () => void;
}

/** Tenders live on the order panel: no payment screen, no extra tap (docs/decisions/0018). */
export function TenderBar(props: TenderBarProps) {
  const { due, blocked, splitLabel, zeroTotal } = props;
  const disabled = !!blocked || due <= 0;
  return (
    <div className="tenders">
      {splitLabel && (
        <div className="split-label">
          <span>{splitLabel}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={props.onCancelSplit}>
            Cancel split
          </button>
        </div>
      )}
      {blocked && <p className="tender-blocked">{blocked}</p>}
      {zeroTotal && !blocked ? (
        <button type="button" className="btn btn-ok btn-lg btn-block" onClick={props.onNoCharge}>
          Complete — no charge
        </button>
      ) : (
        <>
          <button type="button" className="btn btn-ok btn-lg btn-block tender-card" disabled={disabled} onClick={props.onCard}>
            Card {formatMoney(due)}
          </button>
          <div className="cash-row">
            <button type="button" className="btn tender-cash" disabled={disabled} onClick={() => props.onCash(due)}>
              Exact {formatMoney(due)}
            </button>
            {cashSuggestions(due).map((v) => (
              <button key={v} type="button" className="btn tender-cash" disabled={disabled} onClick={() => props.onCash(v)}>
                {formatMoney(v).replace(/\.00$/, '')}
              </button>
            ))}
          </div>
        </>
      )}
      <button type="button" className="btn btn-block more-btn" onClick={props.onMore}>
        Split · custom amount · void
      </button>
    </div>
  );
}
