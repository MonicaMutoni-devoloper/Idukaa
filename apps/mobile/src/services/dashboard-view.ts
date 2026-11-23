import { KIGALI_UTC_OFFSET_MS } from "@sms/shared";
import type { Key } from "../localization";
import type { Change, Operations } from "./local-dashboard";

/**
 * Presentation rules shared by the owner and manager dashboards.
 *
 * The dashboard used to decide these things inline: which figures deserve a headline, which
 * "needs attention" tiles to show, and how to label a chart. Keeping the rules here means they can
 * be tested without rendering React Native, and it keeps the screen from re-deriving financial
 * meaning in JSX.
 *
 * Nothing in this file changes a financial calculation. Every value it returns is the value the
 * server or the on-device ledger already produced; it only chooses what to put first and what to
 * say about it.
 */

/* ------------------------------------------------------------------ greeting */

export type GreetingKey = "home.greeting.morning" | "home.greeting.afternoon" | "home.greeting.evening";

/**
 * Time of day in Africa/Kigali (UTC+2, no daylight saving), not the device's zone: an owner
 * travelling, or a phone with the wrong region set, must still be greeted by the shop's clock.
 */
export function greetingKey(now: number = Date.now()): GreetingKey {
  const hour = new Date(now + KIGALI_UTC_OFFSET_MS).getUTCHours();
  if (hour >= 5 && hour < 12) return "home.greeting.morning";
  if (hour >= 12 && hour < 18) return "home.greeting.afternoon";
  return "home.greeting.evening";
}

/* ------------------------------------------------------------------ primary figures */

export type PrimaryKey = "netSales" | "grossProfit" | "moneyReceived" | "outstandingCredit" | "transactions";

export interface PrimaryFigure {
  key: PrimaryKey;
  labelKey: Key;
  value: number;
  /** Exactly one of these is set: a translated hint, or a key the screen interpolates. */
  hintKey?: Key;
  hint?: string;
  /** Only ever set when the payload carried a real previous-period figure. */
  delta: Change | null;
  tone: "default" | "danger" | "accent";
  /** True when the figure exists for this role but its value may not be shown. */
  restricted?: boolean;
  testID?: string;
}

export interface PrimaryInput {
  operations: Pick<
    Operations,
    "netSales" | "transactions" | "cashCollected" | "creditRepayments" | "totalReceived" | "outstandingCredit"
  >;
  /** Null for a manager the owner has not granted cost and profit data — never faked to zero. */
  financials: { netSales: number; grossProfit: number; grossMarginBps: number | null } | null;
  financialsAllowed: boolean;
  /** `financialComparison` from the payload; absent on older cached copies. */
  comparison?: { netSales: Change; grossProfit: Change } | null;
  /** `salesComparison` — the only comparison a manager's payload carries. */
  salesComparison?: { netSales: Change } | null;
}

/**
 * The four figures an owner opens the app to see, in priority order.
 *
 * Deliberate choices:
 *  - Money received is `totalReceived` (sales collections + credit repayments), not
 *    `cashCollected`: a repayment is money in the till and must be counted once, here.
 *  - Outstanding credit is a BALANCE as of the period end, so it stands alone rather than being
 *    netted against this period's sales.
 *  - Both roles get the SAME four cards in the same order. A manager without the cost grant sees
 *    the profit card locked, never a different card that makes the dashboards look unrelated and
 *    never a zero that would read as a real loss.
 *  - A comparison is attached only when the payload supplied one. No baseline, no arrow.
 */
export function primaryFigures(input: PrimaryInput): PrimaryFigure[] {
  const { operations: ops, financials, financialsAllowed } = input;
  const netSalesDelta = input.comparison?.netSales ?? input.salesComparison?.netSales ?? null;

  const out: PrimaryFigure[] = [
    {
      key: "netSales",
      labelKey: "fin.netSales",
      value: financialsAllowed && financials ? financials.netSales : ops.netSales,
      hintKey: "fin.netSalesHint",
      delta: netSalesDelta,
      tone: "default",
      testID: "kpi-netSales",
    },
  ];

  out.push({
    key: "grossProfit",
    labelKey: "fin.gross",
    value: financials?.grossProfit ?? 0,
    // The screen renders the margin itself; `grossMarginBps` stays the only source for it.
    hintKey: financials && financialsAllowed
      ? (financials.grossMarginBps != null ? "dash.grossMargin" : "fin.marginUnavailable")
      : (financialsAllowed ? "dash.sectionUnavailable" : "dash.financeRestrictedHint"),
    delta: financials && financialsAllowed ? input.comparison?.grossProfit ?? null : null,
    tone: financials && financialsAllowed && financials.grossProfit < 0 ? "danger" : "default",
    restricted: !(financials && financialsAllowed),
    testID: "kpi-grossProfit",
  });

  out.push({
    key: "moneyReceived",
    labelKey: "fin.totalReceived",
    value: ops.totalReceived ?? ops.cashCollected,
    hintKey: "fin.totalReceivedHint",
    delta: null,
    tone: "default",
    testID: "kpi-totalReceived",
  });

  out.push({
    key: "outstandingCredit",
    labelKey: "fin.outstandingCredit",
    value: ops.outstandingCredit ?? 0,
    hintKey: "fin.outstandingCreditHint",
    delta: null,
    tone: (ops.outstandingCredit ?? 0) > 0 ? "accent" : "default",
    testID: "kpi-outstandingCredit",
  });

  return out;
}

/* ------------------------------------------------------------------ needs attention */

export type AttentionTone = "danger" | "warn" | "neutral";

export interface AttentionItem {
  key: "conflicts" | "failed" | "investigations" | "approvals" | "outOfStock" | "lowStock" | "pendingSync";
  labelKey: Key;
  count: number;
  tone: AttentionTone;
  route: string;
}

export interface AttentionInput {
  operations: Operations | null;
  /** Outbox verdict counts from the on-device records. */
  counts?: { pending?: number; failed?: number; conflicts?: number } | null;
  isOwner: boolean;
}

/**
 * Only things that need a decision, in order of how badly they need it.
 *
 * The old panel rendered five zero-valued tiles permanently, so a quiet shop looked busy and a
 * real conflict looked like one tile among equals. Nothing here is shown at zero, and an empty
 * list is the honest "all clear".
 *
 * A pending record is listed but never coloured as a fault: an offline queue is normal operation.
 * Approvals are the owner's to give, so a manager is not sent to a screen they cannot act on.
 */
export function attentionItems({ operations: ops, counts, isOwner }: AttentionInput): AttentionItem[] {
  if (!ops && !counts) return [];
  const conflicts = Math.max(counts?.conflicts ?? 0, ops?.openConflicts ?? 0);
  const failed = counts?.failed ?? 0;
  const pendingSync = counts?.pending ?? 0;
  const outOfStock = ops?.outOfStockCount ?? 0;
  // `lowStockCount` includes the out-of-stock products; counting both would double-report a shelf.
  const lowOnly = Math.max(0, (ops?.lowStockCount ?? 0) - outOfStock);

  const items: AttentionItem[] = [
    { key: "conflicts", labelKey: "dash.openConflicts", count: conflicts, tone: "danger", route: "/sync" },
    { key: "failed", labelKey: "dash.attention.failed", count: failed, tone: "danger", route: "/sync" },
    { key: "investigations", labelKey: "dash.openInvestigations", count: ops?.openInvestigations ?? 0, tone: "warn", route: "/stock" },
    { key: "approvals", labelKey: "dash.pendingApprovals", count: isOwner ? ops?.pendingApprovals ?? 0 : 0, tone: "warn", route: "/approvals" },
    { key: "outOfStock", labelKey: "home.productsOut", count: outOfStock, tone: "warn", route: "/stock" },
    { key: "lowStock", labelKey: "home.productsLow", count: lowOnly, tone: "warn", route: "/stock" },
    { key: "pendingSync", labelKey: "dash.attention.pendingSync", count: pendingSync, tone: "neutral", route: "/sync" },
  ];
  return items.filter((i) => i.count > 0);
}

/* ------------------------------------------------------------------ performance chart */

export type TrendMetric = "sales" | "profit" | "repayments";

export interface TrendRow { date: string; netSales: number; transactions: number; grossProfit: number | null; repayments?: number }

/**
 * One chart, three honest metrics. "Money received" cannot be plotted per day: the payload
 * carries collections for the period as a whole and repayments per bucket, so the third series is
 * labelled credit repayments rather than inventing a daily total nobody calculated.
 */
export function trendSeries(rows: TrendRow[], metric: TrendMetric): { date: string; netSales: number; transactions: number }[] {
  return rows.map((r) => ({
    date: r.date,
    transactions: r.transactions,
    netSales: metric === "profit" ? r.grossProfit ?? 0 : metric === "repayments" ? r.repayments ?? 0 : r.netSales,
  }));
}

export function trendMetricKeys(financialsAllowed: boolean): TrendMetric[] {
  return financialsAllowed ? ["sales", "profit", "repayments"] : ["sales", "repayments"];
}
