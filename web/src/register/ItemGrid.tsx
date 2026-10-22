import { useState, type CSSProperties } from 'react';
import type { MenuIndex } from '../domain/menu';
import { formatMoney } from '../domain/money';

interface ItemGridProps {
  ix: MenuIndex;
  disabled?: boolean;
  onAdd: (itemId: string) => void;
}

/** Category tabs and item tiles. One tap adds an item with its defaults. */
export function ItemGrid({ ix, disabled, onAdd }: ItemGridProps) {
  const categories = ix.doc.categories.filter((c) => ix.doc.items.some((i) => i.categoryId === c.id));
  const [chosen, setChosen] = useState(categories[0]?.id);
  const active = categories.find((c) => c.id === chosen) ?? categories[0];
  const items = ix.doc.items.filter((i) => i.categoryId === active?.id);

  return (
    <section className="items" aria-label="Menu">
      <div className="cat-tabs" role="tablist">
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            className="cat-tab"
            aria-selected={c.id === active?.id}
            style={{ '--cat': c.color || undefined } as CSSProperties}
            onClick={() => setChosen(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="item-grid" role="tabpanel" aria-label={active?.name}>
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            className="item-tile"
            style={{ '--cat': active?.color || undefined } as CSSProperties}
            disabled={disabled}
            onClick={() => onAdd(it.id)}
          >
            <span className="item-name">{it.name}</span>
            <span className="item-price">{formatMoney(it.price)}</span>
          </button>
        ))}
        {items.length === 0 && <p className="muted">This menu has no items yet. A manager can add them in Back office → Menu.</p>}
      </div>
    </section>
  );
}
