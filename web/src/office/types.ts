// Back-office responses (internal/reports, internal/auth). Money is cents.

export interface Summary {
  orders: number;
  grossSales: number;
  tax: number;
  refunds: number;
  refundCount: number;
  refundedTax: number;
  netSales: number;
  netTax: number;
  collected: number;
  averageTicket: number;
  voidedOrders: number;
  voidedLines: number;
  reversals: number;
  openFlags: number;
}

export interface TenderRow {
  tender: 'card' | 'cash';
  payments: number;
  taken: number;
  refundCount: number;
  refunded: number;
  net: number;
}

export interface ItemRow {
  itemId: string;
  name: string;
  category: string;
  qty: number;
  gross: number;
  refundedQty: number;
  refunded: number;
  net: number;
}

export interface CategoryRow {
  category: string;
  qty: number;
  gross: number;
  refunded: number;
  net: number;
}

export interface ModifierRow {
  optionId: string;
  group: string;
  option: string;
  count: number;
  revenue: number;
}

export interface HourRow {
  hour: number;
  orders: number;
  gross: number;
}

export interface StaffReportRow {
  staffId: string;
  name: string;
  orders: number;
  gross: number;
  voidedLines: number;
  voidedLineAmount: number;
  voidedOrders: number;
  reversals: number;
  reversalAmount: number;
  refundsIssued: number;
  refundsApproved: number;
  refundedAmount: number;
}

export interface ReasonRow {
  reason: string;
  count: number;
  amount: number;
}

export interface DrawerRow {
  deviceId: string;
  name: string;
  code: string;
  cashIn: number;
  cashOut: number;
}

export interface Report {
  from: string;
  to: string;
  timezone: string;
  summary: Summary;
  tenders: TenderRow[];
  items: ItemRow[];
  categories: CategoryRow[];
  modifiers: ModifierRow[];
  hours: HourRow[];
  staff: StaffReportRow[];
  exceptions: { lineVoids: ReasonRow[]; orderVoids: ReasonRow[]; reversals: ReasonRow[]; refunds: ReasonRow[] };
  drawers: DrawerRow[];
}

export interface Drawer extends DrawerRow {
  openingFloat: number;
  expected: number;
  counted: number;
  overShort: number;
}

export interface Closeout {
  businessDate: string;
  closedBy: string;
  closedAt: string;
  note: string;
  drawers: Drawer[];
  snapshot: Report;
}

export interface DeviceSync {
  id: string;
  name: string;
  code: string;
  lastSeenAt: string | null;
  reportedPending: number;
  reportedOpen: number;
}

export interface CloseoutStatus {
  businessDate: string;
  closeout: Closeout | null;
  live: Report;
  changed: boolean;
  devices: DeviceSync[];
  defaultFloat: number;
}

export interface FlagView {
  id: number;
  kind: string;
  subjectKind: 'order' | 'refund';
  subjectId: string;
  orderId: string;
  number: string;
  deviceCode: string;
  businessDate: string;
  message: string;
  detail: unknown;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
}

export interface Rejection {
  id: number;
  deviceName: string;
  deviceCode: string;
  docId: string;
  kind: string;
  error: string;
  receivedAt: string;
}

export interface DeviceStatus {
  id: string;
  name: string;
  code: string;
  createdAt: string;
  lastSeenAt: string | null;
  reportedPending: number;
  reportedOpen: number;
  revokedAt: string | null;
}

export interface StaffAccount {
  id: string;
  name: string;
  role: 'barista' | 'manager';
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
