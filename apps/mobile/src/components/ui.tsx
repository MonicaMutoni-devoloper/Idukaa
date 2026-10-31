import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Animated, Easing, KeyboardAvoidingView, Modal as RNModal, Platform, Pressable,
  ScrollView, Text, TextInput, View, useWindowDimensions, type TextInputProps, type ViewStyle,
} from "react-native";
import { create } from "zustand";
import { BREAKPOINT_WIDE, MAX_WIDTH, elevation, motion, radius, space, type, useTheme } from "../theme/tokens";
import { useT } from "../localization";
import { useSync } from "../synchronization/engine";
import { Appear, FadeIn, useReducedMotion } from "./motion";
import { Icon, type IconName } from "./icons";

export const useWide = () => useWindowDimensions().width >= BREAKPOINT_WIDE;
const NATIVE_DRIVER = Platform.OS !== "web";

/* ------------------------------------------------------------------ layout */

export function Screen({ children, title, subtitle, actions, maxWidth = MAX_WIDTH, testID }: {
  children: ReactNode; title?: string; subtitle?: string; actions?: ReactNode; maxWidth?: number; testID?: string;
}) {
  const c = useTheme(); const wide = useWide();
  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} testID={testID} style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: wide ? space.xxl : space.lg, paddingTop: wide ? space.xxl : space.lg, paddingBottom: 112 }} keyboardShouldPersistTaps="handled">
        <View style={{ width: "100%", maxWidth, alignSelf: "center", gap: space.lg }}>
          {title ? (
            <FadeIn duration={motion.base} offset={4}>
              <View style={{ flexDirection: wide ? "row" : "column", alignItems: wide ? "flex-end" : "stretch", gap: space.md }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text accessibilityRole="header" style={{ color: c.ink, ...type.h1 }}>{title}</Text>
                  {subtitle ? <Text style={{ color: c.muted, ...type.small }}>{subtitle}</Text> : null}
                </View>
                {actions ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>{actions}</View> : null}
              </View>
            </FadeIn>
          ) : null}
          <FadeIn>{children}</FadeIn>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function Card({ children, style, tone, padded = true }: { children: ReactNode; style?: ViewStyle; tone?: "warn" | "danger" | "ok" | "muted" | "info"; padded?: boolean }) {
  const c = useTheme();
  const bg = tone === "warn" ? c.warnBg : tone === "danger" ? c.dangerBg : tone === "ok" ? c.okBg : tone === "info" ? c.infoSoft : tone === "muted" ? c.surfaceMuted : c.surface;
  const border = tone === "danger" ? c.danger : tone === "warn" ? c.accent : tone === "ok" ? c.success : tone === "info" ? c.info : c.line;
  return <View style={[{ backgroundColor: bg, borderColor: border, borderWidth: 1, borderRadius: radius.md, padding: padded ? space.lg : 0, gap: space.md }, style]}>{children}</View>;
}

export function Section({ title, description, actions, children, gap = space.md }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode; gap?: number }) {
  const c = useTheme();
  return (
    <View style={{ gap }}>
      {title || actions ? (
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.md }}>
          <View style={{ flex: 1, gap: 2 }}>
            {title ? <Text style={{ color: c.ink, ...type.h2 }}>{title}</Text> : null}
            {description ? <Text style={{ color: c.muted, ...type.small }}>{description}</Text> : null}
          </View>
          {actions ? <View style={{ flexDirection: "row", gap: space.sm }}>{actions}</View> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/* ------------------------------------------------------------------ controls */

type ButtonKind = "primary" | "secondary" | "quiet" | "danger" | "dangerQuiet";
export function Button({ label, onPress, kind = "primary", disabled, loading, size = "md", testID, full }: {
  label: string; onPress: () => void; kind?: ButtonKind; disabled?: boolean; loading?: boolean; size?: "md" | "sm"; testID?: string; full?: boolean;
}) {
  const c = useTheme();
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const blocked = disabled || loading;
  const fg = kind === "primary" || kind === "danger" ? c.onPrimary : kind === "dangerQuiet" ? c.danger : kind === "quiet" ? c.primaryStrong : c.ink;
  const border = kind === "secondary" ? c.lineStrong : kind === "dangerQuiet" ? c.danger : "transparent";
  const to = (v: number) => {
    if (reduced) return;
    Animated.timing(scale, { toValue: v, duration: motion.instant, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE_DRIVER }).start();
  };
  return (
    <Animated.View style={{ alignSelf: full ? "stretch" : "flex-start", transform: [{ scale }] }}>
      <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!blocked, busy: !!loading }}
        disabled={blocked} onPress={onPress} onPressIn={() => to(0.97)} onPressOut={() => to(1)}
        style={({ pressed, hovered, focused }: any) => {
          // Explicit state colours: disabled is a real state (not a faded button), pressed beats hover.
          const bg = blocked ? c.disabledBg
            : kind === "primary" ? (pressed ? c.primaryPressed : hovered ? c.primaryHover : c.primaryStrong)
            : kind === "secondary" ? (pressed ? c.pressed : hovered ? c.hover : c.surface)
            : kind === "danger" ? (hovered && !pressed ? c.danger : c.danger)
            : kind === "dangerQuiet" ? (pressed ? c.dangerBg : c.dangerSoft)
            : (pressed || hovered) ? c.hover : "transparent";
          return {
            minHeight: size === "sm" ? 36 : 44, paddingHorizontal: size === "sm" ? space.md : space.xl, borderRadius: radius.sm,
            alignItems: "center", justifyContent: "center", flexDirection: "row", gap: space.sm,
            backgroundColor: bg, borderWidth: border === "transparent" ? 0 : 1, borderColor: blocked && kind === "secondary" ? c.line : border,
            width: full ? "100%" : undefined,
            ...(focused ? { borderWidth: 2, borderColor: c.focus } : {}),
          };
        }}>
        {loading ? <ActivityIndicator size="small" color={blocked ? c.disabledInk : fg} /> : null}
        <Text style={{ color: blocked ? c.disabledInk : fg, fontWeight: "600", fontSize: size === "sm" ? 13 : 15 }}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

export function Field({ label, error, hint, required, testID, containerStyle, trailing, ...p }: TextInputProps & { label: string; error?: string | null; hint?: string; required?: boolean; testID?: string; containerStyle?: ViewStyle; trailing?: ReactNode }) {
  const c = useTheme(); const [focus, setFocus] = useState(false);
  return (
    <View style={{ gap: 5, flexGrow: 1, flexBasis: 150, minWidth: 120, ...containerStyle }}>
      <Text style={{ color: c.inkSoft, fontSize: 12, fontWeight: "600" }}>
        {label}{required ? <Text style={{ color: c.danger }}> *</Text> : null}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <TextInput {...p} testID={testID} accessibilityLabel={label} onFocus={(e) => { setFocus(true); p.onFocus?.(e); }} onBlur={(e) => { setFocus(false); p.onBlur?.(e); }}
          placeholderTextColor={c.muted}
          style={{ flex: 1, minHeight: 44, borderWidth: focus ? 2 : 1, borderColor: error ? c.danger : focus ? c.focus : c.lineStrong, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 10, color: c.ink, backgroundColor: c.surface, fontSize: 15 }} />
        {trailing}
      </View>
      {error ? <FadeIn key={error} duration={motion.fast} offset={-3}><Text style={{ color: c.danger, fontSize: 12 }}>{error}</Text></FadeIn> : hint ? <Text style={{ color: c.muted, fontSize: 12 }}>{hint}</Text> : null}
    </View>
  );
}

/**
 * Password input with a show/hide control. Concealed by default; the toggle only flips
 * `secureTextEntry`, so the value, focus and cursor position are untouched on web and native.
 */
export function PasswordField({ label, error, hint, required, testID, containerStyle, ...p }: TextInputProps & { label: string; error?: string | null; hint?: string; required?: boolean; testID?: string; containerStyle?: ViewStyle }) {
  const c = useTheme(); const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <Field {...p} label={label} error={error} hint={hint} required={required} testID={testID} containerStyle={containerStyle} secureTextEntry={!shown}
      trailing={
        <Pressable testID={testID ? `${testID}-toggle` : undefined} accessibilityRole="button" accessibilityState={{ selected: shown }}
          accessibilityLabel={shown ? t("common.hidePassword") : t("common.showPassword")}
          onPress={() => setShown((v) => !v)}
          style={({ hovered, pressed, focused }: any) => ({
            width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm,
            borderWidth: focused ? 2 : 1, borderColor: focused ? c.focus : c.lineStrong,
            backgroundColor: pressed ? c.surfaceMuted : hovered ? c.bgAlt : c.surface,
          })}>
          <Icon name={shown ? "eyeOff" : "eye"} size={17} color={c.inkSoft} bg={c.surface} />
        </Pressable>
      } />
  );
}

type Tone = "neutral" | "ok" | "warn" | "danger" | "info";
export function Badge({ label, tone = "neutral", dot }: { label: string; tone?: Tone; dot?: boolean }) {
  const c = useTheme();
  const m: Record<Tone, [string, string]> = { neutral: [c.bgAlt, c.inkSoft], ok: [c.okBg, c.success], warn: [c.warnBg, c.accent], danger: [c.dangerBg, c.danger], info: [c.infoSoft, c.info] };
  return (
    <View style={{ backgroundColor: m[tone][0], borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 3, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5 }}>
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: m[tone][1] }} /> : null}
      <Text style={{ color: m[tone][1], fontSize: 11, fontWeight: "700" }}>{label}</Text>
    </View>
  );
}

function Segment({ option, active, onPress }: { option: { value: string; label: string }; active: boolean; onPress: () => void }) {
  const c = useTheme();
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { progress.setValue(active ? 1 : 0); return; }
    Animated.timing(progress, { toValue: active ? 1 : 0, duration: motion.fast, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  }, [active, progress, reduced]);
  return (
    <Pressable testID={`segment-${option.value}`} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={option.label} onPress={onPress}
      style={({ focused }: any) => ({ minHeight: 34, justifyContent: "center", borderRadius: 6, ...(focused ? { borderWidth: 1, borderColor: c.focus } : {}) })}>
      <Animated.View style={{
        position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: 6,
        backgroundColor: c.surface, borderWidth: 1, borderColor: c.lineStrong,
        opacity: progress, transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }],
      }} />
      <Text style={{ color: active ? c.ink : c.muted, fontWeight: active ? "700" : "600", fontSize: 13, paddingHorizontal: space.md, paddingVertical: 7 }}>{option.label}</Text>
    </Pressable>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T | null; onChange: (v: T) => void; label?: string }) {
  const c = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 2, backgroundColor: c.bgAlt, padding: 3, borderRadius: radius.sm, alignSelf: "flex-start" }} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((o) => <Segment key={o.value} option={o} active={value === o.value} onPress={() => onChange(o.value)} />)}
    </View>
  );
}

/* ------------------------------------------------------------------ data display */

export function Stat({ label, value, delta, footnote, emphasis }: { label: string; value: string; delta?: number | null; footnote?: string; emphasis?: boolean }) {
  const c = useTheme();
  const good = (delta ?? 0) >= 0;
  return (
    <Card style={{ flexGrow: 1, flexBasis: emphasis ? 210 : 165, gap: 4, padding: space.lg }}>
      <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{label}</Text>
      <Text style={{ color: emphasis ? c.ink : c.inkSoft, ...(emphasis ? type.display : type.money) }}>{value}</Text>
      {delta === null ? <Text style={{ color: c.muted, fontSize: 12 }}>No prior-period data</Text>
        : delta !== undefined ? <Text style={{ color: good ? c.success : c.danger, fontSize: 12, fontWeight: "600" }}>{good ? "▲" : "▼"} {Math.abs(delta)}% <Text style={{ color: c.muted, fontWeight: "400" }}>vs previous period</Text></Text>
        : footnote ? <Text style={{ color: c.muted, fontSize: 12 }}>{footnote}</Text> : null}
    </Card>
  );
}

export interface Col<R> { key: string; title: string; align?: "left" | "right"; render?: (r: R) => ReactNode; width?: number; hideOnMobile?: boolean }
/** Wide: a dense, sortable table. Narrow: stacked cards with label/value rows (never horizontal scroll). */
export function DataTable<R extends Record<string, any>>({ cols, rows, onRow, rowTitle, rowTestID, empty }: { cols: Col<R>[]; rows: R[]; onRow?: (r: R) => void; rowTitle?: (r: R) => ReactNode; rowTestID?: (r: R) => string; empty?: ReactNode }) {
  const c = useTheme(); const wide = useWide(); const [sort, setSort] = useState<{ k: string; asc: boolean } | null>(null);
  const sorted = sort ? [...rows].sort((a, b) => { const x = a[sort.k], y = b[sort.k]; return (x > y ? 1 : x < y ? -1 : 0) * (sort.asc ? 1 : -1); }) : rows;
  const cell = (col: Col<R>, r: R) => (col.render ? col.render(r) : <Text style={{ color: c.inkSoft, textAlign: col.align ?? "left", fontSize: 14, fontVariant: ["tabular-nums"] }}>{String(r[col.key] ?? "")}</Text>);
  if (!rows.length) return <>{empty ?? <Empty />}</>;
  if (!wide) return (
    <View style={{ gap: space.sm }}>{sorted.map((r, i) => (
      <Appear key={i} index={i}>
        <Pressable testID={rowTestID?.(r)} accessibilityRole={onRow ? "button" : undefined} onPress={() => onRow?.(r)} disabled={!onRow}>
          <Card style={{ padding: space.md, gap: 6 }}>
            {rowTitle ? <View style={{ marginBottom: 2 }}>{rowTitle(r)}</View> : null}
            {cols.filter((col) => !col.hideOnMobile && col.title).map((col) => (
              <View key={col.key} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.md }}>
                <Text style={{ color: c.muted, fontSize: 12 }}>{col.title}</Text>
                <View style={{ alignItems: "flex-end", flexShrink: 1 }}>{cell(col, r)}</View>
              </View>
            ))}
          </Card>
        </Pressable>
      </Appear>))}
    </View>
  );
  return (
    <FadeIn duration={motion.fast} offset={3}>
      <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: radius.md, overflow: "hidden", backgroundColor: c.surface }}>
        <View style={{ flexDirection: "row", backgroundColor: c.surfaceMuted, paddingVertical: 10, paddingHorizontal: space.md, borderBottomWidth: 1, borderBottomColor: c.line }}>
          {cols.map((col) => (
            <Pressable key={col.key} style={{ flex: col.width ?? 1 }} onPress={() => setSort((s) => ({ k: col.key, asc: s?.k === col.key ? !s.asc : true }))}
              accessibilityRole="button" accessibilityLabel={`${col.title}: sort`} accessibilityState={{ selected: sort?.k === col.key }}>
              <Text style={{ color: c.muted, fontWeight: "700", fontSize: 11, letterSpacing: 0.5, textAlign: col.align ?? "left" }}>{col.title.toUpperCase()}{sort?.k === col.key ? (sort.asc ? " ↑" : " ↓") : ""}</Text>
            </Pressable>
          ))}
        </View>
        {sorted.map((r, i) => (
          <Appear key={i} index={i}>
            <Pressable testID={rowTestID?.(r)} accessibilityRole={onRow ? "button" : undefined} onPress={() => onRow?.(r)} disabled={!onRow} style={({ hovered, pressed }: any) => ({ flexDirection: "row", paddingVertical: 12, paddingHorizontal: space.md, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.line, backgroundColor: pressed ? c.surfaceMuted : hovered && onRow ? c.surfaceMuted : "transparent" })}>
              {cols.map((col) => <View key={col.key} style={{ flex: col.width ?? 1, alignItems: col.align === "right" ? "flex-end" : "flex-start", justifyContent: "center" }}>{cell(col, r)}</View>)}
            </Pressable>
          </Appear>
        ))}
      </View>
    </FadeIn>
  );
}

export function KeyValue({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  const c = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.md, paddingVertical: 5, borderTopWidth: strong ? 1 : 0, borderTopColor: c.line, marginTop: strong ? 4 : 0, paddingTop: strong ? 9 : 5 }}>
      <Text style={{ color: strong ? c.ink : c.muted, fontSize: strong ? 15 : 13, fontWeight: strong ? "700" : "400" }}>{label}</Text>
      <Text style={{ color: c.ink, fontSize: strong ? 18 : 14, fontWeight: strong ? "800" : "600", fontVariant: ["tabular-nums"] }}>{value}</Text>
    </View>
  );
}

/** Neutral loading placeholder. No invented progress percentages. */
export function Skeleton({ height = 16, width = "100%", style }: { height?: number; width?: number | `${number}%`; style?: ViewStyle }) {
  const c = useTheme(); const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    if (reduced) { pulse.setValue(0.7); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.5, duration: 700, useNativeDriver: true }),
    ]));
    loop.start(); return () => loop.stop();
  }, [pulse, reduced]);
  return <Animated.View style={{ height, width, borderRadius: 6, backgroundColor: c.line, opacity: pulse, ...style }} />;
}

/* ------------------------------------------------------------------ feedback */

export function Banner({ text, tone = "ok", title, action }: { text: string; tone?: "ok" | "warn" | "danger"; title?: string; action?: ReactNode }) {
  const c = useTheme(); const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { progress.setValue(1); return; }
    Animated.timing(progress, { toValue: 1, duration: motion.base, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE_DRIVER }).start();
  }, [progress, reduced]);
  return (
    <Animated.View style={{ opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] }) }] }}>
      <Card tone={tone} style={{ paddingVertical: space.md, overflow: "hidden" }}>
        {/* Starts neutral and lets the tone tint in as the banner arrives — a brief highlight, not a permanent decoration. */}
        {reduced ? null : (
          <Animated.View pointerEvents="none" style={{
            position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: c.surface,
            opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
          }} />
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <View style={{ width: 3, alignSelf: "stretch", borderRadius: 2, backgroundColor: tone === "danger" ? c.danger : tone === "warn" ? c.accent : c.success }} />
          <View style={{ flex: 1, gap: 2 }}>
            {title ? <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{title}</Text> : null}
            <Text style={{ color: c.inkSoft, fontSize: 13, lineHeight: 19 }}>{text}</Text>
          </View>
          {action}
        </View>
      </Card>
    </Animated.View>
  );
}

export function Empty({ title, description, action, icon }: { title?: string; description?: string; action?: ReactNode; icon?: IconName }) {
  const c = useTheme(); const t = useT();
  return (
    <View style={{ alignItems: "center", paddingVertical: space.xxl, paddingHorizontal: space.lg, gap: 6 }}>
      <View style={{ width: 36, height: 36, borderRadius: 18, borderWidth: 1.5, borderColor: c.lineStrong, alignItems: "center", justifyContent: "center", marginBottom: 4 }}>
        {icon ? <Icon name={icon} size={18} color={c.lineStrong} /> : <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.lineStrong }} />}
      </View>
      <Text style={{ color: c.ink, fontWeight: "700", fontSize: 15, textAlign: "center" }}>{title ?? t("common.empty")}</Text>
      {description ? <Text style={{ color: c.muted, fontSize: 13, textAlign: "center", maxWidth: 360 }}>{description}</Text> : null}
      {action ? <View style={{ marginTop: space.sm }}>{action}</View> : null}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  const c = useTheme(); const t = useT();
  return <View style={{ paddingVertical: space.xxl, alignItems: "center", gap: space.sm }}><ActivityIndicator color={c.primary} /><Text style={{ color: c.muted, fontSize: 13 }}>{label ?? t("common.loading")}</Text></View>;
}

export function ErrorState({ onRetry, text }: { onRetry?: () => void; text?: string }) {
  const t = useT(); const c = useTheme();
  return <Card tone="danger" style={{ gap: space.md }}><Text style={{ color: c.danger, fontSize: 14 }}>{text ?? t("common.error")}</Text>{onRetry ? <Button kind="secondary" label={t("common.retry")} onPress={onRetry} /> : null}</Card>;
}

/* ------------------------------------------------------------------ toast + dialog */

/** Auto-dismiss lifetime of a toast. The shrinking bar below uses the exact same value. */
const TOAST_MS = 4200;
interface ToastItem { id: number; text: string; tone: Tone }
export const useToasts = create<{ items: ToastItem[]; push: (text: string, tone?: Tone) => void; dismiss: (id: number) => void }>((set, get) => ({
  items: [],
  push: (text, tone = "ok") => { const id = Date.now() + Math.random(); set({ items: [...get().items, { id, text, tone }] }); setTimeout(() => get().dismiss(id), TOAST_MS); },
  dismiss: (id) => set({ items: get().items.filter((i) => i.id !== id) }),
}));

/** The toast's remaining lifetime as a bar shrinking to zero — mirrors the auto-dismiss timer exactly. */
function ToastLife({ color }: { color: string }) {
  const reduced = useReducedMotion();
  const life = useRef(new Animated.Value(reduced ? 0 : 1)).current;
  useEffect(() => {
    if (reduced) return;
    const animation = Animated.timing(life, { toValue: 0, duration: TOAST_MS, easing: Easing.linear, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [life, reduced]);
  return (
    <Animated.View pointerEvents="none" style={{
      position: "absolute", left: 0, bottom: 0, height: 2, borderRadius: 1, backgroundColor: color,
      width: life.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
    }} />
  );
}

export function Toaster() {
  const c = useTheme(); const items = useToasts((s) => s.items); const dismiss = useToasts((s) => s.dismiss);
  if (!items.length) return null;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 24, alignItems: "center", paddingHorizontal: space.lg }}>
      {items.map((i) => {
        const dot = i.tone === "danger" ? c.danger : i.tone === "warn" ? c.accent : c.success;
        return (
          <FadeIn key={i.id} duration={motion.base} offset={8} style={{ width: "100%", maxWidth: 520 }}>
            <Pressable accessibilityRole="button" accessibilityLabel={i.text} onPress={() => dismiss(i.id)} style={{ marginTop: space.sm, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: space.md, backgroundColor: c.ink, flexDirection: "row", alignItems: "center", gap: space.sm, overflow: "hidden" }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dot }} />
              <Text style={{ color: c.surface, flex: 1, fontSize: 13 }}>{i.text}</Text>
              <ToastLife color={dot} />
            </Pressable>
          </FadeIn>
        );
      })}
    </View>
  );
}

/**
 * Dialog on desktop, bottom sheet on phones. The backdrop and panel animate in and out; the content
 * stops receiving input while closing, and closing never blocks the caller's next action.
 */
export function Modal({ open, onClose, title, description, children, footer, width = 480, scroll }: {
  open: boolean; onClose: () => void; title: string; description?: string; children?: ReactNode; footer?: ReactNode; width?: number;
  /** Long forms scroll inside the dialog so the actions stay reachable on a phone. */ scroll?: boolean;
}) {
  const c = useTheme(); const wide = useWide(); const reduced = useReducedMotion(); const t = useT();
  const [mounted, setMounted] = useState(open);
  const progress = useRef(new Animated.Value(open ? 1 : 0)).current;

  useEffect(() => {
    if (open) {
      setMounted(true);
      if (reduced) { progress.setValue(1); return; }
      progress.setValue(0);
      Animated.timing(progress, { toValue: 1, duration: motion.base, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE_DRIVER }).start();
      return;
    }
    if (!mounted) return;
    if (reduced) { setMounted(false); return; }
    Animated.timing(progress, { toValue: 0, duration: motion.fast, easing: Easing.in(Easing.quad), useNativeDriver: NATIVE_DRIVER })
      .start(({ finished }) => { if (finished) setMounted(false); });
    // `mounted` is intentionally not a dependency: it changes as a result of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reduced, progress]);

  if (!mounted) return null;
  return (
    <RNModal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent {...({ "aria-label": title } as any)}>
      <View style={{ flex: 1, justifyContent: wide ? "center" : "flex-end", alignItems: "center" }}>
        <Animated.View style={{ ...StyleSheetAbsoluteFill, backgroundColor: c.overlay, opacity: progress }}>
          <Pressable style={{ flex: 1 }} accessibilityRole="button" accessibilityLabel={t("common.close")} onPress={onClose} />
        </Animated.View>
        <Animated.View accessibilityViewIsModal style={{
          width: "100%", maxWidth: wide ? width : undefined, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line,
          borderRadius: wide ? radius.lg : 0, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
          padding: space.xl, paddingBottom: wide ? space.xl : space.xxl, gap: space.md, ...elevation.raised,
          opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [wide ? 10 : 32, 0] }) }, { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [wide ? 0.98 : 1, 1] }) }],
        }}>
          <View style={{ gap: 4 }}>
            <Text accessibilityRole="header" style={{ color: c.ink, ...type.h2 }}>{title}</Text>
            {description ? <Text style={{ color: c.muted, ...type.small }}>{description}</Text> : null}
          </View>
          {scroll
            ? <ScrollView style={{ maxHeight: wide ? 460 : 330 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.md }}>{children}</ScrollView>
            : children}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm, marginTop: space.xs }}>{footer}</View>
        </Animated.View>
      </View>
    </RNModal>
  );
}

const StyleSheetAbsoluteFill = { position: "absolute" as const, left: 0, right: 0, top: 0, bottom: 0 };

export function ConfirmDialog({ open, title, message, confirmLabel, tone = "primary", busy, disabled, children, onConfirm, onCancel }: {
  open: boolean; title: string; message: string; confirmLabel: string; tone?: "primary" | "danger"; busy?: boolean; disabled?: boolean; children?: ReactNode; onConfirm: () => void; onCancel: () => void;
}) {
  const t = useT();
  return (
    <Modal open={open} onClose={onCancel} title={title} description={message} footer={<>
      <Button kind="secondary" label={t("common.cancel")} onPress={onCancel} disabled={busy} />
      <Button kind={tone === "danger" ? "danger" : "primary"} label={confirmLabel} onPress={onConfirm} loading={busy} disabled={disabled} />
    </>}>
      {children}
    </Modal>
  );
}

/* ------------------------------------------------------------------ sync */

export function SyncBadge() {
  const t = useT(); const { online, running, pending, issues, authRequired } = useSync();
  const tone: Tone = authRequired || issues ? "danger" : !online || pending ? "warn" : "ok";
  const label = authRequired ? t("sync.failed") : !online ? `${t("sync.offline")}${pending ? ` · ${pending}` : ""}` : issues ? `${t("sync.conflict")} · ${issues}` : running ? t("common.loading") : pending ? `${t("sync.pending")} · ${pending}` : t("sync.synced");
  return <Badge dot tone={tone} label={label} />;
}

/**
 * Shared sync-status progress bar for the sync screen (and any screen that wants one).
 *
 * The fill is real progress, never an invented percentage: outside a pass it is full when the
 * queue is empty and empty while work waits; during a push pass it tracks the share of the
 * snapshot queue that has actually been applied (the engine refreshes its counts per batch).
 * A pass that starts with an empty queue is a pull pass with no countable steps, so it shows an
 * indeterminate sweep instead of a fake number. Reduced motion freezes every loop and shows the
 * current state directly.
 */
export function SyncProgress({ testID = "sync-progress" }: { testID?: string }) {
  const t = useT(); const c = useTheme(); const reduced = useReducedMotion();
  const { online, running, pending, issues, authRequired, lastSync } = useSync();

  const phase: "error" | "syncing" | "waiting" | "synced" =
    authRequired ? "error" : running ? "syncing" : issues > 0 ? "error" : pending > 0 || !online ? "waiting" : "synced";

  // Queue size when the current pass started — the denominator for real push progress.
  const baseline = useRef(0);
  useEffect(() => { if (running) baseline.current = pending; }, [running]);

  const determinate = running && baseline.current > 0;
  const target = phase === "synced" ? 1
    : phase === "syncing" && determinate ? Math.max(0, Math.min(1, (baseline.current - pending) / baseline.current))
    : 0;

  const [trackW, setTrackW] = useState(0);
  const pillW = Math.max(36, Math.round(trackW * 0.3));
  const sweeping = running && !determinate;

  // Fill grows/shrinks to the real target (or jumps when reduced motion is on).
  const fill = useRef(new Animated.Value(target)).current;
  useEffect(() => {
    if (reduced) { fill.setValue(target); return; }
    const a = Animated.timing(fill, { toValue: target, duration: motion.count, easing: Easing.out(Easing.cubic), useNativeDriver: false });
    a.start();
    return () => a.stop();
  }, [target, reduced, fill]);

  // Indeterminate sweep: only while a pass runs with no countable queue.
  const sweep = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!sweeping || reduced || trackW <= 0) { sweep.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(sweep, { toValue: 1, duration: 950, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [sweeping, reduced, trackW, sweep]);

  // Breathing edge while work sits in the queue (offline or waiting for the next pass).
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (phase !== "waiting" || reduced) { pulse.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [phase, reduced, pulse]);

  const badgeTone: Tone = phase === "error" ? "danger" : phase === "syncing" ? "info" : phase === "waiting" ? "warn" : "ok";
  const label = phase === "error" ? (authRequired ? t("sync.failed") : t("sync.conflict"))
    : phase === "syncing" ? t("sync.syncing")
    : phase === "waiting" ? t("sync.pending")
    : t("sync.synced");
  const right = phase === "synced"
    ? (lastSync ? new Date(lastSync).toLocaleTimeString() : t("common.never"))
    : pending > 0 ? String(pending) : "";
  const trackBg = phase === "error" ? c.dangerSoft : phase === "waiting" ? c.accentSoft : c.line;

  return (
    <View testID={testID} accessibilityRole="progressbar" accessibilityLabel={label}
      accessibilityValue={target > 0 || phase === "synced" ? { min: 0, max: 100, now: Math.round(target * 100) } : { min: 0, max: 100 }}
      style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <Badge dot tone={badgeTone} label={label} />
        {right ? <Text style={{ color: c.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{right}</Text> : null}
      </View>
      <View onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
        style={{ height: 6, borderRadius: radius.pill, overflow: "hidden", backgroundColor: trackBg }}>
        {phase === "waiting" ? (
          <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 12, borderRadius: radius.pill, backgroundColor: c.accent, opacity: pulse }} />
        ) : null}
        <Animated.View pointerEvents="none" style={{
          position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: radius.pill,
          backgroundColor: phase === "synced" ? c.success : c.primary,
          width: fill.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
        }} />
        {sweeping && trackW > 0 ? (
          <Animated.View pointerEvents="none" style={{
            position: "absolute", left: 0, top: 0, bottom: 0, width: pillW, borderRadius: radius.pill,
            backgroundColor: c.primary, opacity: 0.9,
            transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-pillW, Math.max(trackW, 1)] }) }],
          }} />
        ) : null}
      </View>
    </View>
  );
}

