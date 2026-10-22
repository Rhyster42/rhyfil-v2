// An open order on this tablet. Built locally, synced once when it closes
// (docs/decisions/0002). The reducer arrives in milestone 4.
import type { PaymentDoc, VoidInfo } from './documents';
import type { Selection } from './menu';

export interface DraftLine {
  id: string;
  itemId: string;
  qty: number;
  mods: Selection[];
  addedAt: string;
  void: VoidInfo | null;
}

export interface Draft {
  id: string;
  number: string;
  businessDate: string;
  deviceId: string;
  /** Who started the order. */
  staffId: string;
  /**
   * The menu version this order is priced with. It stays fixed while the
   * order is open, so a menu edit never changes a price mid-order, and the
   * server re-prices against the same version.
   */
  menuVersion: number;
  createdAt: string;
  lines: DraftLine[];
  payments: PaymentDoc[];
  selectedLineId: string | null;
  /** Set when fully paid or voided; the order waits here during the undo window. */
  closedAt: string | null;
  void: VoidInfo | null;
}
