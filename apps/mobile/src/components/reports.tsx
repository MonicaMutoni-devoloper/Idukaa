import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { formatQty, formatRwf } from "@sms/shared";
import { useT } from "../localization";
import { space, type, useTheme } from "../theme/tokens";
import { BarList, CompareBars, ProductRanking, StockHealthBar, TrendBars } from "./charts";
import { Badge, Banner, Button, Card, DataTable, Empty, ErrorState, Field, Loading, Section, Segmented, Stat, type Col } from "./ui";
import type { LoadMeta, ReportCategory, SalesData, InventoryData, MovementsData, FinancialData, SummaryTotals } from "../services/report-data";
import {
  deltaOf, discountedSales, expenseBreakdown, expenseTotals, inventoryIssues, inventoryMetrics, movementGroup,
  movementMetrics, movementSeries, salesByCashier, salesByCategory, salesSeries, seriesOf, shortId,
  type MovementGroup, type MovementRow,
} from "../services/report-analytics";
import { bucketModeFor, periodRange } from "../services/report-period";
import type { ReportAdjustmentRow, ReportExpenseRow, ReportItemRow, ReportPurchaseRow, ReportSaleRow } from "../services/local-reports";
import {
  buildPrintHtml, csvFilename, dayText, instantText, moneyText, quantityText, toCsv,
  type PrintMetric, type PrintSection,
} from "../services/report-format";
import { deliverCsv, printReport } from "../services/report-delivery";

/**
 * The four Reports & Analytics workspaces and the landing page.
 *
 * Layout rules followed here:
 *  - the landing page is a directory, not a dashboard: the period, its status, a few real
 *    headline figures, then the four report categories and what was viewed recently;
 *  - a category owns its subsections, filters, chart, records and exports; switching subsections
 *    never loses the period or the category;
 *  - charts are only drawn from rows that are also in the table, and an empty period says so
 *    instead of drawing an axis with invented points;
 *  - a cost that is unknown is printed as "—", with one sentence saying why.
 */

const PAGE = 25;

const money = (n: number) => formatRwf(Math.round(n));
const qty = (n: number, unit: string) => `${formatQty(Math.round(n))} ${unit}`;

const bucketWord = (mode: "day" | "week" | "month") => `ana.bucket${mode === "day" ? "Day" : mode === "week" ? "Week" : "Month"}` as const;

/* ------------------------------------------------------------------ shared shell */

export function SourceCard({ meta, online, lastSync, onRefresh, pendingNote }: {
  meta: LoadMeta; online: boolean; lastSync: string | null; onRefresh: () => void; pendingNote?: boolean;
}) {
  const t = useT(); const c = useTheme();
  const label = meta.source === "server" ? t("reports.src.server") : meta.source === "cached" ? t("reports.src.cached") : meta.source === "device" ? t("reports.src.device") : t("reports.noData");
  return (
    <Card tone="muted" style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <Badge dot tone={online ? "ok" : "warn"} label={online ? t("sync.online") : t("sync.offline")} />
        <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700" }}>{label}</Text>
        {meta.pendingOps > 0 ? <Badge tone="warn" label={t("reports.pendingOps").replace("{n}", String(meta.pendingOps))} /> : null}
      </View>
      <Text style={{ color: c.muted, fontSize: 12 }}>{t("reports.lastSyncedAt").replace("{time}", lastSync ? new Date(lastSync).toLocaleString() : t("reports.never"))}</Text>
      {meta.source === "cached" && meta.savedAt ? <Text style={{ color: c.muted, fontSize: 12 }}>{t("reports.staleAt").replace("{time}", new Date(meta.savedAt).toLocaleString())}</Text> : null}
      {meta.source === "server" ? <Text testID="reports-cache-state" style={{ color: meta.savedLocally ? c.muted : c.danger, fontSize: 12 }}>
        {t(meta.savedLocally ? "reports.savedForOffline" : "reports.cacheFailed")}
      </Text> : null}
      {meta.source === "device" ? <Text style={{ color: c.muted, fontSize: 12 }}>{t("reports.deviceOnly")}</Text> : null}
      {pendingNote && meta.source === "server" && meta.pendingOps > 0 ? (
        <Text style={{ color: c.muted, fontSize: 12 }}>{t("reports.pendingNotIncluded").replace("{n}", String(meta.pendingOps))}</Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <Button kind="secondary" size="sm" label={t("reports.refresh")} onPress={onRefresh} disabled={!online} />
      </View>
    </Card>
  );
}

/** Previous / next for a result set that is already filtered, sorted and in memory. */
function Pager({ page, setPage, total }: { page: number; setPage: (n: number) => void; total: number }) {
  const t = useT(); const c = useTheme();
  if (total <= PAGE) return null;
  const pages = Math.ceil(total / PAGE);
  const from = page * PAGE + 1;
  const to = Math.min(total, (page + 1) * PAGE);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, flexWrap: "wrap" }}>
      <Text style={{ color: c.muted, fontSize: 12 }}>
        {t("ana.showing").replace("{from}", String(from)).replace("{to}", String(to)).replace("{n}", String(total))}
        {" · "}
        {t("ana.pageOf").replace("{page}", String(page + 1)).replace("{pages}", String(pages))}
      </Text>
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <Button kind="secondary" size="sm" label={t("ana.prev")} disabled={page === 0} onPress={() => setPage(Math.max(0, page - 1))} />
        <Button kind="secondary" size="sm" label={t("ana.next")} disabled={page >= pages - 1} onPress={() => setPage(Math.min(pages - 1, page + 1))} />
      </View>
    </View>
  );
}

interface ExportSpec {
  title: string; header: string[]; rows: (string | number | null)[][];
  metrics?: PrintMetric[]; notes?: string[];
}

function ExportBar({ spec, from, to, source, shop, filename }: {
  spec: ExportSpec | null; from: string; to: string; source: LoadMeta["source"]; shop: string; filename: string;
}) {
  const t = useT(); const c = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localOnly = source !== "server";
  const notes = [
    ...(localOnly ? [t("ana.exportLocal")] : []),
    ...(spec?.notes ?? []),
  ];
  const run = async (kind: "csv" | "pdf") => {
    if (!spec) return;
    setBusy(true); setError(null);
    try {
      if (kind === "csv") {
        await deliverCsv(csvFilename([filename], dayText(from)), toCsv(spec.header, spec.rows));
      } else {
        const doc = buildPrintHtml({
          shop,
          title: spec.title,
          period: `${dayText(from)} – ${dayText(new Date(Date.parse(to) - 1).toISOString())}`,
          source: source === "server" ? t("reports.src.server") : source === "cached" ? t("reports.src.cached") : t("reports.src.device"),
          metrics: spec.metrics ?? [],
          sections: [{ title: spec.title, columns: spec.header, rows: spec.rows.map((r) => r.map((v) => (v === null || v === undefined ? "—" : String(v)))), empty: t("ana.noRecords") }],
          notes,
          generatedAt: t("ana.generated").replace("{time}", new Date().toLocaleString()),
        });
        await printReport(doc);
      }
    } catch {
      setError(t("ana.exportFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card style={{ gap: space.sm }}>
      <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("ana.export")}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <Button testID="reports-export" kind="secondary" size="sm" label={t("ana.exportCsv")} loading={busy} disabled={!spec?.rows.length} onPress={() => void run("csv")} />
        <Button kind="secondary" size="sm" label={t("ana.exportPdf")} disabled={!spec?.rows.length} onPress={() => void run("pdf")} />
        <Button kind="quiet" size="sm" label={t("ana.print")} disabled={!spec?.rows.length} onPress={() => void run("pdf")} />
      </View>
      <Text style={{ color: c.muted, fontSize: 11 }}>{t("ana.exportHint")} {t("ana.printPdfHint")}</Text>
      {localOnly ? <Text style={{ color: c.muted, fontSize: 11 }}>{t("ana.exportLocal")}</Text> : null}
      {error ? <Text style={{ color: c.danger, fontSize: 12 }}>{error}</Text> : null}
    </Card>
  );
}

function TableBlock({ cols, rows, empty, onRow, rowTestID }: {
  cols: Col<any>[]; rows: any[]; empty?: string; onRow?: (r: any) => void; rowTestID?: (r: any) => string;
}) {
  const t = useT();
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [rows.length, cols.length]);
  const start = page * PAGE;
  return (
    <>
      <DataTable rows={rows.slice(start, start + PAGE)} cols={cols} onRow={onRow} rowTestID={rowTestID}
        empty={<Card tone="muted"><Empty icon="chart" title={t("ana.noRecords")} description={empty ?? t("ana.noRecordsDesc")} /></Card>} />
      <Pager page={page} setPage={setPage} total={rows.length} />
    </>
  );
}

function FilterField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const t = useT();
  return <Field label={t("common.search")} value={value} onChangeText={onChange} placeholder={placeholder ?? t("ana.searchPlaceholder")} autoCorrect={false} />;
}

function ComparisonLine({ label, current, previous }: { label: string; current: number; previous: number }) {
  const t = useT(); const c = useTheme();
  const d = deltaOf(current, previous);
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <Text style={{ color: c.muted, fontSize: 13 }}>{label}</Text>
      <Text style={{ color: d.change >= 0 ? c.success : c.danger, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
        {d.change >= 0 ? "+" : ""}{money(d.change)}{d.pct === null ? ` · ${t("ana.noPrior")}` : ` · ${d.pct >= 0 ? "+" : ""}${d.pct}%`}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ landing */

export function ReportsLanding({ from, to, online, lastSync, sales, salesMeta, inventory, inventoryMeta, recent, onOpen, onRefresh }: {
  from: string; to: string; online: boolean; lastSync: string | null;
  sales: SalesData | null; salesMeta: LoadMeta; inventory: InventoryData | null; inventoryMeta: LoadMeta;
  recent: ReportCategory[]; onOpen: (c: ReportCategory) => void; onRefresh: () => void;
}) {
  const t = useT(); const c = useTheme();
  const stock = inventory ? inventoryMetrics(inventory.items) : null;
  const categories: { key: ReportCategory; desc: string }[] = [
    { key: "inventory", desc: t("ana.cat.inventoryDesc") },
    { key: "movements", desc: t("ana.cat.movementsDesc") },
    { key: "sales", desc: t("ana.cat.salesDesc") },
    { key: "financial", desc: t("ana.cat.financialDesc") },
  ];
  return (
    <>
      <SourceCard meta={salesMeta} online={online} lastSync={lastSync} onRefresh={onRefresh} />
      <Section title={t("ana.overview")} description={t("ana.overviewHint")}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          <Stat emphasis label={t("ana.netSalesPeriod")} value={sales ? money(sales.totals.net) : "—"}
            footnote={sales ? `${sales.totals.transactions} ${t("ana.metric.transactions").toLowerCase()} · ${formatQty(sales.totals.units)} ${t("ana.metric.units").toLowerCase()}` : t("ana.noRecords")} />
          <Stat label={t("ana.metric.avgSale")} value={sales ? money(sales.totals.averageSale) : "—"} footnote={t("reports.netNote")} />
          <Stat label={t("ana.metric.products")} value={stock ? String(stock.products) : "—"}
            footnote={stock ? `${t("ana.lowStockN").replace("{n}", String(stock.low))} · ${t("ana.outOfStockN").replace("{n}", String(stock.out))}` : t("ana.stockSummary")} />
          <Stat label={t("ana.metric.value")} value={stock?.value !== null && stock?.value !== undefined ? money(stock.value) : "—"} footnote={t("ana.valueNote")} />
        </View>
      </Section>

      <Section title={t("ana.reports")} description={t("ana.reportsHint")}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          {categories.map((cat) => (
            <Pressable key={cat.key} accessibilityRole="button" accessibilityLabel={t("ana.open").replace("{name}", t(`ana.cat.${cat.key}` as any))}
              testID={`report-open-${cat.key}`} onPress={() => onOpen(cat.key)} style={{ flexGrow: 1, flexBasis: 240, minWidth: 220 }}>
              <Card style={{ gap: 6, minHeight: 108 }}>
                <Text style={{ color: c.ink, ...type.h2 }}>{t(`ana.cat.${cat.key}` as any)}</Text>
                <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18, flexGrow: 1 }}>{cat.desc}</Text>
                <Text style={{ color: c.primary, fontSize: 12, fontWeight: "700" }}>→</Text>
              </Card>
            </Pressable>
          ))}
        </View>
      </Section>

      <Section title={t("ana.recent")}>
        {recent.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {recent.map((r) => (
              <Button key={r} kind="secondary" size="sm" label={t(`ana.cat.${r}` as any)} onPress={() => onOpen(r)} />
            ))}
          </View>
        ) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("ana.recentEmpty")}</Text>}
      </Section>

      <Text style={{ color: c.muted, fontSize: 12 }}>{t("ana.periodNote")} {t("reports.explanation")}</Text>
    </>
  );
}

/* ------------------------------------------------------------------ inventory */

type InventoryView = "overview" | "levels" | "low" | "out" | "valuation" | "issues";

export function InventoryReport({ data, meta, online, lastSync, from, to, view, setView, onBack, onRetry, shop }: {
  data: InventoryData | null; meta: LoadMeta; online: boolean; lastSync: string | null; from: string; to: string;
  view: InventoryView; setView: (v: InventoryView) => void; onBack: () => void; onRetry: () => void; shop: string;
}) {
  const t = useT(); const c = useTheme();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [stockFilter, setStockFilter] = useState<"all" | "low" | "out">("all");

  const items = data?.items ?? [];
  const cats = useMemo(() => [...new Set(items.map((i) => i.category).filter(Boolean) as string[])].sort(), [items]);
  const rows = useMemo(() => {
    let list = items;
    if (view === "low") list = list.filter((i) => i.onHand > 0 && i.low);
    if (view === "out") list = list.filter((i) => i.onHand <= 0);
    if (view === "issues") list = inventoryIssues(list);
    if (stockFilter === "low") list = list.filter((i) => i.onHand > 0 && i.low);
    if (stockFilter === "out") list = list.filter((i) => i.onHand <= 0);
    if (category !== "all") list = list.filter((i) => (i.category ?? "") === category);
    const needle = query.trim().toLowerCase();
    if (needle) list = list.filter((i) => `${i.name} ${i.code}`.toLowerCase().includes(needle));
    return view === "valuation" ? [...list].sort((a, b) => (b.value ?? -1) - (a.value ?? -1)) : list;
  }, [items, view, category, stockFilter, query]);
  const m = inventoryMetrics(items);

  const cols: Col<any>[] = [
    { key: "name", title: t("common.product"), width: 2, render: (r) => (
      <View><Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{r.name}</Text><Text style={{ color: c.muted, fontSize: 11 }}>{r.code}{r.category ? ` · ${r.category}` : ""}</Text></View>
    ) },
    { key: "onHand", title: t("ana.onHand"), align: "right", render: (r) => (
      <Text style={{ color: r.onHand < 0 ? c.danger : c.ink, fontSize: 13, fontVariant: ["tabular-nums"] }}>{qty(r.onHand, r.unit)}</Text>
    ) },
    { key: "threshold", title: t("ana.threshold"), align: "right", render: (r) => <Text style={{ color: c.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{qty(r.threshold, r.unit)}</Text> },
    { key: "status", title: t("common.status"), render: (r) => r.onHand <= 0
      ? <Badge tone="danger" label={t("ana.sub.inventory.out")} />
      : r.low ? <Badge tone="warn" label={t("ana.sub.inventory.low")} /> : <Badge tone="ok" label={t("common.active")} /> },
    { key: "value", title: t("ana.value"), align: "right", render: (r) => <Text style={{ color: c.ink, fontSize: 13, fontVariant: ["tabular-nums"] }}>{r.value === null ? "—" : money(r.value)}</Text> },
  ];

  const spec: ExportSpec = {
    title: `${t(`ana.cat.inventory` as any)} · ${t(`ana.sub.inventory.${view}` as any)}`,
    header: [t("common.product"), t("stock.code"), t("ana.category"), t("ana.onHand"), t("ana.threshold"), t("ana.value")],
    rows: rows.map((r) => [r.name, r.code, r.category ?? "—", quantityText(r.onHand, r.unit), quantityText(r.threshold, r.unit), r.value === null ? "" : r.value]),
    metrics: [
      { label: t("ana.metric.products"), value: String(m.products) },
      { label: t("ana.metric.low"), value: String(m.low) },
      { label: t("ana.metric.out"), value: String(m.out) },
      { label: t("ana.metric.value"), value: m.value === null ? t("ana.costUnavailable") : money(m.value) },
    ],
    notes: [t("ana.inventoryNote"), t("ana.unitsSeparated")],
  };

  if (meta.failed && !data) return <ErrorState onRetry={onRetry} text={t(meta.authIssue ? "reports.sessionExpired" : "reports.noData")} />;

  return (
    <>
      <WorkspaceHeader category="inventory" onBack={onBack} />
      <SourceCard meta={meta} online={online} lastSync={lastSync} onRefresh={onRetry} />
      <Segmented<InventoryView> value={view} onChange={setView} options={[
        { value: "overview", label: t("ana.sub.inventory.overview") }, { value: "levels", label: t("ana.sub.inventory.levels") },
        { value: "low", label: t("ana.sub.inventory.low") }, { value: "out", label: t("ana.sub.inventory.out") },
        { value: "valuation", label: t("ana.sub.inventory.valuation") }, { value: "issues", label: t("ana.sub.inventory.issues") },
      ]} />
      {!data ? <Loading /> : view === "overview" ? (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
            <Stat label={t("ana.metric.products")} value={String(m.products)} />
            <Stat label={t("ana.sub.inventory.low")} value={String(m.low)} />
            <Stat label={t("ana.sub.inventory.out")} value={String(m.out)} />
            <Stat label={t("ana.metric.value")} value={m.value === null ? "—" : money(m.value)} footnote={m.value === null ? t("ana.valueNote") : undefined} />
          </View>
          <Card style={{ gap: space.sm }}>
            <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("ana.stockSummary")}</Text>
            <StockHealthBar label={t("ana.stockSummary")} inStock={Math.max(0, m.products - m.low - m.out)} low={m.low} out={m.out} />
            <Text style={{ color: c.muted, fontSize: 11 }}>{t("ana.inventoryNote")}</Text>
          </Card>
          <Card style={{ gap: space.sm }}>
            <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("ana.metric.units")}</Text>
            <BarList items={m.byUnit.map((u) => ({ key: u.unit, label: u.unit, value: u.qty }))} emptyLabel={t("ana.noRecords")} format={(n) => formatQty(Math.round(n))} />
            <Text style={{ color: c.muted, fontSize: 11 }}>{t("ana.unitsSeparated")}</Text>
          </Card>
        </>
      ) : (
        <>
          <Card style={{ gap: space.sm }}>
            <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("ana.filters")}</Text>
            <FilterField value={query} onChange={setQuery} />
            <Text style={{ color: c.muted, fontSize: 11 }}>{t("ana.category")}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              <Button size="sm" kind={category === "all" ? "primary" : "secondary"} label={t("common.all")} onPress={() => setCategory("all")} />
              {cats.map((cat) => <Button key={cat} size="sm" kind={category === cat ? "primary" : "secondary"} label={cat} onPress={() => setCategory(cat)} />)}
            </View>
            <Text style={{ color: c.muted, fontSize: 11 }}>{t("common.status")}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              <Button size="sm" kind={stockFilter === "all" ? "primary" : "secondary"} label={t("common.all")} onPress={() => setStockFilter("all")} />
              <Button size="sm" kind={stockFilter === "low" ? "primary" : "secondary"} label={t("ana.sub.inventory.low")} onPress={() => setStockFilter("low")} />
              <Button size="sm" kind={stockFilter === "out" ? "primary" : "secondary"} label={t("ana.sub.inventory.out")} onPress={() => setStockFilter("out")} />
            </View>
          </Card>
          {view === "valuation" || view === "issues" ? (
            <Text style={{ color: c.muted, fontSize: 12 }}>{t("ana.valueNote")}</Text>
          ) : null}
          <TableBlock cols={cols} rows={rows} />
        </>
      )}
      {data ? <ExportBar spec={spec} from={from} to={to} source={meta.source} shop={shop} filename={`inventory-${view}`} /> : null}
      <Text style={{ color: c.muted, fontSize: 12 }}>{t("ana.periodNote")}</Text>
    </>
  );
}

/* ------------------------------------------------------------------ movements */

type MovementView = "all" | "received" | "sold" | "loss" | "adjust";

const movementMatch = (r: MovementRow, view: MovementView) => view === "all" || ({
  received: "in", sold: "sold", loss: "loss", adjust: "adjust",
} as Record<Exclude<MovementView, "all">, MovementGroup>)[view] === movementGroup(r.type);

export function MovementsReport({ data, meta, online, lastSync, from, to, view, setView, onBack, onRetry, shop }: {
  data: MovementsData | null; meta: LoadMeta; online: boolean; lastSync: string | null; from: string; to: string;
  view: MovementView; setView: (v: MovementView) => void; onBack: () => void; onRetry: () => void; shop: string;
}) {
  const t = useT(); const c = useTheme();
  const [query, setQuery] = useState("");
  const mode = bucketModeFor(from, to);
  const items = data?.items ?? [];
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((r) => movementMatch(r, view) && (!needle || `${r.product} ${r.code} ${r.reference ?? ""} ${r.by ?? ""}`.toLowerCase().includes(needle)));
  }, [items, view, query]);
  const m = movementMetrics(items);
  const series = useMemo(() => movementSeries(items, from, to, mode).map((p) => ({ date: p.date, a: p.received, b: p.sold })), [items, from, to, mode]);

  const groupCount = (g: MovementGroup) => items.filter((r) => movementGroup(r.type) === g).length;
  const cols: Col<any>[] = [
    { key: "at", title: t("common.date"), width: 1.4, render: (r) => <Text style={{ color: c.inkSoft, fontSize: 12 }}>{instantText(r.at)}</Text> },
    { key: "product", title: t("common.product"), width: 2, render: (r) => (
      <View><Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{r.product}</Text><Text style={{ color: c.muted, fontSize: 11 }}>{r.code}</Text></View>
    ) },
    { key: "type", title: t("ana.type"), render: (r) => (
      <View style={{ gap: 2 }}>
        <Badge tone={movementGroup(r.type) === "loss" ? "danger" : movementGroup(r.type) === "in" ? "ok" : "neutral"} label={t(`ana.move.${r.type}` as any)} />
        {r.local ? <Text style={{ color: c.muted, fontSize: 10 }}>{t("reports.pending")}</Text> : null}
      </View>
    ) },
    { key: "qty", title: t("ana.qty"), align: "right", render: (r) => <Text style={{ color: r.qty < 0 ? c.danger : c.ink, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{formatQty(Math.abs(r.qty))} {r.unit}</Text> },
    { key: "balanceAfter", title: t("ana.balance"), align: "right", render: (r) => <Text style={{ color: c.inkSoft, fontSize: 12, fontVariant: ["tabular-nums"] }}>{r.balanceAfter === null ? "—" : qty(r.balanceAfter, r.unit)}</Text> },
    { key: "unitCost", title: t("ana.unitCost"), align: "right", render: (r) => <Text style={{ color: c.ink, fontSize: 12, fontVariant: ["tabular-nums"] }}>{r.unitCost === null ? "—" : money(r.unitCost)}</Text> },
    { key: "reference", title: t("ana.reference"), render: (r) => <Text style={{ color: c.muted, fontSize: 11 }}>{r.reference ? shortId(r.reference) : "—"}</Text> },
    { key: "by", title: t("ana.by"), render: (r) => <Text style={{ color: c.muted, fontSize: 11 }}>{r.by ?? "—"}</Text> },
  ];

  const spec: ExportSpec = {
    title: `${t("ana.cat.movements" as any)} · ${t(`ana.sub.movements.${view === "adjust" ? "adjust" : view}` as any)}`,
    header: [t("common.date"), t("common.product"), t("stock.code"), t("ana.type"), t("ana.qty"), t("ana.balance"), t("ana.unitCost"), t("ana.reference"), t("ana.by")],
    rows: rows.map((r) => [
      instantText(r.at), r.product, r.code, t(`ana.move.${r.type}` as any), `${formatQty(r.qty)} ${r.unit}`,
      r.balanceAfter === null ? "" : `${formatQty(r.balanceAfter)} ${r.unit}`, r.unitCost === null ? "" : r.unitCost, r.reference ?? "", r.by ?? "",
    ]),
    metrics: [
      { label: t("ana.metric.count"), value: String(m.count) },
      { label: t("ana.metric.inQty"), value: String(groupCount("in")) },
      { label: t("ana.metric.soldQty"), value: String(groupCount("sold")) },
      { label: t("ana.metric.lossQty"), value: String(groupCount("loss")) },
    ],
    notes: [t("ana.balanceNote"), t("ana.lossCostNote")],
  };

  if (meta.failed && !data) return <ErrorState onRetry={onRetry} text={t(meta.authIssue ? "reports.sessionExpired" : "reports.noData")} />;

  return (
    <>
      <WorkspaceHeader category="movements" onBack={onBack} />
      <SourceCard meta={meta} online={online} lastSync={lastSync} onRefresh={onRetry} />
      <Segmented<MovementView> value={view} onChange={setView} options={[
        { value: "all", label: t("ana.sub.movements.all") }, { value: "received", label: t("ana.sub.movements.received") },
        { value: "sold", label: t("ana.sub.movements.sold") }, { value: "loss", label: t("ana.sub.movements.loss") },
        { value: "adjust", label: t("ana.sub.movements.adjust") },
      ]} />
      {!data ? <Loading /> : (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
            <Stat label={t("ana.metric.count")} value={String(m.count)} />
            <Stat label={t("ana.metric.inQty")} value={String(groupCount("in"))} />
            <Stat label={t("ana.metric.soldQty")} value={String(groupCount("sold"))} />
            <Stat label={t("ana.metric.lossQty")} value={String(groupCount("loss"))} />
            <Stat label={t("ana.metric.loss")} value={m.lossValue === null ? "—" : money(m.lossValue)} footnote={m.lossValue === null ? t("ana.costUnavailable") : undefined} />
          </View>
          {items.length ? (
            <Card style={{ gap: space.sm }}>
              <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("ana.chartMovement").replace("{bucket}", t(bucketWord(mode)))}</Text>
              <CompareBars data={series} labelA={t("ana.metric.inQty")} labelB={t("ana.metric.soldQty")} format={(n) => String(Math.round(n))} labelMode={mode === "month" ? "month" : "day"} />
              <Text style={{ color: c.muted, fontSize: 11 }}>{t("ana.records")}</Text>
            </Card>
          ) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("ana.noChart")}</Text>}
          {data.truncated ? <Banner tone="warn" text={t("ana.truncated")} /> : null}
          {meta.source === "device" ? <Banner tone="warn" text={t("ana.inventoryNote")} /> : null}
          <FilterField value={query} onChange={setQuery} />
          <TableBlock cols={cols} rows={rows} />
          <ExportBar spec={spec} from={from} to={to} source={meta.source} shop={shop} filename={`movements-${view}`} />
        </>
      )}
      <Text style={{ color: c.muted, fontSize: 12 }}>{t("ana.periodNote")}</Text>
    </>
  );
}

/* ------------------------------------------------------------------ sales */

type SalesView = "overview" | "product" | "category" | "cashier" | "trends" | "discounts" | "transactions";

export function SalesReport({ data, meta, online, lastSync, from, to, view, setView, onBack, onRetry, shop, onOpenSale }: {
  data: SalesData | null; meta: LoadMeta; online: boolean; lastSync: string | null; from: string; to: string;
  view: SalesView; setView: (v: SalesView) => void; onBack: () => void; onRetry: () => void; shop: string;
  onOpenSale: (id: string) => void;
}) {
  const t = useT(); const c = useTheme();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "posted" | "reversed">("all");
  const mode = bucketModeFor(from, to);
  const sales = data?.sales ?? [];
  const items = data?.items ?? [];
  const totals = data?.totals;

  const filteredSales = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sales.filter((s) => (status === "all" || s.status === status)
      && (!needle || `${s.id} ${s.products} ${s.by ?? ""}`.toLowerCase().includes(needle)));
  }, [sales, status, query]);
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((i) => (!needle || `${i.name} ${i.code}`.toLowerCase().includes(needle)));
  }, [items, query]);
  const cashiers = useMemo(() => salesByCashier(sales), [sales]);
  const catTotals = useMemo(() => salesByCategory(items, (id) => items.find((i) => i.productId === id)?.category ?? null), [items]);
  const discounts = useMemo(() => discountedSales(sales), [sales]);
  const trend = useMemo(() => salesSeries(sales, from, to, mode), [sales, from, to, mode]);

  const saleCols: Col<any>[] = [
    { key: "at", title: t("common.date"), width: 1.4, render: (r) => <Text style={{ color: c.inkSoft, fontSize: 12 }}>{instantText(r.at)}</Text> },
    { key: "ref", title: t("reports.saleReceipt"), width: 1, render: (r) => <Text style={{ color: c.inkSoft, fontSize: 12, fontVariant: ["tabular-nums"] }}>{shortId(r.id)}</Text> },
    { key: "products", title: t("common.product"), width: 1.8, render: (r) => <Text numberOfLines={2} style={{ color: c.inkSoft, fontSize: 12 }}>{r.products || "—"}</Text> },
    { key: "by", title: t("ana.cashier"), width: 1.1 },
    { key: "gross_amount", title: t("common.total"), align: "right", render: (r) => <Text style={{ color: c.ink, fontSize: 13, fontVariant: ["tabular-nums"] }}>{money(r.gross_amount)}</Text> },
    { key: "discount", title: t("common.discount"), align: "right", render: (r) => <Text style={{ color: c.muted, fontSize: 13, fontVariant: ["tabular-nums"] }}>{money(r.discount)}</Text> },
    { key: "amount_paid", title: t("common.paid"), align: "right", render: (r) => <Text style={{ color: c.inkSoft, fontSize: 13, fontVariant: ["tabular-nums"] }}>{money(r.amount_paid)}</Text> },
    { key: "status", title: t("common.status"), render: (r) => <Badge tone={r.status === "reversed" ? "danger" : "ok"} label={t(r.status === "reversed" ? "reports.reversed" : "reports.posted")} /> },
  ];
  const itemCols: Col<any>[] = [
    { key: "name", title: t("common.product"), width: 2.2, render: (r) => (
      <View><Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{r.name}</Text><Text style={{ color: c.muted, fontSize: 11 }}>{r.code}{r.local ? " · " + t("ana.records") : ""}</Text></View>
    ) },
    { key: "units", title: t("ana.metric.units"), align: "right", render: (r) => <Text style={{ color: c.ink, fontSize: 13, fontVariant: ["tabular-nums"] }}>{qty(r.units, r.unit)}</Text> },
    { key: "avgUnitPrice", title: t("reports.avgPrice"), align: "right", render: (r) => <Text style={{ color: c.inkSoft, fontSize: 13, fontVariant: ["tabular-nums"] }}>{money(r.avgUnitPrice)}</Text> },
    { key: "sales", title: t("dash.transactions"), align: "right" },
    { key: "gross", title: t("reports.lineAmount"), align: "right", render: (r) => <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{money(r.gross)}</Text> },
  ];

  const exportSales: ExportSpec = {
    title: `${t("ana.cat.sales" as any)} · ${t("ana.sub.sales.transactions")}`,
    header: [t("common.date"), t("reports.saleReceipt"), t("common.product"), t("ana.cashier"), t("common.total"), t("common.discount"), t("common.paid"), t("common.status")],
    rows: filteredSales.map((r) => [instantText(r.at), r.id, r.products, r.by ?? "", r.gross_amount, r.discount, r.amount_paid, r.status]),
    metrics: [
      { label: t("ana.metric.net"), value: totals ? money(totals.net) : "" },
      { label: t("ana.metric.transactions"), value: totals ? String(totals.transactions) : "" },
      { label: t("ana.metric.unitsSold"), value: totals ? formatQty(totals.units) : "" },
    ],
    notes: [t("reports.explanation")],
  };
  const exportItems: ExportSpec = {
    title: `${t("ana.cat.sales" as any)} · ${t("ana.sub.sales.byProduct")}`,
    header: [t("common.product"), "Code", t("ana.metric.units"), t("reports.avgPrice"), t("dash.transactions"), t("reports.lineAmount")],
    rows: filteredItems.map((r) => [r.name, r.code, `${formatQty(r.units)} ${r.unit}`, r.avgUnitPrice, r.sales, r.gross]),
    notes: [t("reports.itemsNote")],
  };
  const exportCashier: ExportSpec = {
    title: `${t("ana.cat.sales" as any)} · ${t("ana.sub.sales.byCashier")}`,
    header: [t("ana.cashier"), t("ana.metric.net"), t("ana.metric.transactions"), t("ana.metric.units")],
    rows: cashiers.map((r) => [r.label, r.net, r.transactions, formatQty(r.units)]),
  };
  const exportCategories: ExportSpec = {
    title: `${t("ana.cat.sales" as any)} · ${t("ana.sub.sales.byCategory")}`,
    header: [t("ana.category"), t("ana.metric.products"), t("ana.metric.units"), t("reports.lineAmount")],
    rows: catTotals.map((r) => [r.label, r.products, formatQty(r.units), r.gross]),
    notes: [t("ana.unitsSeparated")],
  };
  const exportDiscounts: ExportSpec = {
    title: `${t("ana.cat.sales" as any)} · ${t("ana.sub.sales.discounts")}`,
    header: [t("common.date"), t("reports.saleReceipt"), t("common.product"), t("ana.cashier"), t("common.total"), t("common.discount")],
    rows: discounts.map((r) => [instantText(r.at), r.id, r.products, r.by ?? "", r.gross_amount, r.discount]),
  };
  const exportTrend: ExportSpec = {
    title: `${t("ana.cat.sales" as any)} · ${t("ana.sub.sales.trends")}`,
    header: [t("common.date"), t("ana.metric.net"), t("ana.metric.transactions")],
    rows: trend.map((p) => [p.date, p.netSales, p.transactions]),
  };

  const spec = view === "transactions" ? exportSales : view === "product" ? exportItems : view === "cashier" ? exportCashier
    : view === "category" ? exportCategories : view === "discounts" ? exportDiscounts : exportTrend;

  if (meta.failed && !data) return <ErrorState onRetry={onRetry} text={t(meta.authIssue ? "reports.sessionExpired" : "reports.noData")} />;

  return (
    <>
      <WorkspaceHeader category="sales" onBack={onBack} />
      <SourceCard meta={meta} online={online} lastSync={lastSync} onRefresh={onRetry} />
      <Segmented<SalesView> value={view} onChange={setView} options={[
        { value: "overview", label: t("ana.sub.sales.overview") }, { value: "product", label: t("ana.sub.sales.byProduct") },
        { value: "category", label: t("ana.sub.sales.byCategory") }, { value: "cashier", label: t("ana.sub.sales.byCashier") },
        { value: "trends", label: t("ana.sub.sales.trends") }, { value: "discounts", label: t("ana.sub.sales.discounts") },
        { value: "transactions", label: t("ana.sub.sales.transactions") },
      ]} />
      {!data ? <Loading /> : (
        <>
          {view === "overview" ? (
            <>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
                <Stat emphasis label={t("ana.metric.net")} value={money(totals!.net)} footnote={`${totals!.transactions} ${t("ana.metric.transactions").toLowerCase()}`} />
                <Stat label={t("ana.metric.gross")} value={money(totals!.gross)} />
                <Stat label={t("ana.metric.discounts")} value={money(totals!.discounts)} />
                <Stat label={t("ana.metric.avgSale")} value={money(totals!.averageSale)} />
                <Stat label={t("ana.metric.unitsSold")} value={formatQty(totals!.units)} />
                <Stat label={t("ana.metric.products")} value={String(totals!.products)} />
              </View>
              <Card style={{ gap: space.sm }}>
                <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("ana.chartSales").replace("{bucket}", t(bucketWord(mode)))}</Text>
                <TrendBars data={trend} label={t("ana.metric.transactions")} labelMode={mode === "month" ? "month" : "day"} />
              </Card>
              <Card style={{ gap: space.sm }}>
                <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("ana.sub.sales.byProduct")}</Text>
                <ProductRanking items={filteredItems.slice(0, 6).map((i) => ({ id: i.productId, name: i.name, qty: i.units, netSales: i.gross }))} emptyLabel={t("ana.noRecords")} />
              </Card>
            </>
          ) : null}

          {view === "trends" ? (
            <Card style={{ gap: space.sm }}>
              <TrendBars data={trend} label={t("ana.metric.transactions")} labelMode={mode === "month" ? "month" : "day"} />
            </Card>
          ) : null}

          {view === "cashier" ? (
            <>
              <Card style={{ gap: space.sm }}>
                <BarList items={cashiers.map((r) => ({ key: r.key, label: r.label, value: r.net }))} emptyLabel={t("ana.noRecords")} />
              </Card>
              <TableBlock cols={[
                { key: "label", title: t("ana.cashier") },
                { key: "net", title: t("ana.metric.net"), align: "right", render: (r) => <Text style={{ color: c.ink, fontSize: 13, fontVariant: ["tabular-nums"] }}>{money(r.net)}</Text> },
                { key: "transactions", title: t("ana.metric.transactions"), align: "right" },
                { key: "units", title: t("ana.metric.units"), align: "right", render: (r) => formatQty(r.units) },
              ] as Col<any>[]} rows={cashiers} />
            </>
          ) : null}

          {view === "category" ? (
            <>
              <Card style={{ gap: space.sm }}>
                <BarList items={catTotals.map((r) => ({ key: r.key, label: r.label, value: r.gross }))} emptyLabel={t("ana.noRecords")} />
              </Card>
              <TableBlock cols={[
                { key: "label", title: t("ana.category") },
                { key: "products", title: t("ana.metric.products"), align: "right" },
                { key: "units", title: t("ana.metric.units"), align: "right", render: (r) => formatQty(r.units) },
                { key: "gross", title: t("reports.lineAmount"), align: "right", render: (r) => <Text style={{ color: c.ink, fontSize: 13, fontVariant: ["tabular-nums"] }}>{money(r.gross)}</Text> },
              ] as Col<any>[]} rows={catTotals} />
            </>
          ) : null}

          {view === "discounts" ? (
            <>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
                <Stat label={t("ana.metric.discounts")} value={money(discounts.reduce((s, r) => s + r.discount, 0))} />
                <Stat label={t("ana.metric.transactions")} value={String(discounts.length)} />
              </View>
              <TableBlock cols={saleCols} rows={discounts} onRow={(r) => onOpenSale(r.id)} />
            </>
          ) : null}

          {view === "product" ? (
            <>
              <FilterField value={query} onChange={setQuery} />
              <TableBlock cols={itemCols} rows={filteredItems} />
            </>
          ) : null}

          {view === "transactions" ? (
            <>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, alignItems: "center" }}>
                <Segmented<"all" | "posted" | "reversed"> value={status} onChange={setStatus} options={[
                  { value: "all", label: t("common.all") }, { value: "posted", label: t("reports.posted") }, { value: "reversed", label: t("reports.reversed") },
                ]} />
                <Text style={{ color: c.muted, fontSize: 12 }}>{t("reports.tapForLines")}</Text>
              </View>
              <FilterField value={query} onChange={setQuery} />
              <TableBlock cols={saleCols} rows={filteredSales} onRow={(r) => onOpenSale(r.id)} rowTestID={(r) => `sale-open-${r.id}`} />
            </>
          ) : null}

          <ExportBar spec={spec} from={from} to={to} source={meta.source} shop={shop} filename={`sales-${view}`} />
        </>
      )}
      <Text style={{ color: c.muted, fontSize: 12 }}>{t("ana.periodNote")}</Text>
    </>
  );
}

/* ------------------------------------------------------------------ financial */

type FinancialView = "pnl" | "revenue" | "cogs" | "gross" | "expenses" | "net" | "breakdown" | "trends";
/** The two deliberately separate financial bases. They are never added together in one figure. */
type FinancialBasis = "server" | "local";

export function FinancialReport({ data, meta, online, lastSync, from, to, view, setView, onBack, onRetry, shop, financialsAllowed }: {
  data: FinancialData | null; meta: LoadMeta; online: boolean; lastSync: string | null; from: string; to: string;
  view: FinancialView; setView: (v: FinancialView) => void; onBack: () => void; onRetry: () => void; shop: string;
  financialsAllowed: boolean;
}) {
  const t = useT(); const c = useTheme();
  const [query, setQuery] = useState("");
  const [basis, setBasis] = useState<FinancialBasis>("server");
  const mode = bucketModeFor(from, to);
  const summary = data?.summary ?? null;
  const localSummaryData = data?.localSummary ?? null;
  // "server" means server-confirmed. "local" is this device's complete operational ledger.
  // A basis with no data is never selected silently: the other one is used and labelled.
  const basisValue: FinancialBasis = basis === "local" && localSummaryData ? "local" : summary ? "server" : "local";
  const usingLocal = basisValue === "local";
  const active = usingLocal ? localSummaryData : summary;
  const cur: SummaryTotals | null = active?.current ?? null;
  const prev = active?.previous ?? null;
  const expenses = usingLocal ? (data?.localExpenses ?? []) : (data?.expenses ?? []);
  const activeSales = usingLocal ? (data?.localSales ?? []) : (data?.sales ?? []);
  const pending = data?.pending ?? null;
  const breakdown = useMemo(() => expenseBreakdown(expenses), [expenses]);
  const eTotals = expenseTotals(expenses);
  const revenueSeries = useMemo(() => seriesOf(activeSales, from, to, mode, (r) => r.at, (r) => (r.status === "reversed" ? 0 : r.gross_amount - r.discount)), [activeSales, from, to, mode]);
  const expenseSeries = useMemo(() => seriesOf(expenses, from, to, mode, (r) => r.at, (r) => r.amount), [expenses, from, to, mode]);
  const compareSeries = revenueSeries.map((p, i) => ({ date: p.date, a: p.value, b: expenseSeries[i]?.value ?? 0 }));

  if (!financialsAllowed) {
    return (
      <>
        <WorkspaceHeader category="financial" onBack={onBack} />
        <Card tone="warn" style={{ gap: space.sm }}>
          <Text style={{ color: c.ink, ...type.h2 }}>{t("ana.lockedTitle")}</Text>
          <Text style={{ color: c.muted, fontSize: 13, lineHeight: 19 }}>{t("ana.lockedDesc")}</Text>
        </Card>
      </>
    );
  }
  if (meta.failed && !data) return <ErrorState onRetry={onRetry} text={t(meta.authIssue ? "reports.sessionExpired" : meta.forbidden ? "ana.noFinancialAccess" : "reports.noData")} />;
  if (!data || !active || !cur || !prev) return (
    <>
      <WorkspaceHeader category="financial" onBack={onBack} />
      <SourceCard meta={meta} online={online} lastSync={lastSync} onRefresh={onRetry} pendingNote />
      {data ? <Banner tone="warn" text={t("ana.localUnavailable")} /> : <Loading />}
    </>
  );

  const margin = cur?.grossMarginBps != null ? `${(cur.grossMarginBps / 100).toFixed(2)}%` : t("fin.marginUnavailable");
  const pnlRows: [string, string][] = cur ? [
    [t("reports.grossSales"), money(cur.grossSales)],
    [t("dash.discounts"), money(cur.discounts)],
    [t("dash.returns"), money(cur.salesReturns)],
    [t("fin.netSales"), money(cur.netSales)],
    [t("fin.cogs"), money(cur.cogs)],
    [t("fin.gross"), money(cur.grossProfit)],
    [t("dash.grossMargin"), margin],
    [t("fin.expenses"), money(cur.operatingExpenses)],
    [t("fin.operating"), money(cur.operatingProfit)],
    [t("fin.stockLoss"), money(cur.stockLosses)],
    [t("fin.resultAfterLosses"), money(cur.operatingResultAfterStockLosses)],
    [t("dash.transactions"), String(cur.transactions)],
    [t("dash.unitsSold"), formatQty(cur.unitsSold)],
    [t("fin.cash"), money(cur.cashCollected)],
    [t("fin.receivables"), money(cur.receivables)],
    [t("fin.outstanding"), money(cur.outstandingExpenses)],
    [t("fin.purchases"), money(cur.inventoryPurchases)],
  ] : [];

  const expenseCols: Col<any>[] = [
    { key: "at", title: t("common.date"), width: 1.3, render: (r) => <Text style={{ color: c.inkSoft, fontSize: 12 }}>{instantText(r.at)}</Text> },
    { key: "category", title: t("common.category") },
    { key: "note", title: t("common.note"), width: 1.6, render: (r) => <Text style={{ color: c.muted, fontSize: 12 }}>{r.note ?? "—"}</Text> },
    { key: "amount", title: t("common.amount"), align: "right", render: (r) => <Text style={{ color: c.ink, fontSize: 13, fontVariant: ["tabular-nums"] }}>{money(r.amount)}</Text> },
    { key: "paid", title: t("common.status"), render: (r) => <Badge tone={r.paid ? "ok" : "warn"} label={t(r.paid ? "expense.paid" : "common.unpaid")} /> },
  ];
  const filteredExpenses = expenses.filter((e) => !query.trim() || `${e.category} ${e.note ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));

  // The table rows for the currently selected P&L subsection, so the export matches the screen
  // instead of always dumping the full statement.
  const detailRows: [string, string][] = view === "revenue" ? [
    [t("reports.grossSales"), money(cur.grossSales)],
    [t("dash.discounts"), money(cur.discounts)],
    [t("dash.returns"), money(cur.salesReturns)],
    [t("fin.netSales"), money(cur.netSales)],
  ] : view === "cogs" ? [
    [t("fin.cogs"), money(cur.cogs)],
    [t("reports.receivedInPeriod"), `${cur.purchasesReceived.deliveries} · ${money(cur.purchasesReceived.value)}`],
    [t("reports.openingInventory"), money(cur.openingInventoryValue)],
    [t("reports.closingInventory"), money(cur.closingInventoryValue)],
  ] : view === "gross" ? [
    [t("fin.gross"), money(cur.grossProfit)],
    [t("dash.grossMargin"), margin],
    [t("fin.cogs"), money(cur.cogs)],
  ] : view === "net" ? [
    [t("fin.resultAfterLosses"), money(cur.operatingResultAfterStockLosses)],
    [t("fin.operating"), money(cur.operatingProfit)],
    [t("fin.stockLoss"), money(cur.stockLosses)],
  ] : pnlRows;

  const basisLabel = t(usingLocal ? "ana.basisLocal" : "ana.basisServer");
  const spec: ExportSpec = view === "expenses" ? {
    title: `${t("ana.cat.financial" as any)} · ${t("ana.sub.financial.expenses")} · ${basisLabel}`,
    header: [t("common.date"), t("common.category"), t("common.note"), t("common.amount"), t("common.status")],
    rows: filteredExpenses.map((r) => [instantText(r.at), r.category, r.note ?? "", r.amount, r.paid ? t("expense.paid") : t("common.unpaid")]),
    metrics: [{ label: t("ana.metric.expenses"), value: money(eTotals.total) }, { label: t("common.unpaid"), value: money(eTotals.unpaid) }],
    notes: [usingLocal ? t("ana.localPendingNote") : t("ana.serverBasisNote")],
  } : view === "breakdown" ? {
    title: `${t("ana.cat.financial" as any)} · ${t("ana.sub.financial.breakdown")} · ${basisLabel}`,
    header: [t("common.category"), t("ana.metric.expenses"), t("common.unpaid"), t("dash.transactions")],
    rows: breakdown.map((b) => [b.label, b.amount, b.unpaid, b.count]),
    metrics: [{ label: t("ana.metric.expenses"), value: money(eTotals.total) }],
  } : {
    title: `${t("ana.cat.financial" as any)} · ${t(`ana.sub.financial.${view}` as any)} · ${basisLabel}`,
    header: [t("common.category"), t("ana.value")],
    rows: detailRows,
    metrics: cur ? [
      { label: t("ana.metric.net"), value: money(cur.netSales) },
      { label: t("ana.metric.grossProfit"), value: money(cur.grossProfit) },
      { label: t("ana.metric.expenses"), value: money(cur.operatingExpenses) },
      { label: t("ana.metric.result"), value: money(cur.operatingResultAfterStockLosses) },
    ] : [],
    notes: [t("fin.calculationNote"), usingLocal ? t("ana.localPendingNote") : t("ana.serverBasisNote"), ...(cur?.costBasisIncomplete ? [t("fin.provisional")] : [])],
  };

  return (
    <>
      <WorkspaceHeader category="financial" onBack={onBack} />
      <SourceCard meta={meta} online={online} lastSync={lastSync} onRefresh={onRetry} pendingNote />
      <View style={{ gap: 6 }}>
        <Text style={{ color: c.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>{t("ana.basis")}</Text>
        <Segmented<FinancialBasis> value={basisValue} onChange={setBasis} options={[
          { value: "server", label: t("ana.basisServer") },
          { value: "local", label: t("ana.basisLocal") },
        ]} />
        <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>
          {usingLocal ? t("ana.localBasisNote") : t("ana.serverBasisNote")}
        </Text>
      </View>
      <Segmented<FinancialView> value={view} onChange={setView} options={[
        { value: "pnl", label: t("ana.sub.financial.pnl") }, { value: "revenue", label: t("ana.sub.financial.revenue") },
        { value: "cogs", label: t("ana.sub.financial.cogs") }, { value: "gross", label: t("ana.sub.financial.gross") },
        { value: "expenses", label: t("ana.sub.financial.expenses") }, { value: "net", label: t("ana.sub.financial.net") },
        { value: "breakdown", label: t("ana.sub.financial.breakdown") }, { value: "trends", label: t("ana.sub.financial.trends") },
      ]} />
      {!data || !summary || !cur || !prev ? <Loading /> : (
        <>
          {usingLocal ? (
            <>
              {data.provisional ? <Banner tone="warn" text={t("ana.provisional")} /> : null}
              {cur.costBasisIncomplete ? <Banner tone="warn" text={t("fin.provisional")} /> : null}
              <Card tone="muted" style={{ gap: 2 }}>
                <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("ana.localBreakdown")}</Text>
                {([
                  [t("ana.serverConfirmed"), summary ? money(summary.current.netSales) : t("ana.notHeld"), summary ? undefined : t("ana.serverNotHeld")],
                  [t("ana.pendingSales"), pending ? money(pending.salesNet) : "—", pending ? t("reports.pendingOps").replace("{n}", String(pending.salesCount)) : undefined],
                  [t("ana.localOperational"), money(cur.netSales), t("ana.records")],
                  [t("ana.pendingExpenses"), pending ? money(pending.expenses) : "—", pending ? t("reports.pendingOps").replace("{n}", String(pending.expenseCount)) : undefined],
                  [t("ana.localResult"), money(cur.operatingResultAfterStockLosses)],
                ] as [string, string, string?][]).map(([label, value, note]) => (
                  <View key={label} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: space.md, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.line }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: c.inkSoft, fontSize: 13 }}>{label}</Text>
                      {note ? <Text style={{ color: c.muted, fontSize: 11 }}>{note}</Text> : null}
                    </View>
                    <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{value}</Text>
                  </View>
                ))}
                <Text style={{ color: c.muted, fontSize: 11, marginTop: 4 }}>{t("ana.localPendingNote")}</Text>
              </Card>
            </>
          ) : meta.source === "server" && meta.pendingOps > 0 ? (
            <Banner tone="warn" text={t("ana.pendingServerExcluded").replace("{n}", String(meta.pendingOps))} />
          ) : null}

          {(view === "pnl" || view === "revenue" || view === "cogs" || view === "gross" || view === "net") ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
              <Stat emphasis label={t("ana.metric.net")} value={money(cur.netSales)} />
              <Stat label={t("ana.metric.cogs")} value={money(cur.cogs)} />
              <Stat label={t("ana.metric.grossProfit")} value={money(cur.grossProfit)} footnote={`${t("ana.metric.margin")}: ${margin}`} />
              <Stat label={t("ana.metric.expenses")} value={money(cur.operatingExpenses)} />
              <Stat label={t("ana.metric.loss")} value={money(cur.stockLosses)} />
              <Stat label={t("ana.metric.result")} value={money(cur.operatingResultAfterStockLosses)} />
            </View>
          ) : null}

          {view === "pnl" ? (
            <>
              <Card style={{ gap: 2 }}>
                <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("reports.summaryBreakdown")}</Text>
                {pnlRows.map(([label, value]) => (
                  <View key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.line }}>
                    <Text style={{ color: c.muted, fontSize: 13 }}>{label}</Text>
                    <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{value}</Text>
                  </View>
                ))}
              </Card>
              <Card style={{ gap: 2 }}>
                <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("reports.vsPrevious")}</Text>
                <ComparisonLine label={t("fin.netSales")} current={cur.netSales} previous={prev.netSales} />
                <ComparisonLine label={t("fin.gross")} current={cur.grossProfit} previous={prev.grossProfit} />
                <ComparisonLine label={t("fin.operating")} current={cur.operatingProfit} previous={prev.operatingProfit} />
                <ComparisonLine label={t("fin.resultAfterLosses")} current={cur.operatingResultAfterStockLosses} previous={prev.operatingResultAfterStockLosses} />
              </Card>
            </>
          ) : null}

          {view === "revenue" ? (
            <>
              <Card style={{ gap: 2 }}>
                {([[t("reports.grossSales"), money(cur.grossSales)], [t("dash.discounts"), money(cur.discounts)], [t("dash.returns"), money(cur.salesReturns)], [t("fin.netSales"), money(cur.netSales)]] as [string, string][]).map(([label, value]) => (
                  <View key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.line }}>
                    <Text style={{ color: c.muted, fontSize: 13 }}>{label}</Text>
                    <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{value}</Text>
                  </View>
                ))}
              </Card>
              <Card style={{ gap: space.sm }}>
                <TrendBars data={revenueSeries.map((p) => ({ date: p.date, netSales: p.value, transactions: 0 }))} label={t("ana.metric.net")} showCount={false} labelMode={mode === "month" ? "month" : "day"} />
              </Card>
            </>
          ) : null}

          {view === "cogs" ? (
            <>
              <Card style={{ gap: 2 }}>
                {([[t("fin.cogs"), money(cur.cogs)], [t("reports.receivedInPeriod"), `${cur.purchasesReceived.deliveries} · ${money(cur.purchasesReceived.value)}`], [t("reports.openingInventory"), money(cur.openingInventoryValue)], [t("reports.closingInventory"), money(cur.closingInventoryValue)]] as [string, string][]).map(([label, value]) => (
                  <View key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.line }}>
                    <Text style={{ color: c.muted, fontSize: 13 }}>{label}</Text>
                    <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{value}</Text>
                  </View>
                ))}
              </Card>
              <Text style={{ color: c.muted, fontSize: 12 }}>{t("fin.calculationNote")}</Text>
            </>
          ) : null}

          {view === "gross" ? (
            <>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
                <Stat label={t("ana.metric.grossProfit")} value={money(cur.grossProfit)} />
                <Stat label={t("ana.metric.margin")} value={margin} />
                <Stat label={t("ana.metric.cogs")} value={money(cur.cogs)} />
              </View>
              <ComparisonLine label={t("fin.gross")} current={cur.grossProfit} previous={prev.grossProfit} />
              <Text style={{ color: c.muted, fontSize: 12 }}>{t("fin.calculationNote")}</Text>
            </>
          ) : null}

          {view === "net" ? (
            <>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
                <Stat emphasis label={t("ana.metric.result")} value={money(cur.operatingResultAfterStockLosses)} />
                <Stat label={t("fin.operating")} value={money(cur.operatingProfit)} />
                <Stat label={t("fin.stockLoss")} value={money(cur.stockLosses)} />
              </View>
              <ComparisonLine label={t("fin.resultAfterLosses")} current={cur.operatingResultAfterStockLosses} previous={prev.operatingResultAfterStockLosses} />
            </>
          ) : null}

          {view === "expenses" ? (
            <>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
                <Stat label={t("ana.metric.expenses")} value={money(eTotals.total)} />
                <Stat label={t("expense.paid")} value={money(eTotals.paid)} />
                <Stat label={t("common.unpaid")} value={money(eTotals.unpaid)} />
                <Stat label={t("ana.metric.transactions")} value={String(eTotals.count)} />
              </View>
              <FilterField value={query} onChange={setQuery} />
              <TableBlock cols={expenseCols} rows={filteredExpenses} />
            </>
          ) : null}

          {view === "breakdown" ? (
            <>
              <Card style={{ gap: space.sm }}>
                <BarList items={breakdown.map((b) => ({ key: b.key, label: b.label, value: b.amount }))} emptyLabel={t("ana.noRecords")} />
              </Card>
              <TableBlock cols={[
                { key: "label", title: t("common.category") },
                { key: "amount", title: t("ana.metric.expenses"), align: "right", render: (r) => <Text style={{ color: c.ink, fontSize: 13, fontVariant: ["tabular-nums"] }}>{money(r.amount)}</Text> },
                { key: "unpaid", title: t("common.unpaid"), align: "right", render: (r) => money(r.unpaid) },
                { key: "count", title: t("dash.transactions"), align: "right" },
              ] as Col<any>[]} rows={breakdown} />
            </>
          ) : null}

          {view === "trends" ? (
            <Card style={{ gap: space.sm }}>
              <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("ana.chartExpenses").replace("{bucket}", t(bucketWord(mode)))}</Text>
              <CompareBars data={compareSeries} labelA={t("ana.metric.revenue")} labelB={t("ana.metric.expenses")} labelMode={mode === "month" ? "month" : "day"} />
              <Text style={{ color: c.muted, fontSize: 11 }}>{t("ana.exportHint")}</Text>
            </Card>
          ) : null}

          <ExportBar spec={spec} from={from} to={to} source={meta.source} shop={shop} filename={`financial-${view}-${basisValue}`} />
        </>
      )}
      <Text style={{ color: c.muted, fontSize: 12 }}>{t("ana.privacy")}</Text>
    </>
  );
}

/* ------------------------------------------------------------------ header helpers */

function WorkspaceHeader({ category, onBack }: { category: ReportCategory; onBack: () => void }) {
  const t = useT(); const c = useTheme();
  return (
    <View style={{ gap: space.sm }}>
      <Button testID="reports-back" kind="quiet" size="sm" label={`← ${t("ana.back")}`} onPress={onBack} />
      <Text accessibilityRole="header" style={{ color: c.ink, ...type.h1 }}>{t(`ana.cat.${category}` as any)}</Text>
      <Text style={{ color: c.muted, ...type.small }}>{t(`ana.cat.${category}Desc` as any)}</Text>
    </View>
  );
}

