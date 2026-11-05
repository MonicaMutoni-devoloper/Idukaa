import {
  KIGALI_UTC_OFFSET_MS, TARGET_GROSS_MARGIN_BPS, allocateLineDiscounts, kigaliDay, lineAmount,
  periodCosts, presetRange, priceBelowCost, replayLedger, summarize,
  type Movement, type PeriodSummary,
} from "@sms/shared";
// Type-only: the calculation must stay free of the storage adapter so it can be unit-tested in Node
// (and so the same function runs on SQLite and IndexedDB without knowing which one is present).
import type { LocalProduct, LocalRecord } from "../database";

/**
 * Local dashboard — every figure calculated from records saved on THIS device.
 *
 * Why it exists: the dashboard used to be a server response (or the last copy of one). The local
 * store held products, suppliers and the outbox, but no transactions, so with the API unreachable
 * the only possible answer was "showing the last saved figures". Now every operation persists a
 * reportable record, and this module turns those records into the same dashboard payload using the
 * SAME shared calculation rules as the API (`summarize`, `replayLedger`/`periodCosts`,
 * `presetRange`, `allocateLineDiscounts`), so an offline figure and an online figure agree.
 *
 * Correctness rules enforced here:
 *  - One record per operation id. A pending operation and its later synchronized self are the SAME
 *    row, so moving from pending to synced can never count a sale twice.
 *  - Business days are Africa/Kigali days and every range is half-open [from, to), exactly like the
 *    API, so a sale at 00:30 Kigali never lands in the previous day.
 *  - Stock comes from the same product rows the server fills (`onHand`) plus the pending delta of
 *    queued operations — never from a re-derived history that could disagree.
 *  - When the local ledger cannot explain a sale (stock that arrived before this device had any
 *    history), cost-dependent figures are marked provisional instead of being reported as if exact.
 */

/* ------------------------------------------------------------------ payload types (server-compatible) */

export interface Snapshot {
  range: { from: string; to: string };
  netSales: number; cogs: number; grossProfit: number; grossMarginBps: number | null;
  operatingExpenses: number; operatingProfit: number; stockLosses: number;
  operatingResultAfterStockLosses: number; transactions: number; costBasisIncomplete: boolean;
}
export interface MonthlyRow {
  month: string; year: number; monthNumber: number;
  netSales: number; cogs: number; operatingExpenses: number; stockLosses: number; operatingResult: number;
}
export interface ProfitRow {
  productId: string; name: string; units: number; revenue: number;
  grossProfit?: number; grossMarginBps: number | null;
  sellingPrice?: number; avgCost?: number; belowCost?: boolean;
}
export interface Financials {
  grossSales: number; discounts: number; salesReturns: number; netSales: number; cogs: number;
  grossProfit: number; grossMarginBps: number | null; operatingExpenses: number; operatingProfit: number;
  inventoryPurchases: number; stockLossValue: number; outstandingExpenses: number; expensesPaid: number;
  stockLosses?: number; operatingResultAfterStockLosses?: number; costBasisIncomplete?: boolean;
  snapshots?: { today: Snapshot; month: Snapshot; year: Snapshot } | null;
  monthly?: MonthlyRow[] | null;
  topProductsByProfit?: ProfitRow[];
  lowMarginProducts?: ProfitRow[];
}
export interface Operations {
  netSales: number; transactions: number; unitsSold: number; averageTransaction: number;
  cashCollected: number; receivables: number; grossSales: number; discounts: number;
  deliveries: number; productsReceived: number; unitsReceived: number;
  pendingReceipts: number; inventoryValue: number | null; lowStockCount: number; outOfStockCount: number;
  productCount: number; supplierPayables: number; pendingApprovals: number; openInvestigations: number; openConflicts: number;
}
export interface Change { change: number; pct: number | null }
export interface ActivityRow {
  id: number; at: string; action: string; entity: string; reason: string | null; actor: string | null;
  productName: string | null; saleTotal: number | null; purchaseTotal: number | null; purchaseReference: string | null;
}
export interface Dashboard {
  role: "owner" | "manager";
  permissions: { financials: boolean };
  /** Server-only: panels it could not compute. Absent locally (nothing is ever degraded on-device). */
  degraded?: string[];
  range: { from: string; to: string };
  financials: Financials | null;
  financialComparison: { netSales: Change; grossProfit: Change; operatingProfit: Change } | null;
  operations: Operations;
  salesComparison: { netSales: Change };
  trend: { date: string; netSales: number; transactions: number; grossProfit: number | null; operatingExpenses: number | null }[];
  topProducts: { id: string; name: string; qty: number; netSales: number }[];
  worstProducts: { id: string; name: string; qty: number; netSales: number }[];
  activity: ActivityRow[];
  staffActivity: { actor: string; actions: number }[];
  expensesByCategory: { category: string; amount: number; unpaid: number }[];
  lowStock: { id: string; name: string; onHand: number; unit: string; threshold: number }[];
}

/** Where the figures the user is looking at came from. */
export type FigureSource = "server" | "local" | "cached";
/** The five states the dashboard must distinguish (never claim synced for locally saved work). */
export type FigureStatus = "synchronized" | "calculated_local" | "pending_sync" | "sync_failed" | "conflict";

export interface LocalDashboardResult {
  data: Dashboard;
  source: "local";
  status: Exclude<FigureStatus, "synchronized">;
  calculatedAt: string;
  /** Earliest instant this device holds a record for; null when it holds none. */
  coverageFrom: string | null;
  /** False when the requested range starts before `coverageFrom`: older history needs the server. */
  covered: boolean;
  counts: { pending: number; failed: number; conflicts: number; awaitingApproval: number; total: number; inRange: number };
}

/* ------------------------------------------------------------------ record shapes */

interface SaleLine { productId: string; qty: number; unitPrice: number; sellingQty?: number }
interface Sale { id: string; at: string; discount: number; paid: number; lines: SaleLine[]; status: string }
interface Expense { id: string; at: string; category: string; amount: number; paid: boolean }
interface PurchaseLine { productId: string; qty: number; unitCost: number }
interface Purchase { id: string; at: string; receivedAt: string; receiveNow: boolean; paid: number; lines: PurchaseLine[] }
interface Adjustment { id: string; at: string; productId: string; qty: number; reason: string; status: string }
interface RecordSet {
  sales: Sale[]; expenses: Expense[]; purchases: Purchase[]; adjustments: Adjustment[];
  openings: { productId: string; at: string; qty: number; unitCost: number }[];
}

const num = (v: unknown, fallback = 0) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const inRange = (iso: string, from: string, to: string) => iso >= from && iso < to;
const clampDate = (v: unknown, fallback: string) => {
  const s = typeof v === "string" ? v : "";
  return Number.isNaN(Date.parse(s)) ? fallback : new Date(s).toISOString();
};

/** Turns stored records into domain rows. Unknown types are ignored; malformed payloads are skipped. */
function parseRecords(records: LocalRecord[]): RecordSet {
  const out: RecordSet = { sales: [], expenses: [], purchases: [], adjustments: [], openings: [] };
  const expenses = new Map<string, Expense>();
  for (const r of records) {
    let p: any;
    try { p = JSON.parse(r.data); } catch { continue; }
    if (!p || typeof p !== "object") continue;
    const at = clampDate(p.soldAt ?? p.incurredAt ?? p.orderedAt ?? p.receivedAt ?? p.countedAt ?? r.at, r.at);
    switch (r.type) {
      case "sale.create":
        out.sales.push({
          id: String(p.saleId ?? r.op_id), at,
          discount: Math.max(0, num(p.discount)), paid: Math.max(0, num(p.amountPaid)),
          lines: Array.isArray(p.lines) ? p.lines.map((l: any) => ({
            productId: String(l.productId), qty: num(l.qty), unitPrice: num(l.unitPrice),
            sellingQty: l.sellingQty === undefined ? undefined : num(l.sellingQty),
          })).filter((l: SaleLine) => l.productId && l.qty > 0) : [],
          status: r.status,
        });
        break;
      case "expense.create": {
        const e: Expense = {
          id: String(p.expenseId ?? r.op_id), at, category: String(p.category ?? "other"),
          amount: Math.max(0, num(p.amount)), paid: !!p.paid,
        };
        expenses.set(e.id, e);
        break;
      }
      case "expense.update": {
        const id = String(p.expenseId ?? "");
        const cur = expenses.get(id);
        if (cur) {
          if (p.category !== undefined) cur.category = String(p.category);
          if (p.amount !== undefined) cur.amount = Math.max(0, num(p.amount));
          if (p.paid !== undefined) cur.paid = !!p.paid;
          if (p.incurredAt !== undefined) cur.at = clampDate(p.incurredAt, cur.at);
        }
        break;
      }
      case "purchase.create": {
        const lines = Array.isArray(p.lines) ? p.lines.map((l: any) => ({
          productId: String(l.productId), qty: num(l.qty), unitCost: num(l.unitCost),
        })).filter((l: PurchaseLine) => l.productId && l.qty > 0) : [];
        out.purchases.push({
          id: String(p.purchaseId ?? r.op_id), at, receivedAt: at,
          receiveNow: !!p.receiveNow, paid: Math.max(0, num(p.amountPaid)), lines,
        });
        break;
      }
      case "receipt.create": {
        // A later delivery against a purchase recorded earlier: the cost basis is the purchase line's.
        const parent = out.purchases.find((x) => x.id === String(p.purchaseId));
        const lines = Array.isArray(p.lines) ? p.lines.map((l: any) => {
          const known = parent?.lines.find((pl) => pl.productId === String(l.productId));
          return { productId: String(l.productId), qty: num(l.qty), unitCost: num(l.unitCost ?? known?.unitCost) };
        }).filter((l: PurchaseLine) => l.productId && l.qty > 0) : [];
        out.purchases.push({
          id: String(p.receiptId ?? r.op_id), at: clampDate(p.receivedAt, r.at), receivedAt: clampDate(p.receivedAt, r.at),
          receiveNow: true, paid: 0, lines,
        });
        break;
      }
      case "adjustment.request":
        out.adjustments.push({
          id: String(p.adjustmentId ?? r.op_id), at, productId: String(p.productId ?? ""),
          qty: num(p.qty), reason: String(p.reason ?? "other"), status: r.status,
        });
        break;
      case "product.upsert": {
        const qty = num(p.initialQty);
        if (p.productId && qty > 0) out.openings.push({ productId: String(p.productId), at: r.created_at, qty, unitCost: num(p.initialUnitCost) });
        break;
      }
    }
  }
  out.expenses = [...expenses.values()].sort((a, b) => a.at.localeCompare(b.at));
  out.sales.sort((a, b) => a.at.localeCompare(b.at));
  out.purchases.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

/** Sales, receipts and openings only: the movements the moving-average replay needs. */
function buildLedger(recs: RecordSet): Map<string, Movement[]> {
  const m = new Map<string, Movement[]>();
  const add = (productId: string, mv: Movement) => {
    const list = m.get(productId) ?? [];
    list.push(mv);
    m.set(productId, list);
  };
  for (const o of recs.openings) add(o.productId, { type: "opening", qty: o.qty, unitCost: o.unitCost, occurredAt: o.at });
  for (const p of recs.purchases) {
    if (!p.receiveNow) continue;
    for (const l of p.lines) add(l.productId, { type: "receipt", qty: l.qty, unitCost: l.unitCost, occurredAt: p.receivedAt });
  }
  for (const s of recs.sales) for (const l of s.lines) add(l.productId, { type: "sale", qty: -l.qty, occurredAt: s.at });
  for (const list of m.values()) list.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  return m;
}

/**
 * True when this device's ledger explains every outbound quantity: no sale left stock the history
 * never received. False means part of the cost basis happened before the records began.
 */
function ledgerIsComplete(list: Movement[]): boolean {
  let onHand = 0;
  for (const mv of list) {
    if (mv.qty > 0) { onHand += mv.qty; continue; }
    if (-mv.qty > onHand) return false;
    onHand += mv.qty;
  }
  return true;
}

const saleGross = (s: Sale) => s.lines.reduce((sum, l) => sum + lineAmount(l.sellingQty ?? l.qty, l.unitPrice), 0);
const purchaseTotal = (p: Purchase) => p.lines.reduce((sum, l) => sum + lineAmount(l.qty, l.unitCost), 0);

interface Figures extends PeriodSummary {
  transactions: number; unitsSold: number; cashCollected: number; receivables: number;
  purchasesReceived: { deliveries: number; products: number; units: number; value: number };
  costComplete: boolean;
}

export interface LocalDashboardInput {
  records: LocalRecord[];
  products: LocalProduct[];
  from: string;
  to: string;
  role: "owner" | "manager" | "system_admin";
  /** Whether cost, profit and margin may be shown (owner, or a manager the owner granted it to). */
  financials: boolean;
  now?: number;
}

/** Pure calculation: no storage, no network — the whole report is a function of records + products. */
export function computeLocalDashboard(input: LocalDashboardInput): LocalDashboardResult {
  const { from, to, role, financials } = input;
  const recs = parseRecords(input.records);
  const ledger = buildLedger(recs);
  const costComplete = [...ledger.values()].every(ledgerIsComplete);

  const cogsIn = (a: string, b: string) => [...ledger.values()].reduce((s, l) => s + periodCosts(l, a, b).cogs, 0);
  const lossIn = (a: string, b: string) => [...ledger.values()].reduce((s, l) => s + periodCosts(l, a, b).lossValue, 0);

  const figures = (a: string, b: string): Figures => {
    const sales = recs.sales.filter((s) => inRange(s.at, a, b));
    const expenses = recs.expenses.filter((e) => inRange(e.at, a, b));
    const purchases = recs.purchases.filter((p) => inRange(p.at, a, b));
    const receipts = purchases.filter((p) => p.receiveNow);
    const grossSales = sales.reduce((s, x) => s + saleGross(x), 0);
    const discounts = sales.reduce((s, x) => s + Math.min(x.discount, saleGross(x)), 0);
    const paid = sales.reduce((s, x) => s + Math.min(x.paid, Math.max(0, saleGross(x) - x.discount)), 0);
    const receivable = sales.reduce((s, x) => s + Math.max(0, saleGross(x) - Math.min(x.discount, saleGross(x)) - x.paid), 0);
    const operatingExpenses = expenses.reduce((s, e) => s + e.amount, 0);
    const expensesPaid = expenses.filter((e) => e.paid).reduce((s, e) => s + e.amount, 0);
    const products = new Set(receipts.flatMap((p) => p.lines.map((l) => l.productId)));
    const value = receipts.reduce((s, p) => s + p.lines.reduce((t, l) => t + lineAmount(l.qty, l.unitCost), 0), 0);
    const base = summarize({
      grossSales, discounts, salesReturns: 0,
      cogs: financials ? cogsIn(a, b) : 0,
      operatingExpenses, expensesPaid, cashCollected: paid,
      inventoryPurchases: purchases.reduce((s, p) => s + purchaseTotal(p), 0),
      receivables: receivable, stockLosses: financials ? lossIn(a, b) : 0,
    });
    return {
      ...base,
      transactions: sales.length,
      unitsSold: sales.reduce((s, x) => s + x.lines.reduce((t, l) => t + l.qty, 0), 0),
      cashCollected: paid, receivables: receivable,
      purchasesReceived: {
        deliveries: receipts.length, products: products.size,
        units: receipts.reduce((s, p) => s + p.lines.reduce((t, l) => t + l.qty, 0), 0), value,
      },
      costComplete,
    };
  };

  const cur = figures(from, to);
  const span = Date.parse(to) - Date.parse(from);
  const prevFrom = new Date(Date.parse(from) - span).toISOString();
  const prev = figures(prevFrom, from);
  const change = (a: number, b: number): Change => ({ change: a - b, pct: b !== 0 ? Math.round(((a - b) * 10000) / Math.abs(b)) / 100 : null });

  const snap = (preset: "today" | "month" | "year"): Snapshot => {
    const r = presetRange(preset, input.now);
    const f = figures(r.from, r.to);
    return {
      range: r, netSales: f.netSales, cogs: f.cogs, grossProfit: f.grossProfit,
      grossMarginBps: f.grossMarginBps, operatingExpenses: f.operatingExpenses,
      operatingProfit: f.operatingProfit, stockLosses: f.stockLosses,
      operatingResultAfterStockLosses: f.operatingResultAfterStockLosses,
      transactions: f.transactions, costBasisIncomplete: f.costComplete === false,
    };
  };

  /* ---- chart buckets on the Kigali calendar (day / week / month), same rule as the API ---- */
  const spanDays = span / 86_400_000;
  const bucket: "day" | "week" | "month" = spanDays > 400 ? "month" : spanDays > 62 ? "week" : "day";
  const bucketKey = (iso: string) => {
    const day = kigaliDay(iso);
    if (bucket === "month") return `${day.slice(0, 7)}-01`;
    if (bucket === "day") return day;
    const [y, m, d] = day.split("-").map(Number);
    const at = Date.UTC(y!, m! - 1, d!);
    const dow = new Date(at).getUTCDay();
    return new Date(at - ((dow + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
  };

  const netByBucket = new Map<string, number>();
  const txByBucket = new Map<string, number>();
  for (const s of recs.sales) {
    if (!inRange(s.at, from, to)) continue;
    const k = bucketKey(s.at);
    netByBucket.set(k, (netByBucket.get(k) ?? 0) + saleGross(s) - Math.min(s.discount, saleGross(s)));
    txByBucket.set(k, (txByBucket.get(k) ?? 0) + 1);
  }
  const expByBucket = new Map<string, number>();
  for (const e of recs.expenses) {
    if (!inRange(e.at, from, to)) continue;
    const k = bucketKey(e.at);
    expByBucket.set(k, (expByBucket.get(k) ?? 0) + e.amount);
  }
  const cogsByBucket = new Map<string, number>();
  const costByMonth = new Map<string, number>();
  const year = Number(kigaliDay(from).slice(0, 4));
  const monthKey = (iso: string) => `${kigaliDay(iso).slice(0, 7)}-01`;
  if (financials) {
    for (const list of ledger.values()) {
      const r = replayLedger(list);
      list.forEach((m, i) => {
        if (m.type !== "sale" && m.type !== "sale_return") return;
        const cost = (r.perMovementCost[i] ?? 0) * (m.type === "sale" ? 1 : -1);
        const mk = monthKey(m.occurredAt);
        if (Number(mk.slice(0, 4)) === year) costByMonth.set(mk, (costByMonth.get(mk) ?? 0) + cost);
        if (inRange(m.occurredAt, from, to)) {
          const k = bucketKey(m.occurredAt);
          cogsByBucket.set(k, (cogsByBucket.get(k) ?? 0) + cost);
        }
      });
    }
  }

  const keys = [...new Set([
    ...recs.sales.filter((s) => inRange(s.at, from, to)).map((s) => bucketKey(s.at)),
    ...recs.expenses.filter((e) => inRange(e.at, from, to)).map((e) => bucketKey(e.at)),
  ])].sort();

  /* ---- revenue and cost per product (net of each product's exact discount share) ---- */
  const productNet = new Map<string, { units: number; revenue: number }>();
  for (const s of recs.sales) {
    if (!inRange(s.at, from, to)) continue;
    const amounts = s.lines.map((l) => lineAmount(l.sellingQty ?? l.qty, l.unitPrice));
    const shares = allocateLineDiscounts(amounts, Math.min(s.discount, amounts.reduce((a, b) => a + b, 0)));
    s.lines.forEach((l, i) => {
      const cur2 = productNet.get(l.productId) ?? { units: 0, revenue: 0 };
      cur2.units += l.qty;
      cur2.revenue += (amounts[i] ?? 0) - (shares[i] ?? 0);
      productNet.set(l.productId, cur2);
    });
  }
  const byId = new Map(input.products.map((p) => [p.id, p] as const));
  const productRows: ProfitRow[] = input.products.map((p) => {
    const list = ledger.get(p.id) ?? [];
    const rev = productNet.get(p.id) ?? { units: 0, revenue: 0 };
    const cogs = periodCosts(list, from, to).cogs;
    const grossProfit = rev.revenue - cogs;
    const avgCost = replayLedger(list).avgCost;
    return {
      productId: p.id, name: p.name, units: rev.units, revenue: rev.revenue,
      grossProfit, grossMarginBps: rev.revenue > 0 ? Math.round((grossProfit * 10_000) / rev.revenue) : null,
      sellingPrice: p.selling_price, avgCost,
      belowCost: avgCost > 0 && priceBelowCost(p.selling_price, p.units_per_selling ?? 1, avgCost),
    };
  });

  const ordered = [...productNet.entries()]
    .map(([id, v]) => ({ id, name: byId.get(id)?.name ?? id, qty: v.units, netSales: v.revenue }))
    .sort((a, b) => b.netSales - a.netSales);
  const topProducts = ordered.slice(0, 5);
  const topIds = new Set(topProducts.map((p) => p.id));
  const worstProducts = [...ordered].reverse().filter((p) => !topIds.has(p.id)).slice(0, 5);

  /* ---- operational stock comes from the product rows the server fills + pending deltas ---- */
  const onHandOf = (p: LocalProduct) => num(p.on_hand) + num(p.pending_delta);
  const low = input.products.filter((p) => onHandOf(p) <= num(p.low_threshold));
  const outOfStock = input.products.filter((p) => onHandOf(p) <= 0);
  const inventoryValue = financials && costComplete
    ? input.products.reduce((s, p) => s + replayLedger(ledger.get(p.id) ?? []).value, 0)
    : null;

  /* ---- statuses from the outbox verdict of each record (never inferred) ---- */
  const counted = (s: string) => input.records.filter((r) => r.status === s).length;
  const pending = counted("pending") + counted("retry");
  const failed = counted("rejected");
  const conflicts = counted("conflict");
  const awaitingApproval = counted("pending_approval");
  const status: LocalDashboardResult["status"] =
    conflicts > 0 ? "conflict" : failed > 0 ? "sync_failed" : pending > 0 || awaitingApproval > 0 ? "pending_sync" : "calculated_local";

  const coverageTimes = [
    ...recs.sales.map((s) => s.at), ...recs.expenses.map((e) => e.at),
    ...recs.purchases.map((p) => p.at), ...recs.openings.map((o) => o.at),
    ...input.records.map((r) => r.at),
  ].filter((t) => !Number.isNaN(Date.parse(t))).sort();
  const coverageFrom = coverageTimes[0] ?? null;

  const monthly: MonthlyRow[] | null = financials ? Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, "0")}-01`;
    const f = figures(
      new Date(Date.UTC(year, i, 1) - KIGALI_UTC_OFFSET_MS).toISOString(),
      new Date(Date.UTC(year, i + 1, 1) - KIGALI_UTC_OFFSET_MS).toISOString(),
    );
    const netSales = f.netSales;
    const cogs = costByMonth.get(key) ?? 0;
    return {
      month: key, year, monthNumber: i + 1, netSales, cogs,
      operatingExpenses: f.operatingExpenses, stockLosses: f.stockLosses,
      operatingResult: netSales - cogs - f.operatingExpenses - f.stockLosses,
    };
  }) : null;

  const activity: ActivityRow[] = [...input.records]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 10)
    .map((r, i) => {
      let p: any = {};
      try { p = JSON.parse(r.data); } catch { /* keep the row visible without details */ }
      const names = Array.isArray(p.lines)
        ? p.lines.map((l: any) => byId.get(String(l.productId))?.name).filter(Boolean).join(", ")
        : null;
      const saleRec = recs.sales.find((s) => s.id === String(p.saleId));
      const purRec = recs.purchases.find((x) => x.id === String(p.purchaseId));
      return {
        id: i, at: r.at, action: `op.${r.type}`, entity: "operation", reason: null, actor: null,
        productName: names || byId.get(String(p.productId ?? ""))?.name || null,
        saleTotal: saleRec ? saleGross(saleRec) - Math.min(saleRec.discount, saleGross(saleRec)) : null,
        purchaseTotal: purRec ? purchaseTotal(purRec) : null,
        purchaseReference: p.reference ?? null,
      };
    });

  const expensesByCategory = [...recs.expenses
    .filter((e) => inRange(e.at, from, to))
    .reduce((m, e) => {
      const cur2 = m.get(e.category) ?? { amount: 0, unpaid: 0 };
      cur2.amount += e.amount;
      if (!e.paid) cur2.unpaid += e.amount;
      m.set(e.category, cur2);
      return m;
    }, new Map<string, { amount: number; unpaid: number }>())]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);

  const financialsBlock: Financials | null = financials ? {
    grossSales: cur.grossSales, discounts: cur.discounts, salesReturns: cur.salesReturns,
    netSales: cur.netSales, cogs: cur.cogs, grossProfit: cur.grossProfit, grossMarginBps: cur.grossMarginBps,
    operatingExpenses: cur.operatingExpenses, operatingProfit: cur.operatingProfit,
    inventoryPurchases: cur.inventoryPurchases, stockLosses: cur.stockLosses, stockLossValue: cur.stockLosses,
    operatingResultAfterStockLosses: cur.operatingResultAfterStockLosses,
    outstandingExpenses: cur.outstandingExpenses, expensesPaid: cur.expensesPaid,
    costBasisIncomplete: !costComplete,
    snapshots: { today: snap("today"), month: snap("month"), year: snap("year") },
    monthly,
    topProductsByProfit: productRows.filter((p) => p.units > 0)
      .sort((a, b) => (b.grossProfit ?? 0) - (a.grossProfit ?? 0)).slice(0, 5),
    lowMarginProducts: productRows.filter((p) => p.grossMarginBps !== null && p.grossMarginBps < TARGET_GROSS_MARGIN_BPS)
      .sort((a, b) => (a.grossMarginBps ?? 0) - (b.grossMarginBps ?? 0)).slice(0, 5),
  } : null;

  const data: Dashboard = {
    role: role === "owner" ? "owner" : "manager",
    permissions: { financials },
    // Computed here, from complete local records: no panel is missing, so nothing is degraded.
    degraded: [],
    range: { from, to },
    financials: financialsBlock,
    financialComparison: financials
      ? { netSales: change(cur.netSales, prev.netSales), grossProfit: change(cur.grossProfit, prev.grossProfit), operatingProfit: change(cur.operatingProfit, prev.operatingProfit) }
      : null,
    operations: {
      netSales: cur.netSales, transactions: cur.transactions, unitsSold: cur.unitsSold,
      averageTransaction: cur.transactions ? Math.round(cur.netSales / cur.transactions) : 0,
      cashCollected: cur.cashCollected, receivables: cur.receivables,
      grossSales: cur.grossSales, discounts: cur.discounts,
      deliveries: cur.purchasesReceived.deliveries, productsReceived: cur.purchasesReceived.products,
      unitsReceived: cur.purchasesReceived.units, purchasesReceivedValue: cur.purchasesReceived.value,
      pendingReceipts: recs.purchases.filter((p) => !p.receiveNow).length,
      inventoryValue, lowStockCount: low.length, outOfStockCount: outOfStock.length,
      productCount: input.products.length,
      supplierPayables: recs.purchases.reduce((s, p) => s + Math.max(0, purchaseTotal(p) - p.paid), 0),
      pendingApprovals: recs.adjustments.filter((a) => a.status !== "rejected").length,
      openInvestigations: 0, openConflicts: conflicts + failed,
    } as Operations,
    salesComparison: { netSales: change(cur.netSales, prev.netSales) },
    trend: keys.map((date) => ({
      date,
      netSales: netByBucket.get(date) ?? 0,
      transactions: txByBucket.get(date) ?? 0,
      grossProfit: financials ? (netByBucket.get(date) ?? 0) - (cogsByBucket.get(date) ?? 0) : null,
      operatingExpenses: financials ? (expByBucket.get(date) ?? 0) : null,
    })),
    topProducts,
    worstProducts,
    activity,
    // Staff attribution is only known to the server (the local record stores the operation, not the
    // audit actor), so this panel stays empty offline rather than guessing.
    staffActivity: [],
    expensesByCategory,
    lowStock: low.sort((a, b) => onHandOf(a) - onHandOf(b)).slice(0, 6)
      .map((p) => ({ id: p.id, name: p.name, onHand: onHandOf(p), unit: p.unit, threshold: p.low_threshold })),
  };

  return {
    data, source: "local", status,
    calculatedAt: new Date().toISOString(),
    coverageFrom,
    covered: coverageFrom ? from >= coverageFrom : false,
    counts: {
      pending, failed, conflicts, awaitingApproval, total: input.records.length,
      // Records whose own timestamp falls inside the requested range. Used by the screen to decide
      // whether local figures actually describe this period (and may replace what is on screen).
      inRange: input.records.filter((r) => r.at >= from && r.at < to).length,
    },
  };
}

