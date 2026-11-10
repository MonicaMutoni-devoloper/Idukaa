import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { formatQty, formatRwf, kigaliDay } from "@sms/shared";
import {
  Badge, Banner, Button, ConfirmDialog, Field, KeyValue, Loading, Modal, Screen, Segmented,
} from "../../src/components/ui";
import {
  FinancialReport, InventoryReport, MovementsReport, ReportsLanding, SalesReport,
} from "../../src/components/reports";
import { useT } from "../../src/localization";
import { kvGet, kvSet } from "../../src/database";
import { ApiError, request, useSession } from "../../src/services/api";
import {
  loadFinancial, loadInventory, loadMovements, loadSales, peekCachedReport,
  type FinancialData, type InventoryData, type Loaded, type MovementsData, type ReportCategory, type SalesData,
} from "../../src/services/report-data";
import { customRange, todayDay, addDaysToDay } from "../../src/services/util";
import { periodRange, type ReportPeriod } from "../../src/services/report-period";
import { useSync } from "../../src/synchronization/engine";
import { space, type as typography, useTheme } from "../../src/theme/tokens";

/**
 * Reports & Analytics.
 *
 * The screen owns only what must survive navigation: the period, the open category, the chosen
 * subsection, and the data loaded for that category (server → saved copy → this device). Each
 * category renders through its own workspace component, and the sale dialog stays here because
 * voiding is an action on the sale itself, not part of a report.
 */

type Choice = ReportPeriod | "custom";

interface SaleLine { productId: string; name: string; code: string; unit: string; qty: number; unitPrice: number; lineAmount: number; discount?: number; net?: number }
interface SaleDetail {
  sale: { id: string; at: string; cashier: string; paymentMethod: string; status: string; grossAmount: number; discount: number; amountPaid: number; net: number; balance: number; reversedAt: string | null; reversalReason: string | null };
  lines: SaleLine[];
}

const receiptNo = (id: string) => `RC-${String(id).replace(/-/g, "").slice(0, 8).toUpperCase()}`;
const isoDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const DEFAULT_SUB: Record<ReportCategory, string> = {
  inventory: "overview", movements: "all", sales: "overview", financial: "pnl",
};

/** Dashboard drill-down links still use the old `kind` names; map them onto the new workspaces. */
const LEGACY: Record<string, { category: ReportCategory; sub?: string }> = {
  sales: { category: "sales", sub: "transactions" },
  items: { category: "sales", sub: "product" },
  purchases: { category: "movements", sub: "received" },
  expenses: { category: "financial", sub: "expenses" },
  adjustments: { category: "movements", sub: "adjust" },
  summary: { category: "financial", sub: "pnl" },
};

const RECENT_KEY = "reports.recent.v1";

export default function Reports() {
  const t = useT(); const c = useTheme();
  const { user } = useSession();
  const online = useSync((s) => s.online);
  const lastSync = useSync((s) => s.lastSync);
  const recordsVersion = useSync((s) => s.recordsVersion);
  const businessVersion = useSync((s) => s.businessVersion);
  const shopId = user?.shopId ?? null;
  const params = useLocalSearchParams<{ kind?: string; from?: string; to?: string }>();

  const paramOverride = useMemo(
    () => (params.from && params.to && params.from < params.to ? { from: params.from, to: params.to } : null),
    [params.from, params.to],
  );
  const legacy = params.kind ? LEGACY[String(params.kind)] ?? null : null;

  const [choice, setChoice] = useState<Choice>(paramOverride ? "custom" : "month");
  const [applied, setApplied] = useState(paramOverride ?? customRange(addDaysToDay(todayDay(), -29), todayDay())!);
  const [customFrom, setCustomFrom] = useState(paramOverride ? isoDay(paramOverride.from) : addDaysToDay(todayDay(), -29));
  const [customTo, setCustomTo] = useState(paramOverride ? isoDay(new Date(Date.parse(paramOverride.to) - 1).toISOString()) : todayDay());
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [category, setCategory] = useState<ReportCategory | null>(legacy?.category ?? null);
  const [subs, setSubs] = useState<Record<ReportCategory, string>>({ ...DEFAULT_SUB, ...(legacy?.sub ? { [legacy.category]: legacy.sub } : {}) });
  const [recent, setRecent] = useState<ReportCategory[]>([]);
  const [reload, setReload] = useState(0);
  const [financialsAllowed, setFinancialsAllowed] = useState(user?.role === "owner");

  const [landing, setLanding] = useState<{ sales: Loaded<SalesData>; inventory: Loaded<InventoryData> } | null>(null);
  const [loaded, setLoaded] = useState<Loaded<SalesData | InventoryData | MovementsData | FinancialData> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const loadSeq = useRef(0);
  const loadScope = useRef("");

  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<SaleDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [voidRow, setVoidRow] = useState<{ id: string; gross_amount: number; discount: number } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidBusy, setVoidBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  const range = choice === "custom" ? applied : periodRange(choice as ReportPeriod);
  const { from, to } = range;

  // Re-opening a dashboard drill-down must land on the report it names, even if the screen was
  // already mounted on another category.
  useEffect(() => {
    if (!legacy) return;
    setCategory(legacy.category);
    if (legacy.sub) setSubs((s) => ({ ...s, [legacy.category]: legacy.sub! }));
  }, [legacy?.category, legacy?.sub]);
  useEffect(() => {
    if (!paramOverride) return;
    setChoice("custom"); setApplied(paramOverride);
    setCustomFrom(isoDay(paramOverride.from));
    setCustomTo(isoDay(new Date(Date.parse(paramOverride.to) - 1).toISOString()));
  }, [paramOverride]);

  useEffect(() => {
    let alive = true;
    void kvGet(RECENT_KEY).then((raw) => {
      if (!alive || !raw) return;
      try {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) setRecent(list.filter((x): x is ReportCategory => ["inventory", "movements", "sales", "financial"].includes(x)).slice(0, 4));
      } catch { /* ignore a corrupt preference */ }
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let granted = user?.role === "owner";
      if (!granted) granted = (await kvGet(`dash.perms:${user?.id ?? "none"}`).catch(() => null)) === "1";
      if (alive) setFinancialsAllowed(granted);
    })();
    return () => { alive = false; };
  }, [user?.role, user?.id]);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    const live = () => seq === loadSeq.current;
    const ctx = { online, shopId, from, to, financials: financialsAllowed };
    // Only a different section needs its old payload cleared (the shapes differ). A new date range
    // keeps the current figures on screen and refreshes them quietly; it never blanks the report.
    const scope = `${category ?? "home"}:${shopId ?? "none"}:${financialsAllowed ? "fin" : "ops"}`;
    const scopeChanged = loadScope.current !== scope;
    if (scopeChanged) {
      loadScope.current = scope;
      setLoaded(null); setLanding(null); setLoading(true);
    }
    setRefreshing(true);
    if (category === "financial" && !financialsAllowed) {
      // Do not ask for a report the role cannot read: the server would answer 403 and the UI would
      // briefly show a failure instead of the explanation the user needs.
      setLoaded({ data: null, meta: { ...failedMeta(), forbidden: true } });
      setLoading(false); setRefreshing(false);
      return;
    }
    void (async () => {
      const viewOf = (c: ReportCategory) => c === "inventory" ? "analytics:inventory"
        : c === "movements" ? "analytics:movements" : c === "sales" ? "analytics:sales" : "analytics:financial";

      // Read the saved copy first: opening a report must show the last known figures immediately,
      // then reconcile quietly instead of replacing them with a full-screen spinner.
      if (!category) {
        const [sales, inventory] = await Promise.all([
          peekCachedReport<SalesData>(ctx, viewOf("sales")),
          peekCachedReport<InventoryData>(ctx, viewOf("inventory")),
        ]);
        if (!live()) return;
        if (sales || inventory) {
          setLanding({
            sales: sales ?? { data: null, meta: failedMeta() },
            inventory: inventory ?? { data: null, meta: failedMeta() },
          });
          setLoading(false);
        }
      } else {
        const cached = await peekCachedReport<SalesData | InventoryData | MovementsData | FinancialData>(ctx, viewOf(category));
        if (!live()) return;
        if (cached) { setLoaded(cached); setLoading(false); }
      }

      if (!category) {
        const [sales, inventory] = await Promise.all([loadSales(ctx), loadInventory(ctx)]);
        if (!live()) return;
        setLanding({ sales, inventory });
        setLoaded(null);
      } else {
        const result = category === "inventory" ? await loadInventory(ctx)
          : category === "movements" ? await loadMovements(ctx)
          : category === "sales" ? await loadSales(ctx)
          : await loadFinancial(ctx);
        if (!live()) return;
        setLoaded(result);
        setLanding(null);
      }
      if (live()) { setLoading(false); setRefreshing(false); }
    })().catch(() => {
      if (live()) { setLoading(false); setRefreshing(false); }
    });
  }, [category, from, to, online, shopId, financialsAllowed, recordsVersion, businessVersion]);
  // A rotating access token is not a data change. Server changes arrive through businessVersion,
  // local verdicts through recordsVersion; reloading here would turn token refresh into a spinner.
  useEffect(() => { load(); }, [load, reload]);

  const open = (next: ReportCategory) => {
    setCategory(next);
    setNotice(null);
    const list = [next, ...recent.filter((r) => r !== next)].slice(0, 4);
    setRecent(list);
    void kvSet(RECENT_KEY, JSON.stringify(list)).catch(() => {});
  };

  const applyCustom = () => {
    const r = customRange(customFrom, customTo);
    if (!r) { setRangeError(t("dash.invalidRange")); return; }
    setRangeError(null); setApplied(r);
  };

  const openSale = async (id: string) => {
    setDetailOpen(true); setDetail(null); setDetailFailed(false);
    let shown = false;
    // The transaction cache carries the sale lines, so a saved report can open its details with
    // no connection. The dedicated endpoint is still fetched when online for cashier/audit fields.
    const rows = category === "sales"
      ? ((loaded?.data as SalesData | undefined)?.sales ?? [])
      : (landing?.sales.data?.sales ?? []);
    const row = rows.find((r) => r.id === id);
    if (row?.lines?.length) {
      const net = Number(row.gross_amount) - Number(row.discount);
      const cachedDetail: SaleDetail = {
        sale: {
          id: row.id, at: row.at, cashier: row.by ?? "—", paymentMethod: row.payment_method,
          status: row.status, grossAmount: Number(row.gross_amount), discount: Number(row.discount),
          amountPaid: Number(row.amount_paid), net,
          balance: Math.max(0, net - Number(row.amount_paid)), reversedAt: null, reversalReason: null,
        },
        lines: row.lines.map((l) => ({ ...l, discount: 0, net: l.lineAmount })),
      };
      setDetail(cachedDetail); shown = true;
    }
    const cacheKey = `sale:${shopId ?? "none"}:${id}`;
    try {
      const raw = await kvGet(cacheKey);
      const cached = raw ? JSON.parse(raw) : null;
      if (cached?.detail) { setDetail(cached.detail); shown = true; }
    } catch { /* the report row above is still usable */ }
    try {
      const fresh = await request<SaleDetail>(`/reports/sales/${id}`);
      setDetail(fresh);
      void kvSet(cacheKey, JSON.stringify({ savedAt: new Date().toISOString(), detail: fresh })).catch(() => {});
    } catch {
      if (!shown) setDetailFailed(true);
    }
  };

  const confirmVoid = async () => {
    if (!voidRow || voidReason.trim().length < 3) return;
    setVoidBusy(true); setNotice(null);
    try {
      await request(`/sales/${voidRow.id}/void`, { method: "POST", body: { reason: voidReason.trim() } });
      setVoidRow(null); setVoidReason("");
      setNotice({ tone: "ok", text: t("reports.voided") });
      setReload((n) => n + 1);
    } catch (e: any) {
      const message = e?.body?.message;
      setNotice({ tone: "danger", text: message === "sale_already_reversed" ? t("reports.alreadyVoided") : t("reports.voidFailed") });
    } finally { setVoidBusy(false); }
  };

  const shopLabel = user?.name || t("ana.shopFallback");
  const sub = category ? subs[category] : null;
  const setSub = (v: string) => { if (category) setSubs((s) => ({ ...s, [category]: v })); };

  return (
    <Screen title={category ? undefined : t("ana.title")} subtitle={category ? undefined : t("ana.subtitle")} actions={
      <>
        <Segmented<Choice> label={t("common.period")} value={choice} onChange={(v) => { setChoice(v); setRangeError(null); }} options={[
          { value: "today", label: t("common.today") },
          { value: "yesterday", label: t("common.yesterday") },
          { value: "week", label: t("common.week") },
          { value: "month", label: t("common.month") },
          { value: "lastMonth", label: t("common.lastMonth") },
          { value: "year", label: t("common.year") },
          { value: "custom", label: t("reports.custom") },
        ]} />
      </>
    }>
      {choice === "custom" ? (
        <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
          <Field testID="reports-from" label={t("common.from")} value={customFrom} onChangeText={setCustomFrom} placeholder="YYYY-MM-DD" />
          <Field testID="reports-to" label={t("common.to")} value={customTo} onChangeText={setCustomTo} placeholder="YYYY-MM-DD" />
          <View style={{ justifyContent: "flex-end", paddingBottom: 1 }}><Button testID="reports-apply" label={t("common.apply")} onPress={applyCustom} /></View>
          {rangeError ? <Text style={{ color: c.danger, fontSize: 12, alignSelf: "center" }}>{rangeError}</Text> : null}
        </View>
      ) : null}
      {/* The inclusive Kigali business dates behind every figure, so the period is never implicit. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <Text testID="reports-range" style={{ color: c.muted, fontSize: 12 }}>
          {kigaliDay(from)} → {kigaliDay(Date.parse(to) - 1)}
        </Text>
        {refreshing && !loading ? (
          <View testID="reports-refreshing" style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <ActivityIndicator size="small" color={c.muted} />
            <Text style={{ color: c.muted, fontSize: 11 }}>{t("common.loading")}</Text>
          </View>
        ) : null}
      </View>

      {notice ? <Banner tone={notice.tone} text={notice.text} /> : null}

      {loading ? <Loading /> : category === null ? (
        <ReportsLanding
          from={from} to={to} online={online} lastSync={lastSync}
          sales={landing?.sales.data ?? null} salesMeta={landing?.sales.meta ?? failedMeta()}
          inventory={landing?.inventory.data ?? null} inventoryMeta={landing?.inventory.meta ?? failedMeta()}
          recent={recent} onOpen={open} onRefresh={() => setReload((n) => n + 1)}
        />
      ) : category === "inventory" ? (
        <InventoryReport data={(loaded?.data as InventoryData) ?? null} meta={loaded?.meta ?? failedMeta()} online={online} lastSync={lastSync}
          from={from} to={to} view={(sub as any) ?? "overview"} setView={setSub as any}
          onBack={() => setCategory(null)} onRetry={() => setReload((n) => n + 1)} shop={shopLabel} />
      ) : category === "movements" ? (
        <MovementsReport data={(loaded?.data as MovementsData) ?? null} meta={loaded?.meta ?? failedMeta()} online={online} lastSync={lastSync}
          from={from} to={to} view={(sub as any) ?? "all"} setView={setSub as any}
          onBack={() => setCategory(null)} onRetry={() => setReload((n) => n + 1)} shop={shopLabel} />
      ) : category === "sales" ? (
        <SalesReport data={(loaded?.data as SalesData) ?? null} meta={loaded?.meta ?? failedMeta()} online={online} lastSync={lastSync}
          from={from} to={to} view={(sub as any) ?? "overview"} setView={setSub as any}
          onBack={() => setCategory(null)} onRetry={() => setReload((n) => n + 1)} shop={shopLabel}
          onOpenSale={(id) => void openSale(id)} />
      ) : (
        <FinancialReport data={(loaded?.data as FinancialData) ?? null} meta={loaded?.meta ?? failedMeta()} online={online} lastSync={lastSync}
          from={from} to={to} view={(sub as any) ?? "pnl"} setView={setSub as any}
          onBack={() => setCategory(null)} onRetry={() => setReload((n) => n + 1)} shop={shopLabel}
          financialsAllowed={financialsAllowed} />
      )}

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
              <Badge tone={detail.sale.status === "reversed" ? "danger" : "ok"} label={t(detail.sale.status === "reversed" ? "reports.reversed" : "reports.posted")} />
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
            <Text style={{ color: c.muted, ...typography.caption, textTransform: "uppercase" }}>{t("reports.items")}</Text>
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

const failedMeta = (): Loaded<never>["meta"] => ({
  source: null, savedAt: null, savedLocally: false, pendingOps: 0, authIssue: false, forbidden: false, failed: true,
});
