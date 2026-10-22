// The documents tablets create and sync (docs/decisions/0002). This is the
// wire format the server validates (internal/ledger); once a document is
// synced it never changes.
import type { PricedMod } from './pricing';

/** Who did something, when, and why (voids and reversals). */
export interface VoidInfo {
  at: string;
  by: string;
  reason: string;
}

export interface OrderLineDoc {
  id: string;
  itemId: string;
  itemName: string;
  category: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  taxable: boolean;
  mods: PricedMod[];
  addedAt: string;
  void: VoidInfo | null;
}

export type Tender = 'cash' | 'card';

export interface PaymentDoc {
  id: string;
  tender: Tender;
  /** Applied to the order. */
  amount: number;
  /** Handed over: cash given, or the card amount. */
  tendered: number;
  /** tendered − amount; only cash gives change. */
  change: number;
  /** For split-by-item: the lines this payment covered. */
  coversLineIds: string[];
  staffId: string;
  createdAt: string;
  reversal: VoidInfo | null;
}

export interface OrderDoc {
  v: 1;
  id: string;
  deviceId: string;
  staffId: string;
  number: string;
  businessDate: string;
  status: 'paid' | 'voided';
  menuVersion: number;
  createdAt: string;
  closedAt: string;
  lines: OrderLineDoc[];
  subtotal: number;
  tax: number;
  total: number;
  payments: PaymentDoc[];
  void: VoidInfo | null;
}

export interface RefundLineDoc {
  lineId: string;
  qty: number;
  /** Money returned for these units, tax included. */
  amount: number;
  /** The tax part of amount. */
  tax: number;
}

export interface RefundDoc {
  v: 1;
  id: string;
  orderId: string;
  paymentId: string;
  tender: Tender;
  deviceId: string;
  staffId: string;
  approvedBy: string;
  businessDate: string;
  createdAt: string;
  /** Total returned, tax included. */
  amount: number;
  /** The tax part of amount. */
  tax: number;
  reason: string;
  /** Empty for a custom-amount refund. */
  lines: RefundLineDoc[];
}

export type DocKind = 'order' | 'refund';
