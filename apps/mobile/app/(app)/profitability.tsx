import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  TARGET_GROSS_MARGIN_BPS, breakEven, formatQty, formatRwf, grossMarginPct, markupPct, recommendedPrice,
} from "@sms/shared";
import { Badge, Banner, Button, Card, DataTable, Empty, ErrorState, Field, Loading, Screen, Segmented, useWide } from "../../src/components/ui";
import { DayField } from "../../src/components/date-range-picker";
import { useT, type Key } from "../../src/localization";
import { kvGet, kvSet } from "../../src/database";
import { request, useSession } from "../../src/services/api";
import { cacheWriteMeta, touchCacheAccess } from "../../src/services/cache-meta";
import { addDaysToDay, customRange, parseRwf, presetRange, todayDay, type Preset, type Range } from "../../src/services/util";
import { useSync } from "../../src/synchronization/engine";
import { space, type, useTheme } from "../../src/theme/tokens";

type Period = Preset | "custom";

interface ProductFlags {
  belowCost: boolean; negativeMargin: boolean; lowMargin: boolean; highVolumeLowMargin: boolean;
  slowMoving: boolean; repeatedStockLosses: boolean; outOfStock: boolean; frequentStockouts: boolean;
}
interface PRow {
  productId: string; name: string; code: string | null; unit: string;
  sellingPrice: number; sellingUnit?: string; avgCost: number; onHand: number; inventoryValue: number; lowStock: boolean;
  units: number; revenue: number; cogs: number; grossProfit: number; grossMarginBps: number | null;
  stockLosses: number; stockLossCount: number;
  velocityPerDay: number; velocity30PerDay: number; stockouts90: number;
  flags: ProductFlags;
}
interface Rec {
  code: string; severity: "info" | "warning" | "danger";
  productId?: string; productName?: string;
  params: Record<string, string | number | null>;
  period: { from: string; to: string };
}
interface Totals {
  netSales: number; cogs: number; grossProfit: number; grossMarginBps: number | null;
  operatingExpenses: number; operatingProfit: number; stockLosses: number;
  operatingResultAfterStockLosses: number; inventoryValue: number; costBasisIncomplete: boolean;
}
interface ProfitPayload {
  range: Range; previousRange: Range; valuationMethod: string; targetMarginBps: number; currency: string;
  totals: Totals;
  expenseChanges: { category: string; amount: number; previous: number; pct: number }[];
  items: PRow[];
  recommendations: Rec[];
}

/** Recommendation parameter formatting: money in RWF, quantities in product units, per-day rates too. */
const MONEY_PARAMS = new Set(["price", "cost", "amount", "previous", "value", "revenue", "cogs"]);
const QTY_PARAMS = new Set(["units", "onHand", "velocity30"]);
const recValue = (k: string, v: string | number | null): string => {
  if (v === null || v === undefined) return "—";
  if (MONEY_PARAMS.has(k)) return formatRwf(Number(v));
  if (QTY_PARAMS.has(k)) return formatQty(Number(v));
  return String(v);
};
const SEVERITY_TONE: Record<Rec["severity"], "danger" | "warn" | "neutral"> = {
  danger: "danger", warning: "warn", info: "neutral",
};
/** Expense categories recorded by the Expense screen are localized here for recommendation sentences. */
const CATEGORY_KEYS: Record<string, Key> = {
  rent: "expense.rent", electricity: "expense.electricity", transport: "expense.transport", other: "expense.other",
};

function Stat({ label, value, tone, hint, testID, emphasis }: {
  label: string; value: number; tone?: string; hint?: string; testID?: string; emphasis?: boolean;
}) {
  const c = useTheme();
  return (
    <Card style={{ flexGrow: 1, flexBasis: emphasis ? 210 : 165, gap: 4 }}>
      <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{label}</Text>
      <Text testID={testID} style={{ color: tone ?? c.ink, ...(emphasis ? type.moneyLarge : type.money) }}>{formatRwf(value)}</Text>
      {hint ? <Text style={{ color: c.muted, fontSize: 11 }}>{hint}</Text> : null}
    </Card>
  );
}

export default function Profitability() {
  const t = useT(); const c = useTheme(); const wide = useWide(); const router = useRouter();
  const online = useSync((s) => s.online);
  const lastSync = useSync((s) => s.lastSync);
  const user = useSession((s) => s.user);

  const [period, setPeriod] = useState<Period>("month");
  const [customFrom, setCustomFrom] = useState(addDaysToDay(todayDay(), -6));
  const [customTo, setCustomTo] = useState(todayDay());
  const [appliedCustom, setAppliedCustom] = useState<Range>(() => customRange(addDaysToDay(todayDay(), -6), todayDay())!);
  const [customError, setCustomError] = useState<string | null>(null);
  const [data, setData] = useState<ProfitPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [staleAt, setStaleAt] = useState<string | null>(null);
  const loadedKey = useRef("");

  // Pricing calculator inputs (rows can be tapped to prefill cost and price).
  const [unitCost, setUnitCost] = useState("");
  const [sellPrice, setSellPrice] = useState("");
  const [targetMargin, setTargetMargin] = useState("20");
  // Break-even fixed costs, pre-filled with the period's operating expenses once.
  const [fixedCosts, setFixedCosts] = useState("");

  const range = useMemo(() => (period === "custom" ? appliedCustom : presetRange(period)), [period, appliedCustom]);

  const load = useCallback(async () => {
    if (!range) return;
    setFailed(false); setDenied(false);
    // Profitability is financial data: its saved copy is scoped to the shop AND the signed-in user.
    const key = `profitability:${user?.shopId ?? "none"}:${user?.id ?? "none"}:${range.from}:${range.to}`;
    if (loadedKey.current !== key) {
      loadedKey.current = key;
      setData(null); setStaleAt(null); setLoading(true);
    }
    let hadCache = false;
    try {
      const raw = await kvGet(key);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached?.data) { void touchCacheAccess(key, raw); setData(cached.data); setStaleAt(cached.savedAt ?? null); setLoading(false); hadCache = true; }
      }
    } catch { /* the live request below can still succeed */ }
    if (!hadCache) setLoading(true);
    try {
      const res = await request<ProfitPayload>(`/reports/profitability?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, { auth: true });
      setData(res); setStaleAt(null);
      const now = new Date().toISOString();
      await kvSet(key, JSON.stringify({ savedAt: now, data: res, ...cacheWriteMeta(now) })).catch(() => {});
    } catch (e: any) {
      if (e?.status === 403 || e?.body?.message === "financials_not_permitted") { setDenied(true); setLoading(false); return; }
      setFailed(true);
    } finally { setLoading(false); }
  }, [range, user?.shopId, user?.id]);

  useEffect(() => { void load(); }, [load, lastSync]);

  // One-time prefill of fixed costs from the period's operating expenses.
  useEffect(() => {
    if (data && fixedCosts === "") setFixedCosts(String(data.totals.operatingExpenses || 0));
  }, [data, fixedCosts]);

  const applyCustom = () => {
    const r = customRange(customFrom, customTo);
    if (!r) { setCustomError(t("dash.invalidRange")); return; }
    setCustomError(null); setAppliedCustom(r);
  };

  const cost = parseRwf(unitCost);
  const price = parseRwf(sellPrice);
  const marginNum = (() => {
    const s = targetMargin.trim();
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null;
    const n = Number(s);
    return n >= 0 && n < 100 ? n : null;
  })();
  const markup = cost !== null && price !== null ? markupPct(cost, price) : null;
  const margin = cost !== null && price !== null ? grossMarginPct(cost, price) : null;
  const recommended = cost !== null && marginNum !== null ? recommendedPrice(cost, marginNum) : null;
  const marginInvalid = targetMargin.trim() !== "" && marginNum === null;

  const fixed = parseRwf(fixedCosts);
  const breakEvenResult = data && fixed !== null ? breakEven(data.totals.netSales, data.totals.cogs, fixed) : null;

  const prefillFromRow = (r: PRow) => {
    setUnitCost(r.avgCost > 0 ? String(r.avgCost) : "");
    setSellPrice(String(r.sellingPrice));
  };

  const cols = data ? ([
    { key: "name", title: t("common.product"), width: 2, render: (r: PRow) => (
      <View style={{ gap: 1 }}>
        <Text numberOfLines={1} style={{ color: c.ink, fontWeight: "600", fontSize: 13 }}>{r.name}</Text>
        <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap" }}>
          {r.flags.belowCost ? <Badge tone="danger" label={t("receive.belowCostBadge")} /> : null}
          {r.flags.outOfStock ? <Badge tone="danger" label={t("prof.outOfStock")} /> : null}
          {!r.flags.outOfStock && r.lowStock ? <Badge tone="warn" label={t("stock.low")} /> : null}
          {r.flags.repeatedStockLosses ? <Badge tone="warn" label={t("prof.lossFlag")} /> : null}
        </View>
      </View>
    ) },
    { key: "units", title: t("dash.unitsSold"), align: "right" as const, render: (r: PRow) => <Text style={{ color: c.ink, fontSize: 13, fontVariant: ["tabular-nums"] }}>{formatQty(r.units)} {r.unit}</Text> },
    { key: "revenue", title: t("fin.netSales"), align: "right" as const, render: (r: PRow) => <Text style={{ color: c.ink, fontSize: 13, fontVariant: ["tabular-nums"] }}>{formatRwf(r.revenue)}</Text> },
    { key: "grossProfit", title: t("fin.gross"), align: "right" as const, render: (r: PRow) => <Text style={{ color: r.grossProfit < 0 ? c.danger : c.success, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatRwf(r.grossProfit)}</Text> },
    { key: "margin", title: t("dash.grossMargin"), align: "right" as const, render: (r: PRow) => (
      <Text style={{ color: r.grossMarginBps === null ? c.muted : r.grossMarginBps < 0 ? c.danger : r.grossMarginBps < data.targetMarginBps ? c.accent : c.success, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
        {r.grossMarginBps === null ? "—" : `${(r.grossMarginBps / 100).toFixed(1)}%`}
      </Text>
    ) },
    { key: "price", title: `${t("common.price")} / ${t("common.cost")}`, align: "right" as const, render: (r: PRow) => (
      <View style={{ alignItems: "flex-end", gap: 1 }}>
        <Text style={{ color: c.ink, fontSize: 13, fontVariant: ["tabular-nums"] }}>{formatRwf(r.sellingPrice)}{r.sellingUnit && r.sellingUnit !== r.unit ? ` / ${r.sellingUnit}` : ""}</Text>
        <Text style={{ color: r.flags.belowCost ? c.danger : c.muted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{formatRwf(r.avgCost)}</Text>
      </View>
    ) },
    { key: "stock", title: t("stock.onHand"), align: "right" as const, render: (r: PRow) => (
      <View style={{ alignItems: "flex-end", gap: 1 }}>
        <Text style={{ color: r.onHand <= 0 ? c.danger : c.ink, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{formatQty(r.onHand)} {r.unit}</Text>
        <Text style={{ color: c.muted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{formatRwf(r.inventoryValue)}</Text>
      </View>
    ) },
  ]) : [];

  const recText = (r: Rec) => {
    const key = `rec.${r.code}` as Key;
    let s = t(key);
    s = s.replace("{product}", r.productName ?? "");
    for (const [k, v] of Object.entries(r.params)) {
      const rendered = k === "category" && typeof v === "string" && CATEGORY_KEYS[v] ? t(CATEGORY_KEYS[v]) : recValue(k, v);
      s = s.replace(`{${k}}`, rendered);
    }
    return s;
  };

  return (
    <Screen title={t("prof.title")} subtitle={t("prof.subtitle")}
      actions={
        <Segmented<Period> label={t("common.period")} value={period} onChange={(p) => { setPeriod(p); setCustomError(null); }} options={[
          { value: "today", label: t("common.today") },
          { value: "yesterday", label: t("common.yesterday") },
          { value: "week", label: t("common.week") },
          { value: "month", label: t("common.month") },
          { value: "year", label: t("common.year") },
          { value: "custom", label: t("dash.custom") },
        ]} />
      }>
      {!online ? <Banner tone="warn" text={staleAt ? t("dash.cachedAt").replace("{time}", new Date(staleAt).toLocaleString()) : t("home.cachedData")} /> : null}
      {failed && data ? <Banner tone="warn" text={t("dash.staleBanner")} /> : null}

      {period === "custom" ? (
        <Card style={{ gap: space.md }}>
          <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
            <DayField testID="prof-from" label={t("common.from")} value={customFrom} onChangeText={setCustomFrom} />
            <DayField testID="prof-to" label={t("common.to")} value={customTo} onChangeText={setCustomTo} />
            <View style={{ justifyContent: "flex-end", paddingBottom: 1 }}>
              <Button testID="prof-apply" label={t("common.apply")} onPress={applyCustom} />
            </View>
          </View>
          {customError ? <Text style={{ color: c.danger, fontSize: 12 }}>{customError}</Text> : null}
        </Card>
      ) : null}

      {denied ? (
        <ErrorState text={t("prof.noAccess")} onRetry={() => router.back()} />
      ) : loading && !data ? (
        <Loading />
      ) : failed && !data ? (
        <ErrorState text={t("prof.loadError")} onRetry={() => void load()} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          {data.totals.costBasisIncomplete ? <Banner tone="warn" text={t("fin.provisional")} /> : null}

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            <Stat testID="prof-netSales" emphasis label={t("fin.netSales")} value={data.totals.netSales} />
            <Stat testID="prof-grossProfit" label={t("fin.gross")} value={data.totals.grossProfit}
              tone={data.totals.grossProfit < 0 ? c.danger : undefined}
              hint={data.totals.grossMarginBps != null ? `${t("dash.grossMargin")}: ${(data.totals.grossMarginBps / 100).toFixed(2)}%` : t("fin.marginUnavailable")} />
            <Stat label={t("fin.cogs")} value={data.totals.cogs} />
            <Stat label={t("fin.expenses")} value={data.totals.operatingExpenses} />
            <Stat label={t("fin.stockLoss")} value={data.totals.stockLosses} tone={data.totals.stockLosses > 0 ? c.danger : undefined} />
            <Stat testID="prof-result" label={t("fin.resultAfterLosses")} value={data.totals.operatingResultAfterStockLosses}
              tone={data.totals.operatingResultAfterStockLosses < 0 ? c.danger : c.success} />
            <Stat label={t("fin.invValue")} value={data.totals.inventoryValue} hint={t("prof.valuationMethod")} />
          </View>

          <Card style={{ gap: space.md }}>
            <View style={{ gap: 2 }}>
              <Text style={{ color: c.ink, ...type.h2 }}>{t("prof.recommendations")}</Text>
              <Text style={{ color: c.muted, fontSize: 12 }}>{t("prof.recommendationsHint")}</Text>
            </View>
            {data.recommendations.length ? data.recommendations.map((r, i) => (
              <View key={`${r.code}-${r.productId ?? i}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: 7, borderTopWidth: 1, borderTopColor: c.line }}>
                <Badge tone={SEVERITY_TONE[r.severity]} label={t(r.severity === "danger" ? "prof.sevDanger" : r.severity === "warning" ? "prof.sevWarning" : "prof.sevInfo")} />
                <View style={{ flex: 1, gap: 1 }}>
                  <Text style={{ color: c.ink, fontSize: 13, lineHeight: 19 }}>{recText(r)}</Text>
                  <Text style={{ color: c.muted, fontSize: 11 }}>
                    {new Date(r.period.from).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
                    {" – "}
                    {new Date(new Date(r.period.to).getTime() - 1).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
                  </Text>
                </View>
              </View>
            )) : <Empty icon="chart" title={t("prof.noRecs")} description={t("prof.noRecsDesc")} />}
            <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("prof.recommendationsNote")}</Text>
          </Card>

          <Card style={{ gap: space.md }}>
            <View style={{ gap: 2 }}>
              <Text style={{ color: c.ink, ...type.h2 }}>{t("prof.tableTitle")}</Text>
              <Text style={{ color: c.muted, fontSize: 12 }}>{t("prof.tableHint")}</Text>
            </View>
            <DataTable rows={data.items} cols={cols} onRow={(r: PRow) => prefillFromRow(r)}
              empty={<Card tone="muted"><Empty icon="layers" title={t("prof.noProducts")} description={t("prof.noProductsDesc")} /></Card>} />
            <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("prof.velocityNote")}</Text>
          </Card>

          <View style={{ flexDirection: wide ? "row" : "column", gap: space.md, alignItems: "stretch" }}>
            <Card style={{ flex: 1, gap: space.md, minWidth: 0 }}>
              <View style={{ gap: 2 }}>
                <Text style={{ color: c.ink, ...type.h2 }}>{t("prof.pricingTitle")}</Text>
                <Text style={{ color: c.muted, fontSize: 12 }}>{t("prof.pricingHint")}</Text>
              </View>
              <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
                <Field testID="prof-cost" label={t("common.cost")} value={unitCost} onChangeText={setUnitCost} placeholder="0" keyboardType="number-pad" />
                <Field testID="prof-price" label={t("common.price")} value={sellPrice} onChangeText={setSellPrice} placeholder="0" keyboardType="number-pad" />
                <Field testID="prof-target" label={t("prof.targetMargin")} value={targetMargin} onChangeText={setTargetMargin} placeholder="20"
                  error={marginInvalid ? t("prof.marginInvalid") : null} />
              </View>
              <View style={{ gap: 2 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: c.line }}>
                  <Text style={{ color: c.muted, fontSize: 13 }}>{t("prof.markup")}</Text>
                  <Text testID="prof-markup" style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{markup === null ? "—" : `${markup}%`}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: c.line }}>
                  <Text style={{ color: c.muted, fontSize: 13 }}>{t("prof.marginPct")}</Text>
                  <Text testID="prof-margin" style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{margin === null ? "—" : `${margin}%`}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 5 }}>
                  <Text style={{ color: c.muted, fontSize: 13 }}>{t("prof.recommendedPrice")}</Text>
                  <Text testID="prof-recommended" style={{ color: c.primaryStrong, fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] }}>
                    {recommended === null ? (cost === null ? t("prof.needCost") : t("prof.marginInvalid")) : formatRwf(recommended)}
                  </Text>
                </View>
              </View>
              <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("prof.pricingNote")}</Text>
            </Card>

            <Card style={{ flex: 1, gap: space.md, minWidth: 0 }}>
              <View style={{ gap: 2 }}>
                <Text style={{ color: c.ink, ...type.h2 }}>{t("prof.breakEvenTitle")}</Text>
                <Text style={{ color: c.muted, fontSize: 12 }}>{t("prof.breakEvenHint")}</Text>
              </View>
              <Field testID="prof-fixed" label={t("prof.fixedCosts")} value={fixedCosts} onChangeText={setFixedCosts} placeholder="0" keyboardType="number-pad"
                hint={t("prof.fixedCostsHelp")} />
              {breakEvenResult ? (
                <View style={{ gap: 2 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: c.line }}>
                    <Text style={{ color: c.muted, fontSize: 13 }}>{t("prof.contributionRatio")}</Text>
                    <Text testID="prof-cmr" style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{(breakEvenResult.contributionMarginRatioBps / 100).toFixed(1)}%</Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: 5 }}>
                    <Text style={{ color: c.muted, fontSize: 13 }}>{t("prof.breakEvenRevenue")}</Text>
                    <Text testID="prof-be" style={{ color: c.primaryStrong, fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{formatRwf(breakEvenResult.breakEvenRevenue)}</Text>
                  </View>
                </View>
              ) : (
                <Empty icon="chart" title={t("prof.breakEvenUnavailable")} description={t("prof.breakEvenUnavailableDesc")} />
              )}
              <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("prof.breakEvenNote")}</Text>
            </Card>
          </View>

          <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("prof.methodNote")}</Text>
        </>
      )}
    </Screen>
  );
}
