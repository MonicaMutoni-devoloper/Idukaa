import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Share, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { formatQty, formatRwf } from "@sms/shared";
import { Badge, Banner, Button, Card, ConfirmDialog, DataTable, Empty, ErrorState, Field, KeyValue, Loading, Modal, Screen, Segmented } from "../../src/components/ui";
import { useT } from "../../src/localization";
import { API_URL, ApiError, request, useSession } from "../../src/services/api";
import { addDaysToDay, customRange, rangeFor, todayDay, type Preset, type Range } from "../../src/services/util";
import { useSync } from "../../src/synchronization/engine";
import { space, type, useTheme } from "../../src/theme/tokens";

/** `items` is the products-sold view; `summary` is the period P&L; the rest are transaction ledgers. */
type View_ = "sales" | "items" | "purchases" | "expenses" | "adjustments" | "summary";
type Choice = Preset | "custom";
type Status = "posted" | "reversed";

interface SaleRow { id: string; at: string; by: string; payment_method: string; gross_amount: number; discount: number; amount_paid: number; status: string; units: string | number }
interface ItemRow { productId: string; name: string; code: string; unit: string; units: number; gross: number; sales: number; avgUnitPrice: number }
interface ItemTotals { units: number; gross: number; products: number; sales: number; net: number; discounts: number }
interface SaleLine { productId: string; name: string; code: string; unit: string; qty: number; unitPrice: number; lineAmount: number; discount?: number; net?: number }
interface SaleDetail {
  sale: { id: string; at: string; cashier: string; paymentMethod: string; status: string; grossAmount: number; discount: number; amountPaid: number; net: number; balance: number; reversedAt: string | null; reversalReason: string | null };
  lines: SaleLine[];
}

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
const isoDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const receiptNo = (id: string) => `RC-${String(id).slice(0, 8).toUpperCase()}`;

export default function Reports() {
  const t = useT(); const c = useTheme();
  const { user, token } = useSession();
  const online = useSync((s) => s.online);
  const params = useLocalSearchParams<{ kind?: string; from?: string; to?: string }>();
  const initialView: View_ = ["purchases", "expenses", "items", "adjustments", "summary"].includes(String(params.kind)) ? (params.kind as View_) : "sales";
  // Memoised on the primitive strings. A fresh object literal here would change identity on every
  // render, re-running the param-sync effect below forever (each run calls setApplied with the new
  // object → "Maximum update depth exceeded").
  const paramOverride: Range | null = useMemo(
    () => (params.from && params.to && params.from < params.to ? { from: params.from, to: params.to } : null),
    [params.from, params.to],
  );

  const [choice, setChoice] = useState<Choice>(paramOverride ? "custom" : "week");
  const [applied, setApplied] = useState<Range>(paramOverride ?? customRange(addDaysToDay(todayDay(), -6), todayDay())!);
  const [customFrom, setCustomFrom] = useState(paramOverride ? isoDay(paramOverride.from) : addDaysToDay(todayDay(), -6));
  const [customTo, setCustomTo] = useState(paramOverride ? isoDay(new Date(Date.parse(paramOverride.to) - 1).toISOString()) : todayDay());
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [view, setView] = useState<View_>(initialView);
  const [status, setStatus] = useState<"all" | Status>("all");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [itemTotals, setItemTotals] = useState<ItemTotals | null>(null);
  const [failed, setFailed] = useState(false);
  // A rejected session is not an offline error: say so, or the user keeps waiting for a connection
  // that is already working. The value tracks the last failed load.
  const [authIssue, setAuthIssue] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [voidRow, setVoidRow] = useState<any | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidBusy, setVoidBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<SaleDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);

  const range = choice === "custom" ? applied : rangeFor(choice);
  const { from, to } = range;
  useEffect(() => { setView(initialView); }, [initialView]);
  useEffect(() => {
    if (!paramOverride) return;
    setChoice("custom"); setApplied(paramOverride);
    setCustomFrom(isoDay(paramOverride.from));
    setCustomTo(isoDay(new Date(Date.parse(paramOverride.to) - 1).toISOString()));
  }, [paramOverride]);

  const load = useCallback(() => {
    if (view === "summary") { setLoading(false); setFailed(false); setRows([]); setItemTotals(null); return; }
    setLoading(true); setFailed(false); setAuthIssue(false);
    const failedWith = (e: unknown) => { setFailed(true); setAuthIssue(e instanceof ApiError && e.status === 401); };
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    if (view === "items") {
      request<{ items: ItemRow[]; totals: ItemTotals }>(`/reports/items?${q}`)
        .then((r) => { setRows(r.items); setItemTotals(r.totals); })
        .catch((e) => { failedWith(e); setRows([]); setItemTotals(null); })
        .finally(() => setLoading(false));
      return;
    }
    setItemTotals(null);
    request<any[]>(`/reports/transactions?kind=${view}&${q}`)
      .then((r) => setRows(r)).catch((e) => { failedWith(e); setRows([]); }).finally(() => setLoading(false));
  }, [view, from, to]);
  // `token` is a dependency on purpose: after an expired session is replaced by a fresh sign-in the
  // period reloads by itself instead of asking the user to press Retry.
  useEffect(() => { load(); }, [load, token]);

  const applyCustom = () => {
    const r = customRange(customFrom, customTo);
    if (!r) { setRangeError(t("dash.invalidRange")); return; }
    setRangeError(null); setApplied(r);
  };

  const exportCsv = async () => {
    if (view === "items" || view === "summary" || view === "adjustments") return;
    setExporting(true); setExportError(null);
    try {
      const res = await fetch(`${API_URL}/reports/export?kind=${view}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const csv = await res.text();
      const filename = `shop-${view}-${from.slice(0, 10)}.csv`;
      if (Platform.OS === "web") {
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        await Share.share({ message: csv, title: filename });
      }
    } catch { setExportError(t("reports.exportFailed")); }
    finally { setExporting(false); }
  };

  const openSale = async (id: string) => {
    setDetailOpen(true); setDetail(null); setDetailFailed(false);
    try { setDetail(await request<SaleDetail>(`/reports/sales/${id}`)); }
    catch { setDetailFailed(true); }
  };

  const confirmVoid = async () => {
    if (!voidRow || voidReason.trim().length < 3) return;
    setVoidBusy(true); setNotice(null);
    try {
      await request(`/sales/${voidRow.id}/void`, { method: "POST", body: { reason: voidReason.trim() } });
      setVoidRow(null); setVoidReason("");
      setNotice({ tone: "ok", text: t("reports.voided") });
      load();
    } catch (e: any) {
      const message = e?.body?.message;
      setNotice({ tone: "danger", text: message === "sale_already_reversed" ? t("reports.alreadyVoided") : t("reports.voidFailed") });
    } finally { setVoidBusy(false); }
  };

  const money = (k: string) => (r: any) => <Text style={{ color: c.ink, fontVariant: ["tabular-nums"], fontSize: 14 }}>{formatRwf(Number(r[k]))}</Text>;
  const when = (r: any) => <Text style={{ color: c.inkSoft, fontSize: 13 }}>{new Date(r.at).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</Text>;
  const paidCell = (r: any) => <Badge tone={r.paid ? "ok" : "warn"} label={r.paid ? t("expense.paid") : t("common.unpaid")} />;
  const methodCell = (r: any) => <Text style={{ color: c.inkSoft, fontSize: 12 }}>{t(`sell.${r.payment_method}` as any)}</Text>;
  const refCell = (r: any) => <Text style={{ color: c.inkSoft, fontSize: 12, fontVariant: ["tabular-nums"] }}>{receiptNo(r.id)}</Text>;
  // Voiding happens from the sale dialog, so a table row never contains its own buttons.
  const statusCell = (r: any) => <Badge tone={r.status === "reversed" ? "danger" : "ok"} label={r.status === "reversed" ? t("reports.reversed") : t("reports.posted")} />;

  const filtered = rows.filter((r) => {
    if (view === "sales" && status !== "all" && r.status !== status) return false;
    if (view === "items") {
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return String(r.name ?? "").toLowerCase().includes(needle) || String(r.code ?? "").toLowerCase().includes(needle);
    }
    return true;
  });

  const lossCost = (rows: any[]) => rows.reduce((s, r) => s + (Number(r.qty) < 0 && r.unit_cost != null ? Math.round((-Number(r.qty) * Number(r.unit_cost)) / 1000) : 0), 0);
  const unitsLost = (rows: any[]) => rows.reduce((s, r) => s + Math.max(0, -Number(r.qty)), 0);
  const units = view === "items" ? Number(itemTotals?.units ?? 0) : view === "adjustments" ? unitsLost(filtered) : rows.reduce((s, r) => s + Number(r.units ?? 0), 0);
  const net = view === "sales"
    ? rows.filter((r) => r.status === "posted").reduce((s, r) => s + Number(r.gross_amount) - Number(r.discount), 0)
    : view === "items" ? Number(itemTotals?.net ?? 0) : 0;
  const total = view === "adjustments" ? lossCost(filtered) : filtered.reduce((s, r) => s + Number(view === "expenses" ? r.amount : view === "purchases" ? r.total_amount : view === "items" ? r.gross : r.gross_amount), 0);
  const collected = filtered.reduce((s, r) => s + Number(view === "expenses" ? (r.paid ? r.amount : 0) : view === "items" ? 0 : r.amount_paid), 0);
  const balance = filtered.reduce((s, r) => s + Number(r.total_amount ?? 0) - Number(r.amount_paid ?? 0), 0);
  const unpaid = filtered.reduce((s, r) => s + (r.paid ? 0 : Number(r.amount ?? 0)), 0);

  const cols = view === "sales" ? [
    { key: "at", title: t("common.date"), render: when, width: 1.35 },
    { key: "ref", title: t("reports.saleReceipt"), render: refCell, width: 1 },
    { key: "by", title: t("reports.cashier"), width: 1.15 },
    { key: "payment_method", title: t("reports.paymentMethod"), width: 1, render: methodCell },
    { key: "products", title: t("common.product"), width: 1.8, render: (r: any) => <Text numberOfLines={2} style={{ color: c.inkSoft, fontSize: 12 }}>{r.products || "—"}</Text> },
    { key: "gross_amount", title: t("common.total"), align: "right" as const, render: money("gross_amount") },
    { key: "discount", title: t("common.discount"), align: "right" as const, render: money("discount") },
    { key: "amount_paid", title: t("common.paid"), align: "right" as const, render: money("amount_paid") },
    { key: "balance", title: t("common.balance"), align: "right" as const, render: (r: any) => <Text style={{ color: Number(r.gross_amount - r.discount - r.amount_paid) > 0 ? c.accent : c.muted, fontVariant: ["tabular-nums"] }}>{formatRwf(Number(r.gross_amount - r.discount - r.amount_paid))}</Text> },
    { key: "status", title: t("common.status"), width: 1.3, render: statusCell },
  ] : view === "items" ? [
    { key: "name", title: t("common.product"), width: 2.2, render: (r: any) => <View><Text style={{ color: c.ink, fontWeight: "600", fontSize: 14 }}>{r.name}</Text><Text style={{ color: c.muted, fontSize: 11 }}>{r.code}</Text></View> },
    { key: "units", title: t("reports.units"), align: "right" as const, render: (r: any) => <Text style={{ color: c.ink, fontVariant: ["tabular-nums"] }}>{formatQty(Number(r.units))} {r.unit}</Text> },
    { key: "avgUnitPrice", title: t("reports.avgPrice"), align: "right" as const, render: money("avgUnitPrice") },
    { key: "sales", title: t("dash.transactions"), align: "right" as const },
    { key: "gross", title: t("reports.lineAmount"), align: "right" as const, render: money("gross") },
  ] : view === "purchases" ? [
    { key: "at", title: t("common.date"), render: when, width: 1.3 },
    { key: "supplier", title: t("common.supplier"), width: 1.3 },
    { key: "reference", title: t("receive.reference"), width: 1.1, render: (r: any) => <Text style={{ color: c.inkSoft, fontSize: 12 }}>{r.reference ?? "—"}</Text> },
    { key: "notes", title: t("receive.notes"), width: 1.4, render: (r: any) => <Text style={{ color: c.muted, fontSize: 12 }}>{r.notes ?? "—"}</Text> },
    { key: "total_amount", title: t("common.total"), align: "right" as const, render: money("total_amount") },
    { key: "amount_paid", title: t("common.paid"), align: "right" as const, render: money("amount_paid") },
    { key: "balance", title: t("common.balance"), align: "right" as const, render: (r: any) => <Text style={{ color: c.ink, fontVariant: ["tabular-nums"], fontSize: 14 }}>{formatRwf(Number(r.total_amount - r.amount_paid))}</Text> },
  ] : view === "adjustments" ? [
    { key: "at", title: t("common.date"), render: when, width: 1.3 },
    { key: "product", title: t("common.product"), width: 1.5, render: (r: any) => <Text numberOfLines={1} style={{ color: c.ink, fontWeight: "600", fontSize: 13 }}>{r.product}</Text> },
    { key: "qty", title: t("common.qty"), align: "right" as const, render: (r: any) => <Text style={{ color: Number(r.qty) < 0 ? c.danger : c.ink, fontVariant: ["tabular-nums"], fontSize: 13, fontWeight: "600" }}>{formatQty(Number(r.qty))}</Text> },
    { key: "reason", title: t("appr.reason"), width: 1.2, render: (r: any) => <Text style={{ color: c.inkSoft, fontSize: 12 }}>{String(r.reason ?? "—").replace("_", " ")}</Text> },
    { key: "unit_cost", title: t("common.cost"), align: "right" as const, render: (r: any) => <Text style={{ color: c.ink, fontVariant: ["tabular-nums"], fontSize: 13 }}>{r.unit_cost == null ? "—" : formatRwf(Number(r.unit_cost))}</Text> },
    { key: "status", title: t("common.status"), width: 1.2, render: (r: any) => <Badge tone={r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"} label={t(r.status === "approved" ? "reports.approved" : r.status === "rejected" ? "reports.rejected" : "reports.pending")} /> },
    { key: "requested_by", title: t("reports.requestedBy"), width: 1.2, render: (r: any) => <Text style={{ color: c.inkSoft, fontSize: 12 }}>{r.requested_by ?? "—"}</Text> },
    { key: "note", title: t("common.note"), width: 1.5 },
  ] : [
    { key: "at", title: t("common.date"), render: when, width: 1.3 },
    { key: "category", title: t("common.category"), width: 1.1 },
    { key: "amount", title: t("common.amount"), align: "right" as const, render: money("amount") },
    { key: "paid", title: t("common.status"), align: "right" as const, render: paidCell },
    { key: "note", title: t("common.note"), width: 1.6 },
  ];

  return (
    <Screen title={t("nav.reports")} subtitle={t("reports.subtitle")} actions={
      <>
        <Segmented<Choice> label={t("common.period")} value={choice} onChange={(v) => { setChoice(v); setRangeError(null); }} options={[
          { value: "today", label: t("common.today") },
          { value: "yesterday", label: t("common.yesterday") },
          { value: "week", label: t("common.week") },
          { value: "month", label: t("common.month") },
          { value: "year", label: t("common.year") },
          { value: "custom", label: t("reports.custom") },
        ]} />
        <Segmented<View_> value={view} onChange={setView} label={t("reports.view")} options={[
          { value: "sales", label: t("common.sales") },
          { value: "items", label: t("reports.items") },
          { value: "purchases", label: t("common.purchases") },
          { value: "expenses", label: t("common.expenses") },
          { value: "adjustments", label: t("dash.stockLosses") },
          { value: "summary", label: t("reports.summary") },
        ]} />
      </>
    }>
      {!online ? <Banner tone="warn" text={t("reports.offline")} /> : null}

      {choice === "custom" ? (
        <Card style={{ gap: space.md }}>
          <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
            <Field testID="reports-from" label={t("common.from")} value={customFrom} onChangeText={setCustomFrom} placeholder="YYYY-MM-DD" />
            <Field testID="reports-to" label={t("common.to")} value={customTo} onChangeText={setCustomTo} placeholder="YYYY-MM-DD" />
            <View style={{ justifyContent: "flex-end", paddingBottom: 1 }}><Button testID="reports-apply" label={t("common.apply")} onPress={applyCustom} /></View>
          </View>
          {rangeError ? <Text style={{ color: c.danger, fontSize: 12 }}>{rangeError}</Text> : null}
        </Card>
      ) : null}

      {notice ? <Banner tone={notice.tone} text={notice.text} /> : null}
      {exportError ? <Banner tone="danger" text={exportError} /> : null}

      {view === "summary" ? <SummaryPanel from={from} to={to} /> : null}

      {view !== "summary" ? (
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        <Card style={{ flexGrow: 1, flexBasis: 200, gap: 2 }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{view === "adjustments" ? t("dash.stockLosses") : t("reports.periodTotal")}</Text>
          <Text style={{ color: c.ink, ...type.money }}>{formatRwf(total)}</Text>
          <Text style={{ color: c.muted, fontSize: 11 }}>{fmtDay(from)} – {fmtDay(to)} · {filtered.length} {view === "items" ? t("dash.products") : t("reports.rows")}</Text>
        </Card>
        <Card style={{ flexGrow: 1, flexBasis: 200, gap: 2 }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>
            {view === "adjustments" ? t("reports.unitsLost") : view === "sales" ? t("fin.netSales") : view === "items" ? t("dash.catalogue") : view === "purchases" ? t("common.paid") : t("expense.paid")}
          </Text>
          <Text style={{ color: c.ink, ...type.money }}>
            {view === "adjustments" ? formatQty(units) : view === "sales" ? formatRwf(net) : view === "items" ? String(filtered.length) : formatRwf(collected)}
          </Text>
          <Text style={{ color: c.muted, fontSize: 11 }}>
            {view === "adjustments" ? t("reports.unitsLostNote") : view === "sales" ? t("reports.netNote") : view === "items" ? t("reports.itemsCount") : t("reports.paidNote")}
          </Text>
        </Card>
        <Card style={{ flexGrow: 1, flexBasis: 200, gap: 2 }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>
            {view === "adjustments" ? t("reports.approvedCost") : view === "sales" || view === "items" ? t("dash.unitsSold") : view === "purchases" ? t("common.balance") : t("common.unpaid")}
          </Text>
          <Text style={{ color: c.ink, ...type.money }}>
            {view === "adjustments" ? formatRwf(lossCost(filtered.filter((r: any) => r.status === "approved"))) : view === "sales" || view === "items" ? formatQty(units) : formatRwf(view === "purchases" ? balance : unpaid)}
          </Text>
          <Text style={{ color: c.muted, fontSize: 11 }}>
            {view === "adjustments" ? t("reports.approvedOnly") : view === "sales" || view === "items" ? t("dash.unitsSoldHint") : view === "purchases" ? t("reports.balanceNote") : t("reports.unpaidNote")}
          </Text>
        </Card>
        <Card style={{ flexGrow: 1, flexBasis: 200, gap: space.sm, justifyContent: "center" }}>
          {view === "items"
            ? <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("reports.itemsNote")}</Text>
            : view === "adjustments"
            ? <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("reports.adjustmentsNote")}</Text>
            : <>
                <Button testID="reports-export" kind="secondary" label={t("reports.exportCsv")} loading={exporting} disabled={!filtered.length} onPress={() => void exportCsv()} />
                <Text style={{ color: c.muted, fontSize: 11 }}>{t("reports.exportHelp")}</Text>
              </>}
        </Card>
      </View>
      ) : null}

      {view === "sales" ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, alignItems: "center" }}>
          <Segmented<"all" | Status> value={status} onChange={setStatus} label={t("common.status")}
            options={[{ value: "all", label: t("common.all") }, { value: "posted", label: t("reports.posted") }, { value: "reversed", label: t("reports.reversed") }]} />
          <Text style={{ color: c.muted, fontSize: 12 }}>{t("reports.tapForLines")}</Text>
        </View>
      ) : null}

      {view === "items" ? (
        <Field testID="reports-items-search" label={t("common.search")} placeholder={t("stock.searchPlaceholder")} value={query} onChangeText={setQuery} autoCorrect={false} />
      ) : null}

      {view === "summary" ? null : loading ? <Loading /> : failed ? <ErrorState onRetry={load} text={t(authIssue ? "reports.sessionExpired" : "reports.offline")} /> : (
        <DataTable rows={filtered} cols={cols}
          onRow={view === "sales" ? (r: any) => void openSale(r.id) : undefined}
          rowTestID={view === "sales" ? (r: any) => `sale-open-${r.id}` : undefined}
          empty={
            <Card tone="muted"><Empty icon="chart"
              title={view === "items" ? t("reports.noItems") : t("reports.noRows")}
              description={view === "items" ? t("reports.noItemsDesc") : t("reports.noRowsDesc")} /></Card>
          } />
      )}

      <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("reports.explanation")}</Text>

      <Modal open={detailOpen} onClose={() => setDetailOpen(false)} title={t("reports.saleDetail")}
        description={detail ? receiptNo(detail.sale.id) : undefined} width={560} scroll
        footer={<>
          {detail && user?.role === "owner" && detail.sale.status === "posted" ? (
            <Button testID={`void-${detail.sale.id}`} kind="danger" label={t("reports.void")} onPress={() => {
              const sale = detail.sale;
              setDetailOpen(false); setVoidReason("");
              setVoidRow({ id: sale.id, gross_amount: sale.grossAmount, discount: sale.discount });
            }} />
          ) : null}
          <Button kind="secondary" label={t("common.close")} onPress={() => setDetailOpen(false)} />
        </>}>
        {detailFailed ? <Banner tone="danger" text={t("reports.detailFailed")} /> : !detail ? <Loading /> : (
          <>
            <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
              <Badge tone={detail.sale.status === "reversed" ? "danger" : "ok"} label={detail.sale.status === "reversed" ? t("reports.reversed") : t("reports.posted")} />
              <Badge tone="neutral" label={t(`sell.${detail.sale.paymentMethod}` as any)} />
            </View>
            <View style={{ gap: 2 }}>
              <KeyValue label={t("common.date")} value={new Date(detail.sale.at).toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} />
              <KeyValue label={t("reports.cashier")} value={detail.sale.cashier} />
              <KeyValue label={t("common.total")} value={formatRwf(detail.sale.grossAmount)} />
              <KeyValue label={t("common.discount")} value={formatRwf(detail.sale.discount)} />
              <KeyValue label={t("fin.netSales")} value={formatRwf(detail.sale.net)} />
              <KeyValue label={t("common.paid")} value={formatRwf(detail.sale.amountPaid)} />
              <KeyValue strong label={t("common.balance")} value={formatRwf(detail.sale.balance)} />
            </View>
            <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("reports.items")}</Text>
            {detail.lines.map((l) => (
              <View key={`${l.productId}-${l.name}`} style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 7, borderTopWidth: 1, borderTopColor: c.line }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{l.name}</Text>
                  <Text style={{ color: c.muted, fontSize: 11 }}>{l.code} · {formatRwf(l.unitPrice)} / {l.unit}</Text>
                </View>
                <Text style={{ color: c.inkSoft, fontSize: 13, fontVariant: ["tabular-nums"] }}>{formatQty(l.qty)}</Text>
                <View style={{ alignItems: "flex-end", gap: 1 }}>
                  <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatRwf(l.net ?? l.lineAmount)}</Text>
                  {l.discount ? <Text style={{ color: c.muted, fontSize: 11 }}>{t("common.discount")} −{formatRwf(l.discount)}</Text> : null}
                </View>
              </View>
            ))}
            {detail.sale.status === "reversed" ? (
              <Banner tone="danger" text={detail.sale.reversalReason ? t("reports.voidedWith").replace("{reason}", detail.sale.reversalReason) : t("reports.reversed")} />
            ) : null}
          </>
        )}
      </Modal>

      <ConfirmDialog open={!!voidRow} title={t("reports.voidTitle")}
        message={t("reports.voidMessage").replace("{ref}", voidRow ? receiptNo(voidRow.id) : "").replace("{total}", voidRow ? formatRwf(Number(voidRow.gross_amount) - Number(voidRow.discount)) : "")}
        confirmLabel={t("reports.voidConfirm")} tone="danger" busy={voidBusy} disabled={voidReason.trim().length < 3}
        onCancel={() => { setVoidRow(null); setVoidReason(""); }} onConfirm={() => void confirmVoid()}>
        <Field testID="reports-void-reason" label={t("reports.voidReason")} value={voidReason} onChangeText={setVoidReason}
          placeholder={t("reports.voidReasonPlaceholder")} hint={t("reports.voidReasonHelp")}
          error={voidReason.length > 0 && voidReason.trim().length < 3 ? t("appr.reasonRequired") : null} />
      </ConfirmDialog>
    </Screen>
  );
}

/** Period totals as returned by GET /reports/summary (all figures are persisted-record derived). */
interface SummaryTotals {
  grossSales: number; discounts: number; salesReturns: number; netSales: number; cogs: number;
  grossProfit: number; grossMarginBps: number | null; operatingExpenses: number; operatingProfit: number;
  operatingResultAfterStockLosses: number; stockLosses: number; cashCollected: number; receivables: number;
  outstandingExpenses: number; inventoryPurchases: number;
  transactions: number; unitsSold: number;
  purchasesReceived: { deliveries: number; products: number; units: number; value: number };
  openingInventoryValue: number; closingInventoryValue: number;
  openingInventoryUnits: number; closingInventoryUnits: number; costBasisIncomplete: boolean;
}
interface Delta { change: number; pct: number | null }
interface SummaryPayload {
  range: { from: string; to: string }; previousRange: { from: string; to: string };
  current: SummaryTotals; previous: SummaryTotals;
  comparison: { netSales: Delta; grossProfit: Delta; operatingProfit: Delta; operatingResultAfterStockLosses: Delta };
}

function Stat({ label, value, delta, tone, hint, testID, emphasis }: {
  label: string; value: number; delta?: Delta | null; tone?: string; hint?: string; testID?: string; emphasis?: boolean;
}) {
  const c = useTheme(); const t = useT();
  const good = delta ? delta.change >= 0 : true;
  return (
    <Card style={{ flexGrow: 1, flexBasis: emphasis ? 210 : 165, gap: 4 }}>
      <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{label}</Text>
      <Text testID={testID} style={{ color: tone ?? c.ink, ...(emphasis ? type.moneyLarge : type.money) }}>{formatRwf(value)}</Text>
      {hint ? <Text style={{ color: c.muted, fontSize: 11 }}>{hint}</Text> : null}
      {delta ? (
        delta.pct === null
          ? <Text style={{ color: c.muted, fontSize: 11 }}>{t("dash.noPrior")}</Text>
          : <Text style={{ color: good ? c.success : c.danger, fontSize: 11, fontWeight: "600" }}>
              {good ? "▲" : "▼"} {Math.abs(delta.pct)}% <Text style={{ color: c.muted, fontWeight: "400" }}>{t("fin.vsPrev")}</Text>
            </Text>
      ) : null}
    </Card>
  );
}

/**
 * The period's profit & loss, component by component: gross → net → COGS → gross profit →
 * expenses → operating result → stock-loss-adjusted result, with the previous period beside it.
 * Everything comes from GET /reports/summary, the same source as the dashboard cards.
 */
function SummaryPanel({ from, to }: { from: string; to: string }) {
  const t = useT(); const c = useTheme();
  const { token } = useSession();
  const [data, setData] = useState<SummaryPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [authIssue, setAuthIssue] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true); setFailed(false); setAuthIssue(false);
    request<SummaryPayload>(`/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((r) => setData(r))
      .catch((e) => { setFailed(true); setAuthIssue(e instanceof ApiError && e.status === 401); setData(null); })
      .finally(() => setLoading(false));
  }, [from, to]);
  useEffect(() => { load(); }, [load, token]);

  if (loading) return <Loading />;
  if (failed || !data) return <ErrorState onRetry={load} text={t(authIssue ? "reports.sessionExpired" : "reports.offline")} />;
  const cur = data.current; const cmp = data.comparison;
  const rows: [string, string][] = [
    [t("reports.grossSales"), formatRwf(cur.grossSales)],
    [t("dash.discounts"), formatRwf(cur.discounts)],
    [t("dash.returns"), formatRwf(cur.salesReturns)],
    [t("fin.netSales"), formatRwf(cur.netSales)],
    [t("fin.cogs"), formatRwf(cur.cogs)],
    [t("fin.gross"), formatRwf(cur.grossProfit)],
    [t("dash.grossMargin"), cur.grossMarginBps != null ? `${(cur.grossMarginBps / 100).toFixed(2)}%` : t("fin.marginUnavailable")],
    [t("fin.expenses"), formatRwf(cur.operatingExpenses)],
    [t("fin.operating"), formatRwf(cur.operatingProfit)],
    [t("fin.stockLoss"), formatRwf(cur.stockLosses)],
    [t("fin.resultAfterLosses"), formatRwf(cur.operatingResultAfterStockLosses)],
    [t("dash.transactions"), String(cur.transactions)],
    [t("dash.unitsSold"), formatQty(cur.unitsSold)],
    [t("reports.receivedInPeriod"), `${cur.purchasesReceived.deliveries} ${t("dash.deliveries")} · ${formatQty(cur.purchasesReceived.units)} · ${formatRwf(cur.purchasesReceived.value)}`],
    [t("reports.openingInventory"), `${formatRwf(cur.openingInventoryValue)} · ${formatQty(cur.openingInventoryUnits)}`],
    [t("reports.closingInventory"), `${formatRwf(cur.closingInventoryValue)} · ${formatQty(cur.closingInventoryUnits)}`],
    [t("fin.cash"), formatRwf(cur.cashCollected)],
    [t("fin.receivables"), formatRwf(cur.receivables)],
    [t("fin.outstanding"), formatRwf(cur.outstandingExpenses)],
    [t("fin.purchases"), formatRwf(cur.inventoryPurchases)],
  ];
  const comparisonRows: [string, Delta][] = [
    [t("fin.netSales"), cmp.netSales],
    [t("fin.gross"), cmp.grossProfit],
    [t("fin.operating"), cmp.operatingProfit],
    [t("fin.resultAfterLosses"), cmp.operatingResultAfterStockLosses],
  ];
  return (
    <>
      {cur.costBasisIncomplete ? <Banner tone="warn" text={t("fin.provisional")} /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <Stat testID="sum-netSales" emphasis label={t("fin.netSales")} value={cur.netSales} delta={cmp.netSales} />
        <Stat testID="sum-cogs" label={t("fin.cogs")} value={cur.cogs} />
        <Stat testID="sum-grossProfit" label={t("fin.gross")} value={cur.grossProfit} delta={cmp.grossProfit}
          hint={cur.grossMarginBps != null ? `${t("dash.grossMargin")}: ${(cur.grossMarginBps / 100).toFixed(2)}%` : t("fin.marginUnavailable")}
          tone={cur.grossProfit < 0 ? c.danger : undefined} />
        <Stat testID="sum-expenses" label={t("fin.expenses")} value={cur.operatingExpenses} />
        <Stat testID="sum-stockLosses" label={t("fin.stockLoss")} value={cur.stockLosses} tone={cur.stockLosses > 0 ? c.danger : undefined} />
        <Stat testID="sum-result" label={t("fin.resultAfterLosses")} value={cur.operatingResultAfterStockLosses} delta={cmp.operatingResultAfterStockLosses}
          tone={cur.operatingResultAfterStockLosses < 0 ? c.danger : c.success} />
      </View>

      <Card style={{ gap: 2 }}>
        <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("reports.summaryBreakdown")}</Text>
        {rows.map(([label, value]) => (
          <View key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.line }}>
            <Text style={{ color: c.muted, fontSize: 13 }}>{label}</Text>
            <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{value}</Text>
          </View>
        ))}
      </Card>

      <Card style={{ gap: 2 }}>
        <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("reports.vsPrevious")}</Text>
        <Text style={{ color: c.muted, fontSize: 11 }}>
          {new Date(data.previousRange.from).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
          {" – "}
          {new Date(new Date(data.previousRange.to).getTime() - 1).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
        </Text>
        {comparisonRows.map(([label, d]) => (
          <View key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.line }}>
            <Text style={{ color: c.muted, fontSize: 13 }}>{label}</Text>
            <Text style={{ color: d.change >= 0 ? c.success : c.danger, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
              {d.change >= 0 ? "+" : ""}{formatRwf(d.change)}
              {d.pct === null ? ` · ${t("dash.noPrior")}` : ` · ${d.pct >= 0 ? "+" : ""}${d.pct}%`}
            </Text>
          </View>
        ))}
      </Card>

      <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("fin.calculationNote")}</Text>
    </>
  );
}
