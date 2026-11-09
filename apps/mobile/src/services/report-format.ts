import { formatRwf, kigaliDay } from "@sms/shared";

/**
 * Report exports.
 *
 * Pure string builders: given the same rows the screen shows, produce a CSV or a printable
 * document. Nothing here reads storage, the network or the user's session, so an export can never
 * include more than the report the user is looking at (same filters, same range, same role-limited
 * columns) and the behavior is testable in Node.
 *
 * The printed document is deliberately plain: a shop report, not a dashboard. Numbers are right
 * aligned, the header repeats on every page, and the data source (server / saved copy / this
 * device, including the offline disclaimer) is printed at the top where a reader can see it.
 */

const MONEY = (n: number) => formatRwf(Math.round(n));

export const quantityText = (milliUnits: number, unit: string) => {
  const value = Math.round(milliUnits) / 1000;
  const text = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
  return `${text} ${unit}`.trim();
};

export const moneyText = MONEY;

export const dayText = (iso: string) => kigaliDay(iso);

export const instantText = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "Africa/Kigali", hour12: false,
  });
};

/* ------------------------------------------------------------------ CSV */

/**
 * One CSV cell. Quoted when it contains a delimiter, quote, newline or edge whitespace; embedded
 * quotes are doubled. Values are never coerced with `String(undefined)` → an empty cell instead.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value);
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC-4180-ish CSV with CRLF rows; the API's own export uses the same line ending. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** `idukaa-sales-by-product-2026-11-01.csv` — stable, sortable, safe on every platform. */
export function csvFilename(parts: string[], fromDay: string): string {
  const slug = parts.map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter(Boolean).join("-");
  return `idukaa-${slug}-${fromDay}.csv`;
}

/** Excel needs the BOM to read UTF-8 (Kinyarwanda names, "RWF") as UTF-8. */
export const withBom = (csv: string) => `\uFEFF${csv}`;

/* ------------------------------------------------------------------ printable document */

export interface PrintMetric { label: string; value: string; hint?: string }
export interface PrintSection {
  title: string;
  columns: string[];
  rows: string[][];
  /** Column indexes rendered right-aligned, like the numbers in the table. */
  numeric?: number[];
  empty?: string;
}
export interface PrintDocument {
  shop: string;
  title: string;
  period: string;
  source: string;
  metrics: PrintMetric[];
  sections: PrintSection[];
  notes: string[];
  generatedAt: string;
}

export const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const th = (title: string, numeric?: boolean) => `<th${numeric ? ' class="r"' : ""}>${escapeHtml(title)}</th>`;
const td = (value: string, numeric?: boolean) => `<td${numeric ? ' class="r"' : ""}>${escapeHtml(value)}</td>`;

/**
 * Complete standalone HTML for printing / "Save as PDF". Uses inline CSS only: the Android print
 * service loads the markup with no access to app assets, and the browser window is opened blank.
 */
export function buildPrintHtml(doc: PrintDocument): string {
  const metrics = doc.metrics.length
    ? `<section class="kpis">${doc.metrics.map((m) => `
      <div class="kpi"><span class="kpi-label">${escapeHtml(m.label)}</span><span class="kpi-value">${escapeHtml(m.value)}</span>${m.hint ? `<span class="kpi-hint">${escapeHtml(m.hint)}</span>` : ""}</div>`).join("")}
    </section>`
    : "";

  const sections = doc.sections.map((s) => {
    const numeric = new Set(s.numeric ?? []);
    const body = s.rows.length
      ? s.rows.map((row) => `<tr>${row.map((cell, i) => td(cell ?? "", numeric.has(i))).join("")}</tr>`).join("")
      : `<tr><td class="empty" colspan="${Math.max(1, s.columns.length)}">${escapeHtml(s.empty ?? "No records in this period")}</td></tr>`;
    return `<section class="block">
      <h2>${escapeHtml(s.title)}</h2>
      <table><thead><tr>${s.columns.map((c, i) => th(c, numeric.has(i))).join("")}</tr></thead><tbody>${body}</tbody></table>
    </section>`;
  }).join("");

  const notes = doc.notes.length
    ? `<section class="notes">${doc.notes.map((n) => `<p>${escapeHtml(n)}</p>`).join("")}</section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title)} — ${escapeHtml(doc.shop)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; color: #111827; background: #fff;
    font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 11px; line-height: 1.45; }
  header { display: flex; justify-content: space-between; align-items: flex-start;
    gap: 16px; padding-bottom: 12px; border-bottom: 2px solid #111827; }
  .shop { font-size: 13px; font-weight: 700; letter-spacing: .01em; }
  .brand { font-size: 10px; color: #6b7280; letter-spacing: .16em; text-transform: uppercase; }
  .meta { text-align: right; color: #4b5563; font-size: 10px; }
  h1 { font-size: 20px; line-height: 1.2; margin: 20px 0 4px; letter-spacing: -.01em; }
  .period { font-size: 12px; color: #374151; margin: 0 0 2px; }
  .source { font-size: 10px; color: #6b7280; margin: 0 0 18px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 8px; margin: 0 0 22px; page-break-inside: avoid; }
  .kpi { border: 1px solid #e5e7eb; border-radius: 4px; padding: 8px 10px; }
  .kpi-label { display: block; font-size: 9px; letter-spacing: .06em; text-transform: uppercase; color: #6b7280; }
  .kpi-value { display: block; font-size: 15px; font-weight: 700; margin-top: 3px; letter-spacing: -.01em;
    font-variant-numeric: tabular-nums; }
  .kpi-hint { display: block; font-size: 9px; color: #6b7280; margin-top: 2px; }
  .block { margin: 0 0 20px; page-break-inside: auto; }
  h2 { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #374151;
    margin: 0 0 6px; padding-bottom: 4px; border-bottom: 1px solid #d1d5db; }
  table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { text-align: left; font-size: 9px; letter-spacing: .05em; text-transform: uppercase;
    color: #6b7280; font-weight: 600; padding: 5px 6px; border-bottom: 1px solid #9ca3af; }
  td { padding: 5px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #f9fafb; }
  .r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .empty { color: #6b7280; font-style: italic; padding: 10px 6px; }
  .notes { margin-top: 24px; padding-top: 10px; border-top: 1px solid #d1d5db; color: #4b5563; font-size: 9px; }
  .notes p { margin: 0 0 3px; }
  footer { margin-top: 18px; font-size: 9px; color: #9ca3af; display: flex; justify-content: space-between; }
  @page { size: A4; margin: 12mm; }
  @media print {
    body { padding: 0; }
    .kpi { break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
  <header>
    <div><div class="shop">${escapeHtml(doc.shop)}</div><div class="brand">Idukaa · Shop management</div></div>
    <div class="meta">${escapeHtml(doc.generatedAt)}<br>${escapeHtml(doc.source)}</div>
  </header>
  <h1>${escapeHtml(doc.title)}</h1>
  <p class="period">${escapeHtml(doc.period)}</p>
  <p class="source">${escapeHtml(doc.source)}</p>
  ${metrics}
  ${sections}
  ${notes}
  <footer><span>Idukaa — generated from recorded shop data</span><span>${escapeHtml(doc.shop)}</span></footer>
</body>
</html>`;
}
