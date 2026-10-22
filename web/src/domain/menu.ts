// The menu document (docs/decisions/0004) and its selection rules. Mirrors
// internal/menu; tested against testdata/vectors/selections.json.

export interface MenuDoc {
  taxRatePpm: number;
  categories: Category[];
  items: Item[];
  groups: Group[];
}

export interface Category {
  id: string;
  name: string;
  color: string;
}

export interface Item {
  id: string;
  categoryId: string;
  name: string;
  price: number;
  taxable: boolean;
  groupIds: string[];
}

export interface Group {
  id: string;
  name: string;
  min: number;
  max: number;
  options: Option[];
}

export interface Option {
  id: string;
  name: string;
  delta: number;
  default: boolean;
  maxQty: number;
}

/** A modifier option chosen for a line. */
export interface Selection {
  optionId: string;
  qty: number;
}

export interface OptionRef {
  option: Option;
  group: Group;
}

export interface MenuIndex {
  doc: MenuDoc;
  categories: Map<string, Category>;
  items: Map<string, Item>;
  groups: Map<string, Group>;
  options: Map<string, OptionRef>;
}

export function indexMenu(doc: MenuDoc): MenuIndex {
  const ix: MenuIndex = {
    doc,
    categories: new Map(doc.categories.map((c) => [c.id, c])),
    items: new Map(doc.items.map((i) => [i.id, i])),
    groups: new Map(doc.groups.map((g) => [g.id, g])),
    options: new Map(),
  };
  for (const group of doc.groups) {
    for (const option of group.options) ix.options.set(option.id, { option, group });
  }
  return ix;
}

/** The groups that apply to an item, in display order. */
export function itemGroups(ix: MenuIndex, itemId: string): Group[] {
  const item = ix.items.get(itemId);
  if (!item) return [];
  return item.groupIds.flatMap((id) => ix.groups.get(id) ?? []);
}

/** The options pre-selected when an item is added. */
export function defaultSelections(ix: MenuIndex, itemId: string): Selection[] {
  return itemGroups(ix, itemId).flatMap((g) =>
    g.options.filter((o) => o.default).map((o) => ({ optionId: o.id, qty: 1 })),
  );
}

/**
 * Problems with choosing mods for itemId, as sorted codes like "min:size" or
 * "qty:shot-extra". Empty means the line is complete and valid.
 */
export function checkSelections(ix: MenuIndex, itemId: string, mods: readonly Selection[]): string[] {
  const item = ix.items.get(itemId);
  if (!item) return [`unknown-item:${itemId}`];
  const allowed = new Set(item.groupIds);
  const problems: string[] = [];
  const seen = new Set<string>();
  const chosen = new Map<string, number>();
  for (const m of mods) {
    const ref = ix.options.get(m.optionId);
    if (!ref) {
      problems.push(`unknown:${m.optionId}`);
      continue;
    }
    if (!allowed.has(ref.group.id)) {
      problems.push(`not-allowed:${m.optionId}`);
      continue;
    }
    if (seen.has(m.optionId)) {
      problems.push(`duplicate:${m.optionId}`);
      continue;
    }
    seen.add(m.optionId);
    chosen.set(ref.group.id, (chosen.get(ref.group.id) ?? 0) + 1);
    if (m.qty < 1 || m.qty > ref.option.maxQty) problems.push(`qty:${m.optionId}`);
  }
  for (const gid of item.groupIds) {
    const g = ix.groups.get(gid);
    if (!g) continue;
    const n = chosen.get(gid) ?? 0;
    if (n < g.min) problems.push(`min:${gid}`);
    if (n > g.max) problems.push(`max:${gid}`);
  }
  return problems.sort();
}
