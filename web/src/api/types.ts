// Shapes of the server's JSON responses (see internal/server for routes).
import type { DocKind, OrderDoc, RefundDoc } from '../domain/documents';
import type { MenuDoc } from '../domain/menu';

export type Role = 'barista' | 'manager';

export interface Device {
  id: string;
  name: string;
  code: string;
}

export interface StaffMember {
  id: string;
  name: string;
  role: Role;
  active: boolean;
  /** Present for active staff only. */
  pinVerifier: string | null;
}

export interface Settings {
  storeName: string;
  timezone: string;
  currency: string;
  dayCutoffMinutes: number;
  defaultFloat: number;
  version: number;
}

export interface MenuVersion {
  version: number;
  doc: MenuDoc;
}

export type LedgerEntry =
  | { seq: number; kind: 'order'; doc: OrderDoc }
  | { seq: number; kind: 'refund'; doc: RefundDoc };

export interface PullResponse {
  serverTime: string;
  menu: MenuVersion | null;
  staff: { version: number; members: StaffMember[] } | null;
  settings: Settings | null;
  ledger: { entries: LedgerEntry[]; cursor: number; hasMore: boolean };
}

export type PushStatus = 'applied' | 'duplicate' | 'rejected' | 'retry';

export interface PushResult {
  id: string;
  status: PushStatus;
  seq?: number;
  error?: string;
}

export interface PushRequest {
  mutations: { id: string; kind: DocKind; doc: OrderDoc | RefundDoc }[];
}

export interface Enrolled {
  device: Device;
  token: string;
}

export interface ManagerSessionResponse {
  token: string;
  expiresAt: string;
  staff: { id: string; name: string; role: Role };
}
