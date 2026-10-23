import { useState } from 'react';
import { findManagerByPin } from '../auth/session';
import { engine } from '../app/services';
import { saveRefund } from '../db/ledger';
import { useMeta } from '../db/db';
import { businessDate } from '../domain/businessDate';
import type { OrderDoc, RefundDoc } from '../domain/documents';
import { uuidv7 } from '../domain/ids';
import { formatMoney, sum } from '../domain/money';
import { modSummary } from '../domain/order';
import { buildRefund, customRefundTax, defaultPayment, lineRefund, refundState } from '../domain/refund';
import { Keypad } from '../register/Keypad';
import { now } from '../sync/clock';
import { PinPad } from '../ui/PinPad';
import { Sheet } from '../ui/Sheet';

const REASONS = ['Made wrong', 'Customer unhappy', 'Charged by mistake', 'Item unavailable'];

interface RefundSheetProps {
  order: OrderDoc;
  refunds: RefundDoc[];
  staffId: string;
  onClose: () => void;
}

/**
 * Refund items or an amount to one of the order's payments, with a manager's
 * PIN. Works offline: the refund is a new document (docs/decisions/0009).
 */
export function RefundSheet({ order, refunds, staffId, onClose }: RefundSheetProps) {
  const device = useMeta('device');
  const settings = useMeta('settings');
  const state = refundState(order, refunds);
  const [mode, setMode] = useState<'items' | 'amount'>('items');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [custom, setCustom] = useState(0);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [done, setDone] = useState<RefundDoc | null>(null);

  const chosenLines = state.lines.filter((l) => (qty[l.line.id] ?? 0) > 0);
  const lines = mode === 'items' ? chosenLines.map((l) => lineRefund(l, qty[l.line.id]!)) : [];
  const payment =
    state.payments.find((p) => p.payment.id === paymentId) ??
    defaultPayment(state, chosenLines.map((l) => l.line.id));
  const amount = mode === 'items' ? sum(lines.map((l) => l.amount)) : custom;
  const tax = mode === 'items' ? sum(lines.map((l) => l.tax)) : customRefundTax(order, custom);

  let problem: string | null = null;
  if (!payment) problem = 'Everything on this order has been refunded.';
  else if (amount > payment.remaining)
    problem = `That's more than the ${formatMoney(payment.remaining)} left on this ${payment.payment.tender} payment. Refund the rest to another payment afterwards.`;

  const step = (lineId: string, delta: number, max: number) =>
    setQty((q) => ({ ...q, [lineId]: Math.max(0, Math.min(max, (q[lineId] ?? 0) + delta)) }));

  async function approve(managerId: string) {
    if (!payment || !device || !settings) return;
    const at = now();
    const doc = buildRefund({
      id: uuidv7(at.getTime()),
      order,
      payment: payment.payment,
      lines,
      amount,
      reason: reason!,
      staffId,
      approvedBy: managerId,
      deviceId: device.id,
      at: at.toISOString(),
      businessDate: businessDate(at, settings.timezone, settings.dayCutoffMinutes),
    });
    await saveRefund(doc);
    void engine.syncNow();
    setApproving(false);
    setDone(doc);
  }

  if (done) {
    return (
      <Sheet title="Refund recorded" onClose={onClose}>
        <p className="refund-done">
          {done.tender === 'cash' ? (
            <>
              Give back <strong>{formatMoney(done.amount)}</strong> in cash.
            </>
          ) : (
            <>
              Refund <strong>{formatMoney(done.amount)}</strong> on the card terminal.
            </>
          )}
        </p>
        <button type="button" className="btn btn-primary btn-block" onClick={onClose}>
          Done
        </button>
      </Sheet>
    );
  }

  return (
    <Sheet title={`Refund from ${order.number}`} onClose={onClose} wide>
      <div className="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'items'} onClick={() => setMode('items')}>
          Items
        </button>
        <button type="button" role="tab" aria-selected={mode === 'amount'} onClick={() => setMode('amount')}>
          Amount
        </button>
      </div>

      <div className="refund-grid">
        <section>
          {mode === 'items' ? (
            <ul className="refund-lines">
              {state.lines.map((l) => {
                const n = qty[l.line.id] ?? 0;
                return (
                  <li key={l.line.id} className={l.remainingQty === 0 ? 'done' : undefined}>
                    <span className="refund-line-name">
                      {l.line.itemName}
                      {l.line.mods.length > 0 && <small>{modSummary({ priced: l.line })}</small>}
                      <small>{l.remainingQty === 0 ? 'Refunded' : `${l.remainingQty} of ${l.line.qty} refundable`}</small>
                    </span>
                    <span className="qty" role="group" aria-label={`Refund ${l.line.itemName}`}>
                      <button type="button" aria-label={`One fewer ${l.line.itemName}`} disabled={n === 0} onClick={() => step(l.line.id, -1, l.remainingQty)}>
                        −
                      </button>
                      <output>{n}</output>
                      <button type="button" aria-label={`One more ${l.line.itemName}`} disabled={n >= l.remainingQty} onClick={() => step(l.line.id, 1, l.remainingQty)}>
                        +
                      </button>
                    </span>
                  </li>
                );
              })}
              <li>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setQty(Object.fromEntries(state.lines.map((l) => [l.line.id, l.remainingQty])))}
                >
                  Everything left
                </button>
              </li>
            </ul>
          ) : (
            <Keypad value={custom} onChange={setCustom} max={payment?.remaining ?? 0} />
          )}
        </section>

        <section>
          {state.payments.length > 1 && (
            <>
              <h3>Refund to</h3>
              <div className="choice-list">
                {state.payments.map((p) => (
                  <button
                    key={p.payment.id}
                    type="button"
                    className="chip"
                    aria-pressed={payment?.payment.id === p.payment.id}
                    disabled={p.remaining === 0}
                    onClick={() => setPaymentId(p.payment.id)}
                  >
                    {p.payment.tender === 'card' ? 'Card' : 'Cash'} {formatMoney(p.payment.amount)}
                    <small>{formatMoney(p.remaining)} left</small>
                  </button>
                ))}
              </div>
            </>
          )}
          <h3>Why?</h3>
          <div className="choice-list">
            {REASONS.map((r) => (
              <button key={r} type="button" className="chip" aria-pressed={reason === r} onClick={() => setReason(r)}>
                {r}
              </button>
            ))}
          </div>
          <p className="refund-summary">
            {amount > 0 && payment ? (
              <>
                Refund <strong>{formatMoney(amount)}</strong> {tax > 0 && <span className="muted">(incl. {formatMoney(tax)} tax)</span>} to{' '}
                {payment.payment.tender}
              </>
            ) : (
              <span className="muted">Choose what to refund.</span>
            )}
          </p>
          {problem && <p className="error-text">{problem}</p>}
          <button
            type="button"
            className="btn btn-primary btn-block btn-lg"
            disabled={amount <= 0 || !reason || !!problem}
            onClick={() => setApproving(true)}
          >
            Manager approval
          </button>
        </section>
      </div>

      {approving && (
        <Sheet onClose={() => setApproving(false)}>
          <PinPad
            title="Manager approval"
            hint={`Refund ${formatMoney(amount)}`}
            check={async (pin) => !!(await findManagerByPin(pin))}
            onAccept={(pin) => void findManagerByPin(pin).then((m) => m && approve(m.id))}
            onCancel={() => setApproving(false)}
          />
        </Sheet>
      )}
    </Sheet>
  );
}

