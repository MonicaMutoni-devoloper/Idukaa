import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";
import { formatQty, formatRwf } from "@sms/shared";
import { motion, radius, space, type, useTheme } from "../theme/tokens";
import { useCountUp, useReducedMotion } from "./motion";

export interface TrendPoint { date: string; netSales: number; transactions: number }

const shortDay = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
};
const longDay = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" });
};
/** Bucket labels for monthly series ("YYYY-MM-01" -> "Jan 26"). */
const shortMonth = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
const longMonth = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
const labels = (mode: "day" | "month") => (mode === "month" ? { short: shortMonth, long: longMonth } : { short: shortDay, long: longDay });

/**
 * Real sales-by-period bars. One bar per bucket, height proportional to net sales, with a
 * selectable/hoverable detail readout. The same numbers are always available as text.
 */
export function TrendBars({ data, height = 160, label, pointsLabel, labelMode = "day", showCount = true }: { data: TrendPoint[]; height?: number; label: string; pointsLabel?: string; labelMode?: "day" | "month"; showCount?: boolean }) {
  const c = useTheme();
  const reduced = useReducedMotion();
  const fmt = labels(labelMode);
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const [selected, setSelected] = useState<number | null>(null);
  const values = data.map((d) => d.netSales);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const range = Math.max(1, max - min);
  const zero = Math.round((-min / range) * height); // px from the bottom: supports loss bars below zero
  const total = values.reduce((s, v) => s + v, 0);
  const animatedTotal = useCountUp(total);

  useEffect(() => {
    if (reduced) { progress.setValue(1); return; }
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1, duration: motion.slow, easing: Easing.out(Easing.cubic), useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [data, progress, reduced]);

  const point = selected === null ? null : data[selected];
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, minHeight: 24 }}>
        <Text style={{ color: c.ink, ...type.money }} accessibilityLabel={`${label}: ${formatRwf(animatedTotal)}`}>{formatRwf(animatedTotal)}</Text>
        {showCount ? <Text style={{ color: c.muted, fontSize: 12 }}>{data.reduce((s, d) => s + d.transactions, 0)} {pointsLabel ?? label}</Text> : null}
      </View>
      <View style={{ position: "relative", height }}>
        {[0.25, 0.5, 0.75, 1].map((p) => (
          <View key={p} style={{ position: "absolute", left: 0, right: 0, bottom: (height - 2) * p, height: 1, backgroundColor: c.line, opacity: p === 1 ? 0.9 : 0.45 }} />
        ))}
        <View style={{ position: "absolute", left: 0, right: 0, bottom: zero, height: 1.5, backgroundColor: min < 0 ? c.lineStrong : c.line, zIndex: 2 }} />
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height, flexDirection: "row", alignItems: "flex-end", gap: Math.max(2, Math.min(8, 48 / Math.max(1, data.length))) }}>
          {data.map((d, i) => {
            const value = d.netSales;
            const negative = value < 0;
            const target = Math.max(value !== 0 ? 3 : 1, Math.round((Math.abs(value) / range) * (height - 4)));
            const active = selected === i;
            const barColor = negative ? c.danger : c.primary;
            return (
              <Pressable key={d.date} accessibilityRole="button" accessibilityLabel={`${fmt.long(d.date)}: ${formatRwf(value)}, ${d.transactions}`}
                accessibilityState={{ selected: active }} onPress={() => setSelected(active ? null : i)}
                onHoverIn={() => setSelected(i)} onHoverOut={() => setSelected((v) => (v === i ? null : v))}
                style={{ flex: 1, height, position: "relative", cursor: "pointer" } as any}>
                <Animated.View style={{
                  position: "absolute", left: 0, right: 0,
                  bottom: negative ? zero - target : zero,
                  height: progress.interpolate({ inputRange: [0, 1], outputRange: [1, target] }),
                  backgroundColor: active ? barColor : negative ? c.dangerSoft : c.primarySoft,
                  borderColor: active ? barColor : barColor, borderWidth: 1,
                  borderTopLeftRadius: 3, borderTopRightRadius: 3,
                  borderBottomLeftRadius: negative ? 0 : 3, borderBottomRightRadius: negative ? 0 : 3,
                }} />
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
        <Text style={{ color: c.muted, fontSize: 11 }}>{data.length ? fmt.short(data[0]!.date) : "—"}</Text>
        {point ? (
          <Text style={{ color: c.inkSoft, fontSize: 11, fontWeight: "600" }}>{fmt.long(point.date)} · {formatRwf(point.netSales)} · {point.transactions}</Text>
        ) : <Text style={{ color: c.muted, fontSize: 11 }}>{data.length ? `${data.length} buckets` : "—"}</Text>}
        <Text style={{ color: c.muted, fontSize: 11 }}>{data.length ? fmt.short(data[data.length - 1]!.date) : "—"}</Text>
      </View>
    </View>
  );
}

export interface ComparePoint { date: string; a: number; b: number }

/**
 * Two series per bucket — used for gross profit vs. operating expenses. Bars share one scale,
 * negative values drop below the zero line (a loss), and the selected bucket is spelled out
 * in text so the numbers are never chart-only.
 */
export function CompareBars({ data, labelA, labelB, height = 150, labelMode = "day" }: {
  data: ComparePoint[]; labelA: string; labelB: string; height?: number; labelMode?: "day" | "month";
}) {
  const c = useTheme();
  const fmt = labels(labelMode);
  const [selected, setSelected] = useState<number | null>(null);
  const values = data.flatMap((d) => [d.a, d.b]);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const range = Math.max(1, max - min);
  const zero = Math.round((-min / range) * height);
  const barH = (v: number) => Math.max(v !== 0 ? 3 : 1, Math.round((Math.abs(v) / range) * (height - 4)));
  const totalA = data.reduce((s, d) => s + d.a, 0);
  const totalB = data.reduce((s, d) => s + d.b, 0);
  const point = selected === null ? null : data[selected];
  if (!data.length) return <Text style={{ color: c.muted, fontSize: 12 }}>—</Text>;
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, minHeight: 22 }}>
        <Text style={{ color: c.primaryStrong, fontSize: 12, fontWeight: "700" }}>{labelA}: <Text style={{ color: c.ink, fontVariant: ["tabular-nums"] }}>{formatRwf(totalA)}</Text></Text>
        <Text style={{ color: c.accent, fontSize: 12, fontWeight: "700" }}>{labelB}: <Text style={{ color: c.ink, fontVariant: ["tabular-nums"] }}>{formatRwf(totalB)}</Text></Text>
      </View>
      <View style={{ position: "relative", height }}>
        {[0.25, 0.5, 0.75, 1].map((p) => (
          <View key={p} style={{ position: "absolute", left: 0, right: 0, bottom: (height - 2) * p, height: 1, backgroundColor: c.line, opacity: p === 1 ? 0.9 : 0.45 }} />
        ))}
        <View style={{ position: "absolute", left: 0, right: 0, bottom: zero, height: 1.5, backgroundColor: min < 0 ? c.lineStrong : c.line, zIndex: 2 }} />
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height, flexDirection: "row", alignItems: "flex-end", gap: Math.max(2, Math.min(8, 48 / Math.max(1, data.length))) }}>
          {data.map((d, i) => {
            const active = selected === i;
            return (
              <Pressable key={d.date} accessibilityRole="button"
                accessibilityLabel={`${fmt.long(d.date)}: ${labelA} ${formatRwf(d.a)}, ${labelB} ${formatRwf(d.b)}`}
                accessibilityState={{ selected: active }} onPress={() => setSelected(active ? null : i)}
                onHoverIn={() => setSelected(i)} onHoverOut={() => setSelected((v) => (v === i ? null : v))}
                style={{ flex: 1, height, flexDirection: "row", alignItems: "flex-end", justifyContent: "center", gap: 2, cursor: "pointer" } as any}>
                {[d.a, d.b].map((v, j) => {
                  const h = barH(v);
                  const negative = v < 0;
                  const color = j === 0 ? c.primary : c.accent;
                  return (
                    <View key={j} style={{
                      width: "45%", minHeight: 2,
                      height: h,
                      marginBottom: negative ? zero - h : 0,
                      backgroundColor: active ? color : j === 0 ? c.primarySoft : c.accentSoft,
                      borderWidth: 1, borderColor: color,
                      borderTopLeftRadius: 3, borderTopRightRadius: 3,
                      borderBottomLeftRadius: negative ? 0 : 3, borderBottomRightRadius: negative ? 0 : 3,
                    }} />
                  );
                })}
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
        <Text style={{ color: c.muted, fontSize: 11 }}>{fmt.short(data[0]!.date)}</Text>
        <Text style={{ color: point ? c.inkSoft : c.muted, fontSize: 11, fontWeight: point ? "600" : "400" }}>
          {point ? `${fmt.long(point.date)} · ${formatRwf(point.a)} / ${formatRwf(point.b)}` : `${data.length}`}
        </Text>
        <Text style={{ color: c.muted, fontSize: 11 }}>{fmt.short(data[data.length - 1]!.date)}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: c.primarySoft, borderWidth: 1, borderColor: c.primary }} />
          <Text style={{ color: c.muted, fontSize: 11 }}>{labelA}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: c.accentSoft, borderWidth: 1, borderColor: c.accent }} />
          <Text style={{ color: c.muted, fontSize: 11 }}>{labelB}</Text>
        </View>
      </View>
    </View>
  );
}

/** Horizontal proportional bars for category breakdowns (expenses by category). */
export function BarList({ items, emptyLabel, format = formatRwf }: {
  items: { key: string; label: string; value: number }[]; emptyLabel: string; format?: (n: number) => string;
}) {
  const c = useTheme();
  if (!items.length) return <Text style={{ color: c.muted, fontSize: 12 }}>{emptyLabel}</Text>;
  const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return (
    <View style={{ gap: 8 }}>
      {items.map((i) => (
        <View key={i.key} style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
            <Text numberOfLines={1} style={{ color: c.ink, fontSize: 12, flex: 1 }}>{i.label}</Text>
            <Text style={{ color: c.ink, fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{format(i.value)}</Text>
          </View>
          <View style={{ height: 5, backgroundColor: c.surfaceMuted, borderRadius: 3, overflow: "hidden" }}>
            <View style={{ width: `${Math.max(2, Math.round((Math.abs(i.value) / max) * 100))}%`, height: 5, backgroundColor: c.primary, opacity: 0.7 }} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Ranked products with a proportional bar behind each name. Values are real ledger/sales totals. */
export function ProductRanking({ items, emptyLabel, valueLabel = "sales" }: {
  items: { id: string; name: string; qty: number; netSales: number }[]; emptyLabel: string; valueLabel?: string;
}) {
  const c = useTheme();
  const max = Math.max(1, ...items.map((i) => i.netSales));
  if (!items.length) return <Text style={{ color: c.muted, ...type.small, paddingVertical: space.md }}>{emptyLabel}</Text>;
  return (
    <View style={{ gap: 2 }}>
      {items.map((p) => (
        <View key={p.id} style={{ paddingVertical: 7, gap: 5 }}>
          <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, backgroundColor: c.surfaceMuted, borderRadius: 1 }} />
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
            <Text numberOfLines={1} style={{ color: c.ink, fontSize: 13, fontWeight: "600", flex: 1 }}>{p.name}</Text>
            <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatRwf(p.netSales)}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <View style={{ height: 4, flex: 1, backgroundColor: c.surfaceMuted, borderRadius: 2, overflow: "hidden" }}>
              <View style={{ width: `${Math.max(2, Math.round((p.netSales / max) * 100))}%`, height: 4, backgroundColor: c.primary, opacity: 0.75 }} />
            </View>
            <Text style={{ color: c.muted, fontSize: 11 }}>{formatQty(p.qty)} · {valueLabel}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/** Small stock-health summary using a segmented bar, with an accessible text total. */
export function StockHealthBar({ inStock, low, out, label }: { inStock: number; low: number; out: number; label: string }) {
  const c = useTheme();
  const total = Math.max(1, inStock + low + out);
  const bands = [
    { n: inStock, color: c.success },
    { n: low, color: c.accent },
    { n: out, color: c.danger },
  ];
  return (
    <View style={{ gap: 8 }} accessibilityLabel={`${label}: ${inStock} OK, ${low} low, ${out} out`}>
      <View style={{ flexDirection: "row", height: 8, borderRadius: radius.pill, overflow: "hidden", backgroundColor: c.surfaceMuted }}>
        {bands.map((b) => b.n > 0 ? <View key={b.color} style={{ flex: b.n / total, backgroundColor: b.color }} /> : null)}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        {[
          { label: "OK", n: inStock, color: c.success },
          { label: "Low", n: low, color: c.accent },
          { label: "Out", n: out, color: c.danger },
        ].map((s) => (
          <View key={s.label} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: s.color }} />
            <Text style={{ color: c.muted, fontSize: 11 }}>{s.label} <Text style={{ color: c.inkSoft, fontWeight: "700" }}>{s.n}</Text></Text>
          </View>
        ))}
      </View>
    </View>
  );
}
