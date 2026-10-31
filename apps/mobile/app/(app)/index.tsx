import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { formatQty, formatRwf } from "@sms/shared";
import { Badge, Banner, Button, Card, Empty, ErrorState, Field, Screen, Segmented, Skeleton, useWide } from "../../src/components/ui";
import { BarList, CompareBars, ProductRanking, StockHealthBar, TrendBars } from "../../src/components/charts";
import { Appear, Disclosure, useCountUp } from "../../src/components/motion";
import { useT, type Key } from "../../src/localization";
import { kvGet, kvSet } from "../../src/database";
import { request, useSession } from "../../src/services/api";
import { addDaysToDay, customRange, presetRange, todayDay, type Preset } from "../../src/services/util";
import { useSync } from "../../src/synchronization/engine";
import { motion, space, type, useTheme } from "../../src/theme/tokens";

type Period = Preset | "custom";

interface Snapshot {
  range: { from: string; to: string };
  netSales: number; cogs: number; grossProfit: number; grossMarginBps: number | null;
  operatingExpenses: number; operatingProfit: number; stockLosses: number;
  operatingResultAfterStockLosses: number; transactions: number; costBasisIncomplete: boolean;
}
interface MonthlyRow {
  month: string; year: number; monthNumber: number;
  netSales: number; cogs: number; operatingExpenses: number; stockLosses: number; operatingResult: number;
}
interface ProfitRow {
  productId: string; name: string; units: number; revenue: number;
  grossProfit?: number; grossMarginBps: number | null;
  sellingPrice?: number; avgCost?: number; belowCost?: boolean;
}
interface Financials {
  grossSales: number; discounts: number; salesReturns: number; netSales: number; cogs: number;
  grossProfit: number; grossMarginBps: number | null; operatingExpenses: number; operatingProfit: number;
  inventoryPurchases: number; stockLossValue: number; outstandingExpenses: number; expensesPaid: number;
  // Added by the finance layer; optional so a payload cached by an older build still renders.
  stockLosses?: number; operatingResultAfterStockLosses?: number; costBasisIncomplete?: boolean;
  snapshots?: { today: Snapshot; month: Snapshot; year: Snapshot } | null;
  monthly?: MonthlyRow[] | null;
  topProductsByProfit?: ProfitRow[];
  lowMarginProducts?: ProfitRow[];
}
interface Operations {
  netSales: number; transactions: number; unitsSold: number; averageTransaction: number;
  cashCollected: number; receivables: number; grossSales: number; discounts: number;
  deliveries: number; productsReceived: number; unitsReceived: number;
  pendingReceipts: number; inventoryValue: number | null; lowStockCount: number; outOfStockCount: number;
  productCount: number; supplierPayables: number; pendingApprovals: number; openInvestigations: number; openConflicts: number;
}
interface Change { change: number; pct: number | null }
interface ActivityRow {
  id: number; at: string; action: string; entity: string; reason: string | null; actor: string | null;
  productName: string | null; saleTotal: number | null; purchaseTotal: number | null; purchaseReference: string | null;
}
interface Dashboard {
  role: "owner" | "manager";
  permissions: { financials: boolean };
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

const ACTION_KEYS: Record<string, Key> = {
  "op.sale.create": "dash.act.sale",
  "op.receipt.create": "dash.act.receipt",
  "op.purchase.create": "dash.act.purchase",
  "op.expense.create": "dash.act.expense",
  "op.count.submit": "dash.act.count",
  "op.adjustment.request": "dash.act.adjustment",
  "op.product.upsert": "dash.act.product",
  "product.create": "dash.act.productCreate",
  "product.update": "dash.act.product",
  "op.supplier.upsert": "dash.act.supplier",
  "adjustment.approved": "dash.act.approved",
  "adjustment.rejected": "dash.act.rejected",
  "conflict.resolved": "dash.act.conflictResolved",
  "investigation.update": "dash.act.investigation",
  "purchase.below_cost": "dash.act.belowCost",
  "sale.void": "dash.act.void",
  "sale.discount": "dash.act.discount",
  "product.price_from_purchase": "dash.act.price",
  "shop.policy.update": "dash.act.policy",
};

function Kpi({ label, value, format, delta, hint, tone, emphasis, testID }: {
  label: string; value: number; format?: (n: number) => string; delta?: Change | null; hint?: string;
  tone?: string; emphasis?: boolean; testID?: string;
}) {
  const c = useTheme();
  const t = useT();
  const shown = useCountUp(Number.isFinite(value) ? value : 0);
  const fmt = format ?? formatRwf;
  const good = delta ? delta.change >= 0 : true;
  return (
    <Card style={{ flexGrow: 1, flexBasis: emphasis ? 220 : 158, gap: 4, padding: space.lg }}>
      <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{label}</Text>
      <Text testID={testID} style={{ color: tone ?? (emphasis ? c.ink : c.inkSoft), ...(emphasis ? type.moneyLarge : type.money) }}>{fmt(shown)}</Text>
      {hint ? <Text style={{ color: c.muted, fontSize: 12 }}>{hint}</Text> : null}
      {delta ? (
        delta.pct === null
          ? <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.noPrior")}</Text>
          : <Text style={{ color: good ? c.success : c.danger, fontSize: 12, fontWeight: "600" }}>
              {good ? "▲" : "▼"} {Math.abs(delta.pct)}% <Text style={{ color: c.muted, fontWeight: "400" }}>{t("fin.vsPrev")}</Text>
            </Text>
      ) : null}
    </Card>
  );
}

function QuickAction({ label, onPress, primary, testID }: { label: string; onPress: () => void; primary?: boolean; testID?: string }) {
  const c = useTheme();
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ hovered, pressed, focused }: any) => ({
        flexGrow: 1, flexBasis: 132, minHeight: 44, paddingHorizontal: space.md, borderRadius: 8,
        alignItems: "center", justifyContent: "center", backgroundColor: primary ? c.primaryStrong : c.surface,
        borderWidth: focused ? 2 : 1, borderColor: focused ? c.focus : primary ? c.primaryStrong : c.lineStrong,
        opacity: pressed ? 0.85 : hovered ? 0.95 : 1,
      })}>
      <Text style={{ color: primary ? c.onPrimary : c.ink, fontWeight: "600", fontSize: 13, textAlign: "center" }}>{label}</Text>
    </Pressable>
  );
}

export default function Home() {
  const t = useT();
  const c = useTheme();
  const wide = useWide();
  const router = useRouter();
  const user = useSession((s) => s.user);
  const online = useSync((s) => s.online);
  const lastSync = useSync((s) => s.lastSync);
  const isOwner = user?.role === "owner";

  const [period, setPeriod] = useState<Period>(isOwner ? "month" : "today");
  const [customFrom, setCustomFrom] = useState(addDaysToDay(todayDay(), -6));
  const [customTo, setCustomTo] = useState(todayDay());
  const [appliedCustom, setAppliedCustom] = useState(() => customRange(addDaysToDay(todayDay(), -6), todayDay()));
  const [customError, setCustomError] = useState<string | null>(null);
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [staleAt, setStaleAt] = useState<string | null>(null);
  const [trendMetric, setTrendMetric] = useState<"sales" | "profit">("sales");

  const range = useMemo(() => (period === "custom" ? appliedCustom : presetRange(period)), [period, appliedCustom]);

  const load = useCallback(async () => {
    if (!range) return;
    setLoading(true); setFailed(false);
    const key = `dashboard:${user?.role}:${range.from}:${range.to}`;
    try {
      const res = await request<Dashboard>(`/reports/dashboard?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, { auth: true });
      setData(res); setStaleAt(null);
      void kvSet(key, JSON.stringify({ savedAt: new Date().toISOString(), data: res })).catch(() => {});
    } catch {
      setFailed(true);
      try {
        const raw = await kvGet(key);
        if (raw) { const cached = JSON.parse(raw); if (cached?.data) { setData(cached.data); setStaleAt(cached.savedAt ?? null); } }
      } catch { /* leave the previous data in place */ }
    } finally {
      setLoading(false);
    }
  }, [range, user?.role]);

  useEffect(() => { void load(); }, [load, lastSync]);

  const applyCustom = () => {
    const r = customRange(customFrom, customTo);
    if (!r) { setCustomError(t("dash.invalidRange")); return; }
    setCustomError(null); setAppliedCustom(r);
  };

  const periodLabel = useMemo(() => {
    if (period === "custom") return `${customFrom} – ${customTo}`;
    return t(period === "today" ? "common.today" : period === "yesterday" ? "common.yesterday" : period === "week" ? "common.week" : period === "month" ? "common.month" : "common.year");
  }, [period, customFrom, customTo, t]);

  const ops = data?.operations;
  const fin = data?.financials;
  const outCount = ops?.outOfStockCount ?? 0;
  const lowOnly = Math.max(0, (ops?.lowStockCount ?? 0) - outCount);
  const issueCount = ops ? lowOnly + outCount + ops.pendingApprovals + ops.openInvestigations + ops.openConflicts : 0;
  const inStock = Math.max(0, (ops?.productCount ?? 0) - (ops?.lowStockCount ?? 0));
  const chartData = (data?.trend ?? []).map((p) => ({ ...p, netSales: trendMetric === "profit" ? (p.grossProfit ?? 0) : p.netSales }));
  const chartMode: "day" | "month" = data && (Date.parse(data.range.to) - Date.parse(data.range.from)) / 86_400_000 > 400 ? "month" : "day";

  const actionLabel = (action: string) => {
    const key = ACTION_KEYS[action];
    return key ? t(key) : action.replace(/^op\./, "").replace(/[._]/g, " ");
  };

  return (
    <Screen title={t("home.dashboard")} subtitle={isOwner ? t("home.ownerSubtitle") : t("home.managerSubtitle")}
      actions={
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Badge dot tone={online ? "ok" : "warn"} label={online ? t("sync.online") : t("sync.offline")} />
          {loading && data ? <ActivityIndicator size="small" color={c.muted} /> : null}
        </View>
      }>
      <View style={{ flexDirection: wide ? "row" : "column", alignItems: wide ? "center" : "stretch", gap: space.md }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("common.period")}</Text>
          <Text style={{ color: c.inkSoft, fontSize: 13 }}>
            {periodLabel} · {new Date(data?.range?.from ?? range?.from ?? Date.now()).toLocaleDateString(undefined, { day: "2-digit", month: "short" })}
            {data?.range ? ` – ${new Date(new Date(data.range.to).getTime() - 1).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}` : ""}
          </Text>
        </View>
        <Segmented<Period> label={t("common.period")} value={period} onChange={(p) => { setPeriod(p); setCustomError(null); }} options={[
          { value: "today", label: t("common.today") },
          { value: "yesterday", label: t("common.yesterday") },
          { value: "week", label: t("common.week") },
          { value: "month", label: t("common.month") },
          { value: "year", label: t("common.year") },
          { value: "custom", label: t("dash.custom") },
        ]} />
      </View>

      {period === "custom" ? (
        <Card style={{ gap: space.md }}>
          <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
            <Field testID="dash-from" label={t("common.from")} value={customFrom} onChangeText={setCustomFrom} placeholder="YYYY-MM-DD" />
            <Field testID="dash-to" label={t("common.to")} value={customTo} onChangeText={setCustomTo} placeholder="YYYY-MM-DD" />
            <View style={{ justifyContent: "flex-end", paddingBottom: 1 }}>
              <Button testID="dash-apply" label={t("common.apply")} onPress={applyCustom} />
            </View>
          </View>
          {customError ? <Text style={{ color: c.danger, fontSize: 12 }}>{customError}</Text> : null}
        </Card>
      ) : null}

      {!online ? <Banner tone="warn" text={staleAt ? t("dash.cachedAt").replace("{time}", new Date(staleAt).toLocaleString()) : t("home.cachedData")} /> : null}
      {failed && data ? <Banner tone="warn" text={t("dash.staleBanner")} /> : null}

      <Card tone="muted" style={{ gap: space.sm }}>
        <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("home.quickActions")}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          <QuickAction testID="home-action-sell" primary label={t("nav.sell")} onPress={() => router.push("/sell")} />
          <QuickAction testID="home-action-stock" label={t("nav.stock")} onPress={() => router.push("/stock")} />
          <QuickAction testID="home-action-expense" label={t("nav.expense")} onPress={() => router.push("/expense")} />
          {user?.role !== "owner" ? <QuickAction testID="home-action-count" label={t("stock.count")} onPress={() => router.push({ pathname: "/stock", params: { count: "1" } })} /> : null}
        </View>
      </Card>

      {loading && !data ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} height={98} width="23%" style={{ minWidth: 150, flexGrow: 1 }} />)}
        </View>
      ) : failed && !data ? (
        <ErrorState text={t("home.loadError")} onRetry={() => void load()} />
      ) : !data || !ops ? (
        <Loading />
      ) : (
        <>
          {fin ? (
            <>
              {fin.costBasisIncomplete ? <Banner tone="warn" text={t("fin.provisional")} /> : null}
              {fin.snapshots ? (
                <Card style={{ gap: space.sm }}>
                  <View style={{ gap: 2 }}>
                    <Text style={{ color: c.ink, ...type.h2 }}>{t("dash.headlines")}</Text>
                    <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.headlinesHint")}</Text>
                  </View>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                    <Kpi testID="kpi-todayNetSales" label={t("dash.todayNetSales")} value={fin.snapshots.today.netSales} hint={t("common.today")} />
                    <Kpi label={t("dash.todayProfit")} value={fin.snapshots.today.grossProfit}
                      hint={fin.snapshots.today.grossMarginBps != null ? `${t("dash.grossMargin")}: ${(fin.snapshots.today.grossMarginBps / 100).toFixed(1)}%` : t("fin.marginUnavailable")}
                      tone={fin.snapshots.today.grossProfit < 0 ? c.danger : undefined} />
                    <Kpi testID="kpi-todayResult" label={t("dash.todayResult")} value={fin.snapshots.today.operatingResultAfterStockLosses}
                      tone={fin.snapshots.today.operatingResultAfterStockLosses < 0 ? c.danger : c.success} />
                    <Kpi testID="kpi-monthResult" label={t("dash.monthResult")} value={fin.snapshots.month.operatingResultAfterStockLosses}
                      tone={fin.snapshots.month.operatingResultAfterStockLosses < 0 ? c.danger : c.success} />
                    <Kpi testID="kpi-yearResult" label={t("dash.yearResult")} value={fin.snapshots.year.operatingResultAfterStockLosses}
                      tone={fin.snapshots.year.operatingResultAfterStockLosses < 0 ? c.danger : c.success} />
                  </View>
                </Card>
              ) : null}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Kpi testID="kpi-netSales" emphasis label={t("fin.netSales")} value={fin.netSales} delta={data.financialComparison?.netSales} />
                <Kpi label={t("fin.cogs")} value={fin.cogs} hint={t("fin.cogs")} />
                <Kpi label={t("fin.gross")} value={fin.grossProfit} delta={data.financialComparison?.grossProfit}
                  hint={fin.grossMarginBps != null ? `${t("dash.grossMargin")}: ${(fin.grossMarginBps / 100).toFixed(1)}%` : t("fin.marginUnavailable")}
                  tone={fin.grossProfit < 0 ? c.danger : undefined} />
                <Kpi label={t("fin.operating")} value={fin.operatingProfit} delta={data.financialComparison?.operatingProfit}
                  tone={fin.operatingProfit < 0 ? c.danger : c.success} />
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Kpi label={t("fin.cash")} value={ops.cashCollected} hint={t("dash.cashCollectedHint")} />
                <Kpi label={t("fin.receivables")} value={ops.receivables} tone={ops.receivables > 0 ? c.accent : undefined} hint={t("dash.receivablesHint")} />
                <Kpi label={t("fin.expenses")} value={fin.operatingExpenses} hint={`${t("fin.outstanding")}: ${formatRwf(fin.outstandingExpenses)}`} />
                <Kpi label={t("fin.purchases")} value={fin.inventoryPurchases}
                  hint={`${t("dash.supplierPayables")}: ${formatRwf(ops.supplierPayables)}`} />
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Kpi testID="kpi-stockLosses" label={t("fin.stockLoss")} value={fin.stockLosses ?? fin.stockLossValue ?? 0}
                  tone={(fin.stockLosses ?? fin.stockLossValue ?? 0) > 0 ? c.danger : undefined} hint={t("fin.stockLossHint")} />
                <Kpi testID="kpi-invValue" label={t("fin.invValue")} value={ops.inventoryValue ?? 0} hint={t("dash.inventoryHint")} />
                <Kpi testID="kpi-resultAfterLosses" label={t("fin.resultAfterLosses")}
                  value={fin.operatingResultAfterStockLosses ?? fin.operatingProfit}
                  hint={t("fin.resultAfterLossesHint")}
                  tone={(fin.operatingResultAfterStockLosses ?? fin.operatingProfit) < 0 ? c.danger : c.success} />
              </View>
            </>
          ) : (
            <>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Kpi testID="kpi-netSales" emphasis label={t("fin.netSales")} value={ops.netSales} delta={data.salesComparison?.netSales} />
                <Kpi label={t("dash.transactions")} value={ops.transactions} format={(n) => String(n)} hint={periodLabel} />
                <Kpi label={t("dash.unitsSold")} value={ops.unitsSold} format={(n) => formatQty(n)} hint={t("dash.unitsSoldHint")} />
                <Kpi label={t("dash.avgSale")} value={ops.averageTransaction} hint={t("dash.avgSaleHint")} />
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Kpi label={t("fin.cash")} value={ops.cashCollected} hint={t("dash.cashCollectedHint")} />
                <Kpi label={t("dash.outstandingBalance")} value={ops.receivables} tone={ops.receivables > 0 ? c.accent : undefined} hint={t("dash.receivablesHint")} />
                {ops.inventoryValue !== null
                  ? <Kpi label={t("fin.invValue")} value={ops.inventoryValue} hint={t("dash.inventoryHint")} />
                  : <Kpi label={t("dash.catalogue")} value={ops.productCount} format={(n) => String(n)} hint={t("dash.catalogueHint")} />}
                <Kpi label={t("dash.productsReceived")} value={ops.unitsReceived} format={(n) => formatQty(n)}
                  hint={`${ops.deliveries} ${t("dash.deliveries")} · ${ops.productsReceived} ${t("dash.products")}`} />
              </View>
            </>
          )}

          {data.permissions?.financials && range ? (
            <Card style={{ gap: space.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
                <View style={{ flex: 1, gap: 2, minWidth: 160 }}>
                  <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("dash.drilldown")}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.drilldownHint")}</Text>
                </View>
                {(["sales", "purchases", "expenses", "adjustments"] as const).map((kind) => (
                  <Button key={kind} size="sm" kind="secondary"
                    label={t(kind === "sales" ? "common.sales" : kind === "purchases" ? "common.purchases" : kind === "expenses" ? "common.expenses" : "dash.stockLosses")}
                    onPress={() => router.push(`/reports?kind=${kind}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` as any)} />
                ))}
                <Button key="profitability" size="sm" label={t("nav.profitability")} onPress={() => router.push("/profitability" as any)} />
              </View>
            </Card>
          ) : null}

          <Card tone={issueCount ? "warn" : "ok"} style={{ gap: space.md }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: c.ink, ...type.h3 }}>{t("dash.actionable")}</Text>
                <Text style={{ color: c.muted, fontSize: 12 }}>{issueCount ? t("dash.actionableHint") : t("dash.allClearDesc")}</Text>
              </View>
              <Badge tone={issueCount ? "warn" : "ok"} label={String(issueCount)} />
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {[
                { label: t("home.productsLow"), n: lowOnly },
                { label: t("home.productsOut"), n: outCount },
                { label: t("dash.pendingApprovals"), n: ops.pendingApprovals },
                { label: t("dash.openInvestigations"), n: ops.openInvestigations },
                { label: t("dash.openConflicts"), n: ops.openConflicts },
              ].map((s) => (
                <View key={s.label} style={{ minWidth: 130, flexGrow: 1, flexBasis: 120, padding: space.sm, borderRadius: 8, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, gap: 2 }}>
                  <Text style={{ color: s.n ? c.ink : c.muted, ...type.money }}>{s.n}</Text>
                  <Text style={{ color: c.muted, fontSize: 11 }}>{s.label}</Text>
                </View>
              ))}
            </View>
            <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
              <Button size="sm" kind="secondary" label={t("home.viewStock")} onPress={() => router.push("/stock")} />
              {isOwner ? <Button size="sm" label={t("dash.reviewApprovals")} onPress={() => router.push("/approvals")} /> : (
                <Button size="sm" label={t("nav.sync")} onPress={() => router.push("/sync")} />
              )}
            </View>
          </Card>

          <View style={{ flexDirection: wide ? "row" : "column", gap: space.md, alignItems: "stretch" }}>
            <Card style={{ flex: wide ? 1.5 : undefined, gap: space.md, minWidth: 0 }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: space.sm }}>
                <View style={{ flex: 1, gap: 2, minWidth: 150 }}>
                  <Text style={{ color: c.ink, ...type.h2 }}>{trendMetric === "profit" ? t("dash.profitTrend") : t("dash.salesTrend")}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>
                    {trendMetric === "profit" ? `${periodLabel} · ${t("dash.profitTrendHint")}` : `${periodLabel} · ${t("dash.trendHint")}`}
                  </Text>
                </View>
                {data.permissions?.financials ? (
                  <Segmented value={trendMetric} onChange={setTrendMetric} label={t("dash.trendMetric")} options={[
                    { value: "sales", label: t("fin.netSales") },
                    { value: "profit", label: t("fin.gross") },
                  ]} />
                ) : null}
              </View>
              {chartData.some((p) => p.netSales !== 0)
                ? <TrendBars data={chartData} label={trendMetric === "profit" ? t("fin.gross") : t("fin.netSales")} pointsLabel={t("dash.transactions")} />
                : <Empty icon="chart" title={t("dash.noSales")} description={t("dash.noSalesDesc")}
                    action={<Button testID="dash-record-sale" label={t("dash.recordSale")} onPress={() => router.push("/sell")} />} />}
            </Card>
            <Card style={{ flex: 1, gap: space.md, minWidth: 0 }}>
              <View style={{ gap: 2 }}>
                <Text style={{ color: c.ink, ...type.h2 }}>{t("dash.topProducts")}</Text>
                <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.topProductsHint")}</Text>
              </View>
              <ProductRanking items={data.topProducts} emptyLabel={t("dash.noSales")} valueLabel={t("common.total")} />
            </Card>
          </View>

          {fin ? (
            <View style={{ flexDirection: wide ? "row" : "column", gap: space.md, alignItems: "stretch" }}>
              <Card style={{ flex: wide ? 1.5 : undefined, gap: space.md, minWidth: 0 }}>
                <View style={{ gap: 2 }}>
                  <Text style={{ color: c.ink, ...type.h2 }}>{t("dash.gpVsExpenses")}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.gpVsExpensesHint")}</Text>
                </View>
                {data.trend.some((p) => (p.grossProfit ?? 0) !== 0 || (p.operatingExpenses ?? 0) !== 0)
                  ? <CompareBars data={data.trend.map((p) => ({ date: p.date, a: p.grossProfit ?? 0, b: p.operatingExpenses ?? 0 }))}
                      labelA={t("fin.gross")} labelB={t("fin.expenses")} labelMode={chartMode} />
                  : <Empty icon="chart" title={t("dash.noSales")} description={t("dash.noExpensesDesc")} />}
              </Card>
              <Card style={{ flex: 1, gap: space.md, minWidth: 0 }}>
                <View style={{ gap: 2 }}>
                  <Text style={{ color: c.ink, ...type.h2 }}>{t("dash.monthlyResult")}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.monthlyResultHint")}</Text>
                </View>
                {fin.monthly && fin.monthly.some((m) => m.netSales !== 0 || m.operatingExpenses !== 0)
                  ? <TrendBars data={fin.monthly.map((m) => ({ date: m.month, netSales: m.operatingResult, transactions: 0 }))}
                      label={t("fin.resultAfterLosses")} labelMode="month" showCount={false} />
                  : <Empty title={t("dash.noSales")} description={t("dash.noSalesDesc")} />}
              </Card>
            </View>
          ) : null}

          {fin ? (
            <View style={{ flexDirection: wide ? "row" : "column", gap: space.md, alignItems: "stretch" }}>
              <Card style={{ flex: 1, gap: space.md, minWidth: 0 }}>
                <View style={{ gap: 2 }}>
                  <Text style={{ color: c.ink, ...type.h2 }}>{t("dash.topByProfit")}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.topByProfitHint")}</Text>
                </View>
                {(fin.topProductsByProfit ?? []).length ? (fin.topProductsByProfit ?? []).map((p) => (
                  <View key={p.productId} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: c.line }}>
                    <Text numberOfLines={1} style={{ color: c.ink, fontSize: 13, flex: 1 }}>{p.name}</Text>
                    <Text style={{ color: (p.grossProfit ?? 0) < 0 ? c.danger : c.success, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatRwf(p.grossProfit ?? 0)}</Text>
                    <Text style={{ color: c.muted, fontSize: 11, width: 52, textAlign: "right" }}>{p.grossMarginBps != null ? `${(p.grossMarginBps / 100).toFixed(0)}%` : "—"}</Text>
                  </View>
                )) : <Empty title={t("dash.noSales")} description={t("dash.noSalesDesc")} />}
              </Card>
              <Card style={{ flex: 1, gap: space.md, minWidth: 0 }}>
                <View style={{ gap: 2 }}>
                  <Text style={{ color: c.ink, ...type.h2 }}>{t("dash.lowMargin")}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.lowMarginHint")}</Text>
                </View>
                {(fin.lowMarginProducts ?? []).length ? (fin.lowMarginProducts ?? []).map((p) => (
                  <View key={p.productId} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: c.line }}>
                    <Text numberOfLines={1} style={{ color: c.ink, fontSize: 13, flex: 1 }}>{p.name}</Text>
                    {p.belowCost ? <Badge tone="danger" label={t("receive.belowCostBadge")} /> : null}
                    <Text style={{ color: c.danger, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"], minWidth: 52, textAlign: "right" }}>
                      {p.grossMarginBps != null ? `${(p.grossMarginBps / 100).toFixed(1)}%` : "—"}
                    </Text>
                  </View>
                )) : <Empty title={t("dash.noLowMargin")} description={t("dash.noLowMarginDesc")} />}
              </Card>
            </View>
          ) : null}

          <View style={{ flexDirection: wide ? "row" : "column", gap: space.md, alignItems: "stretch" }}>
            <Card style={{ flex: 1, gap: space.md, minWidth: 0 }}>
              <View style={{ gap: 2 }}>
                <Text style={{ color: c.ink, ...type.h2 }}>{t("dash.stockHealth")}</Text>
                <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.stockHealthHint")}</Text>
              </View>
              <StockHealthBar inStock={inStock} low={lowOnly} out={outCount} label={t("dash.stockHealth")} />
              {data.lowStock.length ? (
                <View style={{ gap: 2 }}>
                  {data.lowStock.map((p) => (
                    <View key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: c.line }}>
                      <Text numberOfLines={1} style={{ color: c.ink, fontSize: 13, flex: 1 }}>{p.name}</Text>
                      <Badge tone={p.onHand <= 0 ? "danger" : "warn"} dot label={`${formatQty(p.onHand)} ${p.unit}`} />
                    </View>
                  ))}
                </View>
              ) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("home.noLowStockDesc")}</Text>}
            </Card>

            <Card style={{ flex: 1.25, gap: space.md, minWidth: 0 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: c.ink, ...type.h2 }}>{t("home.recentActivity")}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.activityHint")}</Text>
                </View>
              </View>
              {data.activity.length ? data.activity.slice(0, 7).map((a, i) => (
                <Appear key={a.id} index={i}>
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: 7, borderTopWidth: 1, borderTopColor: c.line }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, marginTop: 5, backgroundColor: a.action.startsWith("adjustment") || a.action.startsWith("conflict") ? c.accent : a.action.startsWith("op.") ? c.primary : c.lineStrong }} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{actionLabel(a.action)}</Text>
                    <Text numberOfLines={1} style={{ color: c.muted, fontSize: 11 }}>
                      {a.productName ?? a.purchaseReference ?? a.reason ?? t("appr.entity")}
                      {a.saleTotal !== null ? ` · ${formatRwf(a.saleTotal)}` : a.purchaseTotal !== null ? ` · ${formatRwf(a.purchaseTotal)}` : ""}
                    </Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 1, maxWidth: 150 }}>
                    <Text numberOfLines={1} style={{ color: c.inkSoft, fontSize: 11, fontWeight: "600" }}>{a.actor ?? t("common.none")}</Text>
                    <Text style={{ color: c.muted, fontSize: 10 }}>{new Date(a.at).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</Text>
                  </View>
                </View>
                </Appear>
              )) : <Empty icon="checkSquare" title={t("appr.noActivity")} description={t("dash.noActivityDesc")} />}
            </Card>
          </View>

          {fin && data.expensesByCategory.length ? (
            <Card style={{ gap: space.md }}>
              <View style={{ gap: 2 }}>
                <Text style={{ color: c.ink, ...type.h2 }}>{t("dash.expensesByCategory")}</Text>
                <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.expensesByCategoryHint")}</Text>
              </View>
              <BarList items={data.expensesByCategory.map((e) => ({ key: e.category, label: e.category, value: e.amount }))} emptyLabel={t("common.empty")} />
            </Card>
          ) : null}

          {fin ? (
            <Disclosure title={t("dash.financialDetail")} description={t("dash.financialDetailHint")} testID="dash-financial-detail">
              <View style={{ padding: space.lg, gap: 2 }}>
                {[
                  { label: t("fin.netSales"), value: formatRwf(fin.netSales) },
                  { label: `${t("fin.cogs")}`, value: formatRwf(fin.cogs) },
                  { label: t("fin.gross"), value: formatRwf(fin.grossProfit) },
                  { label: t("fin.expenses"), value: formatRwf(fin.operatingExpenses) },
                  { label: t("fin.operating"), value: formatRwf(fin.operatingProfit) },
                  { label: t("fin.resultAfterLosses"), value: formatRwf(fin.operatingResultAfterStockLosses ?? fin.operatingProfit - (fin.stockLosses ?? fin.stockLossValue ?? 0)) },
                  { label: t("dash.discounts"), value: formatRwf(fin.discounts) },
                  { label: t("dash.returns"), value: formatRwf(fin.salesReturns) },
                  { label: t("fin.stockLoss"), value: formatRwf(fin.stockLosses ?? fin.stockLossValue ?? 0) },
                  { label: t("fin.purchases"), value: formatRwf(fin.inventoryPurchases) },
                  { label: t("fin.outstanding"), value: formatRwf(fin.outstandingExpenses) },
                ].map((r) => (
                  <View key={r.label} style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.line }}>
                    <Text style={{ color: c.muted, fontSize: 13 }}>{r.label}</Text>
                    <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{r.value}</Text>
                  </View>
                ))}
                {data.expensesByCategory?.length ? (
                  <View style={{ gap: 2, marginTop: space.md }}>
                    <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("dash.expensesByCategory")}</Text>
                    {data.expensesByCategory.map((e) => (
                      <View key={e.category} style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.line }}>
                        <Text style={{ color: c.muted, fontSize: 13 }}>{e.category}</Text>
                        <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
                          {formatRwf(e.amount)}
                          {e.unpaid > 0 ? <Text style={{ color: c.accent, fontWeight: "400" }}>{` · ${t("common.unpaid")} ${formatRwf(e.unpaid)}`}</Text> : null}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18, marginTop: space.sm }}>{t("fin.calculationNote")}</Text>
              </View>
            </Disclosure>
          ) : null}

          <View style={{ flexDirection: wide ? "row" : "column", gap: space.md, alignItems: "stretch" }}>
            {data.worstProducts.length > 1 ? (
              <Card style={{ flex: 1, gap: space.md, minWidth: 0 }}>
                <View style={{ gap: 2 }}>
                  <Text style={{ color: c.ink, ...type.h2 }}>{t("dash.worstProducts")}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.worstProductsHint")}</Text>
                </View>
                <ProductRanking items={data.worstProducts} emptyLabel={t("dash.noSales")} valueLabel={t("common.total")} />
              </Card>
            ) : null}
            <Card style={{ flex: 1, gap: space.md, minWidth: 0 }}>
              <View style={{ gap: 2 }}>
                <Text style={{ color: c.ink, ...type.h2 }}>{t("dash.staffActivity")}</Text>
                <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.staffActivityHint")}</Text>
              </View>
              {data.staffActivity.length ? data.staffActivity.map((s) => (
                <View key={s.actor} style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 7, borderTopWidth: 1, borderTopColor: c.line }}>
                  <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: c.primarySoft, alignItems: "center", justifyContent: "center" }}>
                    <Text style={{ color: c.primaryStrong, fontWeight: "800", fontSize: 11 }}>{s.actor.slice(0, 1).toUpperCase()}</Text>
                  </View>
                  <Text style={{ color: c.ink, fontSize: 13, flex: 1 }} numberOfLines={1}>{s.actor}</Text>
                  <Text style={{ color: c.inkSoft, fontSize: 12, fontWeight: "700" }}>{s.actions} {t("dash.actions")}</Text>
                </View>
              )) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.noStaff")}</Text>}
              {isOwner ? (
                <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
                  <Button size="sm" kind="secondary" label={t("nav.approvals")} onPress={() => router.push("/approvals")} />
                </View>
              ) : null}
            </Card>
          </View>
        </>
      )}
    </Screen>
  );
}

function Loading() {
  const c = useTheme(); const t = useT();
  return <View style={{ paddingVertical: space.xxl, alignItems: "center", gap: space.sm }}><ActivityIndicator color={c.primary} /><Text style={{ color: c.muted, fontSize: 13 }}>{t("common.loading")}</Text></View>;
}
