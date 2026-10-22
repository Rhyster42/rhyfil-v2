import { useEffect, useState } from 'react';
import type { PaymentDoc, Tender } from '../domain/documents';
import { formatMoney } from '../domain/money';
import { captured, isEditable } from '../domain/order';
import { amountForLines, evenSplit, unclaimedLineIds } from '../domain/tender';
import { ItemGrid } from './ItemGrid';
import { ModifierPanel } from './ModifierPanel';
import { MoreSheet } from './MoreSheet';
import { OrderPanel } from './OrderPanel';
import { LINE_VOID_REASONS, ORDER_VOID_REASONS, ReasonSheet, REVERSAL_REASONS } from './ReasonSheet';
import { TenderBar } from './TenderBar';
import { useRegister, type RegisterOptions } from './useRegister';

type Split = { kind: 'even'; parts: number[]; index: number } | { kind: 'items'; lineIds: string[] } | { kind: 'amount'; amount: number } | null;

type Dialog =
  | { kind: 'more' }
  | { kind: 'voidLine'; lineId: string; name: string }
  | { kind: 'voidOrder' }
  | { kind: 'reverse'; payment: PaymentDoc }
  | null;

export function RegisterScreen({ staffId, options }: { staffId: string; options?: RegisterOptions }) {
  const reg = useRegister(staffId, options);
  const [split, setSplit] = useState<Split>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const { draft, priced, ix } = reg;

  // A split belongs to one order.
  const draftId = draft?.id;
  const closed = !!draft?.closedAt;
  useEffect(() => setSplit(null), [draftId, closed]);

  if (reg.loading) return <div className="placeholder">Loading…</div>;
  if (reg.menuMissing || !ix) return <div className="placeholder">Waiting for the menu to arrive…</div>;

  const editable = draft ? isEditable(draft) : true;
  // A closed order (in its undo window) doesn't block the next one.
  const canAdd = !draft || closed || editable;
  // While a split is being paid, the screen is about payment, not customizing.
  const selected = !closed && !split ? priced?.lines.find((l) => l.id === draft?.selectedLineId) : undefined;

  // What the next payment is for.
  let due = priced?.remaining ?? 0;
  let splitLabel: string | null = null;
  let blocked: string | null = null;
  if (priced) {
    if (split?.kind === 'even') {
      due = Math.min(split.parts[split.index] ?? due, due);
      splitLabel = `Split ${split.parts.length} ways · ${split.index + 1} of ${split.parts.length}`;
    } else if (split?.kind === 'items') {
      due = amountForLines(priced, split.lineIds);
      splitLabel = split.lineIds.length ? `Paying for ${split.lineIds.length} of the items` : null;
      if (!split.lineIds.length) blocked = 'Tap the items this person is paying for.';
    } else if (split?.kind === 'amount') {
      due = Math.min(split.amount, due);
      splitLabel = `Paying ${formatMoney(due)} of ${formatMoney(priced.remaining)}`;
    }
    const incomplete = priced.lines.find((l) => l.problems.length);
    if (!priced.lines.length) blocked = 'Add an item to take payment.';
    else if (incomplete) blocked = `Finish the ${incomplete.priced.itemName} first.`;
  }

  function payNow(tender: Tender, tendered: number) {
    const covers = split?.kind === 'items' ? split.lineIds : [];
    if (!reg.pay(tender, due, tendered, covers)) return;
    if (split?.kind === 'even') setSplit(split.index + 1 < split.parts.length ? { ...split, index: split.index + 1 } : null);
    else if (split?.kind === 'items') setSplit({ kind: 'items', lineIds: [] });
    else setSplit(null);
  }

  const pickable = split?.kind === 'items' && draft && priced ? unclaimedLineIds(draft, priced) : null;

  return (
    <div className="register">
      <div className="register-left">
        <ItemGrid ix={ix} disabled={!canAdd} onAdd={reg.addItem} />
        {selected && draft && (
          <ModifierPanel
            ix={ix}
            line={selected}
            editable={editable}
            onToggle={(o) => reg.toggle(selected.id, o)}
            onStep={(o, d) => reg.step(selected.id, o, d)}
            onQty={(q) => reg.setQty(selected.id, q)}
            onDuplicate={() => reg.duplicate(selected.id)}
            onRemove={() => setDialog({ kind: 'voidLine', lineId: selected.id, name: selected.priced.itemName })}
          />
        )}
      </div>

      <OrderPanel
        ix={ix}
        draft={draft}
        priced={priced}
        lastClose={reg.lastClose}
        canUndo={reg.canUndo}
        error={reg.error}
        pickable={pickable}
        picked={split?.kind === 'items' ? split.lineIds : []}
        onSelect={reg.select}
        onPick={(id) =>
          split?.kind === 'items' &&
          setSplit({ kind: 'items', lineIds: split.lineIds.includes(id) ? split.lineIds.filter((x) => x !== id) : [...split.lineIds, id] })
        }
        onUndo={reg.undo}
        onDismissError={reg.dismissError}
        tenders={
          priced && (
            <TenderBar
              due={due}
              blocked={blocked}
              splitLabel={splitLabel}
              zeroTotal={priced.totals.total === 0 && priced.lines.length > 0}
              onCard={() => payNow('card', due)}
              onCash={(tendered) => payNow('cash', tendered)}
              onNoCharge={reg.noCharge}
              onMore={() => setDialog({ kind: 'more' })}
              onCancelSplit={() => setSplit(null)}
            />
          )
        }
      />

      {dialog?.kind === 'more' && draft && priced && (
        <MoreSheet
          remaining={priced.remaining}
          canPay={priced.ready && priced.remaining > 0}
          canVoid={captured(draft).length === 0}
          payments={captured(draft)}
          onSplitEven={(n) => {
            setSplit({ kind: 'even', parts: evenSplit(priced.remaining, n), index: 0 });
            setDialog(null);
          }}
          onSplitItems={() => {
            setSplit({ kind: 'items', lineIds: [] });
            setDialog(null);
          }}
          onCustom={(amount) => {
            setSplit({ kind: 'amount', amount });
            setDialog(null);
          }}
          onReverse={(payment) => setDialog({ kind: 'reverse', payment })}
          onVoid={() => setDialog({ kind: 'voidOrder' })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'voidLine' && (
        <ReasonSheet
          title={`Remove ${dialog.name}?`}
          reasons={LINE_VOID_REASONS}
          danger
          onChoose={(reason) => {
            reg.voidLine(dialog.lineId, reason);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'voidOrder' && draft && (
        <ReasonSheet
          title={`Void order ${draft.number}?`}
          detail="It stays on the record as voided."
          reasons={ORDER_VOID_REASONS}
          danger
          onChoose={(reason) => {
            reg.voidOrder(reason);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'reverse' && (
        <ReasonSheet
          title={`Give back ${formatMoney(dialog.payment.amount)} ${dialog.payment.tender === 'card' ? 'to the card' : 'in cash'}?`}
          detail={dialog.payment.tender === 'card' ? 'Refund or void it on the card terminal too.' : undefined}
          reasons={REVERSAL_REASONS}
          onChoose={(reason) => {
            reg.reverse(dialog.payment.id, reason);
            setSplit(null);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
