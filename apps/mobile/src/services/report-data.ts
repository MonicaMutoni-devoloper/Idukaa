import { listProducts, listRecords, kvGet, kvSet } from "../database";
import { ApiError, request } from "./api";
import { isUnsynced, mergePendingRows, readReportCache, reportCacheKey } from "./local-reports";
import type {
  ReportAdjustmentRow, ReportExpenseRow, ReportItemRow, ReportPurchaseRow, ReportSaleRow,
} from "./local-reports";
import { buildLocalReport, buildLocalSummary } from "./local-reports-data";
import {
  applyPendingStock, inventoryFromProducts, mergePendingItems, movementsFromRecords, pendingFinancials, salesTotals,
  type InventoryRow, type MovementRow, type PendingFinancials,
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
  /** True only after this exact payload was durably written to the device cache. */
  savedLocally: boolean;
  pendingOps: number;
  authIssue: boolean;
  forbidden: boolean;
  failed: boolean;
}

export interface Loaded<T> { data: T | null; meta: LoadMeta }

export interface LoadContext {
  online: boolean; shopId: string | null; from: string; to: string; financials: boolean;
}

const EMPTY_META: LoadMeta = { source: null, savedAt: null, savedLocally: false, pendingOps: 0, authIssue: false, forbidden: false, failed: true };

const meta = (over: Partial<LoadMeta>): LoadMeta => ({ ...EMPTY_META, failed: false, ...over });

const readCache = async <T>(ctx: LoadContext, view: string): Promise<{ data: T; savedAt: string } | null> => {
  try {
    const entry = readReportCache(await kvGet(reportCacheKey(ctx.shopId, view, ctx.from, ctx.to, ctx.financials)), {
      shopId: ctx.shopId, view, from: ctx.from, to: ctx.to, financials: ctx.financials,
    });
    // New entries carry the complete payload (rows included), so an offline report can render its
    // ledger and sale details. Entries written by an older build only kept totals; they remain
    // readable as summary-only copies instead of being treated as corrupt.
    const data = (entry as any)?.data ?? entry?.totals;
    if (!data || typeof data !== "object") return null;
    return { data: data as T, savedAt: entry!.savedAt };
  } catch {
    return null;
  }
};

const writeCache = async (ctx: LoadContext, view: string, data: unknown): Promise<boolean> => {
  try {
    await kvSet(reportCacheKey(ctx.shopId, view, ctx.from, ctx.to, ctx.financials), JSON.stringify({
      savedAt: new Date().toISOString(), shopId: ctx.shopId, view, from: ctx.from, to: ctx.to,
      access: ctx.financials ? "financial" : "operational",
      rows: [], totals: data, data,
    }));
    return true;
  } catch {
    // The live answer can still be shown, but it must never be labelled as available offline.
    return false;
  }
};

/** The saved copy for the exact scope, without making a request. Used for cache-first rendering. */
export async function peekCachedReport<T>(ctx: LoadContext, view: string): Promise<Loaded<T> | null> {
  const cached = await readCache<T>(ctx, view);
  return cached
    ? { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, savedLocally: true, pendingOps: 0 }) }
    : null;
}

const pendingIn = (records: { status: string; at: string }[], from: string, to: string) =>
  records.filter((r) => isUnsynced(r.status) && r.at >= from && r.at < to).length;

const TX_PAGE = 500;
/** Walk every transaction page for the range. Stopping at the first page would silently hide history. */
async function allTransactions<T>(kind: string, ctx: LoadContext): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < 500_000; offset += TX_PAGE) {
    const q = `kind=${kind}&from=${encodeURIComponent(ctx.from)}&to=${encodeURIComponent(ctx.to)}&limit=${TX_PAGE}&offset=${offset}`;
    const page = await request<T[]>(`/reports/transactions?${q}`);
    out.push(...page);
    if (page.length < TX_PAGE) break;
  }
  return out;
}

const MOVEMENT_PAGE = 1000;
async function allMovements(ctx: LoadContext): Promise<ApiMovements> {
  const items: ApiMovements["items"] = [];
  let financials = false;
  for (let offset = 0; offset < 500_000; offset += MOVEMENT_PAGE) {
    const q = `from=${encodeURIComponent(ctx.from)}&to=${encodeURIComponent(ctx.to)}&limit=${MOVEMENT_PAGE}&offset=${offset}`;
    const page = await request<ApiMovements>(`/reports/movements?${q}`);
    items.push(...page.items);
    financials = page.financials;
    if (page.items.length < MOVEMENT_PAGE) break;
  }
  return { items, truncated: false, financials };
}

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
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, savedLocally: true, pendingOps }) };
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
    const savedLocally = await writeCache(ctx, view, data);
    return { data, meta: meta({ source: "server", savedLocally, pendingOps }) };
  } catch (e) {
    const cached = await readCache<InventoryData>(ctx, view);
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, savedLocally: true, pendingOps, ...failMeta(e) }) };
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
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, savedLocally: true, pendingOps }) };
    const device = fromDevice();
    return device
      ? { data: device, meta: meta({ source: "device", pendingOps }) }
      : { data: null, meta: { ...EMPTY_META, pendingOps } };
  }

  try {
    const r = await allMovements(ctx);
    // Pending movements cannot be on the server yet (that is what pending means), so appending
    // them cannot double count; once synchronized the record is no longer unsynced and only the
    // server row remains.
    const items = [...pending, ...r.items].sort((a, b) => b.at.localeCompare(a.at));
    const data: MovementsData = { items, truncated: r.truncated, financials: r.financials };
    const savedLocally = await writeCache(ctx, view, data);
    return { data, meta: meta({ source: "server", savedLocally, pendingOps }) };
  } catch (e) {
    const cached = await readCache<MovementsData>(ctx, view);
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, savedLocally: true, pendingOps, ...failMeta(e) }) };
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
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, savedLocally: true, pendingOps }) };
    const device = await fromDevice();
    return device
      ? { data: device, meta: meta({ source: "device", pendingOps }) }
      : { data: null, meta: { ...EMPTY_META, pendingOps } };
  }

  try {
    const q = `from=${encodeURIComponent(ctx.from)}&to=${encodeURIComponent(ctx.to)}`;
    const [tx, itemReport] = await Promise.all([
      allTransactions<ReportSaleRow>("sales", ctx),
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
    const savedLocally = await writeCache(ctx, view, data);
    return { data, meta: meta({ source: "server", savedLocally, pendingOps }) };
  } catch (e) {
    const cached = await readCache<SalesData>(ctx, view);
    if (cached) return { data: cached.data, meta: meta({ source: "cached", savedAt: cached.savedAt, savedLocally: true, pendingOps, ...failMeta(e) }) };
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
  /** Server-confirmed P&L: successfully synchronized records only. Null when no server answer is held. */
  summary: SummaryPayload | null;
  /** P&L calculated on this device from every record it holds, queued operations included. */
  localSummary: SummaryPayload | null;
  /** Server-confirmed ledger rows, with no queued operation merged in. */
  expenses: ReportExpenseRow[];
  purchases: ReportPurchaseRow[];
  adjustments: ReportAdjustmentRow[];
  /** Posted sales in the period: the rows behind the revenue trend. */
  sales: ReportSaleRow[];
  /** The same ledgers as this device holds them (synchronized records plus queued operations). */
  localExpenses: ReportExpenseRow[];
  localPurchases: ReportPurchaseRow[];
  localAdjustments: ReportAdjustmentRow[];
  localSales: ReportSaleRow[];
  /** Value of queued operations in the period, shown separately — never folded into a confirmed total. */
  pending: PendingFinancials;
  /** True when the local ledger cannot price every movement (cost basis or history incomplete). */
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

  /** Local operational view: every record on this device, each counted exactly once. */
  const localBundle = async () => {
    const [summary, rows] = await Promise.all([localSummary(ctx), localRows()]);
    return { summary, rows, pending: pendingFinancials(rows) };
  };
  type LocalBundle = Awaited<ReturnType<typeof localBundle>>;
  const withLocal = (base: Omit<FinancialData, "localSummary" | "localExpenses" | "localPurchases" | "localAdjustments" | "localSales" | "pending" | "provisional" | "summary"> & { summary: SummaryPayload | null }, local: LocalBundle): FinancialData => ({
    ...base,
    summary: base.summary,
    localSummary: local.summary,
    localExpenses: local.rows.expenses, localPurchases: local.rows.purchases,
    localAdjustments: local.rows.adjustments, localSales: local.rows.sales,
    pending: local.pending,
    provisional: !local.summary || local.summary.provisional === true,
  });
  const emptyBase = { expenses: [], purchases: [], adjustments: [], sales: [] };

  const fromDevice = async (): Promise<FinancialData | null> => {
    if (!ctx.financials) return null;
    // A brand-new device has the catalogue but no business history. Rendering an all-zero P&L
    // would present "never downloaded" as a genuine zero, so ask for the first online download.
    if (!records.length) return null;
    const local = await localBundle();
    if (!local.summary) return null;
    return withLocal({ summary: null, ...emptyBase }, local);
  };

  if (!ctx.online) {
    const cached = await readCache<FinancialData>(ctx, view);
    if (cached) return {
      data: withLocal({
        summary: cached.data.summary ?? null,
        expenses: cached.data.expenses ?? [], purchases: cached.data.purchases ?? [],
        adjustments: cached.data.adjustments ?? [], sales: cached.data.sales ?? [],
      }, await localBundle()),
      meta: meta({ source: "cached", savedAt: cached.savedAt, savedLocally: true, pendingOps }),
    };
    const device = await fromDevice();
    return device
      ? { data: device, meta: meta({ source: "device", pendingOps }) }
      : { data: null, meta: { ...EMPTY_META, pendingOps } };
  }

  try {
    const q = `from=${encodeURIComponent(ctx.from)}&to=${encodeURIComponent(ctx.to)}`;
    const [summary, expenses, purchases, adjustments, sales] = await Promise.all([
      request<SummaryPayload>(`/reports/summary?${q}`),
      allTransactions<ReportExpenseRow>("expenses", ctx),
      allTransactions<ReportPurchaseRow>("purchases", ctx),
      allTransactions<ReportAdjustmentRow>("adjustments", ctx),
      allTransactions<ReportSaleRow>("sales", ctx),
    ]);
    // Confirmed rows stay exactly as the server returned them; queued work lives in the local
    // basis. This is what keeps a pending sale from appearing in both totals at once.
    const data = withLocal({
      summary, expenses, purchases, adjustments, sales,
    }, await localBundle());
    const savedLocally = await writeCache(ctx, view, data);
    return { data, meta: meta({ source: "server", savedLocally, pendingOps }) };
  } catch (e) {
    const cached = await readCache<FinancialData>(ctx, view);
    if (cached) return {
      data: withLocal({
        summary: cached.data.summary ?? null,
        expenses: cached.data.expenses ?? [], purchases: cached.data.purchases ?? [],
        adjustments: cached.data.adjustments ?? [], sales: cached.data.sales ?? [],
      }, await localBundle()),
      meta: meta({ source: "cached", savedAt: cached.savedAt, savedLocally: true, pendingOps, ...failMeta(e) }),
    };
    const device = await fromDevice();
    if (device) return { data: device, meta: meta({ source: "device", pendingOps, ...failMeta(e) }) };
    return { data: null, meta: { ...EMPTY_META, pendingOps, ...failMeta(e) } };
  }
}
