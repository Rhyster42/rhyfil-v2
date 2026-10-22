import { useState } from 'react';
import type { PaymentDoc } from '../domain/documents';
import { formatMoney } from '../domain/money';
import { Sheet } from '../ui/Sheet';
import { Keypad } from './Keypad';

interface MoreSheetProps {
  remaining: number;
  canVoid: boolean;
  canPay: boolean;
  payments: PaymentDoc[];
  onSplitEven: (ways: number) => void;
  onSplitItems: () => void;
  onCustom: (amount: number) => void;
  onReverse: (payment: PaymentDoc) => void;
  onVoid: () => void;
  onClose: () => void;
}

/** Everything that isn't the common path: splits, odd amounts, giving money back, voiding. */
export function MoreSheet(props: MoreSheetProps) {
  const [custom, setCustom] = useState(0);
  const { remaining, canPay } = props;

  return (
    <Sheet title="More" onClose={props.onClose} wide>
      <div className="more-grid">
        <section>
          <h3>Split the bill · {formatMoney(remaining)} left</h3>
          <div className="split-ways">
            {[2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className="btn" disabled={!canPay || remaining < n} onClick={() => props.onSplitEven(n)}>
                {n} ways
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-block" disabled={!canPay} onClick={props.onSplitItems}>
            By item
          </button>

          {props.payments.length > 0 && (
            <>
              <h3>Payments taken</h3>
              <ul className="payment-list">
                {props.payments.map((p) => (
                  <li key={p.id}>
                    <span>
                      {p.tender === 'card' ? 'Card' : 'Cash'} {formatMoney(p.amount)}
                    </span>
                    <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => props.onReverse(p)}>
                      Give back
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3>Cancel the order</h3>
          <button type="button" className="btn btn-block btn-danger-outline" disabled={!props.canVoid} onClick={props.onVoid}>
            Void order
          </button>
          {!props.canVoid && props.payments.length > 0 && <p className="muted">Give the payments back first.</p>}
        </section>
        <section>
          <h3>Pay a custom amount</h3>
          <Keypad value={custom} onChange={setCustom} max={remaining} />
          <button type="button" className="btn btn-primary btn-block" disabled={!canPay || custom <= 0} onClick={() => props.onCustom(custom)}>
            Pay {formatMoney(custom)} of {formatMoney(remaining)}
          </button>
        </section>
      </div>
    </Sheet>
  );
}
