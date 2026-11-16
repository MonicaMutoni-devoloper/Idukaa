import { kigaliDay, lineAmount, replayLedger } from "@sms/shared";
import type { LocalRecord } from "../database";
// Explicit .ts so Node's test runner resolves these exactly as the tests do; tsconfig allows it.
import { buildLedger, ledgerIsComplete, parseRecords, type Dashboard } from "./local-dashboard.ts";
import { isUnsynced } from "./local-reports.ts";

/**
 * The work this device has queued but not synchronized, as figures that can be laid ON TOP of a
 * server (or saved) dashboard.
 *
 * Why: the Overview is a snapshot of the SHOP, so it must not be replaced by this phone's rows —
 * that is what used to hide every sale made on another phone. But a snapshot alone freezes the
 * opposite way: a sale rung up with no network is neither on the server nor in the saved copy, so
 * the owner saw today's takings stay still until the phone found a network. The two complaints have
 * one answer: keep the snapshot as the basis and fold the QUEUED operations onto it.
 *
 * Rules enforced here:
 *  - Only operations still in the outbox are added (`isUnsynced`). One that synchronized is already
 *    inside the snapshot, so adding it again would count the same sale twice.
 *  - A rejected or conflicting operation is never added: the shop ledger never accepted it.
 *  - Cost comes from this device's own stock history (openings, receipts and the queued sales
 *    themselves, replayed at moving average). When that history does not explain the quantity sold,
 *    the figure is marked provisional instead of being presented as exact — the same rule the local
 *    dashboard already follows.
 */
export interface PendingSaleFigure {
  at: string;
  net: number;
  cogs: number;
  /** Unpaid part of this sale: it raises the shop's outstanding customer credit. */
  credit: number;
}
export interface PendingFigures {
  /** Queued sales inside the range. */
  count: number;
  grossSales: number;
  discounts: number;
  netSales: number;
  paid: number;
  receivable: number;
  unitsSold: number;
  cogs: number;
  /** False when part of the cost basis for these sales is not on this device. */
  costComplete: boolean;
  sales: PendingSaleFigure[];
  repayments: { at: string; amount: number }[];
  repaymentsByMethod: { cash: number; momo: number; bank: number; other: number };
  /** Change in outstanding customer credit caused by the queued work (+ from credit sales, − repayments). */
  creditDelta: number;
}

const EMPTY: PendingFigures = {
  count: 0, grossSales: 0, discounts: 0, netSales: 0, paid: 0, receivable: 0, unitsSold: 0,
  cogs: 0, costComplete: true, sales: [], repayments: [],
  repaymentsByMethod: { cash: 0, momo: 0, bank: 0, other: 0 }, creditDelta: 0,
};

const inRange = (iso: string, from: string, to: string) => iso >= from && iso < to;
const saleGross = (s: ReturnType<typeof parseRecords>["sales"][number]) =>
  s.lines.reduce((sum, l) => sum + lineAmount(l.sellingQty ?? l.qty, l.unitPrice), 0);

/**
 * Cost of each queued sale, from this device's ledger.
 *
 * The replay needs the stock that arrived before the sale, so it is built from ALL of this device's
 * records with only the queued sales consuming stock: synchronized sales are already reflected in the
 * server snapshot and must not be subtracted here. Under moving average a sale takes the average cost
 * current at its own moment, so leaving the synchronized sales out of the replay does not change the
 * cost of a queued one — it only changes the stock level, which is why incompleteness is tracked.
 */
function costBySale(records: LocalRecord[]): { cost: Map<string, number>; complete: boolean } {
  const all = parseRecords(records);
  const queued = all.sales.filter((s) => isUnsynced(s.status));
  const ledger = buildLedger({ ...all, sales: queued });
  const cost = new Map<string, number>();
  let complete = true;
  for (const [productId, list] of ledger) {
    if (!ledgerIsComplete(list)) complete = false;
    const replayed = replayLedger(list);
    const ofProduct = queued
      .filter((s) => s.lines.some((l) => l.productId === productId))
      .sort((a, b) => a.at.localeCompare(b.at));
    let saleIndex = 0;
    list.forEach((m, i) => {
      if (m.type !== "sale") return;
      const sale = ofProduct[saleIndex++];
      if (!sale) return;
      // A sale has at most one line per product; when it does not, the movement cost is 0 and the
      // figure stays provisional rather than pretending to know the cost.
      const line = sale.lines.find((l) => l.productId === productId);
      const qty = line?.qty ?? 0;
      const share = qty > 0 ? (replayed.perMovementCost[i] ?? 0) : 0;
      if (qty <= 0) complete = false;
      cost.set(sale.id, (cost.get(sale.id) ?? 0) + share);
    });
  }
  return { cost, complete };
}

/** Queued sales and repayments inside `[from, to)`, priced where this device can price them. */
export function pendingFigures(input: { records: LocalRecord[]; from: string; to: string; withCosts: boolean }): PendingFigures {
  const { records, from, to, withCosts } = input;
  const queued = parseRecords(records.filter((r) => isUnsynced(r.status)));
  const sales = queued.sales.filter((s) => inRange(s.at, from, to));
  const repayments = queued.repayments.filter((p) => inRange(p.at, from, to));
  if (!sales.length && !repayments.length) return EMPTY;

  const priced = withCosts ? costBySale(records) : { cost: new Map<string, number>(), complete: true };
  const out: PendingFigures = {
    ...EMPTY,
    sales: [], repayments: [], repaymentsByMethod: { cash: 0, momo: 0, bank: 0, other: 0 },
    costComplete: withCosts ? priced.complete : true,
  };
  let creditDelta = 0;
  for (const s of sales) {
    const gross = saleGross(s);
    const discount = Math.min(s.discount, gross);
    const net = gross - discount;
    const paid = Math.min(s.paid, net);
    // Only an account sale creates customer credit; a walk-in partial is not a credit account.
    const credit = s.customerId ? Math.max(0, net - paid) : 0;
    const cogs = withCosts ? (priced.cost.get(s.id) ?? 0) : 0;
    out.count += 1;
    out.grossSales += gross;
    out.discounts += discount;
    out.netSales += net;
    out.paid += paid;
    out.receivable += net - paid;
    out.unitsSold += s.lines.reduce((t, l) => t + l.qty, 0);
    out.cogs += cogs;
    out.sales.push({ at: s.at, net, cogs, credit });
    creditDelta += credit;
  }
  for (const p of repayments) {
    out.repayments.push({ at: p.at, amount: p.amount });
    if (p.method === "cash" || p.method === "momo" || p.method === "bank") out.repaymentsByMethod[p.method] += p.amount;
    else out.repaymentsByMethod.other += p.amount;
    creditDelta -= p.amount;
  }
  out.creditDelta = creditDelta;
  return out;
}

const grossMarginBps = (net: number, gross: number) =>
  net > 0 ? Math.round((gross * 10_000) / net) : null;

/** The trend bucket a moment belongs to: the latest bucket start at or before its Kigali day. */
function bucketOf(trend: { date: string }[], at: string): number {
  const day = kigaliDay(at);
  let found = -1;
  trend.forEach((p, i) => { if (p.date <= day) found = i; });
  return found;
}

/**
 * Lays the queued figures onto a dashboard payload. Pure: the base payload is never mutated, so the
 * same saved snapshot can be re-merged after every sale without accumulating the previous merge.
 */
export function applyPendingDashboard(base: Dashboard, f: PendingFigures): Dashboard {
  if (!f.count && !f.repayments.length) return base;
  const ops = base.operations;
  const netSales = ops.netSales + f.netSales;
  const transactions = ops.transactions + f.count;
  const cashCollected = ops.cashCollected + f.paid;
  const creditRepayments = (ops.creditRepayments ?? 0) + f.repayments.reduce((s, p) => s + p.amount, 0);
  const byMethod = { ...(ops.repaymentsByMethod ?? { cash: 0, momo: 0, bank: 0, other: 0 }) };
  for (const k of ["cash", "momo", "bank", "other"] as const) byMethod[k] += f.repaymentsByMethod[k];

  const financials = base.financials
    ? (() => {
        const fin = base.financials!;
        const finNet = fin.netSales + f.netSales;
        const cogs = fin.cogs + f.cogs;
        const grossProfit = finNet - cogs;
        const operatingExpenses = fin.operatingExpenses;
        const stockLosses = fin.stockLosses ?? fin.stockLossValue ?? 0;
        const operatingProfit = grossProfit - operatingExpenses;
        return {
          ...fin,
          grossSales: fin.grossSales + f.grossSales,
          discounts: fin.discounts + f.discounts,
          netSales: finNet,
          cogs,
          grossProfit,
          grossMarginBps: grossMarginBps(finNet, grossProfit),
          operatingProfit,
          operatingResultAfterStockLosses: operatingProfit - stockLosses,
          costBasisIncomplete: !!fin.costBasisIncomplete || !f.costComplete,
        };
      })()
    : null;

  const trend = base.trend.map((p) => ({ ...p }));
  for (const s of f.sales) {
    const i = bucketOf(trend, s.at);
    if (i < 0) continue;
    const row = trend[i]!;
    row.netSales += s.net;
    row.transactions += 1;
    if (row.grossProfit !== null) row.grossProfit += s.net - s.cogs;
  }
  for (const p of f.repayments) {
    const i = bucketOf(trend, p.at);
    if (i >= 0) trend[i]!.repayments += p.amount;
  }

  return {
    ...base,
    financials,
    operations: {
      ...ops,
      netSales,
      transactions,
      unitsSold: ops.unitsSold + f.unitsSold,
      averageTransaction: transactions ? Math.round(netSales / transactions) : 0,
      grossSales: ops.grossSales + f.grossSales,
      discounts: ops.discounts + f.discounts,
      cashCollected,
      receivables: ops.receivables + f.receivable,
      creditRepayments,
      totalReceived: cashCollected + creditRepayments,
      outstandingCredit: Math.max(0, (ops.outstandingCredit ?? 0) + f.creditDelta),
      repaymentsByMethod: byMethod,
    },
    trend,
  };
}
