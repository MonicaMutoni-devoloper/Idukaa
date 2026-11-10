import { compare, lineAmount, periodCosts, summarize, valueAt } from "@sms/shared";
// Type-only: the calculation must stay independent of SQLite/IndexedDB so it runs in Node tests.
import type { LocalProduct, LocalRecord } from "../database";
// Explicit .ts so Node's test runner resolves it exactly as the tests do; tsconfig allows it.
import { buildLedger, isFailedSync, ledgerIsComplete, parseRecords } from "./local-dashboard.ts";

/**
 * Offline reports — the rows and totals behind the Reports screen, calculated from the operations
 * saved on THIS device.
 *
 * Why it exists: the Reports screen used to be a pure API client. Opening it without a connection
 * showed an error, and a sale saved in airplane mode was invisible until the phone synchronized,
 * even though the same sale was already on disk (the dashboard has read it since local records
 * were introduced). This module turns `records` + `products` into the exact row shapes the API
 * returns, and computes the summary with the SAME shared functions the API uses (`summarize`,
 * `periodCosts`, `valueAt`), so an offline figure and an online figure cannot drift apart.
 *
 * Two rules keep reconciliation honest:
 *  - A row's id is the operation's own id (`saleId`, `expenseId`, …), which the server keeps. When
 *    the same sale later comes back from the server, `mergePendingRows` matches it by id instead of
 *    adding a second row.
 *  - Only UNSYNCHRONIZED records are merged into a server answer. A synchronized record is already
 *    inside the server rows; adding it would double-count revenue.
 *
 * Deliberately absent offline rather than guessed: supplier names, cashier names, approved
 * adjustment costs and stock-loss costs (all live only on the server), and reversal state. Those
 * columns render as "—" and the screen says the figures are local.
 */

export type ReportView = "sales" | "items" | "purchases" | "expenses" | "adjustments";

/** Sync verdict of the record a row was calculated from (undefined for server rows). */
export type RowSyncStatus = "pending" | "retry" | "synced" | "conflict" | "rejected" | "pending_approval";

export interface CachedSaleLine {
  productId: string; name: string; code: string; unit: string;
  qty: number; unitPrice: number; lineAmount: number;
}
export interface ReportSaleRow {
  id: string; at: string; by: string | null; payment_method: string;
  gross_amount: number; discount: number; amount_paid: number; status: string;
  units: number; products: string; lines?: CachedSaleLine[]; local?: boolean; syncStatus?: RowSyncStatus;
}
export interface ReportItemRow {
  productId: string; name: string; code: string; unit: string;
  /** Catalogue category when the source has it (API and device rows both do); absent = uncategorised. */
  category?: string | null;
  units: number; gross: number; sales: number; avgUnitPrice: number;
  local?: boolean; syncStatus?: RowSyncStatus;
}
export interface CachedPurchaseLine {
  productId: string; name: string; code: string; unit: string;
  qty: number; qtyReceived?: number; unitCost: number; lineAmount: number;
}
export interface ReportPurchaseRow {
  id: string; at: string; supplier: string | null; reference: string | null; notes: string | null;
  total_amount: number; amount_paid: number; balance: number; lines?: CachedPurchaseLine[];
  local?: boolean; syncStatus?: RowSyncStatus;
}
export interface ReportExpenseRow {
  id: string; at: string; category: string; amount: number; paid: boolean;
  note: string | null; by: string | null;
  local?: boolean; syncStatus?: RowSyncStatus;
}
export interface ReportAdjustmentRow {
  id: string; at: string; product: string; qty: number; reason: string;
  unit_cost: number | null; status: string; requested_by: string | null; note: string | null;
  local?: boolean; syncStatus?: RowSyncStatus;
}
export type ReportRow = ReportSaleRow | ReportItemRow | ReportPurchaseRow | ReportExpenseRow | ReportAdjustmentRow;

export interface ReportItemsTotals { units: number; gross: number; products: number; sales: number; net: number; discounts: number }

export interface LocalReportResult {
  rows: ReportRow[];
  totals: ReportItemsTotals | null;
  /** Operations saved on this device and not yet confirmed by the server, inside the period. */
  counts: { pending: number; failed: number; conflicts: number; inRange: number };
  /** Earliest instant this device holds any record for; null when it holds none. */
  coverageFrom: string | null;
}

export interface LocalReportInput {
  records: LocalRecord[];
  products: LocalProduct[];
  view: ReportView;
  from: string;
  to: string;
}

const num = (v: unknown, fallback = 0) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const inRange = (iso: string, from: string, to: string) => {
  const t = Date.parse(iso);
  return t >= Date.parse(from) && t < Date.parse(to);
};
const toIso = (v: unknown, fallback: string) => {
  const s = typeof v === "string" ? v : "";
  return Number.isNaN(Date.parse(s)) ? fallback : new Date(s).toISOString();
};
const json = (raw: string): any => {
  try {
    const p = JSON.parse(raw);
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
};
/** A record is "still ours" until the server has confirmed it: exactly the rows to merge into a server answer. */
export const isUnsynced = (status: string) => status === "pending" || status === "retry" || status === "pending_approval";

/** Signed RWF for a sale line: quantities are milli-units, prices integer RWF. */
const lineValue = (l: any) => lineAmount(num(l.sellingQty ?? l.qty), num(l.unitPrice));

/**
 * Rows for one report view, from this device's records. Pure: no storage, no network.
 */
export function computeLocalReport(input: LocalReportInput): LocalReportResult {
  const { records, products, view, from, to } = input;
  const byId = new Map(products.map((p) => [p.id, p] as const));
  const nameOf = (id: unknown) => byId.get(String(id))?.name ?? String(id ?? "");
  const inPeriod = records.filter((r) => inRange(r.at, from, to));
  // Failed/conflicting operations stay visible on the Sync screen for recovery, but they are not
  // business rows: the server refused them, so nothing moved in stock or money.
  const usable = records.filter((r) => !isFailedSync(r.status));
  const counts = {
    inRange: inPeriod.length,
    pending: inPeriod.filter((r) => isUnsynced(r.status)).length,
    failed: inPeriod.filter((r) => r.status === "rejected").length,
    conflicts: inPeriod.filter((r) => r.status === "conflict").length,
  };
  const coverageFrom = records.reduce<string | null>((min, r) => {
    const t = Date.parse(r.at);
    if (Number.isNaN(t)) return min;
    return min === null || t < Date.parse(min) ? new Date(t).toISOString() : min;
  }, null);
  const base = { counts, coverageFrom };

  if (view === "sales") {
    const rows: ReportSaleRow[] = [];
    for (const r of usable) {
      if (r.type !== "sale.create") continue;
      const p = json(r.data);
      if (!p) continue;
      const at = toIso(p.soldAt ?? r.at, r.at);
      if (!inRange(at, from, to)) continue;
      const lines: any[] = Array.isArray(p.lines) ? p.lines : [];
      const gross = lines.reduce((s, l) => s + lineValue(l), 0);
      const discount = Math.min(Math.max(0, num(p.discount)), gross);
      rows.push({
        id: String(p.saleId ?? r.op_id), at, by: r.actor ?? null,
        payment_method: String(p.paymentMethod ?? "cash"),
        gross_amount: gross, discount,
        amount_paid: Math.min(Math.max(0, num(p.amountPaid)), gross - discount),
        status: "posted",
        units: lines.reduce((s, l) => s + num(l.qty), 0),
        products: lines.map((l) => nameOf(l.productId)).filter(Boolean).join(", "),
        lines: lines.map((l) => {
          const product = byId.get(String(l.productId));
          return {
            productId: String(l.productId), name: product?.name ?? String(l.productId),
            code: product?.code ?? "—", unit: product?.unit ?? "unit",
            qty: num(l.qty), unitPrice: num(l.unitPrice), lineAmount: lineValue(l),
          };
        }),
        local: r.status !== "synced", syncStatus: r.status as RowSyncStatus,
      });
    }
    return { ...base, totals: null, rows: rows.sort((a, b) => b.at.localeCompare(a.at)) };
  }

  if (view === "items") {
    const acc = new Map<string, { units: number; gross: number; sales: number }>();
    let grossAll = 0, discounts = 0;
    for (const r of usable) {
      if (r.type !== "sale.create") continue;
      const p = json(r.data);
      if (!p) continue;
      const at = toIso(p.soldAt ?? r.at, r.at);
      if (!inRange(at, from, to)) continue;
      const lines: any[] = Array.isArray(p.lines) ? p.lines : [];
      const gross = lines.reduce((s, l) => s + lineValue(l), 0);
      grossAll += gross;
      discounts += Math.min(Math.max(0, num(p.discount)), gross);
      for (const l of lines) {
        const key = String(l.productId);
        const cur = acc.get(key) ?? { units: 0, gross: 0, sales: 0 };
        cur.units += num(l.qty);
        cur.gross += lineValue(l);
        cur.sales += 1;
        acc.set(key, cur);
      }
    }
    const rows: ReportItemRow[] = [...acc.entries()].map(([productId, v]) => {
      const p = byId.get(productId);
      return {
        productId, name: p?.name ?? productId, code: p?.code ?? "—", unit: p?.unit ?? "unit", category: p?.category ?? null,
        units: v.units, gross: v.gross, sales: v.sales,
        // Server formula: integer RWF per selling unit, from gross value over milli-units.
        avgUnitPrice: v.units > 0 ? Math.round(v.gross / (v.units / 1000)) : 0,
      };
    }).sort((a, b) => b.gross - a.gross || a.name.localeCompare(b.name));
    return {
      ...base, rows,
      totals: { units: rows.reduce((s, r) => s + r.units, 0), gross: grossAll, products: rows.length, sales: rows.reduce((s, r) => s + r.sales, 0), net: grossAll - discounts, discounts },
    };
  }

  if (view === "purchases") {
    const rows: ReportPurchaseRow[] = [];
    for (const r of usable) {
      if (r.type !== "purchase.create" && r.type !== "receipt.create") continue;
      const p = json(r.data);
      if (!p) continue;
      const isReceipt = r.type === "receipt.create";
      const at = toIso(isReceipt ? p.receivedAt : p.orderedAt, r.at);
      if (!inRange(at, from, to)) continue;
      const lines: any[] = Array.isArray(p.lines) ? p.lines : [];
      const total = lines.reduce((s, l) => s + lineAmount(num(l.qty), num(l.unitCost)), 0);
      const paid = isReceipt ? 0 : Math.max(0, num(p.amountPaid));
      rows.push({
        id: String((isReceipt ? p.receiptId : p.purchaseId) ?? r.op_id), at,
        // Supplier names live only on the server; the screen prints "—" instead of inventing one.
        supplier: p.supplierName ?? p.supplier ?? null,
        reference: p.reference ?? null, notes: p.notes ?? null,
        total_amount: total, amount_paid: paid, balance: total - paid,
        local: r.status !== "synced", syncStatus: r.status as RowSyncStatus,
      });
    }
    return { ...base, totals: null, rows: rows.sort((a, b) => b.at.localeCompare(a.at)) };
  }

  if (view === "expenses") {
    // `expense.update` patches the row it names; without applying it here an edited expense would
    // be reported at its original amount offline and at its new amount online.
    const map = new Map<string, ReportExpenseRow>();
    for (const r of usable) {
      const p = json(r.data);
      if (!p) continue;
      if (r.type === "expense.create") {
        const id = String(p.expenseId ?? r.op_id);
        map.set(id, {
          id, at: toIso(p.incurredAt ?? r.at, r.at), category: String(p.category ?? "other"),
          amount: Math.max(0, num(p.amount)), paid: !!p.paid, note: p.note ?? null, by: r.actor ?? null,
          local: r.status !== "synced", syncStatus: r.status as RowSyncStatus,
        });
      } else if (r.type === "expense.update") {
        const cur = map.get(String(p.expenseId ?? ""));
        if (!cur) continue;
        if (p.category !== undefined) cur.category = String(p.category);
        if (p.amount !== undefined) cur.amount = Math.max(0, num(p.amount));
        if (p.paid !== undefined) cur.paid = !!p.paid;
        if (p.note !== undefined) cur.note = p.note;
        if (p.incurredAt !== undefined) cur.at = toIso(p.incurredAt, cur.at);
      }
    }
    const rows = [...map.values()].filter((e) => inRange(e.at, from, to)).sort((a, b) => b.at.localeCompare(a.at));
    return { ...base, totals: null, rows };
  }

  const rows: ReportAdjustmentRow[] = [];
  for (const r of usable) {
    if (r.type !== "adjustment.request") continue;
    const p = json(r.data);
    if (!p) continue;
    const at = toIso(p.countedAt ?? r.at, r.at);
    if (!inRange(at, from, to)) continue;
    rows.push({
      id: String(p.adjustmentId ?? r.op_id), at, product: nameOf(p.productId),
      qty: num(p.qty), reason: String(p.reason ?? "other"),
      // Ledger cost comes from stock movements the device does not pull; null renders as "—".
      unit_cost: null,
      // Approval is decided by the server, so a device row is never presented as approved.
      status: r.status === "rejected" ? "rejected" : r.status === "synced" ? "pending" : "pending",
      requested_by: r.actor ?? null, note: p.note ?? null,
      local: r.status !== "synced", syncStatus: r.status as RowSyncStatus,
    });
  }
  return { ...base, totals: null, rows: rows.sort((a, b) => b.at.localeCompare(a.at)) };
}

/* ------------------------------------------------------------------ reconciliation */

/**
 * Combines authoritative (server or cached) rows with operations this device has not synchronized
 * yet. Matching is by row id, which is the operation id the server also stores, so a sale that
 * pushed successfully cannot appear twice even if the local verdict is stale.
 */
export function mergePendingRows<T extends { id?: string; at?: string; local?: boolean }>(authoritative: T[], pending: T[]): T[] {
  const seen = new Set(authoritative.map((r) => String(r.id ?? "")));
  const extra = pending.filter((r) => !seen.has(String(r.id ?? ""))).map((r) => ({ ...r, local: true }));
  const merged = [...authoritative, ...extra];
  return merged.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
}

/* ------------------------------------------------------------------ cache */

export interface ReportCacheEntry {
  savedAt: string;
  shopId: string | null;
  view: string;
  from: string;
  to: string;
  /** Cost/profit scope. A manager without financial access can never read an owner's cached copy. */
  access: "financial" | "operational";
  rows: unknown[];
  totals: unknown;
}

const accessScope = (financials: boolean): "financial" | "operational" => financials ? "financial" : "operational";

/** Per shop, per view, per period AND permission scope: a cached report can never cross any of them. */
export const reportCacheKey = (shopId: string | null, view: string, from: string, to: string, financials = false) =>
  `report:v2:${shopId ?? "none"}:${view}:${from}:${to}:${accessScope(financials)}`;

/**
 * Validates a cached entry before it is rendered. Anything that does not match the shop, view,
 * exact period or financial-permission scope is rejected, so a corrupted entry or another
 * account's cost data can never stand in for this report. Never throws.
 */
export function readReportCache(
  raw: string | null,
  expect: { shopId: string | null; view: string; from: string; to: string; financials?: boolean },
): ReportCacheEntry | null {
  if (!raw) return null;
  let e: any;
  try { e = JSON.parse(raw); } catch { return null; }
  if (!e || typeof e !== "object" || !Array.isArray(e.rows)) return null;
  if (e.view !== expect.view || e.from !== expect.from || e.to !== expect.to) return null;
  if ((e.shopId ?? null) !== (expect.shopId ?? null)) return null;
  if (e.access !== accessScope(expect.financials ?? false)) return null;
  if (typeof e.savedAt !== "string" || Number.isNaN(Date.parse(e.savedAt))) return null;
  return e as ReportCacheEntry;
}

/* ------------------------------------------------------------------ summary (P&L) */

/** Same shape as GET /reports/summary's `current`, so one component renders both. */
export interface LocalSummaryTotals {
  grossSales: number; discounts: number; salesReturns: number; netSales: number; cogs: number;
  grossProfit: number; grossMarginBps: number | null; operatingExpenses: number; operatingProfit: number;
  operatingResultAfterStockLosses: number; stockLosses: number; cashCollected: number; receivables: number;
  outstandingExpenses: number; inventoryPurchases: number; expensesPaid: number;
  transactions: number; unitsSold: number;
  purchasesReceived: { deliveries: number; products: number; units: number; value: number };
  openingInventoryValue: number; closingInventoryValue: number;
  openingInventoryUnits: number; closingInventoryUnits: number; costBasisIncomplete: boolean;
}

export interface LocalSummaryPayload {
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  current: LocalSummaryTotals;
  previous: LocalSummaryTotals;
  comparison: ReturnType<typeof compare>;
  /** Operations in the period still waiting for the server: not inside the server's own totals. */
  pendingOps: number;
  /** True when this device's ledger cannot price every sale (history predates the records). */
  provisional: boolean;
}

export interface LocalSummaryInput {
  records: LocalRecord[];
  products: LocalProduct[];
  from: string;
  to: string;
  /** False for a manager without financial access: costs and profit stay hidden, sales do not. */
  financials?: boolean;
}

/**
 * Period P&L from saved records, mirroring FinanceService.period: net sales after discounts, COGS
 * from the full moving-average ledger, expenses deducted in the period they were incurred, stock
 * received treated as inventory (never as revenue), and opening/closing inventory at the same cost.
 */
export function computeLocalSummary(input: LocalSummaryInput): LocalSummaryPayload {
  const { from, to } = input;
  const financials = input.financials ?? true;
  const recs = parseRecords(input.records);
  const ledger = buildLedger(recs);
  const missingCost = [...ledger.values()].some((list) =>
    list.some((m) => (m.type === "opening" || m.type === "receipt" || m.type === "transfer_in") && m.qty > 0 && !m.unitCost),
  );
  const ledgerComplete = [...ledger.values()].every(ledgerIsComplete);
  const provisional = !financials || !ledgerComplete || missingCost;

  const figures = (a: string, b: string): LocalSummaryTotals => {
    const sales = recs.sales.filter((s) => inRange(s.at, a, b));
    const expenses = recs.expenses.filter((e) => inRange(e.at, a, b));
    const purchases = recs.purchases.filter((p) => inRange(p.at, a, b));
    const receipts = purchases.filter((p) => p.receiveNow);

    let grossSales = 0, discounts = 0, cashCollected = 0, receivables = 0, unitsSold = 0;
    for (const s of sales) {
      const gross = s.lines.reduce((sum, l) => sum + lineAmount(l.sellingQty ?? l.qty, l.unitPrice), 0);
      const discount = Math.min(s.discount, gross);
      grossSales += gross;
      discounts += discount;
      cashCollected += Math.min(s.paid, Math.max(0, gross - discount));
      receivables += Math.max(0, gross - discount - s.paid);
      unitsSold += s.lines.reduce((sum, l) => sum + l.qty, 0);
    }
    const operatingExpenses = expenses.reduce((s, e) => s + e.amount, 0);
    const expensesPaid = expenses.filter((e) => e.paid).reduce((s, e) => s + e.amount, 0);

    let cogs = 0, losses = 0, openingValue = 0, closingValue = 0, openingUnits = 0, closingUnits = 0;
    for (const list of ledger.values()) {
      if (financials) {
        const c = periodCosts(list, a, b);
        cogs += c.cogs; losses += c.lossValue;
        const o = valueAt(list, a); const e = valueAt(list, b);
        openingValue += o.value; closingValue += e.value;
        openingUnits += o.onHand; closingUnits += e.onHand;
      }
    }

    const base = summarize({
      grossSales, discounts, salesReturns: 0, cogs,
      operatingExpenses, expensesPaid, cashCollected,
      inventoryPurchases: purchases.reduce((s, p) =>
        s + p.lines.reduce((t, l) => t + lineAmount(l.qty, l.unitCost), 0), 0),
      receivables, stockLosses: losses,
    });

    return {
      ...base,
      transactions: sales.length,
      unitsSold,
      purchasesReceived: {
        deliveries: receipts.length,
        products: new Set(receipts.flatMap((p) => p.lines.map((l) => l.productId))).size,
        units: receipts.reduce((s, p) => s + p.lines.reduce((t, l) => t + l.qty, 0), 0),
        value: receipts.reduce((s, p) => s + p.lines.reduce((t, l) => t + lineAmount(l.qty, l.unitCost), 0), 0),
      },
      openingInventoryValue: openingValue, closingInventoryValue: closingValue,
      openingInventoryUnits: openingUnits, closingInventoryUnits: closingUnits,
      costBasisIncomplete: provisional,
    };
  };

  const current = figures(from, to);
  const span = Date.parse(to) - Date.parse(from);
  const prevFrom = new Date(Date.parse(from) - span).toISOString();
  const previous = figures(prevFrom, from);
  const pendingOps = input.records.filter((r) => isUnsynced(r.status) && inRange(r.at, from, to)).length;
  return {
    range: { from, to }, previousRange: { from: prevFrom, to: from },
    current, previous, comparison: compare(current, previous), pendingOps, provisional,
  };
}
