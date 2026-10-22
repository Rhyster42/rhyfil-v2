// The register's state: the open order lives in memory for instant taps and
// is written through to IndexedDB on every change, so a reload or crash
// never loses it (docs/decisions/0001, 0018).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../api/client';
import type { Settings } from '../api/types';
import { engine } from '../app/services';
import { db, useMeta } from '../db/db';
import { finalizeOrder, finalizeStaleDrafts, formatOrderNumber, loadOrderCounter, useMenuIndex } from '../db/ledger';
import { businessDate } from '../domain/businessDate';
import type { Tender } from '../domain/documents';
import { uuidv7 } from '../domain/ids';
import type { MenuIndex } from '../domain/menu';
import * as order from '../domain/order';
import { cardPayment, cashPayment } from '../domain/tender';
import { now, nowIso } from '../sync/clock';

export interface CloseSummary {
  draftId: string;
  number: string;
  status: 'paid' | 'voided';
  total: number;
  tender: Tender | 'none' | 'split';
  change: number;
}

export interface RegisterOptions {
  /** How long a closed order can be undone before it's sent. */
  undoWindowMs?: number;
}

function dayOf(at: Date, settings: Settings | null | undefined): string {
  const tz = settings?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return businessDate(at, tz, settings?.dayCutoffMinutes ?? 240);
}

export function useRegister(staffId: string, { undoWindowMs = 10_000 }: RegisterOptions = {}) {
  const device = useMeta('device');
  const settings = useMeta('settings');
  const latestVersion = useMeta('menuVersion');
  const [draft, setDraft] = useState<order.Draft | null | undefined>(undefined);
  const [lastClose, setLastClose] = useState<CloseSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const counter = useRef<{ businessDate: string; n: number } | null>(null);
  const finalized = useRef(new Set<string>());
  const current = useRef(draft);
  current.current = draft;

  const draftIx = useMenuIndex(draft?.menuVersion);
  const latestIx = useMenuIndex(latestVersion);
  // An open order keeps its own menu version; a new one uses the latest.
  const ix: MenuIndex | null | undefined = draft ? draftIx : latestIx;
  const priced = useMemo(() => (draft && draftIx ? order.priceDraft(draft, draftIx) : null), [draft, draftIx]);

  // Load the open order and the order counter once.
  const deviceCode = device?.code;
  useEffect(() => {
    if (!deviceCode || settings === undefined) return;
    let live = true;
    void (async () => {
      await finalizeStaleDrafts(); // closed during an earlier visit
      const today = dayOf(now(), settings);
      const n = await loadOrderCounter(deviceCode, today);
      const open = (await db.drafts.toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null;
      if (!live) return;
      counter.current = { businessDate: today, n };
      setDraft((d) => (d === undefined ? open : d));
    })();
    return () => {
      live = false;
    };
    // Runs once settings have loaded (they only matter for this first load).
  }, [deviceCode, settings === undefined]);

  // Write every change through.
  useEffect(() => {
    if (draft && !finalized.current.has(draft.id)) void db.drafts.put(draft);
  }, [draft]);

  const finalize = useCallback(async (d: order.Draft) => {
    if (finalized.current.has(d.id)) return;
    finalized.current.add(d.id);
    try {
      await finalizeOrder(d);
    } catch (e) {
      finalized.current.delete(d.id);
      setError(errorMessage(e));
      return;
    }
    void engine.syncNow();
  }, []);

  // The undo window: a closed order is sent when it expires.
  useEffect(() => {
    if (!draft?.closedAt) return;
    const timer = setTimeout(() => {
      void finalize(draft);
      setDraft((d) => (d?.id === draft.id ? null : d));
    }, undoWindowMs);
    return () => clearTimeout(timer);
  }, [draft, finalize, undoWindowMs]);

  // Leaving the register ends the undo window.
  useEffect(
    () => () => {
      const d = current.current;
      if (d?.closedAt) void finalize(d);
    },
    [finalize],
  );

  /** Applies a pure change to the open order, reporting rule violations. */
  const apply = (f: (d: order.Draft) => order.Draft) => {
    if (!draft) return;
    try {
      setDraft(f(draft));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const takeNumber = (code: string, day: string): string => {
    const c = counter.current;
    const n = c && c.businessDate === day ? c.n + 1 : 1;
    counter.current = { businessDate: day, n };
    void db.setMeta('orderCounter', { businessDate: day, n });
    return formatOrderNumber(code, n);
  };

  function addItem(itemId: string) {
    setLastClose(null);
    setError(null);
    let base = draft ?? null;
    if (base?.closedAt) {
      void finalize(base);
      base = null;
    }
    if (base && !order.isEditable(base)) {
      setError('This order has payments. Give them back (More) to change it.');
      return;
    }
    const menu = base ? draftIx : latestIx;
    if (!device || !menu || latestVersion == null || !counter.current) return;
    const at = now();
    if (!base) {
      const day = dayOf(at, settings);
      base = order.newDraft({
        id: uuidv7(at.getTime()),
        number: takeNumber(device.code, day),
        businessDate: day,
        deviceId: device.id,
        staffId,
        menuVersion: latestVersion,
        createdAt: at.toISOString(),
      });
    }
    setDraft(order.addItem(base, menu, itemId, uuidv7(at.getTime()), at.toISOString()));
  }

  const who = (reason: string) => ({ at: nowIso(), by: staffId, reason });

  function pay(tender: Tender, due: number, tendered: number, coversLineIds: string[] = []): boolean {
    if (!draft || !priced) return false;
    const at = nowIso();
    const payment =
      tender === 'card'
        ? cardPayment({ id: uuidv7(), amount: due, staffId, at, coversLineIds })
        : cashPayment({ id: uuidv7(), due, tendered, staffId, at, coversLineIds });
    let next: order.Draft;
    try {
      next = order.addPayment(draft, priced, payment);
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
    setDraft(next);
    setError(null);
    if (next.closedAt) {
      const kept = order.captured(next);
      setLastClose({
        draftId: next.id,
        number: next.number,
        status: 'paid',
        total: priced.totals.total,
        tender: kept.length > 1 ? 'split' : tender,
        change: payment.change,
      });
    }
    return true;
  }

  return {
    loading: draft === undefined || ix === undefined,
    menuMissing: ix === null,
    draft: draft ?? null,
    ix: ix ?? null,
    priced,
    lastClose,
    error,
    /** True while the last closed order can still be undone. */
    canUndo: !!draft?.closedAt,
    dismissError: () => setError(null),

    addItem,
    select: (lineId: string | null) => apply((d) => order.selectLine(d, lineId)),
    toggle: (lineId: string, optionId: string) => draftIx && apply((d) => order.toggleOption(d, draftIx, lineId, optionId)),
    step: (lineId: string, optionId: string, delta: 1 | -1) => draftIx && apply((d) => order.stepOption(d, draftIx, lineId, optionId, delta)),
    setQty: (lineId: string, qty: number) => apply((d) => order.setLineQty(d, lineId, qty)),
    duplicate: (lineId: string) => apply((d) => order.duplicateLine(d, lineId, uuidv7(), nowIso())),
    voidLine: (lineId: string, reason: string) => apply((d) => order.voidLine(d, lineId, who(reason))),
    voidOrder: (reason: string) => {
      if (!draft || !priced) return;
      apply((d) => order.voidOrder(d, who(reason)));
      setLastClose({ draftId: draft.id, number: draft.number, status: 'voided', total: priced.totals.total, tender: 'none', change: 0 });
    },
    pay,
    noCharge: () => {
      if (!draft || !priced) return;
      apply((d) => order.closeNoCharge(d, priced, nowIso()));
      setLastClose({ draftId: draft.id, number: draft.number, status: 'paid', total: 0, tender: 'none', change: 0 });
    },
    reverse: (paymentId: string, reason: string) => apply((d) => order.reversePayment(d, paymentId, who(reason))),
    undo: () => {
      apply((d) => order.undoClose(d, who('Undone at the register')));
      setLastClose(null);
    },
  };
}

export type Register = ReturnType<typeof useRegister>;
