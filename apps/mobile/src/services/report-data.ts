import { listProducts, listRecords, kvGet, kvSet } from "../database";
import { ApiError, request } from "./api";
import { isUnsynced, mergePendingRows, readReportCache, reportCacheKey } from "./local-reports";
import type {
  ReportAdjustmentRow, ReportExpenseRow, ReportItemRow, ReportPurchaseRow, ReportSaleRow,
} from "./local-reports";
import { buildLocalReport, buildLocalSummary } from "./local-reports-data";
import {
  applyPendingStock, inventoryFromProducts, mergePendingItems, movementsFromRecords, salesTotals,
  type InventoryRow, type MovementRow,
} from "./report-analytics";
import type { LocalSummaryPayload } from "./local-reports";

/**
 * Data for the Reports & Analytics workspaces.
 *
 * Each category loads the server answer when online, falls back to the last saved copy and then to
 * this device's records when it is not, and merges unsynchronized operations so work done offline
 * is visible immediately. The rules are the same ones the previous Reports screen enforced:
 *
 *  - a failed request never replaces a known report with zeros;
 *  - a cached answer is validated against shop + period before it is shown, and is labelled;
 *  - pending operations are added once (by id for ledgers, summed for product totals), never twice;
 *  - a 401 is reported as a session problem, not as "offline";
 *  - financial cost data stays hidden for a manager the owner did not grant it to.
 */

export type ReportCategory = "inventory" | "movements" | "sales" | "financial";
export type FigureSource = "server" | "cached" | "device";

export interface LoadMeta {
  source: FigureSource | null;
  savedAt: string | null;
  pendingOps: number;
  authIssue: boolean;
  forbidden: boolean;
  failed: boolean;
}

export interface Loaded<T> { data: T | null; meta: LoadMeta }

export interface LoadContext {
  online: boolean; shopId: string | null; from: string; to: string; financials: boolean;
}

const EMPTY_META: LoadMeta = { source: null, savedAt: null, pendingOps: 0, authIssue: false, forbidden: false, failed: true };

const meta = (over: Partial<LoadMeta>): LoadMeta => ({ ...EMPTY_META, failed: false, ...over });

const readCache = async <T>(ctx: LoadContext, view: string): Promise<{ data: T; savedAt: string } | null> => {
  try {
    const entry = readReportCache(await kvGet(reportCacheKey(ctx.shopId, view, ctx.from, ctx.to)), {
      shopId: ctx.shopId, view, from: ctx.from, to: ctx.to,
    });
    if (!entry?.totals || typeof entry.totals !== "object") return null;
    return { data: entry.totals as T, savedAt: entry.savedAt };
  } catch {
    return null;
  }
};

const writeCache = (ctx: LoadContext, view: string, data: unknown) =>
  kvSet(reportCacheKey(ctx.shopId, view, ctx.from, ctx.to), JSON.stringify({
    savedAt: new Date().toISOString(), shopId: ctx.shopId, view, from: ctx.from, to: ctx.to,
    rows: [], totals: data,
  })).catch(() => {});

const pendingIn = (records: { status: string; at: string }[], from: string, to: string) =>
  records.filter((r) => isUnsynced(r.status) && r.at >= from && r.at < to).length;

const failMeta = (e: unknown): Partial<LoadMeta> => ({
  authIssue: e instanceof ApiError && e.status === 401,
  forbidden: e instanceof ApiError && e.status === 403,
  failed: true,
});

/* ------------------------------------------------------------------ inventory */

export interface InventoryData { items: InventoryRow[]; totalValue: number | null; financials: boolean }

interface ApiInventory {
  items: {
    id: string; code: string; name: string; unit: string; category?: string | null;
    selling_price: number; low_stock_threshold: number; onHand: number; low: boolean;
    avgCost?: number; value?: number;
  }[];
  totalValue: number | null;
}

export async function loadInventory(ctx: LoadContext): Promise<Loaded<InventoryData>> {
  let records: Awaited<ReturnType<typeof listRecords>> = [];
  let products: Awaited<ReturnType<typeof listProducts>> = [];
  try { [records, products] = await Promise.all([listRecords(), listProducts("")]); } catch { /* device store unavailable */ }
  const pendingOps = pendingIn(records, ctx.from, ctx.to);
  const view = "analytics:inventory";

  const fromDevice = (): InventoryData | null => {
    if (!products.length) return null;
    return { items: inventoryFromProducts(products), totalValue: null, financials: false };
  };

  if (!ctx.online) {
    const cached = await readCache<InventoryData>(ctx, view);
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, pendingOps }) };
    const device = fromDevice();
    return device
      ? { data: device, meta: meta({ source: "device", pendingOps }) }
      : { data: null, meta: { ...EMPTY_META, pendingOps } };
  }

  try {
    const r = await request<ApiInventory>("/reports/inventory");
    const items = applyPendingStock(r.items.map((i) => ({
      id: i.id, name: i.name, code: i.code, unit: i.unit, category: i.category ?? null,
      onHand: Number(i.onHand), threshold: Number(i.low_stock_threshold), low: !!i.low,
      sellingPrice: Number(i.selling_price),
      avgCost: i.avgCost === undefined || i.avgCost === null ? null : Number(i.avgCost),
      value: i.value === undefined || i.value === null ? null : Number(i.value),
    })), products);
    const data: InventoryData = { items, totalValue: r.totalValue === null ? null : Number(r.totalValue), financials: r.totalValue !== null };
    void writeCache(ctx, view, data);
    return { data, meta: meta({ source: "server", pendingOps }) };
  } catch (e) {
    const cached = await readCache<InventoryData>(ctx, view);
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, pendingOps, ...failMeta(e) }) };
    const device = fromDevice();
    if (device) return { data: device, meta: meta({ source: "device", pendingOps, ...failMeta(e) }) };
    return { data: null, meta: { ...EMPTY_META, pendingOps, ...failMeta(e) } };
  }
}

/* ------------------------------------------------------------------ stock movements */

export interface MovementsData { items: MovementRow[]; truncated: boolean; financials: boolean }

interface ApiMovements {
  items: {
    id: string; at: string; productId: string; product: string; code: string; unit: string;
    type: MovementRow["type"]; qty: number; unitCost: number | null; reason: string | null;
    reference: string | null; by: string | null; balanceBefore: number; balanceAfter: number;
  }[];
  truncated: boolean;
  financials: boolean;
}

export async function loadMovements(ctx: LoadContext): Promise<Loaded<MovementsData>> {
  let records: Awaited<ReturnType<typeof listRecords>> = [];
  let products: Awaited<ReturnType<typeof listProducts>> = [];
  try { [records, products] = await Promise.all([listRecords(), listProducts("")]); } catch { /* device store unavailable */ }
  const pendingOps = pendingIn(records, ctx.from, ctx.to);
  const pending = movementsFromRecords({ records, products, from: ctx.from, to: ctx.to })
    .filter((r) => r.syncStatus && isUnsynced(r.syncStatus));
  const view = "analytics:movements";

  const fromDevice = (): MovementsData | null => {
    if (!products.length) return null;
    return { items: movementsFromRecords({ records, products, from: ctx.from, to: ctx.to }), truncated: false, financials: false };
  };

  if (!ctx.online) {
    const cached = await readCache<MovementsData>(ctx, view);
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, pendingOps }) };
    const device = fromDevice();
    return device
      ? { data: device, meta: meta({ source: "device", pendingOps }) }
      : { data: null, meta: { ...EMPTY_META, pendingOps } };
  }

  try {
    const r = await request<ApiMovements>(`/reports/movements?from=${encodeURIComponent(ctx.from)}&to=${encodeURIComponent(ctx.to)}`);
    // Pending movements cannot be on the server yet (that is what pending means), so appending
    // them cannot double count; once synchronized the record is no longer unsynced and only the
    // server row remains.
    const items = [...pending, ...r.items].sort((a, b) => b.at.localeCompare(a.at));
    const data: MovementsData = { items, truncated: r.truncated, financials: r.financials };
    void writeCache(ctx, view, data);
    return { data, meta: meta({ source: "server", pendingOps }) };
  } catch (e) {
    const cached = await readCache<MovementsData>(ctx, view);
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, pendingOps, ...failMeta(e) }) };
    const device = fromDevice();
    if (device) return { data: device, meta: meta({ source: "device", pendingOps, ...failMeta(e) }) };
    return { data: null, meta: { ...EMPTY_META, pendingOps, ...failMeta(e) } };
  }
}

/* ------------------------------------------------------------------ sales */

export interface SalesTotalsView {
  gross: number; discounts: number; net: number; transactions: number; units: number;
  averageSale: number; reversed: number;
}
export interface SalesData {
  sales: ReportSaleRow[];
  items: ReportItemRow[];
  totals: SalesTotalsView & { products: number };
}

interface ApiItems { items: ReportItemRow[]; totals: { units: number; gross: number; products: number; sales: number; net: number; discounts: number } }

const totalsFrom = (sales: ReportSaleRow[], items: ReportItemRow[]): SalesData["totals"] => ({
  ...salesTotals(sales),
  products: items.length,
});

export async function loadSales(ctx: LoadContext): Promise<Loaded<SalesData>> {
  let records: Awaited<ReturnType<typeof listRecords>> = [];
  try { records = await listRecords(); } catch { /* device store unavailable */ }
  const pendingOps = pendingIn(records, ctx.from, ctx.to);
  const view = "analytics:sales";

  const fromDevice = async (): Promise<SalesData | null> => {
    try {
      const [salesLocal, itemsLocal] = await Promise.all([
        buildLocalReport({ view: "sales", from: ctx.from, to: ctx.to }),
        buildLocalReport({ view: "items", from: ctx.from, to: ctx.to }),
      ]);
      const sales = salesLocal.rows as ReportSaleRow[];
      const items = itemsLocal.rows as ReportItemRow[];
      if (!sales.length && !items.length) return null;
      return { sales, items, totals: totalsFrom(sales, items) };
    } catch {
      return null;
    }
  };

  if (!ctx.online) {
    const cached = await readCache<SalesData>(ctx, view);
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, pendingOps }) };
    const device = await fromDevice();
    return device
      ? { data: device, meta: meta({ source: "device", pendingOps }) }
      : { data: null, meta: { ...EMPTY_META, pendingOps } };
  }

  try {
    const q = `from=${encodeURIComponent(ctx.from)}&to=${encodeURIComponent(ctx.to)}`;
    const [tx, itemReport] = await Promise.all([
      request<ReportSaleRow[]>(`/reports/transactions?kind=sales&${q}`),
      request<ApiItems>(`/reports/items?${q}`),
    ]);
    let pendingSales: ReportSaleRow[] = [];
    let pendingItems: ReportItemRow[] = [];
    if (records.length) {
      try {
        const [s, i] = await Promise.all([
          buildLocalReport({ view: "sales", from: ctx.from, to: ctx.to }),
          buildLocalReport({ view: "items", from: ctx.from, to: ctx.to }),
        ]);
        pendingSales = (s.rows as ReportSaleRow[]).filter((r) => r.syncStatus && isUnsynced(r.syncStatus));
        pendingItems = (i.rows as ReportItemRow[]).filter((r) => r.syncStatus && isUnsynced(r.syncStatus));
      } catch { /* nothing local to add */ }
    }
    const sales = mergePendingRows(tx, pendingSales);
    const items = mergePendingItems(itemReport.items, pendingItems);
    const data: SalesData = { sales, items, totals: totalsFrom(sales, items) };
    void writeCache(ctx, view, data);
    return { data, meta: meta({ source: "server", pendingOps }) };
  } catch (e) {
    const cached = await readCache<SalesData>(ctx, view);
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, pendingOps, ...failMeta(e) }) };
    const device = await fromDevice();
    if (device) return { data: device, meta: meta({ source: "device", pendingOps, ...failMeta(e) }) };
    return { data: null, meta: { ...EMPTY_META, pendingOps, ...failMeta(e) } };
  }
}

/* ------------------------------------------------------------------ financial */

export interface SummaryTotals {
  grossSales: number; discounts: number; salesReturns: number; netSales: number; cogs: number;
  grossProfit: number; grossMarginBps: number | null; operatingExpenses: number; operatingProfit: number;
  operatingResultAfterStockLosses: number; stockLosses: number; cashCollected: number; receivables: number;
  outstandingExpenses: number; inventoryPurchases: number;
  transactions: number; unitsSold: number;
  purchasesReceived: { deliveries: number; products: number; units: number; value: number };
  openingInventoryValue: number; closingInventoryValue: number;
  openingInventoryUnits: number; closingInventoryUnits: number; costBasisIncomplete: boolean;
}
export interface SummaryDelta { change: number; pct: number | null }
export interface SummaryPayload {
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  current: SummaryTotals;
  previous: SummaryTotals;
  comparison: { netSales: SummaryDelta; grossProfit: SummaryDelta; operatingProfit: SummaryDelta; operatingResultAfterStockLosses: SummaryDelta };
  /** Local-only annotations; absent on a server answer. */
  pendingOps?: number;
  provisional?: boolean;
}

export interface FinancialData {
  summary: SummaryPayload | null;
  expenses: ReportExpenseRow[];
  purchases: ReportPurchaseRow[];
  adjustments: ReportAdjustmentRow[];
  /** Posted sales in the period: the rows behind the revenue trend. */
  sales: ReportSaleRow[];
  /** True when the summary was calculated on this device (cost basis may be incomplete). */
  provisional: boolean;
}

const localSummary = async (ctx: LoadContext): Promise<SummaryPayload | null> => {
  try {
    const local: LocalSummaryPayload = await buildLocalSummary({
      from: ctx.from, to: ctx.to, financials: ctx.financials,
    });
    return local as unknown as SummaryPayload;
  } catch {
    return null;
  }
};

export async function loadFinancial(ctx: LoadContext): Promise<Loaded<FinancialData>> {
  let records: Awaited<ReturnType<typeof listRecords>> = [];
  try { records = await listRecords(); } catch { /* device store unavailable */ }
  const pendingOps = pendingIn(records, ctx.from, ctx.to);
  const view = "analytics:financial";

  const localRows = async () => {
    try {
      const [expenses, purchases, adjustments, sales] = await Promise.all([
        buildLocalReport({ view: "expenses", from: ctx.from, to: ctx.to }),
        buildLocalReport({ view: "purchases", from: ctx.from, to: ctx.to }),
        buildLocalReport({ view: "adjustments", from: ctx.from, to: ctx.to }),
        buildLocalReport({ view: "sales", from: ctx.from, to: ctx.to }),
      ]);
      return {
        expenses: expenses.rows as ReportExpenseRow[],
        purchases: purchases.rows as ReportPurchaseRow[],
        adjustments: adjustments.rows as ReportAdjustmentRow[],
        sales: sales.rows as ReportSaleRow[],
      };
    } catch {
      return { expenses: [], purchases: [], adjustments: [], sales: [] };
    }
  };

  const fromDevice = async (): Promise<FinancialData | null> => {
    if (!ctx.financials) return null;
    const summary = await localSummary(ctx);
    if (!summary) return null;
    return { summary, ...(await localRows()), provisional: true };
  };

  if (!ctx.online) {
    const cached = await readCache<FinancialData>(ctx, view);
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, pendingOps }) };
    const device = await fromDevice();
    return device
      ? { data: device, meta: meta({ source: "device", pendingOps }) }
      : { data: null, meta: { ...EMPTY_META, pendingOps } };
  }

  try {
    const q = `from=${encodeURIComponent(ctx.from)}&to=${encodeURIComponent(ctx.to)}`;
    const [summary, expenses, purchases, adjustments, sales] = await Promise.all([
      request<SummaryPayload>(`/reports/summary?${q}`),
      request<ReportExpenseRow[]>(`/reports/transactions?kind=expenses&${q}`),
      request<ReportPurchaseRow[]>(`/reports/transactions?kind=purchases&${q}`),
      request<ReportAdjustmentRow[]>(`/reports/transactions?kind=adjustments&${q}`),
      request<ReportSaleRow[]>(`/reports/transactions?kind=sales&${q}`),
    ]);
    const local = await localRows();
    const pendingOf = <T extends { syncStatus?: string }>(rows: T[]) => rows.filter((r) => r.syncStatus && isUnsynced(r.syncStatus));
    const data: FinancialData = {
      summary,
      expenses: mergePendingRows(expenses, pendingOf(local.expenses)),
      purchases: mergePendingRows(purchases, pendingOf(local.purchases)),
      adjustments: mergePendingRows(adjustments, pendingOf(local.adjustments)),
      sales: mergePendingRows(sales, pendingOf(local.sales)),
      provisional: false,
    };
    void writeCache(ctx, view, data);
    return { data, meta: meta({ source: "server", pendingOps }) };
  } catch (e) {
    const cached = await readCache<FinancialData>(ctx, view);
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, pendingOps, ...failMeta(e) }) };
    const device = await fromDevice();
    if (device) return { data: device, meta: meta({ source: "device", pendingOps, ...failMeta(e) }) };
    return { data: null, meta: { ...EMPTY_META, pendingOps, ...failMeta(e) } };
  }
}
