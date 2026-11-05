import type { Key } from "../localization/en";

/**
 * The report sections the API can report as `degraded` (see ReportsController.section()).
 *
 * The server names a panel it could not compute; the dashboard must say WHICH one, otherwise
 * "1 parts ... could not be loaded" tells the owner that something is missing but not what, and the
 * empty panel behind it reads like a real "no sales this period". Every name here must also exist
 * in both dictionaries — the mobile test enforces that, so a new server section cannot ship unlabelled.
 */
export const SECTION_LABELS: Record<string, Key> = {
  product_profitability: "dash.sec.profitability",
  open_purchases: "dash.sec.openPurchases",
  payables: "dash.sec.payables",
  issues: "dash.sec.issues",
  trend: "dash.sec.trend",
  trend_expenses: "dash.sec.trendExpenses",
  monthly_sales: "dash.sec.monthlySales",
  monthly_returns: "dash.sec.monthlyReturns",
  monthly_expenses: "dash.sec.monthlyExpenses",
  product_totals: "dash.sec.productTotals",
  activity: "dash.sec.activity",
  expenses_by_category: "dash.sec.expenseCategories",
  staff_activity: "dash.sec.staffActivity",
};

/** The dictionary key for a section name, or null when this build has no label for it yet. */
export const sectionKey = (name: string): Key | null => SECTION_LABELS[name] ?? null;

/** Readable fallback for a section name this build does not know: never hide it, never print `undefined`. */
export const sectionLabel = (name: string): string =>
  name.replace(/[_\-.]+/g, " ").trim() || "unknown section";

/**
 * Normalises the payload field. A response cached by an older build has no `degraded`, and a
 * malformed one must not crash the screen: anything that is not a non-empty string is dropped, and
 * duplicates are collapsed (the same panel can never be listed twice).
 */
export function degradedList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const name = v.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
