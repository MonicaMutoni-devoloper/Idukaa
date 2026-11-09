import { lineAmount, type MovementType } from "@sms/shared";
import type { LocalProduct, LocalRecord } from "../database";
import { parseRecords } from "./local-dashboard.ts";
import { bucketKey, bucketKeys, type BucketMode } from "./report-period.ts";
import type {
  ReportAdjustmentRow, ReportExpenseRow, ReportItemRow, ReportPurchaseRow, ReportSaleRow, RowSyncStatus,
} from "./local-reports";

/**
 * Analytics for the reports workspace.
 *
 * These are pure aggregations of rows that already exist (sale, item, expense, purchase,
 * adjustment, inventory and movement rows) — they never introduce a second profit or COGS
 * definition. Anything that is an accounting rule (net sales, COGS, gross profit, stock-loss
 * value) comes from the shared/API summary or from the existing local summary; this module only
 * groups and totals the same records for display, charts and exports.
 *
 * A missing value stays missing: cost, inventory value and loss cost are `null` when the device or
 * the caller's role cannot see them, never `0`. The UI prints "—" and says what is unavailable.
 */

export interface InventoryRow {
  id: string; name: string; code: string; unit: string; category: string | null;
  onHand: number; threshold: number; low: boolean; sellingPrice: number;
  avgCost: number | null; value: number | null; local?: boolean;
}

export type MovementGroup = "in" | "sold" | "loss" | "adjust" | "other";

export interface MovementRow {
  id: string; at: string; product: string; code: string; unit: string;
  type: MovementType; qty: number; unitCost: number | null;
  reason: string | null; reference: string | null; by: string | null;
  balanceBefore: number | null; balanceAfter: number | null;
  local?: boolean; syncStatus?: RowSyncStatus;
}

/* ------------------------------------------------------------------ sales */

export interface SalesTotals {
  gross: number; discounts: number; net: number; transactions: number; units: number;
  averageSale: number; reversed: number;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Posted sales only; voided sales stay visible in the ledger but never in revenue. */
export function salesTotals(sales: ReportSaleRow[]): SalesTotals {
  let gross = 0, discounts = 0, units = 0, transactions = 0, reversed = 0;
  for (const s of sales) {
    if (s.status === "reversed") { reversed += 1; continue; }
    gross += num(s.gross_amount);
    discounts += num(s.discount);
    units += num(s.units);
    transactions += 1;
  }
  const net = gross - discounts;
  return { gross, discounts, net, transactions, units, averageSale: transactions ? Math.round(net / transactions) : 0, reversed };
}

export interface CashierTotal { key: string; label: string; net: number; transactions: number; units: number }

/** Sales grouped by the cashier the server recorded. A device-authored sale has no name offline → "—". */
export function salesByCashier(sales: ReportSaleRow[]): CashierTotal[] {
  const map = new Map<string, CashierTotal>();
  for (const s of sales) {
    if (s.status === "reversed") continue;
    const key = (s.by ?? "").trim();
    const cur = map.get(key) ?? { key: key || "unknown", label: key || "—", net: 0, transactions: 0, units: 0 };
    cur.net += num(s.gross_amount) - num(s.discount);
    cur.transactions += 1;
    cur.units += num(s.units);
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.net - a.net || a.label.localeCompare(b.label));
}

export interface CategoryTotal { key: string; label: string; gross: number; units: number; products: number }

/**
 * Product sales grouped by catalogue category. Product-level rows carry no category from the API
 * (only the product/shop data does), so the caller supplies the mapping; unknown stays "—".
 */
export function salesByCategory(items: ReportItemRow[], categoryOf: (productId: string) => string | null): CategoryTotal[] {
  const map = new Map<string, CategoryTotal>();
  for (const item of items) {
    const label = categoryOf(item.productId)?.trim() || "—";
    const key = label.toLowerCase();
    const cur = map.get(key) ?? { key, label, gross: 0, units: 0, products: 0 };
    cur.gross += num(item.gross);
    cur.units += num(item.units);
    cur.products += 1;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.gross - a.gross || a.label.localeCompare(b.label));
}

/** Discounted sales, largest discount first — the evidence behind the discounts total. */
export function discountedSales(sales: ReportSaleRow[]): ReportSaleRow[] {
  return sales
    .filter((s) => s.status !== "reversed" && num(s.discount) > 0)
    .sort((a, b) => num(b.discount) - num(a.discount));
}

/* ------------------------------------------------------------------ expenses */

export interface ExpenseTotals { total: number; paid: number; unpaid: number; count: number }
export interface ExpenseCategory { key: string; label: string; amount: number; unpaid: number; count: number }

export function expenseTotals(expenses: ReportExpenseRow[]): ExpenseTotals {
  let total = 0, paid = 0;
  for (const e of expenses) {
    const amount = num(e.amount);
    total += amount;
    if (e.paid) paid += amount;
  }
  return { total, paid, unpaid: total - paid, count: expenses.length };
}

export function expenseBreakdown(expenses: ReportExpenseRow[]): ExpenseCategory[] {
  const map = new Map<string, ExpenseCategory>();
  for (const e of expenses) {
    const label = (e.category || "other").trim();
    const key = label.toLowerCase();
    const cur = map.get(key) ?? { key, label, amount: 0, unpaid: 0, count: 0 };
    cur.amount += num(e.amount);
    if (!e.paid) cur.unpaid += num(e.amount);
    cur.count += 1;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
}

/* ------------------------------------------------------------------ pending financials */

export interface PendingFinancials {
  /** Sales, expenses and purchases queued in the period; other operation types are counted by LoadMeta. */
  salesNet: number; salesGross: number; salesDiscounts: number; salesCount: number;
  expenses: number; expenseCount: number;
  purchases: number; purchaseCount: number;
}

/**
 * The value of operations this device has not synchronized yet, using the same row formulas as the
 * confirmed views. Deliberately limited to what can be stated without the server: pending COGS and
 * profit are not invented here — they are only shown inside the local ledger summary, which costs
 * every pending and synchronized movement together.
 */
export function pendingFinancials(input: {
  sales: ReportSaleRow[]; expenses: ReportExpenseRow[]; purchases: ReportPurchaseRow[];
}): PendingFinancials {
  const s = salesTotals(input.sales);
  const e = expenseTotals(input.expenses);
  return {
    salesNet: s.net, salesGross: s.gross, salesDiscounts: s.discounts, salesCount: s.transactions,
    expenses: e.total, expenseCount: e.count,
    purchases: input.purchases.reduce((sum, p) => sum + num(p.total_amount), 0), purchaseCount: input.purchases.length,
  };
}

/* ------------------------------------------------------------------ inventory */

export function inventoryFromProducts(products: LocalProduct[], includePending = true): InventoryRow[] {
  return products.map((p) => {
    // The device's product row holds the last server quantity plus the delta of queued operations,
    // exactly like the stock screen. Local rows never carry cost, so value stays unknown.
    const onHand = num(p.on_hand) + (includePending ? num(p.pending_delta) : 0);
    return {
      id: p.id, name: p.name, code: p.code, unit: p.unit, category: p.category ?? null,
      onHand, threshold: num(p.low_threshold), low: onHand <= num(p.low_threshold),
      sellingPrice: num(p.selling_price), avgCost: null, value: null,
      local: includePending && num(p.pending_delta) !== 0,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Adds the stock delta of operations this device has queued but not synchronized to a server
 * inventory read, matched by product id. The product rows hold that delta (the sync engine keeps
 * it), so this is the same number the stock screen shows.
 */
export function applyPendingStock(items: InventoryRow[], products: LocalProduct[]): InventoryRow[] {
  const delta = new Map(products.map((p) => [p.id, num(p.pending_delta)] as const));
  return items.map((i) => {
    const d = delta.get(i.id) ?? 0;
    if (!d) return i;
    const onHand = i.onHand + d;
    return { ...i, onHand, low: onHand <= i.threshold, local: true };
  });
}

export interface InventoryMetrics {
  products: number; low: number; out: number; negative: number;
  /** Quantity per unit — only summed within a unit, because pieces and kilograms do not add up. */
  byUnit: { unit: string; qty: number }[];
  /** Null when at least one product has no cost on this device/role: a partial sum would lie. */
  value: number | null; priced: number; unpriced: number;
}

export function inventoryMetrics(items: InventoryRow[]): InventoryMetrics {
  const units = new Map<string, number>();
  let value = 0, priced = 0;
  for (const i of items) {
    units.set(i.unit || "unit", (units.get(i.unit || "unit") ?? 0) + num(i.onHand));
    if (i.value === null || i.value === undefined) continue;
    value += num(i.value);
    priced += 1;
  }
  return {
    products: items.length,
    low: items.filter((i) => i.low && i.onHand > 0).length,
    out: items.filter((i) => i.onHand <= 0).length,
    negative: items.filter((i) => i.onHand < 0).length,
    byUnit: [...units].map(([unit, qty]) => ({ unit, qty })).sort((a, b) => a.unit.localeCompare(b.unit)),
    value: priced === items.length ? value : null,
    priced,
    unpriced: items.length - priced,
  };
}

/** Negative stock and stock with no cost basis: the two things a shop can actually act on. */
export function inventoryIssues(items: InventoryRow[]): InventoryRow[] {
  return items.filter((i) => i.onHand < 0 || i.value === null).sort((a, b) => a.onHand - b.onHand);
}

/* ------------------------------------------------------------------ stock movements */

export function movementGroup(type: MovementType): MovementGroup {
  if (type === "opening" || type === "receipt" || type === "transfer_in") return "in";
  if (type === "sale" || type === "sale_return") return "sold";
  if (type === "damage" || type === "expiry") return "loss";
  if (type === "adjustment" || type === "count_correction") return "adjust";
  return "other";
}

export interface MovementMetrics {
  count: number; inQty: number; soldQty: number; lossQty: number; adjustQty: number;
  lossValue: number | null; missingCost: number;
}

export function movementMetrics(rows: MovementRow[]): MovementMetrics {
  let inQty = 0, soldQty = 0, lossQty = 0, adjustQty = 0, value = 0, missingCost = 0;
  for (const r of rows) {
    const group = movementGroup(r.type);
    const qty = num(r.qty);
    if (group === "in") inQty += qty;
    else if (group === "sold") soldQty += qty < 0 ? -qty : qty;
    else if (group === "loss") {
      lossQty += Math.max(0, -qty);
      if (r.unitCost === null) missingCost += 1;
      else value += Math.abs(qty) * r.unitCost / 1000;
    } else if (group === "adjust") adjustQty += qty;
  }
  return {
    count: rows.length, inQty, soldQty,
    // Loss quantities are always known; the cost is only claimed when every loss row has one.
    lossQty, adjustQty,
    lossValue: missingCost ? null : Math.round(value),
    missingCost,
  };
}

/**
 * Movements derived from this device's records, for the offline stock-movement report. Running
 * balances are deliberately absent: the device does not hold the whole ledger, so a balance derived
 * here could be wrong. One row per operation line, keyed so a pending and a synced copy are the same row.
 */
export function movementsFromRecords(input: {
  records: LocalRecord[]; products: LocalProduct[]; from: string; to: string;
}): MovementRow[] {
  const { from, to } = input;
  const recs = parseRecords(input.records);
  const products = new Map(input.products.map((p) => [p.id, p] as const));
  // parseRecords drops the operation id, so remember the sync verdict by the business id inside
  // each payload. Every row here is a device record; the verdict tells the table what is pending.
  const verdict = new Map<string, RowSyncStatus>();
  for (const r of input.records) {
    let p: any;
    try { p = JSON.parse(r.data); } catch { continue; }
    const id = p?.saleId ?? p?.purchaseId ?? p?.receiptId ?? p?.adjustmentId;
    if (id) verdict.set(String(id), r.status as RowSyncStatus);
  }
  const productsById = (id: string) => products.get(id);
  const row = (id: string, at: string, productId: string, type: MovementType, qty: number, unitCost: number | null, extra: Partial<MovementRow> = {}): MovementRow => {
    const p = productsById(productId);
    return {
      id, at, product: p?.name ?? productId, code: p?.code ?? "—", unit: p?.unit ?? "unit",
      type, qty, unitCost, reason: null, reference: null, by: null,
      balanceBefore: null, balanceAfter: null, local: true, ...extra,
    };
  };
  const out: MovementRow[] = [];
  for (const o of recs.openings) {
    out.push(row(`m:open:${o.productId}:${o.at}`, o.at, o.productId, "opening", o.qty, o.unitCost ?? null));
  }
  for (const p of recs.purchases) {
    if (!p.receiveNow) continue;
    p.lines.forEach((l, i) => out.push(row(`m:rcv:${p.id}:${l.productId}:${i}`, p.receivedAt, l.productId, "receipt", l.qty, l.unitCost ?? null, { reference: shortId(p.id), syncStatus: verdict.get(p.id) })));
  }
  for (const s of recs.sales) {
    s.lines.forEach((l, i) => out.push(row(`m:sale:${s.id}:${l.productId}:${i}`, s.at, l.productId, "sale", -l.qty, null, { reference: shortId(s.id), syncStatus: verdict.get(s.id) })));
  }
  for (const a of recs.adjustments) {
    const type: MovementType = a.reason === "damage" ? "damage" : a.reason === "expiry" ? "expiry" : a.reason === "sale_return" ? "sale_return" : a.reason === "supplier_return" ? "supplier_return" : "adjustment";
    out.push(row(`m:adj:${a.id}:${a.productId}`, a.at, a.productId, type, a.qty, null, {
      reason: a.reason, reference: shortId(a.id), syncStatus: verdict.get(a.id),
    }));
  }
  return out
    .filter((r) => r.at >= from && r.at < to)
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}

export const shortId = (id: string) => `RC-${String(id).replace(/-/g, "").slice(0, 8).toUpperCase()}`;

/* ------------------------------------------------------------------ series */

export interface ValuePoint { date: string; value: number }

export function seriesOf<T>(rows: T[], from: string, to: string, mode: BucketMode, dateOf: (r: T) => string, valueOf: (r: T) => number): ValuePoint[] {
  const keys = bucketKeys(from, to, mode);
  const at = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const r of rows) {
    const key = bucketKey(dateOf(r), mode);
    if (at.has(key)) at.set(key, (at.get(key) ?? 0) + valueOf(r));
  }
  return keys.map((date) => ({ date, value: at.get(date) ?? 0 }));
}

export interface SalesPoint { date: string; netSales: number; transactions: number }

/** Net sales and transaction counts per bucket. Reversed sales are excluded, matching revenue. */
export function salesSeries(sales: ReportSaleRow[], from: string, to: string, mode: BucketMode): SalesPoint[] {
  const keys = bucketKeys(from, to, mode);
  const acc = new Map<string, { netSales: number; transactions: number }>(keys.map((k) => [k, { netSales: 0, transactions: 0 }]));
  for (const s of sales) {
    if (s.status === "reversed") continue;
    const key = bucketKey(s.at, mode);
    const cur = acc.get(key);
    if (!cur) continue;
    cur.netSales += num(s.gross_amount) - num(s.discount);
    cur.transactions += 1;
  }
  return keys.map((date) => ({ date, ...(acc.get(date) ?? { netSales: 0, transactions: 0 }) }));
}

export interface MovementPoint { date: string; received: number; sold: number }

/** Received vs sold quantity per bucket, from the same movement rows shown in the table. */
export function movementSeries(rows: MovementRow[], from: string, to: string, mode: BucketMode): MovementPoint[] {
  const keys = bucketKeys(from, to, mode);
  const acc = new Map<string, { received: number; sold: number }>(keys.map((k) => [k, { received: 0, sold: 0 }]));
  for (const r of rows) {
    const cur = acc.get(bucketKey(r.at, mode));
    if (!cur) continue;
    const group = movementGroup(r.type);
    if (group === "in") cur.received += Math.max(0, num(r.qty));
    else if (group === "sold") cur.sold += Math.abs(num(r.qty));
  }
  return keys.map((date) => ({ date, ...(acc.get(date) ?? { received: 0, sold: 0 }) }));
}

/* ------------------------------------------------------------------ reconciliation */

/**
 * Adds this device's unsynchronized product totals to a server answer. Unlike ledger rows these are
 * aggregates, so they are SUMMED per product (matched by product id) instead of merged by row id —
 * a pending sale for a product already sold on the server must add to that product, not disappear.
 */
export function mergePendingItems(server: ReportItemRow[], pending: ReportItemRow[]): ReportItemRow[] {
  if (!pending.length) return server;
  const map = new Map(server.map((r) => [r.productId, { ...r }] as const));
  for (const p of pending) {
    const cur = map.get(p.productId);
    if (!cur) {
      map.set(p.productId, { ...p, local: true });
      continue;
    }
    const units = cur.units + p.units;
    const gross = cur.gross + p.gross;
    map.set(p.productId, {
      ...cur, units, gross, sales: cur.sales + p.sales, local: true,
      // Same formula the API and the local engine use: integer RWF per selling unit.
      avgUnitPrice: units > 0 ? Math.round(gross / (units / 1000)) : 0,
    });
  }
  return [...map.values()].sort((a, b) => b.gross - a.gross || a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ comparison */

export interface Delta { change: number; pct: number | null }

/** Absolute and relative change; a percentage is never invented when the prior value is zero. */
export function deltaOf(current: number, previous: number): Delta {
  const change = current - previous;
  return { change, pct: previous === 0 ? null : Math.round((change * 10_000) / Math.abs(previous)) / 100 };
}

/** Sales value of a line, exposed so exports and reports share one formula. */
export const saleLineValue = (qty: number, unitPrice: number) => lineAmount(qty, unitPrice);
