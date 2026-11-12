import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button, Modal } from "./ui";
import { Icon } from "./icons";
import { useT, type Key } from "../localization";
import { kigaliDay } from "@sms/shared";
import {
  OVERVIEW_PRESETS, OVERVIEW_PRESET_LABEL, formatSelectionRange, monthMatrix, monthOfDay,
  rangeSelection, selectionDays, shiftMonth, todaySelection, type OverviewPreset, type OverviewSelection,
} from "../services/overview-period";
import { radius, space, type, useTheme } from "../theme/tokens";

const fmtDay = (day: string, withYear = true) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(undefined, {
    day: "numeric", month: "long", ...(withYear ? { year: "numeric" as const } : {}), timeZone: "UTC",
  });
};

const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }),
);

/**
 * Overview period control: presets plus a Monday-first Kigali calendar for one day or a range.
 * No external calendar dependency — the existing design tokens and geometric icons keep the web
 * and Android layouts identical.
 */
export function PeriodSelector({ selection, onChange, testID = "period-selector" }: {
  selection: OverviewSelection; onChange: (next: OverviewSelection) => void; testID?: string;
}) {
  const t = useT(); const c = useTheme();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"day" | "range">("day");
  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState(() => monthOfDay(kigaliDay(Date.now())));
  const today = kigaliDay(Date.now());

  const reset = () => {
    const days = selectionDays(selection);
    setStart(days.fromDay); setEnd(selection.kind === "range" ? days.toDay : null);
    setMode(selection.kind === "range" ? "range" : "day");
    setDirty(false);
    setView(monthOfDay(days.fromDay));
  };

  useEffect(() => { if (open) reset(); /* draft is seeded from the committed selection */ }, [open, selection]);

  const cells = useMemo(() => monthMatrix(view.year, view.month, today), [view.year, view.month, today]);
  const monthLabel = new Date(Date.UTC(view.year, view.month - 1, 1)).toLocaleDateString(undefined, {
    month: "long", year: "numeric", timeZone: "UTC",
  });
  const customMode = mode === "range";
  const rangeReady = !!start && (!customMode || !!end);
  const heading = selection.kind === "preset"
    ? t(OVERVIEW_PRESET_LABEL[selection.preset] as Key)
    : selection.kind === "day" ? t("date.customDay") : t("date.customRange");

  const pick = (day: string) => {
    setDirty(true);
    if (!customMode) { setStart(day); setEnd(day); return; }
    if (!start || (start && end)) { setStart(day); setEnd(null); return; }
    if (day < start) { setStart(day); setEnd(null); return; } // never create an invalid range
    setEnd(day);
  };

  const apply = () => {
    if (!start) return;
    if (customMode) {
      const next = rangeSelection(start, end ?? start);
      if (!next) return;
      onChange(next);
    } else {
      onChange({ kind: "day", day: start });
    }
    setOpen(false);
  };

  const choosePreset = (preset: OverviewPreset) => {
    onChange({ kind: "preset", preset });
    setOpen(false);
  };

  return (
    <>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={`${t("common.period")}: ${heading}, ${formatSelectionRange(selection)}`}
        onPress={() => setOpen(true)}
        style={({ hovered, pressed, focused }: any) => ({
          minHeight: 52, width: "100%", maxWidth: 430, paddingHorizontal: space.md, paddingVertical: 8,
          borderRadius: radius.md, borderWidth: focused ? 2 : 1, borderColor: focused ? c.focus : c.lineStrong,
          backgroundColor: pressed ? c.pressed : hovered ? c.hover : c.surface,
          flexDirection: "row", alignItems: "center", gap: space.sm,
        })}
      >
        <View style={{ width: 34, height: 34, borderRadius: radius.sm, backgroundColor: c.primarySoft, alignItems: "center", justifyContent: "center" }}>
          <Icon name="calendar" size={18} color={c.primaryStrong} bg={c.primarySoft} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={{ color: c.ink, fontSize: 13, fontWeight: "700" }}>{heading}</Text>
          <Text numberOfLines={1} style={{ color: c.muted, fontSize: 12 }}>{formatSelectionRange(selection)}</Text>
        </View>
        <Icon name="chevronDown" size={16} color={c.muted} />
      </Pressable>

      <Modal open={open} onClose={() => setOpen(false)} title={t("date.title")} description={t("date.help")} scroll
        footer={<>
          <Button testID="date-cancel" kind="secondary" label={t("common.cancel")} onPress={() => setOpen(false)} />
          {customMode || dirty || selection.kind !== "preset" ? (
            <Button testID="date-apply" label={t("common.apply")} disabled={!rangeReady} onPress={apply} />
          ) : null}
        </>}>
        <View style={{ gap: space.sm }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("date.presets")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {OVERVIEW_PRESETS.map((preset) => {
              const active = selection.kind === "preset" && selection.preset === preset;
              return (
                <Pressable key={preset} testID={`preset-${preset}`} accessibilityRole="button"
                  accessibilityState={{ selected: active }} onPress={() => choosePreset(preset)}
                  style={({ pressed, focused }: any) => ({
                    minHeight: 36, paddingHorizontal: space.md, borderRadius: radius.pill,
                    alignItems: "center", justifyContent: "center",
                    borderWidth: focused ? 2 : 1,
                    borderColor: active ? c.primaryStrong : focused ? c.focus : c.lineStrong,
                    backgroundColor: active ? c.primaryStrong : pressed ? c.pressed : c.surface,
                  })}>
                  <Text style={{ color: active ? c.onPrimary : c.ink, fontSize: 12, fontWeight: active ? "700" : "600" }}>
                    {t(OVERVIEW_PRESET_LABEL[preset] as Key)}
                  </Text>
                </Pressable>
              );
            })}
            {(["day", "range"] as const).map((m) => {
              const active = mode === m;
              return (
                <Pressable key={m} testID={`custom-${m}`} accessibilityRole="button"
                  accessibilityState={{ selected: active }}                  onPress={() => {
                    setMode(m); setDirty(true);
                    if (m === "range" && start && !end) setEnd(start);
                  }}
                  style={({ pressed, focused }: any) => ({
                    minHeight: 36, paddingHorizontal: space.md, borderRadius: radius.pill,
                    alignItems: "center", justifyContent: "center",
                    borderWidth: focused ? 2 : 1,
                    borderColor: active ? c.primaryStrong : focused ? c.focus : c.lineStrong,
                    backgroundColor: active ? c.primarySoft : pressed ? c.pressed : c.surface,
                  })}>
                  <Text style={{ color: active ? c.primaryStrong : c.ink, fontSize: 12, fontWeight: active ? "700" : "600" }}>
                    {t(m === "day" ? "date.customDay" : "date.customRange")}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={{ height: 1, backgroundColor: c.line }} />

        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Pressable testID="calendar-prev" accessibilityRole="button" accessibilityLabel={t("date.previousMonth")}
              onPress={() => setView(shiftMonth(view.year, view.month, -1))}
              style={({ pressed }: any) => ({ width: 40, height: 40, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? c.pressed : c.surfaceMuted })}>
              <Icon name="chevronLeft" size={16} color={c.inkSoft} />
            </Pressable>
            <Text testID="calendar-month" style={{ flex: 1, textAlign: "center", color: c.ink, fontSize: 15, fontWeight: "700" }}>{monthLabel}</Text>
            <Pressable testID="calendar-next" accessibilityRole="button" accessibilityLabel={t("date.nextMonth")}
              onPress={() => setView(shiftMonth(view.year, view.month, 1))}
              style={({ pressed }: any) => ({ width: 40, height: 40, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? c.pressed : c.surfaceMuted })}>
              <Icon name="chevronRight" size={16} color={c.inkSoft} />
            </Pressable>
            <Pressable testID="calendar-today" accessibilityRole="button" onPress={() => {
              const next = todaySelection();
              const days = selectionDays(next);
              setMode("day"); setDirty(true); setStart(days.fromDay); setEnd(days.fromDay);
              setView(monthOfDay(days.fromDay));
            }} style={({ pressed }: any) => ({
              minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.sm, justifyContent: "center",
              borderWidth: 1, borderColor: c.lineStrong, backgroundColor: pressed ? c.pressed : c.surface,
            })}>
              <Text style={{ color: c.primaryStrong, fontSize: 12, fontWeight: "700" }}>{t("common.today")}</Text>
            </Pressable>
          </View>

          <View style={{ flexDirection: "row", gap: 2 }}>
            {WEEKDAYS.map((d, i) => (
              <Text key={`${d}-${i}`} style={{ flex: 1, textAlign: "center", color: c.muted, fontSize: 10, fontWeight: "700", paddingVertical: 2 }}>{d}</Text>
            ))}
          </View>

          {Array.from({ length: 6 }, (_, row) => (
            <View key={row} style={{ flexDirection: "row", gap: 2 }}>
              {cells.slice(row * 7, row * 7 + 7).map((cell) => {
                const selected = cell.day === start || cell.day === end;
                const between = customMode && !!start && !!end && cell.day > start && cell.day < end;
                return (
                  <Pressable key={cell.day} testID={`calendar-day-${cell.day}`} accessibilityRole="button"
                    accessibilityLabel={fmtDay(cell.day)}
                    accessibilityState={{ selected }} onPress={() => pick(cell.day)}
                    style={({ pressed, focused }: any) => ({
                      flex: 1, minHeight: 40, borderRadius: radius.sm, alignItems: "center", justifyContent: "center",
                      borderWidth: focused ? 2 : cell.isToday && !selected ? 1 : 0,
                      borderColor: focused ? c.focus : c.primary,
                      backgroundColor: selected ? c.primaryStrong : between ? c.primarySoft : pressed ? c.pressed : "transparent",
                    })}>
                    <Text style={{
                      color: selected ? c.onPrimary : between ? c.primaryStrong : cell.inMonth ? c.ink : c.muted,
                      fontSize: 13, fontWeight: selected || cell.isToday ? "700" : "500",
                      opacity: cell.inMonth ? 1 : 0.55, fontVariant: ["tabular-nums"],
                    }}>{Number(cell.day.slice(-2))}</Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>

        <View style={{ gap: 3, padding: space.md, borderRadius: radius.sm, backgroundColor: c.surfaceMuted }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("date.selected")}</Text>
          <Text testID="calendar-summary" style={{ color: c.ink, fontSize: 13, fontWeight: "700" }}>
            {!start ? t("date.pickDay") : customMode
              ? `${fmtDay(start)}${end ? ` – ${fmtDay(end)}` : ""}${!end ? ` · ${t("date.pickEnd")}` : ""}`
              : fmtDay(start)}
          </Text>
          {customMode && !end ? <Text style={{ color: c.muted, fontSize: 11 }}>{t("date.rangeHint")}</Text> : null}
        </View>
      </Modal>
    </>
  );
}
