import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated, Easing, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "../localization";
import { motion, radius, space, type, useTheme } from "../theme/tokens";
import { useReducedMotion } from "./motion";
import { Icon } from "./icons";
import { introDurationFor, type IntroMode } from "../services/intro";

const NATIVE_DRIVER = Platform.OS !== "web";
const GLOW = "rgba(45,212,191,0.14)";
const GLOW_SOFT = "rgba(45,212,191,0.07)";
const HAIRLINE = "rgba(255,255,255,0.12)";
const CARD = "rgba(255,255,255,0.055)";
const TRACK = "rgba(255,255,255,0.16)";

const fade = (value: Animated.Value, start: number, inEnd: number, outStart: number, outEnd: number) =>
  value.interpolate({
    inputRange: [start, inEnd, outStart, outEnd],
    outputRange: [0, 1, 1, 0],
    extrapolate: "clamp",
  });

const grow = (value: Animated.Value, start: number, end: number) =>
  value.interpolate({ inputRange: [start, end], outputRange: [0, 1], extrapolate: "clamp" });

function BrandMark({ size = 40, accent, ink }: { size?: number; accent: string; ink: string }) {
  return (
    <View style={{
      width: size, height: size, borderRadius: size * 0.28, backgroundColor: accent,
      alignItems: "center", justifyContent: "center",
      shadowColor: accent, shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 6,
    }}>
      <Icon name="box" size={size * 0.52} color={ink} strokeWidth={1.8} />
    </View>
  );
}

function BrandLockup({ compact = false }: { compact?: boolean }) {
  const c = useTheme();
  const t = useT();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: compact ? 10 : 14 }}>
      <BrandMark size={compact ? 34 : 52} accent={c.sidebarIndicator} ink={c.sidebar} />
      <View style={{ gap: compact ? 0 : 3 }}>
        <Text style={{ color: c.sidebarInk, fontSize: compact ? 17 : 25, lineHeight: compact ? 21 : 30, fontWeight: "800", letterSpacing: -0.4 }}>
          {t("app.name")}
        </Text>
        <Text numberOfLines={1} style={{ color: c.sidebarMuted, ...(compact ? { fontSize: 10, lineHeight: 14 } : type.small) }}>
          {t("brand.tagline")}
        </Text>
      </View>
    </View>
  );
}

/** One framed, purely illustrative stage. No records, prices, names or totals are shown. */
function Stage({ children, accent, line }: { children: ReactNode; accent: string; line: string }) {
  return (
    <View style={{
      width: 252, height: 156, borderRadius: radius.lg, borderWidth: 1, borderColor: HAIRLINE,
      backgroundColor: "rgba(4,20,19,0.22)", overflow: "hidden",
    }}>
      <View style={{ position: "absolute", left: 0, right: 0, top: 0, height: 2, backgroundColor: accent, opacity: 0.85 }} />
      <View style={{ position: "absolute", width: 160, height: 160, borderRadius: 80, backgroundColor: GLOW_SOFT, right: -64, top: -74 }} />
      {children}
      <View style={{ position: "absolute", left: 16, right: 16, bottom: 13, height: 1, backgroundColor: line, opacity: 0.6 }} />
    </View>
  );
}

function GhostTile({ color, size = 25, opacity = 1 }: { color: string; size?: number; opacity?: number }) {
  return <View style={{ width: size, height: size * 0.78, borderRadius: 6, borderWidth: 1, borderColor: color, opacity, backgroundColor: "rgba(255,255,255,0.03)" }} />;
}

function StockInStage({ local, accent, line, ink }: { local: Animated.AnimatedInterpolation<number>; accent: string; line: string; ink: string }) {
  const drop = local.interpolate({ inputRange: [0, 0.62, 0.82, 1], outputRange: [-50, 0, 0, 0] });
  const boxOpacity = local.interpolate({ inputRange: [0, 0.12, 0.9, 1], outputRange: [0, 1, 1, 1] });
  const arrow = local.interpolate({ inputRange: [0, 0.16, 0.48, 0.62], outputRange: [0, 1, 1, 0] });
  return (
    <Stage accent={accent} line={line}>
      <Animated.View style={{ position: "absolute", left: 0, right: 0, top: 16, alignItems: "center", opacity: arrow }}>
        <View style={{ transform: [{ rotate: "90deg" }] }}><Icon name="arrowRight" size={18} color={accent} /></View>
      </Animated.View>
      <Animated.View style={{
        position: "absolute", left: 94, top: 58, width: 64, height: 60, borderRadius: 14,
        backgroundColor: accent, alignItems: "center", justifyContent: "center",
        opacity: boxOpacity, transform: [{ translateY: drop }],
        shadowColor: accent, shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 7 },
      }}>
        <Icon name="box" size={30} color={ink} strokeWidth={1.7} />
      </Animated.View>
      <View style={{ position: "absolute", left: 18, right: 18, top: 118, height: 2, borderRadius: 1, backgroundColor: line }} />
      <View style={{ position: "absolute", left: 30, top: 132, flexDirection: "row", gap: 9 }}>
        <GhostTile color={line} opacity={0.55} />
        <GhostTile color={line} opacity={0.4} />
      </View>
      <View style={{ position: "absolute", right: 28, top: 129, flexDirection: "row", gap: 9 }}>
        <GhostTile color={line} opacity={0.4} />
        <GhostTile color={line} opacity={0.55} />
      </View>
    </Stage>
  );
}

function InventoryStage({ local, accent, line, ink }: { local: Animated.AnimatedInterpolation<number>; accent: string; line: string; ink: string }) {
  const scan = local.interpolate({ inputRange: [0.15, 0.9], outputRange: [0, 92] });
  const rows = [
    { at: 0.08, opacity: local.interpolate({ inputRange: [0.05, 0.26], outputRange: [0.18, 1], extrapolate: "clamp" }) },
    { at: 0.3, opacity: local.interpolate({ inputRange: [0.25, 0.46], outputRange: [0.18, 1], extrapolate: "clamp" }) },
    { at: 0.52, opacity: local.interpolate({ inputRange: [0.45, 0.68], outputRange: [0.18, 1], extrapolate: "clamp" }) },
  ];
  return (
    <Stage accent={accent} line={line}>
      <View style={{ position: "absolute", left: 34, right: 34, top: 28, gap: 12 }}>
        {rows.map((row, i) => (
          <View key={i} style={{ flexDirection: "row", justifyContent: "space-between" }}>
            {[0, 1, 2, 3].map((n) => (
              <Animated.View key={n} style={{
                width: 34, height: 22, borderRadius: 6, borderWidth: 1, borderColor: accent,
                backgroundColor: "rgba(45,212,191,0.16)", opacity: row.opacity,
                transform: [{ translateY: local.interpolate({ inputRange: [row.at, row.at + 0.18], outputRange: [5, 0], extrapolate: "clamp" }) }],
              }} />
            ))}
          </View>
        ))}
      </View>
      <Animated.View style={{
        position: "absolute", left: 22, right: 22, top: 32, height: 2, borderRadius: 1,
        backgroundColor: accent, opacity: local.interpolate({ inputRange: [0.1, 0.2, 0.85, 0.98], outputRange: [0, 1, 1, 0] }),
        transform: [{ translateY: scan }],
      }} />
      <View style={{ position: "absolute", right: 22, top: 20, width: 24, height: 24, borderRadius: 7, backgroundColor: accent, alignItems: "center", justifyContent: "center" }}>
        <Icon name="layers" size={13} color={ink} />
      </View>
      <View style={{ position: "absolute", left: 22, bottom: 22, height: 5, width: 54, borderRadius: 3, backgroundColor: line, opacity: 0.65 }} />
    </Stage>
  );
}

function SaleStage({ local, accent, line, ink }: { local: Animated.AnimatedInterpolation<number>; accent: string; line: string; ink: string }) {
  const slide = local.interpolate({ inputRange: [0.15, 0.7], outputRange: [0, 16] });
  const receipt = local.interpolate({ inputRange: [0.12, 0.36, 0.92, 1], outputRange: [0, 1, 1, 1] });
  const check = local.interpolate({ inputRange: [0.55, 0.82], outputRange: [0, 1], extrapolate: "clamp" });
  return (
    <Stage accent={accent} line={line}>
      <View style={{ position: "absolute", left: 26, top: 44, width: 72, height: 62, borderRadius: 10, borderWidth: 1, borderColor: line, backgroundColor: "rgba(255,255,255,0.03)", padding: 9, justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <View style={{ flex: 1, height: 18, borderRadius: 4, borderWidth: 1, borderColor: accent, backgroundColor: "rgba(45,212,191,0.14)" }} />
          <View style={{ flex: 1, height: 18, borderRadius: 4, borderWidth: 1, borderColor: accent, backgroundColor: "rgba(45,212,191,0.14)" }} />
        </View>
        <View style={{ height: 2, width: "82%", borderRadius: 1, backgroundColor: line, opacity: 0.7 }} />
        <View style={{ height: 2, width: "56%", borderRadius: 1, backgroundColor: line, opacity: 0.5 }} />
      </View>
      <View style={{ position: "absolute", left: 108, right: 98, top: 75, height: 2, backgroundColor: line }} />
      <View style={{ position: "absolute", left: 126, top: 67 }}><Icon name="arrowRight" size={17} color={accent} /></View>
      <Animated.View style={{
        position: "absolute", left: 156, top: 43, width: 48, height: 64, borderRadius: 9,
        borderWidth: 1, borderColor: accent, backgroundColor: "rgba(4,20,19,0.5)",
        opacity: receipt, transform: [{ translateX: slide }],
        padding: 8, justifyContent: "space-between",
      }}>
        <Icon name="receipt" size={22} color={accent} />
        <View style={{ gap: 4 }}>
          <View style={{ height: 2, width: "100%", backgroundColor: line }} />
          <View style={{ height: 2, width: "68%", backgroundColor: line }} />
        </View>
      </Animated.View>
      <Animated.View style={{
        position: "absolute", right: 22, top: 66, width: 26, height: 26, borderRadius: 13,
        backgroundColor: accent, alignItems: "center", justifyContent: "center", opacity: check,
        transform: [{ scale: check }],
      }}>
        <Icon name="check" size={14} color={ink} strokeWidth={2.2} />
      </Animated.View>
      <View style={{ position: "absolute", right: 22, bottom: 22, width: 24, height: 4, borderRadius: 2, backgroundColor: line, opacity: 0.65 }} />
    </Stage>
  );
}

function ProgressRail({ master, reduced }: { master: Animated.Value; reduced: boolean }) {
  const c = useTheme();
  const widths = reduced ? [1, 1, 1] : [grow(master, 0.03, 0.255), grow(master, 0.31, 0.555), grow(master, 0.61, 0.855)];
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", gap: 6, width: "100%" }}>
      {widths.map((scaleX, i) => (
        <View key={i} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: TRACK, overflow: "hidden" }}>
          <Animated.View style={{
            width: "100%", height: 3, borderRadius: 2, backgroundColor: c.sidebarIndicator,
            transformOrigin: "left", transform: [{ scaleX }],
          }} />
        </View>
      ))}
    </View>
  );
}

/** Static, readable version of the same information for people who ask for reduced motion. */
function ReducedIntro({ returning }: { returning: boolean }) {
  const c = useTheme();
  const t = useT();
  const rows = [
    { icon: "box" as const, title: "intro.step1Title" as const, text: "intro.step1Text" as const },
    { icon: "layers" as const, title: "intro.step2Title" as const, text: "intro.step2Text" as const },
    { icon: "cart" as const, title: "intro.step3Title" as const, text: "intro.step3Text" as const },
  ];
  return (
    <View style={{ width: "100%", maxWidth: 430, alignItems: "center", gap: space.lg }}>
      <BrandMark size={64} accent={c.sidebarIndicator} ink={c.sidebar} />
      <View style={{ alignItems: "center", gap: 5 }}>
        <Text style={{ color: c.sidebarInk, ...type.display }}>{returning ? t("intro.welcome") : t("app.name")}</Text>
        <Text style={{ color: c.sidebarMuted, textAlign: "center", ...type.body }}>
          {returning ? t("brand.tagline") : t("intro.firstLead")}
        </Text>
      </View>
      {returning ? null : (
        <View style={{ width: "100%", borderRadius: radius.lg, borderWidth: 1, borderColor: HAIRLINE, backgroundColor: CARD, padding: space.lg, gap: space.md }}>
          {rows.map((row) => (
            <View key={row.title} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: "rgba(45,212,191,0.16)", alignItems: "center", justifyContent: "center" }}>
                <Icon name={row.icon} size={17} color={c.sidebarIndicator} />
              </View>
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={{ color: c.sidebarInk, ...type.h3 }}>{t(row.title)}</Text>
                <Text style={{ color: c.sidebarMuted, ...type.small }}>{t(row.text)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * The branded introduction, mounted once by the root layout and never by a screen. It covers the
 * app while startup continues underneath, so database, session, language and sync work are not
 * delayed. `mode` resolves once the device preference has been read; only a first installation
 * gets the full stock-in → inventory → sale story.
 */
export function BrandIntro({ mode, onDone }: { mode: IntroMode; onDone: () => void }) {
  const c = useTheme();
  const t = useT();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const master = useRef(new Animated.Value(0)).current;
  const [sceneIndex, setSceneIndex] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;
  const short = height < 660;

  // Keep the accessibility tree on the scene that is actually visible. The animation itself stays
  // on the native driver; these three timers only decide which text a screen reader may announce.
  useEffect(() => {
    setSceneIndex(0);
    if (mode !== "first" || reduced) return;
    const timers = [
      setTimeout(() => setSceneIndex(1), 1320),
      setTimeout(() => setSceneIndex(2), 2640),
      setTimeout(() => setSceneIndex(3), 3960),
    ];
    return () => timers.forEach(clearTimeout);
  }, [mode, reduced]);

  useEffect(() => {
    if (mode === "loading" || mode === "done") return;
    if (reduced) {
      master.setValue(1);
      const timer = setTimeout(() => done.current(), introDurationFor(mode, true));
      return () => clearTimeout(timer);
    }
    master.setValue(0);
    const animation = Animated.timing(master, {
      toValue: 1,
      duration: introDurationFor(mode, false),
      easing: Easing.linear,
      useNativeDriver: NATIVE_DRIVER,
    });
    animation.start(({ finished }) => { if (finished) done.current(); });
    return () => animation.stop();
  }, [mode, reduced, master]);

  const overlayOpacity = mode === "returning" && !reduced
    ? master.interpolate({ inputRange: [0, 0.12, 0.82, 1], outputRange: [0, 1, 1, 0], extrapolate: "clamp" })
    : mode === "first" && !reduced
      ? master.interpolate({ inputRange: [0, 0.01, 0.96, 1], outputRange: [0.98, 1, 1, 0], extrapolate: "clamp" })
      : 1;

  const doneOpacity = mode === "first" && !reduced
    ? master.interpolate({ inputRange: [0.9, 0.95, 0.995], outputRange: [0, 1, 1], extrapolate: "clamp" })
    : mode === "first" ? 1 : 0;

  // A short empty beat between scenes keeps two captions from ever being legible on top of each
  // other; the illustration still changes in one continuous flow.
  const sceneOpacity = {
    a: mode === "first" && !reduced ? fade(master, 0.01, 0.05, 0.255, 0.285) : mode === "first" ? 1 : 0,
    b: mode === "first" && !reduced ? fade(master, 0.31, 0.35, 0.555, 0.585) : 0,
    c: mode === "first" && !reduced ? fade(master, 0.61, 0.65, 0.855, 0.885) : 0,
  };
  const local = {
    a: master.interpolate({ inputRange: [0.01, 0.28], outputRange: [0, 1], extrapolate: "clamp" }),
    b: master.interpolate({ inputRange: [0.31, 0.6], outputRange: [0, 1], extrapolate: "clamp" }),
    c: master.interpolate({ inputRange: [0.61, 0.9], outputRange: [0, 1], extrapolate: "clamp" }),
  };
  const returningScale = master.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0.94, 1, 1.025], extrapolate: "clamp" });
  const stageHeight = short ? 128 : 156;
  const hiddenScene = (index: number) => mode === "first" && !reduced && sceneIndex !== index;

  const scenes = [
    {
      key: "a",
      title: t("intro.step1Title"),
      text: t("intro.step1Text"),
      opacity: sceneOpacity.a,
      illustration: <StockInStage local={local.a} accent={c.sidebarIndicator} line={c.sidebarMuted} ink={c.sidebar} />,
    },
    {
      key: "b",
      title: t("intro.step2Title"),
      text: t("intro.step2Text"),
      opacity: sceneOpacity.b,
      illustration: <InventoryStage local={local.b} accent={c.sidebarIndicator} line={c.sidebarMuted} ink={c.sidebar} />,
    },
    {
      key: "c",
      title: t("intro.step3Title"),
      text: t("intro.step3Text"),
      opacity: sceneOpacity.c,
      illustration: <SaleStage local={local.c} accent={c.sidebarIndicator} line={c.sidebarMuted} ink={c.sidebar} />,
    },
  ];

  return (
    <Animated.View
      testID="brand-intro"
      accessibilityViewIsModal
      aria-modal
      accessibilityLabel={t("intro.a11y")}
      style={[StyleSheet.absoluteFill, { zIndex: 1000, elevation: 40, backgroundColor: c.sidebar, opacity: overlayOpacity }]}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={{ position: "absolute", width: 520, height: 520, borderRadius: 260, backgroundColor: GLOW, top: -250, right: -230 }} />
        <View style={{ position: "absolute", width: 420, height: 420, borderRadius: 210, backgroundColor: GLOW_SOFT, bottom: -230, left: -200 }} />
        <View style={{ position: "absolute", width: 1, height: "100%", backgroundColor: "rgba(255,255,255,0.035)", left: "26%" }} />
        <View style={{ position: "absolute", width: 1, height: "100%", backgroundColor: "rgba(255,255,255,0.035)", right: "26%" }} />
      </View>

      <View style={{
        flex: 1, paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.md,
        paddingHorizontal: space.lg, alignItems: "center", justifyContent: "space-between", gap: space.md,
      }}>
        <View style={{ width: "100%", maxWidth: 430, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md }}>
          <BrandLockup compact={short} />
          {mode === "first" || mode === "returning" ? (
            <Pressable
              testID="intro-skip"
              accessibilityRole="button"
              accessibilityLabel={t("intro.skip")}
              onPress={() => done.current()}
              style={({ hovered, pressed, focused }: any) => ({
                minHeight: 42, paddingHorizontal: space.md, borderRadius: radius.pill,
                flexDirection: "row", alignItems: "center", gap: 6,
                borderWidth: 1, borderColor: focused ? c.sidebarIndicator : HAIRLINE,
                backgroundColor: hovered || pressed ? "rgba(255,255,255,0.09)" : "transparent",
              })}
            >
              <Text style={{ color: c.sidebarInk, ...type.small, fontWeight: "700" }}>{t("intro.skip")}</Text>
              <Icon name="arrowRight" size={13} color={c.sidebarMuted} />
            </Pressable>
          ) : null}
        </View>

        <View style={{ width: "100%", flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: space.md }}>
          {mode === "loading" ? (
            <View style={{ alignItems: "center", gap: space.lg }}>
              <BrandMark size={58} accent={c.sidebarIndicator} ink={c.sidebar} />
              <Text style={{ color: c.sidebarMuted, ...type.small }}>{t("intro.loading")}</Text>
            </View>
          ) : reduced ? (
            <ReducedIntro returning={mode === "returning"} />
          ) : mode === "returning" ? (
            <Animated.View style={{ alignItems: "center", gap: space.md, transform: [{ scale: returningScale }] }}>
              <BrandMark size={70} accent={c.sidebarIndicator} ink={c.sidebar} />
              <Text style={{ color: c.sidebarInk, ...type.display }}>{t("intro.welcome")}</Text>
              <Text style={{ color: c.sidebarMuted, ...type.body }}>{t("brand.tagline")}</Text>
            </Animated.View>
          ) : (
            <View style={{
              width: "100%", maxWidth: 430, borderRadius: 24, borderWidth: 1, borderColor: HAIRLINE,
              backgroundColor: CARD, padding: space.lg, gap: space.md,
              shadowColor: "#041413", shadowOpacity: 0.3, shadowRadius: 30, shadowOffset: { width: 0, height: 16 }, elevation: 10,
            }}>
              <View style={{ height: stageHeight, alignItems: "center", justifyContent: "center" }}>
                {scenes.map((scene) => (
                  <Animated.View
                    key={scene.key}
                    accessibilityElementsHidden={hiddenScene(scenes.indexOf(scene))}
                    importantForAccessibility={hiddenScene(scenes.indexOf(scene)) ? "no-hide-descendants" : "auto"}
                    style={{
                      position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                      alignItems: "center", justifyContent: "center", opacity: scene.opacity,
                    }}
                  >
                    <View style={{ transform: [{ scale: short ? 0.82 : 1 }] }}>{scene.illustration}</View>
                  </Animated.View>
                ))}
                <Animated.View
                  accessibilityElementsHidden={!(mode === "first" && !reduced && sceneIndex === 3)}
                  importantForAccessibility={mode === "first" && !reduced && sceneIndex === 3 ? "auto" : "no-hide-descendants"}
                  style={{ position: "absolute", alignItems: "center", gap: 7, opacity: doneOpacity }}
                >
                  <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.sidebarIndicator, alignItems: "center", justifyContent: "center" }}>
                    <Icon name="check" size={24} color={c.sidebar} strokeWidth={2.3} />
                  </View>
                  <Text style={{ color: c.sidebarInk, ...type.h3, fontWeight: "800" }}>{t("intro.ready")}</Text>
                </Animated.View>
              </View>

              <View style={{ minHeight: 68, justifyContent: "flex-start" }}>
                {scenes.map((scene) => (
                  <Animated.View
                    key={scene.key}
                    accessibilityElementsHidden={hiddenScene(scenes.indexOf(scene))}
                    importantForAccessibility={hiddenScene(scenes.indexOf(scene)) ? "no-hide-descendants" : "auto"}
                    style={{ position: "absolute", top: 0, left: 0, right: 0, gap: 3, opacity: scene.opacity }}
                  >
                    <Text style={{ color: c.sidebarInk, textAlign: "center", ...type.h1 }}>{scene.title}</Text>
                    <Text style={{ color: c.sidebarMuted, textAlign: "center", ...type.body }}>{scene.text}</Text>
                  </Animated.View>
                ))}
                <Animated.View
                  accessibilityElementsHidden={!(mode === "first" && !reduced && sceneIndex === 3)}
                  importantForAccessibility={mode === "first" && !reduced && sceneIndex === 3 ? "auto" : "no-hide-descendants"}
                  style={{ position: "absolute", top: 0, left: 0, right: 0, gap: 3, opacity: doneOpacity }}
                >
                  <Text style={{ color: c.sidebarInk, textAlign: "center", ...type.h1 }}>{t("intro.readyLead")}</Text>
                  <Text style={{ color: c.sidebarMuted, textAlign: "center", ...type.body }}>{t("brand.tagline")}</Text>
                </Animated.View>
              </View>

              <ProgressRail master={master} reduced={reduced} />
            </View>
          )}
        </View>

        <View style={{ width: "100%", maxWidth: 430, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, minHeight: 20 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.sidebarIndicator }} />
          <Text style={{ color: c.sidebarMuted, ...type.small }}>{t("shell.offlineNote")}</Text>
        </View>
      </View>
    </Animated.View>
  );
}
