import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo, Animated, Easing, Platform, Pressable, Text, View, type StyleProp, type ViewStyle,
} from "react-native";
import { motion, radius, space, type, useTheme } from "../theme/tokens";
import { Icon } from "./icons";

const NATIVE_DRIVER = Platform.OS !== "web";

/** Single source of truth for the OS/browser reduced-motion preference. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setReduced(v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.("reduceMotionChanged", (v: boolean) => setReduced(v));
    const mq = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    if (mq) {
      setReduced(mq.matches);
      const on = () => setReduced(mq.matches);
      mq.addEventListener?.("change", on);
      return () => { alive = false; sub?.remove?.(); mq.removeEventListener?.("change", on); };
    }
    return () => { alive = false; sub?.remove?.(); };
  }, []);
  return reduced;
}

/** Brief page/content entrance: opacity plus a few pixels of vertical travel. Never blocks input. */
export function FadeIn({ children, delay = 0, offset = 6, duration = motion.page, style }: {
  children: ReactNode; delay?: number; offset?: number; duration?: number; style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { progress.setValue(1); return; }
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1, duration, delay, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE_DRIVER,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, reduced, delay, duration]);
  return (
    <Animated.View style={[{ opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [offset, 0] }) }] }, style]}>
      {children}
    </Animated.View>
  );
}

/** Counts a metric up once when its value changes. Reduced motion shows the final number immediately. */
export function useCountUp(value: number, duration = motion.count): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const previous = useRef(value);
  useEffect(() => {
    if (reduced || previous.current === value || !Number.isFinite(value)) { previous.current = value; setShown(value); return; }
    const start = previous.current;
    const delta = value - start;
    const driver = new Animated.Value(0);
    const listener = driver.addListener(({ value: p }) => setShown(Math.round(start + delta * p)));
    Animated.timing(driver, { toValue: 1, duration, easing: Easing.out(Easing.cubic), useNativeDriver: false })
      .start(() => { setShown(value); previous.current = value; driver.removeListener(listener); });
    return () => { driver.removeListener(listener); driver.stopAnimation(); };
  }, [value, reduced, duration]);
  return shown;
}

/** Height/opacity transition for expandable sections, measured from real content. */
export function Disclosure({ title, description, children, initiallyOpen = false, testID }: {
  title: string; description?: string; children: ReactNode; initiallyOpen?: boolean; testID?: string;
}) {
  const c = useTheme();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(initiallyOpen);
  const [measured, setMeasured] = useState(0);
  const progress = useRef(new Animated.Value(initiallyOpen ? 1 : 0)).current;

  useEffect(() => {
    if (reduced) { progress.setValue(open ? 1 : 0); return; }
    const animation = Animated.timing(progress, {
      toValue: open ? 1 : 0, duration: motion.slow, easing: Easing.inOut(Easing.cubic), useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [open, progress, reduced]);

  return (
    <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: radius.md, backgroundColor: c.surface, overflow: "hidden" }}>
      <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open} accessibilityLabel={title}
        onPress={() => setOpen((v) => !v)}
        style={({ hovered, pressed, focused }: any) => ({
          paddingVertical: space.md, paddingHorizontal: space.lg, flexDirection: "row", alignItems: "center", gap: space.md,
          backgroundColor: hovered || pressed ? c.surfaceMuted : c.surface,
          ...(focused ? { borderWidth: 1, borderColor: c.focus, borderRadius: radius.md } : {}),
        })}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: c.ink, ...type.h3 }}>{title}</Text>
          {description ? <Text style={{ color: c.muted, ...type.small }}>{description}</Text> : null}
        </View>
        <Animated.View style={{ transform: [{ rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "180deg"] }) }] }}>
          <Icon name="chevronDown" size={16} color={c.muted} />
        </Animated.View>
      </Pressable>
      <Animated.View pointerEvents={open ? "auto" : "none"} accessibilityElementsHidden={!open}
        importantForAccessibility={open ? "auto" : "no-hide-descendants"} aria-hidden={!open}
        style={{
          height: progress.interpolate({ inputRange: [0, 1], outputRange: [0, Math.max(1, measured)] }),
          opacity: progress, overflow: "hidden",
        }}>
        <View onLayout={(e) => setMeasured(e.nativeEvent.layout.height)}>{children}</View>
      </Animated.View>
    </View>
  );
}

/** Rows past this index render immediately: staggering a hundred rows would only make lists feel slow. */
const STAGGER_ROWS = 10;

/**
 * Staggered entrance for list rows: the same travel as FadeIn, delayed by row index and capped so a
 * long list never makes anyone wait. Rows past the stagger window skip the animation entirely.
 */
export function Appear({ children, index = 0, stagger = 30, maxDelay = motion.slow, offset = 6, style }: {
  children: ReactNode; index?: number; stagger?: number; maxDelay?: number; offset?: number; style?: StyleProp<ViewStyle>;
}) {
  if (index >= STAGGER_ROWS) return <View style={style}>{children}</View>;
  return (
    <FadeIn delay={Math.min(index * stagger, maxDelay)} duration={motion.base} offset={offset} style={style}>
      {children}
    </FadeIn>
  );
}

/**
 * Exit animation for a removable row. While `active` the child renders normally; when it flips to
 * false the child fades and lifts a few pixels and only then does `onDone` fire, so the caller drops
 * the row from state after the animation instead of yanking it away in the frame the user pressed
 * remove. Reduced motion calls `onDone` immediately.
 */
export function Dismiss({ active, onDone, children, style }: {
  active: boolean; onDone: () => void; children: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(active ? 1 : 0)).current;
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (active) { progress.setValue(1); return; }
    if (reduced) { done.current(); return; }
    const animation = Animated.timing(progress, {
      toValue: 0, duration: motion.fast, easing: Easing.in(Easing.quad), useNativeDriver: NATIVE_DRIVER,
    });
    animation.start(({ finished }) => { if (finished) done.current(); });
    return () => animation.stop();
  }, [active, reduced, progress]);
  return (
    <Animated.View style={[{
      opacity: progress,
      transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }],
    }, style]}>
      {children}
    </Animated.View>
  );
}

/**
 * Short horizontal shake for an invalid submission. Each new `trigger` value replays it once, so
 * callers bump a counter instead of wiring refs; reduced motion never shakes.
 */
export function Shake({ trigger, children, style }: {
  trigger: number; children: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced || trigger <= 0) return;
    x.setValue(0);
    const animation = Animated.sequence(
      [-4, 4, -3, 3, 0].map((to) =>
        Animated.timing(x, { toValue: to, duration: motion.instant / 2, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE_DRIVER })),
    );
    animation.start();
    return () => animation.stop();
  }, [trigger, reduced, x]);
  return <Animated.View style={[{ transform: [{ translateX: x }] }, style]}>{children}</Animated.View>;
}
