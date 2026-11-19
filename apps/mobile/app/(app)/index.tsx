import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, useWindowDimensions, View, type DimensionValue } from "react-native";
import { useRouter } from "expo-router";
import { formatQty, formatRwf } from "@sms/shared";
import { Badge, Banner, Button, Card, Empty, ErrorState, Screen, Segmented, Skeleton, useWide } from "../../src/components/ui";
import { Icon, type IconName } from "../../src/components/icons";
import { PeriodSelector } from "../../src/components/date-range-picker";
import { OfflineReadinessStrip } from "../../src/components/offline-download";
import { CompareBars, ProductRanking, StockHealthBar, TrendBars } from "../../src/components/charts";
import { Appear, Disclosure } from "../../src/components/motion";
import { useT, type Key } from "../../src/localization";
import { kvGet, kvSet, listRecords } from "../../src/database";
import { ApiError, request, sessionRejected, useSession } from "../../src/services/api";
import { degradedList, sectionKey, sectionLabel } from "../../src/services/report-sections";
import { businessRevisionKey, dashboardCacheIsCurrent, dashboardCacheKey, dashboardScope } from "../../src/services/dashboard-cache";
import { readOfflineSnapshot, snapshotKeys } from "../../src/services/offline-data";
import { cacheWriteMeta, touchCacheAccess } from "../../src/services/cache-meta";
import { buildLocalDashboard } from "../../src/services/local-dashboard-data";
import { applyPendingDashboard, pendingFigures } from "../../src/services/pending-dashboard";
import type { Dashboard as DashboardPayload, FigureSource, FigureStatus, LocalDashboardResult } from "../../src/services/local-dashboard";
import {
  OVERVIEW_PRESET_LABEL, defaultSelection, formatSelectionRange, selectionRange,
  type OverviewSelection,
} from "../../src/services/overview-period";
import {
  attentionItems, greetingKey, primaryFigures, trendMetricKeys, trendSeries, type TrendMetric,
} from "../../src/services/dashboard-view";
import { useSync } from "../../src/synchronization/engine";
import { radius, space, type, useTheme } from "../../src/theme/tokens";

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
  // Collections from sales and repayments of older credits are separate indicators. Optional so a
  // payload cached by an older build still renders.
  creditRepayments?: number; totalReceived?: number; outstandingCredit?: number;
  repaymentsByMethod?: { cash: number; momo: number; bank: number; other: number };
  deliveries: number; productsReceived: number; unitsReceived: number;
  pendingReceipts: number; inventoryValue: number | null; lowStockCount: number; outOfStockCount: number;
  productCount: number; supplierPayables: number; pendingApprovals: number; openInvestigations: number; openConflicts: number;
}
interface Change { change: number; pct: number | null }
interface ActivityRow {
  id: number; at: string; action: string; entity: string; reason: string | null; actor: string | null;
  productName: string | null; saleTotal: number | null; purchaseTotal: number | null; purchaseReference: string | null;
}
/**
 * The payload is defined once, in the local calculation service: the figures rendered offline are
 * the same shape as the ones the API returns, so a local figure can never drift structurally from
 * a server figure.
 */
type Dashboard = DashboardPayload;

/** True when this device holds at least one record inside the range, so local figures describe it. */
const localInRange = (r: LocalDashboardResult, to: string) =>
  !!r.coverageFrom && r.coverageFrom < to && r.counts.inRange > 0;

const ACTION_KEYS: Record<string, Key> = {
  "op.sale.create": "dash.act.sale",
  // A repayment is money received against an older credit, never a sale.
  "op.credit.payment.create": "dash.act.payment",
  "credit.payment.create": "dash.act.payment",
  "op.customer.upsert": "dash.act.customer",
  "op.customer.create": "dash.act.customer",
  "customer.upsert": "dash.act.customer",
  "shop.upsert": "dash.act.policy",
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

function Kpi({ label, value, hint, delta, tone, testID }: {
  label: string; value: string; hint?: string; delta?: Change | null; tone?: string; testID?: string;
}) {
  const c = useTheme();
  const t = useT();
  return (
    <Card style={{ flexGrow: 1, flexBasis: 172, minWidth: 148, gap: 5, padding: space.lg }}>
      <Text numberOfLines={1} style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{label}</Text>
      <Text testID={testID} style={{ color: tone ?? c.ink, ...type.money }}>{value}</Text>
      {hint ? <Text numberOfLines={2} style={{ color: c.muted, fontSize: 12, lineHeight: 16 }}>{hint}</Text> : null}
      {delta ? (
        delta.pct === null
          ? <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.noPrior")}</Text>
          : <Text style={{ color: delta.change >= 0 ? c.success : c.danger, fontSize: 12, fontWeight: "600" }}>
              {delta.change >= 0 ? "▲" : "▼"} {Math.abs(delta.pct)}% <Text style={{ color: c.muted, fontWeight: "400" }}>{t("fin.vsPrev")}</Text>
            </Text>
      ) : null}
    </Card>
  );
}

function QuickAction({ label, icon, onPress, primary, testID }: {
  label: string; icon: IconName; onPress: () => void; primary?: boolean; testID?: string;
}) {
  const c = useTheme();
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ hovered, pressed, focused }: any) => ({
        flexGrow: 1, flexBasis: 128, minHeight: 48, paddingHorizontal: space.md, borderRadius: radius.sm,
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7,
        backgroundColor: primary ? c.primaryStrong : c.surface,
        borderWidth: focused ? 2 : 1, borderColor: focused ? c.focus : primary ? c.primaryStrong : c.lineStrong,
        opacity: pressed ? 0.85 : hovered ? 0.95 : 1,
      })}>
      <Icon name={icon} size={15} color={primary ? c.onPrimary : c.inkSoft} />
      <Text style={{ color: primary ? c.onPrimary : c.ink, fontWeight: "600", fontSize: 13, textAlign: "center" }}>{label}</Text>
    </Pressable>
  );
}

/** One line of a "needs attention" list: only ever rendered for a real, non-zero count. */
function AttentionRow({ label, count, tone, onPress }: {
  label: string; count: number; tone: "danger" | "warn" | "neutral"; onPress: () => void;
}) {
  const c = useTheme();
  const colour = tone === "danger" ? c.danger : tone === "warn" ? c.accent : c.muted;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${count}`} onPress={onPress}
      style={({ hovered, pressed, focused }: any) => ({
        flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 10, paddingHorizontal: space.lg,
        borderTopWidth: 1, borderTopColor: c.line, borderRadius: 6,
        backgroundColor: pressed ? c.pressed : hovered ? c.hover : "transparent",
        outlineStyle: focused ? "solid" : undefined,
      } as any)}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colour }} />
      <Text numberOfLines={2} style={{ flex: 1, color: c.ink, fontSize: 13, fontWeight: "600" }}>{label}</Text>
      <Text style={{ color: colour, fontSize: 13, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{count}</Text>
      <Icon name="chevronRight" size={14} color={c.muted} />
    </Pressable>
  );
}

function FigureRow({ label, value, note }: { label: string; value: string; note?: string }) {
  const c = useTheme();
  return (
    <View style={{ flexGrow: 1, flexBasis: 250, minWidth: 0, flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.md, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: c.muted, fontSize: 13 }}>{label}</Text>
        {note ? <Text numberOfLines={2} style={{ color: c.muted, fontSize: 11 }}>{note}</Text> : null}
      </View>
      <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{value}</Text>
    </View>
  );
}

/** One compact secondary figure. Same width and minimum height keep every group visually even. */
function FigureCard({ label, value, hint, note, tone, emphasis, width, testID }: {
  label: string; value: string; hint?: string; note?: string;
  tone?: "danger" | "success"; emphasis?: boolean; width: DimensionValue; testID?: string;
}) {
  const c = useTheme();
  const valueColor = tone === "danger" ? c.danger : tone === "success" ? c.success : c.ink;
  return (
    <View testID={testID} accessibilityLabel={`${label}: ${value}${hint ? `. ${hint}` : ""}${note ? `. ${note}` : ""}`}
      style={{
        width, minHeight: 116, padding: space.md, gap: space.xs, justifyContent: "space-between",
        backgroundColor: c.surface, borderWidth: 1, borderColor: emphasis ? c.primary : c.line, borderRadius: radius.sm,
      }}>
      <Text style={{ color: emphasis ? c.primaryStrong : c.muted, fontSize: 11, lineHeight: 15, fontWeight: "700", letterSpacing: 0.35, textTransform: "uppercase" }}>
        {label}
      </Text>
      <View style={{ gap: 2 }}>
        <Text testID={testID ? `${testID}-value` : undefined}
          style={{ color: valueColor, fontSize: emphasis ? 22 : 18, lineHeight: emphasis ? 28 : 23, fontWeight: "800", fontVariant: ["tabular-nums"] }}>
          {value}
        </Text>
        {hint ? <Text style={{ color: c.muted, fontSize: 11, lineHeight: 15 }}>{hint}</Text> : null}
        {note ? <Text style={{ color: c.inkSoft, fontSize: 11, lineHeight: 15, fontWeight: "600" }}>{note}</Text> : null}
      </View>
    </View>
  );
}

function FigureGroup({ title, children, divided }: { title: string; children: ReactNode; divided?: boolean }) {
  const c = useTheme();
  return (
    <View style={{ gap: space.sm, borderTopWidth: divided ? 1 : 0, borderTopColor: c.line, paddingTop: divided ? space.lg : 0 }}>
      <Text style={{ color: c.inkSoft, fontSize: 12, lineHeight: 16, fontWeight: "700", letterSpacing: 0.2 }}>{title}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "stretch" }}>{children}</View>
    </View>
  );
}

/** Owner-only secondary figures. Collapsed by default; the open state lives in Home so refreshes keep it. */
function MoreFigures({ fin, ops, expenses, methodNote, open, onOpenChange }: {
  fin: Financials; ops: Operations; expenses: { category: string; amount: number; unpaid: number }[];
  methodNote: string; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const c = useTheme();
  const t = useT();
  const { width } = useWindowDimensions();
  const columns = width >= 900 ? 3 : width >= 520 ? 2 : 1;
  const cardWidth = columns === 3 ? "31.5%" : columns === 2 ? "48.2%" : "100%";
  const stockLoss = fin.stockLosses ?? fin.stockLossValue ?? 0;
  const resultAfterLosses = fin.operatingResultAfterStockLosses ?? fin.operatingProfit;
  // Keep the existing explanation verbatim; break its sentences into readable lines rather than
  // introducing a second, potentially divergent definition of the accounting rules.
  const definitions = t("fin.calculationNote").split(". ")
    .map((line, i, all) => i < all.length - 1 ? `${line}.` : line)
    .filter(Boolean);

  return (
    <Disclosure title={t("dash.moreFigures")} description={t("dash.moreFiguresHint")}
      testID="dash-financial-detail" open={open} onOpenChange={onOpenChange}>
      <View style={{ padding: space.lg, paddingTop: space.md, gap: space.lg }}>
        <FigureGroup title={t("dash.financialPerformance")}>
          <FigureCard width={cardWidth} testID="dash-figure-cogs" label={t("fin.cogs")} value={formatRwf(fin.cogs)} hint={t("fin.cogsHint")} />
          <FigureCard width={cardWidth} testID="dash-figure-expenses" label={t("fin.expenses")} value={formatRwf(fin.operatingExpenses)}
            note={`${t("fin.outstanding")}: ${formatRwf(fin.outstandingExpenses)}`} />
          <FigureCard width={cardWidth} testID="dash-figure-operating-profit" label={t("fin.operating")} value={formatRwf(fin.operatingProfit)}
            hint={t("fin.operatingHint")} emphasis tone={fin.operatingProfit < 0 ? "danger" : undefined} />
          <FigureCard width={cardWidth} testID="dash-figure-stock-losses" label={t("fin.stockLoss")} value={formatRwf(stockLoss)}
            hint={t("fin.stockLossHint")} tone={stockLoss > 0 ? "danger" : undefined} />
          <FigureCard width={cardWidth} testID="dash-figure-result-after-losses" label={t("fin.resultAfterLosses")} value={formatRwf(resultAfterLosses)}
            hint={t("fin.resultAfterLossesHint")} tone={resultAfterLosses < 0 ? "danger" : undefined} />
        </FigureGroup>

        <FigureGroup title={t("dash.cashAndInventory")} divided>
          <FigureCard width={cardWidth} testID="dash-figure-collected" label={t("fin.salesCollected")} value={formatRwf(ops.cashCollected)} hint={t("fin.salesCollectedHint")} />
          <FigureCard width={cardWidth} testID="dash-figure-credit-repayments" label={t("fin.creditRepayments")} value={formatRwf(ops.creditRepayments ?? 0)}
            hint={t("fin.creditRepaymentsHint")} note={methodNote || undefined} />
          <FigureCard width={cardWidth} testID="dash-figure-purchases" label={t("fin.purchases")} value={formatRwf(fin.inventoryPurchases)}
            note={`${t("dash.supplierPayables")}: ${formatRwf(ops.supplierPayables)}`} />
          <FigureCard width={cardWidth} testID="dash-figure-inventory-value" label={t("fin.invValue")}
            value={ops.inventoryValue !== null ? formatRwf(ops.inventoryValue) : "—"} hint={t("dash.inventoryHint")} />
        </FigureGroup>

        <FigureGroup title={t("dash.salesAdjustments")} divided>
          <FigureCard width={cardWidth} testID="dash-figure-discounts" label={t("dash.discounts")} value={formatRwf(fin.discounts)}
            note={`${t("dash.returns")}: ${formatRwf(fin.salesReturns)}`} />
        </FigureGroup>

        <View style={{ borderTopWidth: 1, borderTopColor: c.line, paddingTop: space.lg, gap: space.sm }}>
          <Text style={{ color: c.inkSoft, fontSize: 12, lineHeight: 16, fontWeight: "700", letterSpacing: 0.2 }}>{t("dash.expensesByCategory")}</Text>
          {expenses.length ? (
            <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: radius.sm, overflow: "hidden" }}>
              {expenses.map((e, i) => (
                <View key={e.category} style={{
                  flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 9, paddingHorizontal: space.md,
                  borderTopWidth: i ? 1 : 0, borderTopColor: c.line, backgroundColor: c.surface,
                }}>
                  <Text style={{ flex: 1, color: c.inkSoft, fontSize: 13 }}>{e.category}</Text>
                  <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatRwf(e.amount)}</Text>
                </View>
              ))}
            </View>
          ) : (
            <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: radius.sm, padding: space.md, backgroundColor: c.surfaceMuted }}>
              <Text style={{ color: c.muted, fontSize: 12, lineHeight: 17 }}>{t("dash.noExpensesThisPeriod")}</Text>
            </View>
          )}
        </View>

        <Disclosure title={t("fin.howCalculated")} compact>
          <View style={{ gap: 6, paddingBottom: space.sm }}>
            {definitions.map((line, i) => (
              <View key={`${i}-${line.slice(0, 18)}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: 7 }}>
                <View style={{ width: 4, height: 4, borderRadius: 2, marginTop: 7, backgroundColor: c.lineStrong }} />
                <Text style={{ flex: 1, color: c.muted, fontSize: 12, lineHeight: 18 }}>{line}</Text>
              </View>
            ))}
          </View>
        </Disclosure>
      </View>
    </Disclosure>
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
  // Local records/verdicts: recalculate the local figures, never reload the whole dashboard.
  const recordsVersion = useSync((s) => s.recordsVersion);
  // A successful pull saw a new business revision: quietly reconcile the server figures.
  const businessVersion = useSync((s) => s.businessVersion);
  const syncing = useSync((s) => s.running);
  const pendingOps = useSync((s) => s.pending);
  const awaitingApproval = useSync((s) => s.awaitingApproval);
  const isOwner = user?.role === "owner";

  // ONE selection is the source of truth for every Overview request, cached copy and calculation.
  const [selection, setSelection] = useState<OverviewSelection>(() => defaultSelection(user?.role));
  const [view, setView] = useState<{ key: string; data: Dashboard; source: FigureSource; staleAt: string | null } | null>(null);
  const [localInfoState, setLocalInfoState] = useState<{ key: string; info: LocalDashboardResult } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Distinguishes "the server rejected the session" from "the server could not be reached".
  const [authIssue, setAuthIssue] = useState(false);
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("sales");
  // Owned here, not inside the disclosure, so an ordinary figures refresh cannot fold it away.
  const [moreFiguresOpen, setMoreFiguresOpen] = useState(false);
  // The shop's own name, from the profile snapshot the offline download already keeps. No extra
  // request: a shop whose download has not run yet simply shows the period line alone.
  const [savedShopName, setSavedShopName] = useState<string | null>(null);
  // The session carries the shop name (sign-in and every token refresh). The saved profile snapshot
  // is the fallback for a session issued before the API started sending it, so no extra request is
  // ever made from this screen.
  const shopName = user?.shopName?.trim() || savedShopName;
  // Every request takes a sequence number: a response for a scope the user has already changed is
  // discarded instead of overwriting newer figures (the old duplicate-request/render-loop bug).
  const loadSeq = useRef(0);
  const localSeq = useRef(0);
  const sourceRef = useRef<FigureSource | null>(null);
  const viewRef = useRef<{ key: string; data: Dashboard } | null>(null);
  // The payload exactly as the server (or the saved copy) reported it, BEFORE any queued work was
  // folded in. Merging must always start from this copy: merging onto an already-merged payload
  // would add every queued sale again on each recalculation.
  const baseRef = useRef<{ key: string; data: Dashboard; source: FigureSource; savedAt: string | null } | null>(null);
  const scopeRef = useRef("");
  const inFlight = useRef<{ key: string; version: number; promise: Promise<Dashboard> } | null>(null);
  const seenRecords = useRef(recordsVersion);
  const seenBusiness = useRef(businessVersion);
  const businessDirty = useRef(false);

  const range = useMemo(() => selectionRange(selection), [selection]);
  const scope = dashboardScope(user);
  const scopeKey = `${scope}:${range.from}:${range.to}`;
  scopeRef.current = scopeKey;
  const cacheKey = useMemo(
    () => dashboardCacheKey(user, range.from, range.to),
    [user?.shopId, user?.id, user?.role, range.from, range.to],
  );
  const revisionKey = businessRevisionKey(user?.shopId);

  useEffect(() => {
    let live = true;
    if (!user?.shopId || user.shopName?.trim()) { setSavedShopName(null); return; }
    readOfflineSnapshot<{ name?: string | null }>(snapshotKeys.shop(user.shopId))
      .then((snap) => {
        const name = snap?.data?.name;
        if (live) setSavedShopName(typeof name === "string" && name.trim() ? name.trim() : null);
      })
      .catch(() => { if (live) setSavedShopName(null); });
    return () => { live = false; };
  }, [user?.shopId, user?.shopName, revisionKey]);
  // A payload is rendered only when it belongs to the CURRENT range. Clearing state in an effect
  // happens after a paint, which is exactly how the old build flashed today's figures under a newly
  // selected label. This derivation makes that impossible by construction.
  const activeView = view?.key === scopeKey ? view : null;
  const data = activeView?.data ?? null;
  const source = activeView?.source ?? null;
  const staleAt = activeView?.staleAt ?? null;
  const localInfo = localInfoState?.key === scopeKey ? localInfoState.info : null;

  const showData = useCallback((next: Dashboard | null, from: FigureSource | null, savedAt: string | null, key = scopeKey, keepBase = false) => {
    if (key !== scopeRef.current) return;
    viewRef.current = next && from ? { key, data: next } : null;
    sourceRef.current = from;
    // A server answer or a saved copy is the shop-wide basis; this device's local calculation is not.
    if (next && !keepBase && (from === "server" || from === "cached")) baseRef.current = { key, data: next, source: from, savedAt };
    setView(next && from ? { key, data: next, source: from, staleAt: savedAt } : null);
  }, [scopeKey]);

  /**
   * Recalculate only this device's figures. No request, no loading state, no remount.
   * `adoptWithoutRecords` is used only when the server and its saved copy both failed: it lets the
   * device's records render a period that has no record of its own yet (today, early in the day)
   * instead of leaving the screen on "could not load".
   */
  const refreshLocal = useCallback(async (adoptWithoutRecords = false) => {
    if (!user?.id) return;
    const keyAtStart = scopeKey;
    const rangeAtStart = range;
    const seq = ++localSeq.current;
    try {
      // A manager only sees cost and profit when the owner granted it — remembered from the last
      // server answer so the local view does not invent a permission it cannot verify offline.
      const granted = user.role === "owner" ? true : (await kvGet(`dash.perms:${user.id}`).catch(() => null)) === "1";
      const local = await buildLocalDashboard({ from: rangeAtStart.from, to: rangeAtStart.to, role: user.role, financials: granted });
      if (seq !== localSeq.current || scopeRef.current !== keyAtStart) return;
      setLocalInfoState({ key: keyAtStart, info: local });
      // Adopt local figures only when this device holds a record INSIDE the range. A fresh install,
      // or a period whose history lives only on the server, must never replace good figures with
      // zeros just because the local ledger happens to be empty for that period.
      const base = baseRef.current;
      if (base?.key === keyAtStart) {
        // A server answer and a saved copy are both snapshots of the SHOP; this device only holds the
        // operations it made itself, so the snapshot must never be replaced by those rows — that is
        // what made an offline phone show its own sales as the whole period.
        // The opposite failure is a snapshot that never moves: a sale rung up with no network is on
        // neither the server nor the saved copy, so it is folded ON TOP of the pristine snapshot
        // here. It appears in today's figures as soon as it is queued, and the merge always starts
        // from `baseRef`, so no sale is ever counted twice.
        try {
          const figures = pendingFigures({
            records: await listRecords(), from: rangeAtStart.from, to: rangeAtStart.to,
            withCosts: !!base.data.financials,
          });
          if (seq !== localSeq.current || scopeRef.current !== keyAtStart) return;
          showData(applyPendingDashboard(base.data, figures), base.source, base.savedAt, keyAtStart, true);
        } catch { /* keep the snapshot on screen, unfoldable work stays in the outbox */ }
        return;
      }
      if (localInRange(local, rangeAtStart.to) || (adoptWithoutRecords && local.counts.total > 0)) {
        // No snapshot for this period at all: the device's own records are the only figures available.
        showData(local.data, "local", null, keyAtStart, true);
        setLoading(false);
      }
    } catch { /* local calculation failed: keep what is on screen, never blank it */ }
  }, [range, scopeKey, user?.id, user?.role, showData]);

  /** Reconcile the server figures in the background, keeping whatever is already visible. */
  const fetchServer = useCallback(async () => {
    const keyAtStart = scopeKey;
    const rangeAtStart = range;
    const seq = ++loadSeq.current;
    const versionAtStart = useSync.getState().businessVersion;
    // Deduplicate by scope, not by version: two coalesced sync passes can publish the same final
    // revision moments apart, and both must share one HTTP request.
    let promise = inFlight.current?.key === cacheKey ? inFlight.current.promise : null;
    if (!promise) {
      promise = request<Dashboard>(`/reports/dashboard?from=${encodeURIComponent(rangeAtStart.from)}&to=${encodeURIComponent(rangeAtStart.to)}`, { auth: true });
      inFlight.current = { key: cacheKey, version: versionAtStart, promise };
    }
    if (viewRef.current?.key !== keyAtStart) setLoading(true);
    try {
      const revisionBefore = await kvGet(revisionKey).catch(() => null);
      const res = await promise;
      if (seq !== loadSeq.current || scopeRef.current !== keyAtStart || dashboardScope(useSession.getState().user) !== scope) return;
      showData(res, "server", null, keyAtStart); setFailed(false); setAuthIssue(false);
      // The revision is recorded with the payload: a remount can reuse it only while the last pull
      // still reports the same business state.
      const now = new Date().toISOString();
      void kvSet(cacheKey, JSON.stringify({ version: 3, savedAt: now, data: res, revision: revisionBefore, ...cacheWriteMeta(now) })).catch(() => {});
      void kvSet(`dash.perms:${user?.id ?? "none"}`, res.permissions?.financials ? "1" : "0").catch(() => {});
      // A fresh server answer is the new basis: fold back whatever is still queued (a pull can land
      // before the outbox has drained) so the figures never dip while unsynced work exists.
      void refreshLocal();
    } catch (e) {
      if (seq !== loadSeq.current || scopeRef.current !== keyAtStart) return;
      // A 401 means "sign in again" only when the refresh credential was actually rejected. A token
      // that is merely absent (offline start) or whose refresh is backing off is not an expired
      // session — saying so is what turned a network hiccup into a fake logout.
      setAuthIssue(e instanceof ApiError && e.status === 401 && sessionRejected());
      setFailed(true);
      // Never erase figures already shown. If this was the first attempt, the saved copy is the
      // last valid one; otherwise the previous response simply stays on screen.
      if (viewRef.current?.key !== keyAtStart) {
        try {
          const raw = await kvGet(cacheKey);
          const cached = raw ? JSON.parse(raw) : null;
          if (cached?.data && scopeRef.current === keyAtStart) {
            void touchCacheAccess(cacheKey, raw);
            showData(cached.data, "cached", cached.savedAt ?? null, keyAtStart);
          }
        } catch { /* leave the previous data in place */ }
      }
      // Still nothing for this range — typically the first open of a new day while offline, where
      // no copy of "today" can exist yet. Render what this device recorded rather than a dead end;
      // it is labelled "calculated on this device" like any other local figure.
      if (viewRef.current?.key !== keyAtStart) await refreshLocal(true);
    } finally {
      if (inFlight.current?.promise === promise) {
        inFlight.current = null;
        // A real change landed while this request was in flight. Reconcile once more; the shared
        // request above only covers the identical-revision burst case.
        if (useSync.getState().businessVersion !== versionAtStart && scopeRef.current === keyAtStart) {
          setTimeout(() => { void fetchServer(); }, 100);
        }
      }
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [range, scopeKey, cacheKey, revisionKey, scope, showData, refreshLocal, user?.id]);

  /**
   * A scope change (range, account, shop or role) is the only time old figures are cleared. The
   * cached copy is shown before any network work, so a return visit never flashes a skeleton.
   */
  const load = useCallback(async (force = false) => {
    const keyAtStart = scopeKey;
    const seq = ++loadSeq.current;
    setFailed(false); setAuthIssue(false);
    let cached: any = null;
    try {
      const raw = await kvGet(cacheKey);
      cached = raw ? JSON.parse(raw) : null;
      if (cached?.data && seq === loadSeq.current && scopeRef.current === keyAtStart) {
        void touchCacheAccess(cacheKey, raw);
        showData(cached.data, "cached", cached.savedAt ?? null, keyAtStart);
        setLoading(false);
      }
    } catch { /* no usable cache */ }

    await refreshLocal();
    if (seq !== loadSeq.current || scopeRef.current !== keyAtStart) return;
    const revision = await kvGet(revisionKey).catch(() => null);
    if (seq !== loadSeq.current || scopeRef.current !== keyAtStart) return;
    // Same business revision as the saved copy: the server has not reported a relevant change, so
    // returning to a tab must not spend a request merely to render the same figures.
    if (!force && dashboardCacheIsCurrent(cached, revision)) { setLoading(false); return; }
    await fetchServer();
  }, [scopeKey, cacheKey, revisionKey, refreshLocal, fetchServer, showData]);

  // Only a range/account/shop/role change starts a full dashboard scope load. Local record changes
  // recalculate locally; a new server revision refreshes quietly. A rotating access token is not a
  // data change and is deliberately absent from these dependencies.
  const lastScope = useRef("");
  useEffect(() => {
    if (lastScope.current === scopeKey) return;
    lastScope.current = scopeKey;
    sourceRef.current = null;
    viewRef.current = null;
    setLoading(true); setFailed(false); setAuthIssue(false);
    void load();
  }, [scopeKey, load]);

  useEffect(() => {
    if (seenRecords.current === recordsVersion) return;
    seenRecords.current = recordsVersion;
    void refreshLocal();
  }, [recordsVersion, refreshLocal]);

  useEffect(() => {
    if (seenBusiness.current !== businessVersion) {
      seenBusiness.current = businessVersion;
      businessDirty.current = true;
    }
    // A realtime burst can queue one extra sync pass. Wait until the engine is idle so both passes
    // land before reconciling once; otherwise the second pass would duplicate the same refresh.
    if (!businessDirty.current || syncing) return;
    const timer = setTimeout(() => {
      if (!businessDirty.current) return;
      businessDirty.current = false;
      void fetchServer();
    }, 250);
    return () => clearTimeout(timer);
  }, [businessVersion, syncing, fetchServer]);

  const periodLabel = selection.kind === "preset"
    ? t(OVERVIEW_PRESET_LABEL[selection.preset] as Key)
    : t(selection.kind === "day" ? "date.customDay" : "date.customRange");

  const ops = data?.operations;
  const fin = data?.financials;
  const counts = localInfo?.counts;
  // Sections the API could not compute (it reports them instead of answering 500). NAMED, not just
  // counted: "1 part is missing" without saying which one leaves the owner unable to tell an empty
  // panel apart from a real zero.
  const degraded = degradedList(data?.degraded);
  const sectionName = (n: string) => { const k = sectionKey(n); return k ? t(k) : sectionLabel(n); };
  const profitMissing = degraded.includes("product_profitability");
  // "Synchronized" can only be claimed when the server answered AND nothing is still queued.
  const displayStatus: FigureStatus =
    counts && counts.conflicts > 0 ? "conflict"
    : counts && counts.failed > 0 ? "sync_failed"
    : pendingOps > 0 || awaitingApproval > 0 ? "pending_sync"
    : source === "server" ? "synchronized"
    : source === "cached" ? "cached"
    : "calculated_local";
  const statusTone: "ok" | "warn" | "danger" =
    displayStatus === "synchronized" ? "ok" : displayStatus === "sync_failed" || displayStatus === "conflict" ? "danger" : "warn";
  const figureNote = useMemo(() => {
    const parts: string[] = [];
    if (source === "cached" && staleAt) parts.push(t("dash.cachedAt").replace("{time}", new Date(staleAt).toLocaleString()));
    if (source === "local" && localInfo) {
      parts.push(t("dash.localFigures").replace("{n}", String(localInfo.counts.total)).replace("{time}", new Date(localInfo.calculatedAt).toLocaleTimeString()));
      if (localInfo.coverageFrom && !localInfo.covered) parts.push(t("dash.localCoverage").replace("{date}", new Date(localInfo.coverageFrom).toLocaleDateString()));
    }
    if (counts?.pending) parts.push(t("dash.pendingNote").replace("{n}", String(counts.pending)));
    if (counts?.failed) parts.push(t("dash.failedNote").replace("{n}", String(counts.failed)));
    if (counts?.conflicts) parts.push(t("dash.conflictNote").replace("{n}", String(counts.conflicts)));
    if (!parts.length && lastSync) parts.push(`${t("sync.lastSync")}: ${new Date(lastSync).toLocaleString()}`);
    return parts.join(" ");
  }, [source, staleAt, localInfo, counts, lastSync, t]);
  const outCount = ops?.outOfStockCount ?? 0;
  const lowOnly = Math.max(0, (ops?.lowStockCount ?? 0) - outCount);
  const inStock = Math.max(0, (ops?.productCount ?? 0) - (ops?.lowStockCount ?? 0));
  const chartMode: "day" | "month" = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 > 400 ? "month" : "day";
  // Repayments by the method actually used, so a cash collection is never shown as mobile money.
  const methodNote = ops?.repaymentsByMethod
    ? (["cash", "momo", "bank", "other"] as const)
        .filter((k) => (ops.repaymentsByMethod?.[k] ?? 0) > 0)
        .map((k) => `${t(`fin.method.${k}` as Key)} ${formatRwf(ops.repaymentsByMethod![k])}`)
        .join(" · ")
    : "";

  const actionLabel = (action: string) => {
    const key = ACTION_KEYS[action];
    return key ? t(key) : action.replace(/^op\./, "").replace(/[._]/g, " ");
  };

  /* ---- presentation-layer decisions (see src/services/dashboard-view.ts) ---- */
  const finVisible = !!data?.permissions?.financials;
  const primary = ops ? primaryFigures({
    operations: ops,
    financials: fin ? { netSales: fin.netSales, grossProfit: fin.grossProfit, grossMarginBps: fin.grossMarginBps } : null,
    financialsAllowed: finVisible,
    comparison: data?.financialComparison ?? null,
    salesComparison: data?.salesComparison ?? null,
  }) : [];
  const attention = attentionItems({ operations: ops ?? null, counts: counts ?? null, isOwner });
  const attentionCount = attention.reduce((n, item) => n + item.count, 0);
  const metrics = trendMetricKeys(finVisible);
  const QUICK_TO_PRESET = { today: "today", yesterday: "yesterday", week: "thisWeek", month: "thisMonth" } as const;
  type QuickPeriod = keyof typeof QUICK_TO_PRESET;
  const quickValue = selection.kind === "preset"
    ? (Object.keys(QUICK_TO_PRESET) as QuickPeriod[]).find((k) => QUICK_TO_PRESET[k] === selection.preset) ?? null
    : null;
  const kpiHint = (key: string) => {
    if (key === "grossProfit") {
      return fin?.grossMarginBps != null ? `${t("dash.grossMargin")} ${(fin.grossMarginBps / 100).toFixed(1)}%` : t("fin.marginUnavailable");
    }
    if (key === "moneyReceived") {
      return t("dash.receivedBreakdown")
        .replace("{sales}", formatRwf(ops?.cashCollected ?? 0))
        .replace("{repayments}", formatRwf(ops?.creditRepayments ?? 0));
    }
    return undefined;
  };
  const metricLabel = (m: TrendMetric) =>
    m === "profit" ? t("fin.gross") : m === "repayments" ? t("fin.creditRepayments") : t("fin.netSales");
  const chartRows = data ? trendSeries(data.trend, trendMetric) : [];
  const hasChartData = !!data?.trend.some((p) => p.netSales !== 0 || (p.grossProfit ?? 0) !== 0 || (p.repayments ?? 0) !== 0);

  return (
    <Screen
      title={user?.name ? `${t(greetingKey())}, ${user.name.split(" ")[0]}` : t("home.dashboard")}
      subtitle={[shopName, periodLabel, formatSelectionRange(selection)].filter(Boolean).join(" · ")}
      actions={loading && data ? <ActivityIndicator size="small" color={c.muted} /> : undefined}>
      {/* Period: four one-tap business periods, plus the Kigali calendar for anything custom. */}
      <View style={{ flexDirection: wide ? "row" : "column", alignItems: wide ? "center" : "stretch", gap: space.sm, flexWrap: "wrap" }}>
        <Segmented<QuickPeriod>
          value={quickValue as QuickPeriod | null}
          onChange={(v) => setSelection({ kind: "preset", preset: QUICK_TO_PRESET[v] })}
          label={t("common.period")}
          options={[
            { value: "today", label: t("common.today") },
            { value: "yesterday", label: t("common.yesterday") },
            { value: "week", label: t("common.week") },
            { value: "month", label: t("common.month") },
          ]} />
        <PeriodSelector selection={selection} onChange={setSelection} compact />
      </View>

      {!online ? <Banner tone="warn" text={t("home.cachedData")} /> : null}
      {failed && data && online ? <Banner tone="warn" text={t("dash.refreshFailed")} /> : null}
      {authIssue ? <Banner tone="danger" text={t("dash.sessionExpired")} /> : null}
      {degraded.length ? <Banner tone="warn" text={t("dash.degraded").replace("{list}", degraded.map(sectionName).join(", "))} /> : null}

      {/* One compact line of provenance. The header already carries the sync badge, so this states
          where the FIGURES came from and how fresh they are — one indicator per question, no repeats. */}
      {data ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusTone === "ok" ? c.success : statusTone === "danger" ? c.danger : c.accent }} />
          <Text style={{ color: c.inkSoft, fontSize: 12, fontWeight: "700" }}>{t(`dash.status.${displayStatus}` as Key)}</Text>
          {figureNote ? <Text numberOfLines={2} style={{ flexShrink: 1, color: c.muted, fontSize: 12, lineHeight: 17 }}>· {figureNote}</Text> : null}
        </View>
      ) : null}

      <OfflineReadinessStrip />

      {loading && !data ? (
        <View testID="dash-loading" style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} height={104} width="23%" style={{ minWidth: 150, flexGrow: 1 }} />)}
        </View>
      ) : failed && !data ? (
        <ErrorState text={t(authIssue ? "dash.sessionExpired" : "home.loadError")} onRetry={() => void load(true)} />
      ) : !data || !ops ? (
        <Loading />
      ) : (
        <>
          {/* The four questions an owner opens the app to answer. */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {primary.map((tile) => (
              <Kpi key={tile.key} testID={tile.testID}
                label={t(tile.labelKey)}
                value={tile.key === "transactions" ? String(tile.value) : formatRwf(tile.value)}
                delta={tile.delta}
                hint={kpiHint(tile.key) ?? (tile.hintKey ? t(tile.hintKey) : undefined)}
                tone={tile.tone === "danger" ? c.danger : tile.tone === "accent" ? c.accent : undefined} />
            ))}
          </View>

          {fin?.costBasisIncomplete ? <Banner tone="warn" text={t("fin.provisional")} /> : null}

          {/* Secondary figures sit directly under the headline KPIs and stay folded by default. */}
          {finVisible && fin ? (
            <MoreFigures fin={fin} ops={ops} expenses={data.expensesByCategory} methodNote={methodNote}
              open={moreFiguresOpen} onOpenChange={setMoreFiguresOpen} />
          ) : (
            <Disclosure title={t("dash.moreFigures")} description={t("dash.moreFiguresOpsHint")}>
              <View style={{ padding: space.lg, paddingTop: space.md }}>
                <FigureRow label={t("dash.transactions")} value={String(ops.transactions)} />
                <FigureRow label={t("dash.unitsSold")} value={formatQty(ops.unitsSold)} />
                <FigureRow label={t("dash.avgSale")} value={formatRwf(ops.averageTransaction)} />
                <FigureRow label={t("dash.productsReceived")} value={formatQty(ops.unitsReceived)}
                  note={`${ops.deliveries} ${t("dash.deliveries")} · ${ops.productsReceived} ${t("dash.products")}`} />
              </View>
            </Disclosure>
          )}

          {/* Four actions, one row, no duplicate routes. */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            <QuickAction testID="home-action-sell" primary icon="cart" label={t("nav.sell")} onPress={() => router.push("/sell")} />
            <QuickAction testID="home-action-stock" icon="layers" label={t("nav.stock")} onPress={() => router.push("/stock")} />
            <QuickAction testID="home-action-expense" icon="receipt" label={t("nav.expense")} onPress={() => router.push("/expense")} />
            <QuickAction testID="home-action-count" icon="checkSquare" label={t("stock.count")} onPress={() => router.push({ pathname: "/stock", params: { count: "1" } })} />
          </View>

          <View style={{ flexDirection: wide ? "row" : "column", gap: space.md, alignItems: "flex-start" }}>
            {/* ONE performance chart, on the metric the owner picks. */}
            <Card style={{ flex: wide ? 1.6 : undefined, gap: space.md, minWidth: 0 }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: space.sm }}>
                <View style={{ flex: 1, gap: 2, minWidth: 150 }}>
                  <Text style={{ color: c.ink, ...type.h2 }}>{t("dash.performance")}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>
                    {t("dash.performanceHint").replace("{unit}", t(chartMode === "month" ? "dash.performanceMonth" : "dash.performanceDay"))}
                  </Text>
                </View>
                {metrics.length > 1 ? (
                  <Segmented<TrendMetric> value={trendMetric} onChange={setTrendMetric} label={t("dash.trendMetric")}
                    options={metrics.map((m) => ({ value: m, label: metricLabel(m) }))} />
                ) : null}
              </View>
              {hasChartData
                ? <TrendBars data={chartRows} label={metricLabel(trendMetric)} pointsLabel={t("dash.transactions")} labelMode={chartMode === "month" ? "month" : "day"} showCount={trendMetric === "sales"} />
                : <Empty icon="chart" title={t("dash.noSales")} description={t("dash.noSalesDesc")}
                    action={<Button testID="dash-record-sale" label={t("dash.recordSale")} onPress={() => router.push("/sell")} />} />}
            </Card>

            {/* Only work that needs a decision. No rows means an honest all-clear. */}
            <Card padded={false} style={{ flex: wide ? 1 : undefined, alignSelf: "flex-start", width: wide ? undefined : "100%", minWidth: 0, gap: 0 }} tone={attentionCount ? "warn" : "ok"}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.lg }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: c.ink, ...type.h2 }}>{t("dash.actionable")}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>
                    {attention.length ? t("dash.attentionHint") : t("dash.noAttention")}
                  </Text>
                </View>
                {attentionCount ? <Badge tone="warn" label={String(attentionCount)} /> : <Icon name="check" size={18} color={c.success} />}
              </View>
              {attention.map((item) => (
                <AttentionRow key={item.key} label={t(item.labelKey)} count={item.count} tone={item.tone}
                  onPress={() => router.push(item.route as any)} />
              ))}
            </Card>
          </View>

          {/* Recent activity, with the full reports one tap away. */}
          <Card style={{ gap: space.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
              <View style={{ flex: 1, gap: 2, minWidth: 150 }}>
                <Text style={{ color: c.ink, ...type.h2 }}>{t("home.recentActivity")}</Text>
                <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.activityHint")}</Text>
              </View>
              {finVisible ? (
                <>
                  <Button size="sm" kind="secondary" label={t("common.sales")} onPress={() => router.push(`/reports?kind=sales&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` as any)} />
                  <Button size="sm" kind="secondary" label={t("common.expenses")} onPress={() => router.push(`/reports?kind=expenses&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` as any)} />
                  <Button size="sm" kind="secondary" label={t("nav.profitability")} onPress={() => router.push("/profitability" as any)} />
                </>
              ) : null}
            </View>
            {data.activity.length ? data.activity.slice(0, 6).map((a, i) => (
              <Appear key={a.id} index={i}>
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: 7, borderTopWidth: 1, borderTopColor: c.line }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, marginTop: 5, backgroundColor: a.action.startsWith("adjustment") || a.action.startsWith("conflict") ? c.accent : a.action.startsWith("op.") ? c.primary : c.lineStrong }} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{actionLabel(a.action)}</Text>
                    <Text numberOfLines={1} style={{ color: c.muted, fontSize: 11 }}>
                      {a.productName ?? a.purchaseReference ?? a.reason ?? t("appr.entity")}
                      {a.actor ? ` · ${a.actor}` : ""}
                    </Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 1 }}>
                    {a.saleTotal !== null ? <Text style={{ color: c.inkSoft, fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatRwf(a.saleTotal)}</Text>
                      : a.purchaseTotal !== null ? <Text style={{ color: c.inkSoft, fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatRwf(a.purchaseTotal)}</Text> : null}
                    <Text style={{ color: c.muted, fontSize: 10 }}>{new Date(a.at).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</Text>
                  </View>
                </View>
              </Appear>
            )) : <Empty icon="checkSquare" title={t("appr.noActivity")} description={t("dash.noActivityDesc")} />}
            {data.activity.length > 6 ? (
              <Button testID="dash-activity-toggle" size="sm" kind="secondary" label={t("dash.viewAllActivity")} onPress={() => router.push("/reports" as any)} />
            ) : null}
          </Card>

          {finVisible && fin ? (
            <Disclosure title={t("dash.moreCharts")} description={t("dash.moreChartsHint")}>
              <View style={{ padding: space.lg, gap: space.lg, paddingTop: space.md }}>
                <View style={{ gap: 2 }}>
                  <Text style={{ color: c.ink, ...type.h3 }}>{t("dash.gpVsExpenses")}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.gpVsExpensesHint")}</Text>
                </View>
                {data.trend.some((p) => (p.grossProfit ?? 0) !== 0 || (p.operatingExpenses ?? 0) !== 0)
                  ? <CompareBars data={data.trend.map((p) => ({ date: p.date, a: p.grossProfit ?? 0, b: p.operatingExpenses ?? 0 }))}
                      labelA={t("fin.gross")} labelB={t("fin.expenses")} labelMode={chartMode === "month" ? "month" : "day"} />
                  : <Empty icon="chart" title={t("dash.noSales")} description={t("dash.noExpensesDesc")} />}
                <View style={{ gap: 2 }}>
                  <Text style={{ color: c.ink, ...type.h3 }}>{t("dash.monthlyResult")}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.monthlyResultHint")}</Text>
                </View>
                {fin.monthly && fin.monthly.some((m) => m.netSales !== 0 || m.operatingExpenses !== 0)
                  ? <TrendBars data={fin.monthly.map((m) => ({ date: m.month, netSales: m.operatingResult, transactions: 0 }))}
                      label={t("fin.resultAfterLosses")} labelMode="month" showCount={false} />
                  : <Empty title={t("dash.noSales")} description={t("dash.noSalesDesc")} />}
              </View>
            </Disclosure>
          ) : null}

          <Disclosure title={t("dash.productPanels")} description={t("dash.productPanelsHint")}>
            <View style={{ padding: space.lg, gap: space.lg, paddingTop: space.md }}>
              <View style={{ flexDirection: wide ? "row" : "column", gap: space.lg }}>
                <View style={{ flex: 1, gap: space.sm, minWidth: 0 }}>
                  <Text style={{ color: c.ink, ...type.h3 }}>{t("dash.topProducts")}</Text>
                  <ProductRanking items={data.topProducts} emptyLabel={t("dash.noSales")} valueLabel={t("common.total")} />
                </View>
                <View style={{ flex: 1, gap: space.sm, minWidth: 0 }}>
                  <Text style={{ color: c.ink, ...type.h3 }}>{t("dash.topByProfit")}</Text>
                  {profitMissing ? <Text style={{ color: c.danger, fontSize: 13, lineHeight: 19 }}>{t("dash.sectionUnavailable")}</Text>
                    : (fin?.topProductsByProfit ?? []).length ? (fin?.topProductsByProfit ?? []).map((p) => (
                    <View key={p.productId} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: c.line }}>
                      <Text numberOfLines={1} style={{ color: c.ink, fontSize: 13, flex: 1 }}>{p.name}</Text>
                      <Text style={{ color: (p.grossProfit ?? 0) < 0 ? c.danger : c.success, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatRwf(p.grossProfit ?? 0)}</Text>
                      <Text style={{ color: c.muted, fontSize: 11, width: 52, textAlign: "right" }}>{p.grossMarginBps != null ? `${(p.grossMarginBps / 100).toFixed(0)}%` : "—"}</Text>
                    </View>
                  )) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.noSales")}</Text>}
                </View>
              </View>
              {finVisible && fin ? (
                <View style={{ flexDirection: wide ? "row" : "column", gap: space.lg }}>
                  <View style={{ flex: 1, gap: space.sm, minWidth: 0 }}>
                    <Text style={{ color: c.ink, ...type.h3 }}>{t("dash.lowMargin")}</Text>
                    {profitMissing ? <Text style={{ color: c.danger, fontSize: 13, lineHeight: 19 }}>{t("dash.sectionUnavailable")}</Text>
                      : (fin.lowMarginProducts ?? []).length ? (fin.lowMarginProducts ?? []).map((p) => (
                      <View key={p.productId} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: c.line }}>
                        <Text numberOfLines={1} style={{ color: c.ink, fontSize: 13, flex: 1 }}>{p.name}</Text>
                        {p.belowCost ? <Badge tone="danger" label={t("receive.belowCostBadge")} /> : null}
                        <Text style={{ color: c.danger, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"], minWidth: 52, textAlign: "right" }}>
                          {p.grossMarginBps != null ? `${(p.grossMarginBps / 100).toFixed(1)}%` : "—"}
                        </Text>
                      </View>
                    )) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("dash.noLowMargin")}</Text>}
                  </View>
                  <View style={{ flex: 1, gap: space.sm, minWidth: 0 }}>
                    <Text style={{ color: c.ink, ...type.h3 }}>{t("dash.worstProducts")}</Text>
                    <ProductRanking items={data.worstProducts} emptyLabel={t("dash.noSales")} valueLabel={t("common.total")} />
                  </View>
                </View>
              ) : null}
              <View style={{ gap: space.sm }}>
                <Text style={{ color: c.ink, ...type.h3 }}>{t("dash.stockHealth")}</Text>
                <StockHealthBar inStock={inStock} low={lowOnly} out={outCount} label={t("dash.stockHealth")} />
                {data.lowStock.length ? data.lowStock.map((p) => (
                  <View key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: c.line }}>
                    <Text numberOfLines={1} style={{ color: c.ink, fontSize: 13, flex: 1 }}>{p.name}</Text>
                    <Badge tone={p.onHand <= 0 ? "danger" : "warn"} dot label={`${formatQty(p.onHand)} ${p.unit}`} />
                  </View>
                )) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("home.noLowStockDesc")}</Text>}
                <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
                  <Button size="sm" kind="secondary" label={t("home.viewStock")} onPress={() => router.push("/stock")} />
                  {isOwner ? <Button size="sm" kind="secondary" label={t("nav.approvals")} onPress={() => router.push("/approvals")} /> : null}
                </View>
              </View>
            </View>
          </Disclosure>

          {isOwner && data.staffActivity.length ? (
            <Disclosure title={t("dash.staffActivity")} description={t("dash.staffActivityHint")}>
              <View style={{ padding: space.lg, paddingTop: space.md }}>
                {data.staffActivity.map((s) => (
                  <View key={s.actor} style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 7, borderTopWidth: 1, borderTopColor: c.line }}>
                    <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: c.primarySoft, alignItems: "center", justifyContent: "center" }}>
                      <Text style={{ color: c.primaryStrong, fontWeight: "800", fontSize: 11 }}>{s.actor.slice(0, 1).toUpperCase()}</Text>
                    </View>
                    <Text numberOfLines={1} style={{ color: c.ink, fontSize: 13, flex: 1 }}>{s.actor}</Text>
                    <Text style={{ color: c.inkSoft, fontSize: 12, fontWeight: "700" }}>{s.actions} {t("dash.actions")}</Text>
                  </View>
                ))}
              </View>
            </Disclosure>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function Loading() {
  const c = useTheme(); const t = useT();
  return <View testID="dash-loading" style={{ paddingVertical: space.xxl, alignItems: "center", gap: space.sm }}><ActivityIndicator color={c.primary} /><Text style={{ color: c.muted, fontSize: 13 }}>{t("common.loading")}</Text></View>;
}
