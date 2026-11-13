import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { formatQty, formatRwf } from "@sms/shared";
import { Badge, Banner, Button, Card, Empty, ErrorState, Screen, Segmented, Skeleton, useWide } from "../../src/components/ui";
import { PeriodSelector } from "../../src/components/date-range-picker";
import { OfflineReadinessStrip } from "../../src/components/offline-download";
import { BarList, CompareBars, ProductRanking, StockHealthBar, TrendBars } from "../../src/components/charts";
import { Appear, Disclosure, useCountUp } from "../../src/components/motion";
import { useT, type Key } from "../../src/localization";
import { kvGet, kvSet } from "../../src/database";
import { ApiError, request, sessionRejected, useSession } from "../../src/services/api";
import { degradedList, sectionKey, sectionLabel } from "../../src/services/report-sections";
import { businessRevisionKey, dashboardCacheIsCurrent, dashboardCacheKey, dashboardScope } from "../../src/services/dashboard-cache";
import { cacheWriteMeta, touchCacheAccess } from "../../src/services/cache-meta";
import { buildLocalDashboard } from "../../src/services/local-dashboard-data";
import type { Dashboard as DashboardPayload, FigureSource, FigureStatus, LocalDashboardResult } from "../../src/services/local-dashboard";
import {
  OVERVIEW_PRESET_LABEL, defaultSelection, formatSelectionRange, selectionRange,
  type OverviewSelection,
} from "../../src/services/overview-period";
import { useSync } from "../../src/synchronization/engine";
import { motion, space, type, useTheme } from "../../src/theme/tokens";

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
  const [trendMetric, setTrendMetric] = useState<"sales" | "profit">("sales");
  const [activityExpanded, setActivityExpanded] = useState(false);
  // Every request takes a sequence number: a response for a scope the user has already changed is
  // discarded instead of overwriting newer figures (the old duplicate-request/render-loop bug).
  const loadSeq = useRef(0);
  const localSeq = useRef(0);
  const sourceRef = useRef<FigureSource | null>(null);
  const viewRef = useRef<{ key: string; data: Dashboard } | null>(null);
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
  // A payload is rendered only when it belongs to the CURRENT range. Clearing state in an effect
  // happens after a paint, which is exactly how the old build flashed today's figures under a newly
  // selected label. This derivation makes that impossible by construction.
  const activeView = view?.key === scopeKey ? view : null;
  const data = activeView?.data ?? null;
  const source = activeView?.source ?? null;
  const staleAt = activeView?.staleAt ?? null;
  const localInfo = localInfoState?.key === scopeKey ? localInfoState.info : null;

  const showData = useCallback((next: Dashboard | null, from: FigureSource | null, savedAt: string | null, key = scopeKey) => {
    if (key !== scopeRef.current) return;
    viewRef.current = next && from ? { key, data: next } : null;
    sourceRef.current = from;
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
      if (localInRange(local, rangeAtStart.to) || (adoptWithoutRecords && local.counts.total > 0)) {
        const hasUnconfirmed = local.counts.pending > 0 || local.counts.awaitingApproval > 0 || local.counts.failed > 0;
        // A server response and a revision-validated saved copy are both authoritative snapshots.
        // Keep them on screen unless this device has work the server cannot have counted yet; a
        // verdict change alone must not swap the whole dashboard back to device-only records.
        const trustedSnapshot = sourceRef.current === "server" || sourceRef.current === "cached";
        if (!trustedSnapshot || hasUnconfirmed) {
          showData(local.data, "local", null, keyAtStart);
          setLoading(false);
        }
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
  const issueCount = ops ? lowOnly + outCount + ops.pendingApprovals + ops.openInvestigations + ops.openConflicts : 0;
  const inStock = Math.max(0, (ops?.productCount ?? 0) - (ops?.lowStockCount ?? 0));
  const chartData = (data?.trend ?? []).map((p) => ({ ...p, netSales: trendMetric === "profit" ? (p.grossProfit ?? 0) : p.netSales }));
  const chartMode: "day" | "month" = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 > 400 ? "month" : "day";

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
        <View style={{ flex: 1, gap: 5, minWidth: 240 }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("common.period")}</Text>
          <PeriodSelector selection={selection} onChange={setSelection} />
          <Text style={{ color: c.muted, fontSize: 11 }}>{formatSelectionRange(selection)}</Text>
        </View>
        {loading && data ? <ActivityIndicator size="small" color={c.muted} /> : null}
      </View>

      {!online ? <Banner tone="warn" text={t("home.cachedData")} /> : null}
      {failed && data && online ? <Banner tone="warn" text={t("dash.refreshFailed")} /> : null}
      {authIssue ? <Banner tone="danger" text={t("dash.sessionExpired")} /> : null}
      <OfflineReadinessStrip />
      {degraded.length ? <Banner tone="warn" text={t("dash.degraded").replace("{list}", degraded.map(sectionName).join(", "))} /> : null}
      {data ? (
        <Card tone={displayStatus === "conflict" || displayStatus === "sync_failed" ? "warn" : "muted"} style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
            <Badge dot tone={statusTone} label={t("dash.figureStatus")} />
            <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700" }}>{t(`dash.status.${displayStatus}` as Key)}</Text>
            <Text style={{ color: c.muted, fontSize: 12 }}>
              {source === "server" ? t("dash.src.server") : source === "cached" ? t("dash.src.cached") : t("dash.src.local")}
            </Text>
          </View>
          {figureNote ? <Text style={{ color: c.muted, fontSize: 12, lineHeight: 17 }}>{figureNote}</Text> : null}
        </Card>
      ) : null}

      <Card tone="muted" style={{ gap: space.sm }}>
        <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("home.quickActions")}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          <QuickAction testID="home-action-sell" primary label={t("nav.sell")} onPress={() => router.push("/sell")} />
          <QuickAction testID="home-action-stock" label={t("nav.stock")} onPress={() => router.push("/stock")} />
          <QuickAction testID="home-action-expense" label={t("nav.expense")} onPress={() => router.push("/expense")} />
          {/* A stock count is a manager operation, so the owner gets this shortcut as well. */}
          <QuickAction testID="home-action-count" label={t("stock.count")} onPress={() => router.push({ pathname: "/stock", params: { count: "1" } })} />
        </View>
      </Card>

      {loading && !data ? (
        <View testID="dash-loading" style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} height={98} width="23%" style={{ minWidth: 150, flexGrow: 1 }} />)}
        </View>
      ) : failed && !data ? (
        <ErrorState text={t(authIssue ? "dash.sessionExpired" : "home.loadError")} onRetry={() => void load(true)} />
      ) : !data || !ops ? (
        <Loading />
      ) : (
        <>
          {fin ? (
            <>
              {fin.costBasisIncomplete ? <Banner tone="warn" text={t("fin.provisional")} /> : null}
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
                {profitMissing ? <Text style={{ color: c.danger, fontSize: 13, lineHeight: 19 }}>{t("dash.sectionUnavailable")}</Text>
                  : (fin.topProductsByProfit ?? []).length ? (fin.topProductsByProfit ?? []).map((p) => (
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
                {profitMissing ? <Text style={{ color: c.danger, fontSize: 13, lineHeight: 19 }}>{t("dash.sectionUnavailable")}</Text>
                  : (fin.lowMarginProducts ?? []).length ? (fin.lowMarginProducts ?? []).map((p) => (
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
              {(activityExpanded ? data.activity : data.activity.slice(0, 7)).map((a, i) => (
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
              ))}
              {!data.activity.length ? <Empty icon="checkSquare" title={t("appr.noActivity")} description={t("dash.noActivityDesc")} /> : null}
              {data.activity.length > 7 ? (
                <Button testID="dash-activity-toggle" size="sm" kind="secondary"
                  label={activityExpanded
                    ? t("dash.activityLess")
                    : t("dash.activityMore").replace("{n}", String(data.activity.length - 7))}
                  onPress={() => setActivityExpanded((open) => !open)} />
              ) : null}
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
  return <View testID="dash-loading" style={{ paddingVertical: space.xxl, alignItems: "center", gap: space.sm }}><ActivityIndicator color={c.primary} /><Text style={{ color: c.muted, fontSize: 13 }}>{t("common.loading")}</Text></View>;
}
