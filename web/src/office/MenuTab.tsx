import { useEffect, useState, type CSSProperties } from 'react';
import { ApiError, errorMessage } from '../api/client';
import type { MenuVersion } from '../api/types';
import { engine } from '../app/services';
import { shortId } from '../domain/ids';
import type { Group, Item, MenuDoc } from '../domain/menu';
import { formatMoney } from '../domain/money';
import { MoneyInput } from '../ui/MoneyInput';
import { officeApi, useOffice } from './officeApi';

type Section = 'items' | 'groups' | 'categories';

function move<T>(list: T[], i: number, delta: number): void {
  const j = i + delta;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
}

function ppmToPercent(ppm: number): string {
  return String(ppm / 10_000);
}

function percentToPpm(text: string): number | null {
  if (!/^\d{1,2}(\.\d{0,4})?$/.test(text.trim())) return null;
  return Math.round(Number(text) * 10_000);
}

function Arrows({ onUp, onDown, label }: { onUp: () => void; onDown: () => void; label: string }) {
  return (
    <span className="arrows">
      <button type="button" className="btn btn-sm btn-ghost" aria-label={`Move ${label} up`} onClick={onUp}>
        ↑
      </button>
      <button type="button" className="btn btn-sm btn-ghost" aria-label={`Move ${label} down`} onClick={onDown}>
        ↓
      </button>
    </span>
  );
}

function ItemForm({ doc, item, edit }: { doc: MenuDoc; item: Item; edit: (f: (d: MenuDoc) => void) => void }) {
  const at = (d: MenuDoc) => d.items.find((i) => i.id === item.id)!;
  const unused = doc.groups.filter((g) => !item.groupIds.includes(g.id));
  return (
    <div className="editor-form">
      <div className="field-row">
        <div className="field">
          <label htmlFor="item-name">Name</label>
          <input id="item-name" className="input" value={item.name} maxLength={60} onChange={(e) => edit((d) => void (at(d).name = e.target.value))} />
        </div>
        <div className="field">
          <label htmlFor="item-price">Price</label>
          <MoneyInput id="item-price" label="Price" value={item.price} onChange={(v) => edit((d) => void (at(d).price = v))} />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="item-category">Category</label>
          <select id="item-category" className="input" value={item.categoryId} onChange={(e) => edit((d) => void (at(d).categoryId = e.target.value))}>
            {doc.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <label className="check field">
          <input type="checkbox" checked={item.taxable} onChange={(e) => edit((d) => void (at(d).taxable = e.target.checked))} /> Charge sales tax
        </label>
      </div>
      <div className="field">
        <span className="label">Modifier groups, in the order the register shows them</span>
        <ul className="editor-rows">
          {item.groupIds.map((gid, i) => (
            <li key={gid}>
              <label className="check">
                <input type="checkbox" checked onChange={() => edit((d) => void at(d).groupIds.splice(i, 1))} />
                {doc.groups.find((g) => g.id === gid)?.name ?? gid}
              </label>
              <Arrows
                label={doc.groups.find((g) => g.id === gid)?.name ?? gid}
                onUp={() => edit((d) => move(at(d).groupIds, i, -1))}
                onDown={() => edit((d) => move(at(d).groupIds, i, 1))}
              />
            </li>
          ))}
          {unused.map((g) => (
            <li key={g.id}>
              <label className="check muted">
                <input type="checkbox" checked={false} onChange={() => edit((d) => void at(d).groupIds.push(g.id))} />
                {g.name}
              </label>
            </li>
          ))}
        </ul>
      </div>
      <button type="button" className="btn btn-danger-outline" onClick={() => edit((d) => void (d.items = d.items.filter((i) => i.id !== item.id)))}>
        Delete item
      </button>
    </div>
  );
}

function GroupForm({ group, edit }: { group: Group; edit: (f: (d: MenuDoc) => void) => void }) {
  const at = (d: MenuDoc) => d.groups.find((g) => g.id === group.id)!;
  return (
    <div className="editor-form">
      <div className="field-row">
        <div className="field">
          <label htmlFor="group-name">Name</label>
          <input id="group-name" className="input" value={group.name} maxLength={60} onChange={(e) => edit((d) => void (at(d).name = e.target.value))} />
        </div>
        <div className="field">
          <label htmlFor="group-min">Must pick at least</label>
          <input id="group-min" className="input" type="number" min={0} value={group.min} onChange={(e) => edit((d) => void (at(d).min = Number(e.target.value)))} />
        </div>
        <div className="field">
          <label htmlFor="group-max">At most</label>
          <input id="group-max" className="input" type="number" min={1} value={group.max} onChange={(e) => edit((d) => void (at(d).max = Number(e.target.value)))} />
        </div>
      </div>
      <p className="muted">
        {group.min === 1 && group.max === 1
          ? 'Exactly one, like a size. A default makes it one tap.'
          : group.min === 0
            ? `Optional, up to ${group.max}.`
            : `Between ${group.min} and ${group.max}.`}
      </p>
      <table className="data-table options-table">
        <thead>
          <tr>
            <th>Option</th>
            <th>Price change</th>
            <th>Default</th>
            <th>Up to</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {group.options.map((o, i) => {
            const opt = (d: MenuDoc) => at(d).options[i]!;
            return (
              <tr key={o.id}>
                <td>
                  <input className="input" aria-label="Option name" value={o.name} maxLength={60} onChange={(e) => edit((d) => void (opt(d).name = e.target.value))} />
                </td>
                <td>
                  <MoneyInput label={`Price change for ${o.name}`} signed value={o.delta} onChange={(v) => edit((d) => void (opt(d).delta = v))} />
                </td>
                <td>
                  <input type="checkbox" aria-label={`${o.name} is a default`} checked={o.default} onChange={(e) => edit((d) => void (opt(d).default = e.target.checked))} />
                </td>
                <td>
                  <input className="input qty-input" type="number" min={1} max={20} aria-label={`Most ${o.name} per drink`} value={o.maxQty} onChange={(e) => edit((d) => void (opt(d).maxQty = Number(e.target.value)))} />
                </td>
                <td className="num">
                  <Arrows label={o.name} onUp={() => edit((d) => move(at(d).options, i, -1))} onDown={() => edit((d) => move(at(d).options, i, 1))} />
                  <button type="button" className="btn btn-sm btn-ghost" aria-label={`Delete ${o.name}`} onClick={() => edit((d) => void at(d).options.splice(i, 1))}>
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="button-row">
        <button
          type="button"
          className="btn"
          onClick={() => {
            const id = shortId('opt');
            edit((d) => void at(d).options.push({ id, name: 'New option', delta: 0, default: false, maxQty: 1 }));
          }}
        >
          Add option
        </button>
        <button
          type="button"
          className="btn btn-danger-outline"
          onClick={() =>
            edit((d) => {
              d.groups = d.groups.filter((g) => g.id !== group.id);
              d.items.forEach((i) => (i.groupIds = i.groupIds.filter((g) => g !== group.id)));
            })
          }
        >
          Delete group
        </button>
      </div>
    </div>
  );
}

function CategoriesForm({ doc, edit }: { doc: MenuDoc; edit: (f: (d: MenuDoc) => void) => void }) {
  const [tax, setTax] = useState(ppmToPercent(doc.taxRatePpm));
  const badTax = percentToPpm(tax) === null;
  return (
    <div className="editor-form">
      <div className="field">
        <label htmlFor="tax-rate">Sales tax rate (%)</label>
        <input
          id="tax-rate"
          className={`input${badTax ? ' input-bad' : ''}`}
          inputMode="decimal"
          value={tax}
          onChange={(e) => {
            setTax(e.target.value);
            const ppm = percentToPpm(e.target.value);
            if (ppm !== null) edit((d) => void (d.taxRatePpm = ppm));
          }}
        />
        <span className="muted">Up to four decimals, e.g. 8.875. Orders keep the rate they were sold with.</span>
      </div>
      <span className="label">Categories, in register order</span>
      <ul className="editor-rows">
        {doc.categories.map((c, i) => {
          const used = doc.items.some((it) => it.categoryId === c.id);
          return (
            <li key={c.id}>
              <input type="color" aria-label={`${c.name} color`} value={c.color || '#8a5a2b'} onChange={(e) => edit((d) => void (d.categories[i]!.color = e.target.value))} />
              <input className="input" aria-label="Category name" value={c.name} maxLength={60} onChange={(e) => edit((d) => void (d.categories[i]!.name = e.target.value))} />
              <Arrows label={c.name} onUp={() => edit((d) => move(d.categories, i, -1))} onDown={() => edit((d) => move(d.categories, i, 1))} />
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={`Delete ${c.name}`}
                title={used ? 'Move or delete its items first' : undefined}
                disabled={used}
                onClick={() => edit((d) => void d.categories.splice(i, 1))}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="btn"
        onClick={() => {
          const id = shortId('cat');
          edit((d) => void d.categories.push({ id, name: 'New category', color: '#8a5a2b' }));
        }}
      >
        Add category
      </button>
    </div>
  );
}

/**
 * The menu is one document (docs/decisions/0004): edit a copy, then save it as
 * a new version. A save names the version it started from, so two managers
 * can't overwrite each other.
 */
export function MenuTab() {
  const remote = useOffice<MenuVersion>('/menu');
  const [doc, setDoc] = useState<MenuDoc | null>(null);
  const [base, setBase] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [section, setSection] = useState<Section>('items');
  const [selected, setSelected] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [status, setStatus] = useState<{ text: string; conflict?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (remote.data) {
      setDoc(remote.data.doc);
      setBase(remote.data.version);
      setDirty(false);
    }
  }, [remote.data]);

  const edit = (mutate: (d: MenuDoc) => void) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      mutate(next);
      return next;
    });
    setDirty(true);
    setStatus(null);
  };

  async function save() {
    if (!doc) return;
    setSaving(true);
    setProblems([]);
    setStatus(null);
    try {
      const res = await officeApi<{ version: number }>('PUT', '/menu', { baseVersion: base, doc });
      setBase(res.version);
      setDirty(false);
      setStatus({ text: `Saved as version ${res.version}. Tablets get it on their next sync; open orders keep their prices.` });
      void engine.syncNow();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_menu') setProblems(e.details as string[]);
      else if (e instanceof ApiError && e.code === 'conflict')
        setStatus({ text: 'Someone else saved the menu while you were editing. Reload to get their version; your changes here will be lost.', conflict: true });
      else setStatus({ text: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  if (remote.error && !doc) return <p className="error-text office-page">{remote.error}</p>;
  if (!doc) return null;

  const item = section === 'items' ? doc.items.find((i) => i.id === selected) : undefined;
  const group = section === 'groups' ? doc.groups.find((g) => g.id === selected) : undefined;

  return (
    <div className="office-page menu-editor">
      <div className="filter-row">
        <div className="segmented" role="tablist" aria-label="Menu section">
          {(
            [
              ['items', 'Items'],
              ['groups', 'Modifier groups'],
              ['categories', 'Categories & tax'],
            ] as [Section, string][]
          ).map(([s, label]) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={section === s}
              onClick={() => {
                setSection(s);
                setSelected(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="muted">{dirty ? 'Unsaved changes' : `Version ${base}`}</span>
        <button type="button" className="btn" disabled={!dirty} onClick={() => remote.reload()}>
          Discard
        </button>
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save menu'}
        </button>
      </div>
      {problems.length > 0 && (
        <div className="banner banner-danger" role="alert">
          <div>
            <strong>The menu wasn't saved:</strong>
            <ul>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {status && (
        <p className={status.conflict ? 'banner banner-warn' : 'ok-text'} role="status">
          {status.text}
          {status.conflict && (
            <button type="button" className="btn btn-sm" onClick={() => remote.reload()}>
              Reload
            </button>
          )}
        </p>
      )}

      {section === 'categories' ? (
        <CategoriesForm doc={doc} edit={edit} />
      ) : (
        <div className="editor-grid">
          <aside className="editor-list">
            {section === 'items'
              ? doc.categories.map((c) => (
                  <div key={c.id}>
                    <h4 style={{ '--cat': c.color } as CSSProperties}>{c.name}</h4>
                    {doc.items
                      .filter((i) => i.categoryId === c.id)
                      .map((i) => (
                        <button key={i.id} type="button" className={`editor-row${selected === i.id ? ' selected' : ''}`} onClick={() => setSelected(i.id)}>
                          <span>{i.name}</span>
                          <span className="muted">{formatMoney(i.price)}</span>
                        </button>
                      ))}
                  </div>
                ))
              : doc.groups.map((g) => (
                  <button key={g.id} type="button" className={`editor-row${selected === g.id ? ' selected' : ''}`} onClick={() => setSelected(g.id)}>
                    <span>{g.name}</span>
                    <span className="muted">
                      {g.options.length} {g.options.length === 1 ? 'option' : 'options'}
                    </span>
                  </button>
                ))}
            <button
              type="button"
              className="btn btn-block"
              disabled={section === 'items' && doc.categories.length === 0}
              onClick={() => {
                if (section === 'items') {
                  const id = shortId('item');
                  edit((d) => void d.items.push({ id, categoryId: d.categories[0]!.id, name: 'New item', price: 0, taxable: true, groupIds: [] }));
                  setSelected(id);
                } else {
                  const id = shortId('group');
                  const optionId = shortId('opt');
                  edit((d) => void d.groups.push({ id, name: 'New group', min: 0, max: 1, options: [{ id: optionId, name: 'Option', delta: 0, default: false, maxQty: 1 }] }));
                  setSelected(id);
                }
              }}
            >
              {section === 'items' ? 'Add item' : 'Add group'}
            </button>
          </aside>
          {item ? (
            <ItemForm key={item.id} doc={doc} item={item} edit={edit} />
          ) : group ? (
            <GroupForm key={group.id} group={group} edit={edit} />
          ) : (
            <p className="muted editor-form">Choose {section === 'items' ? 'an item' : 'a group'} to edit.</p>
          )}
        </div>
      )}
    </div>
  );
}
