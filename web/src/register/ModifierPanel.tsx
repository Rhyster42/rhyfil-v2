import { itemGroups, type MenuIndex, type Option } from '../domain/menu';
import { formatMoney } from '../domain/money';
import type { LineView } from '../domain/order';

interface ModifierPanelProps {
  ix: MenuIndex;
  line: LineView;
  editable: boolean;
  onToggle: (optionId: string) => void;
  onStep: (optionId: string, delta: 1 | -1) => void;
  onQty: (qty: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

function delta(o: Option): string | null {
  if (o.delta === 0) return null;
  return `${o.delta > 0 ? '+' : '−'}${formatMoney(Math.abs(o.delta))}`;
}

/**
 * The selected line's modifiers, always on screen (docs/decisions/0018):
 * pick-one groups read as segmented choices, and options that can repeat
 * (extra shots, syrup pumps) become steppers once chosen.
 */
export function ModifierPanel({ ix, line, editable, onToggle, onStep, onQty, onDuplicate, onRemove }: ModifierPanelProps) {
  const qtyOf = (optionId: string) => line.mods.find((m) => m.optionId === optionId)?.qty ?? 0;

  return (
    <section className="mods" aria-label={`Customize ${line.priced.itemName}`}>
      <header className="mods-header">
        <h2>{line.priced.itemName}</h2>
        <div className="qty" role="group" aria-label="Quantity">
          <button type="button" aria-label="One fewer" disabled={!editable || line.qty <= 1} onClick={() => onQty(line.qty - 1)}>
            −
          </button>
          <output aria-label="Quantity">{line.qty}</output>
          <button type="button" aria-label="One more" disabled={!editable} onClick={() => onQty(line.qty + 1)}>
            +
          </button>
        </div>
        <button type="button" className="btn btn-sm" disabled={!editable} onClick={onDuplicate}>
          Duplicate
        </button>
        <button type="button" className="btn btn-sm btn-danger-outline" disabled={!editable} onClick={onRemove}>
          Remove
        </button>
      </header>
      {itemGroups(ix, line.itemId).map((g) => {
        const missing = line.problems.includes(`min:${g.id}`);
        return (
          <div key={g.id} className={`mod-group${missing ? ' mod-missing' : ''}`} role="group" aria-label={g.name}>
            <span className="mod-group-name">
              {g.name}
              {missing && <span className="mod-required">Choose {g.min === 1 ? 'one' : g.min}</span>}
            </span>
            <div className="mod-options">
              {g.options.map((o) => {
                const qty = qtyOf(o.id);
                if (o.maxQty > 1 && qty > 0) {
                  return (
                    <span key={o.id} className="stepper" role="group" aria-label={o.name}>
                      <button type="button" aria-label={`Less ${o.name}`} disabled={!editable} onClick={() => onStep(o.id, -1)}>
                        −
                      </button>
                      <span>
                        {qty}× {o.name}
                      </span>
                      <button type="button" aria-label={`More ${o.name}`} disabled={!editable || qty >= o.maxQty} onClick={() => onStep(o.id, 1)}>
                        +
                      </button>
                    </span>
                  );
                }
                return (
                  <button
                    key={o.id}
                    type="button"
                    className="chip"
                    aria-pressed={qty > 0}
                    disabled={!editable}
                    onClick={() => (o.maxQty > 1 ? onStep(o.id, 1) : onToggle(o.id))}
                  >
                    {o.name}
                    {delta(o) && <small>{delta(o)}</small>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}
