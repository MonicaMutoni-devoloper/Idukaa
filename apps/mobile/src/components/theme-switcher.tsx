import { Pressable, Text, View } from "react-native";
import { motion, radius, space, type, useTheme, useThemeMode, type ThemeMode } from "../theme/tokens";
import { useT } from "../localization";
import { Icon, type IconName } from "./icons";
import { FadeIn } from "./motion";

const OPTIONS: { value: ThemeMode; icon: IconName; title: "appearance.light" | "appearance.dark" | "appearance.system"; description: "appearance.lightDesc" | "appearance.darkDesc" | "appearance.systemDesc" }[] = [
  { value: "light", icon: "sun", title: "appearance.light", description: "appearance.lightDesc" },
  { value: "dark", icon: "moon", title: "appearance.dark", description: "appearance.darkDesc" },
  { value: "system", icon: "monitor", title: "appearance.system", description: "appearance.systemDesc" },
];

const nextMode = (mode: ThemeMode): ThemeMode => (mode === "light" ? "dark" : mode === "dark" ? "system" : "light");

/** Compact control for the app bar: three explicit choices on desktop, one cycling button on phones. */
export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const t = useT(); const c = useTheme(); const mode = useThemeMode((s) => s.mode); const setMode = useThemeMode((s) => s.setMode);
  const current = t(`appearance.${mode}` as "appearance.light");

  if (compact) {
    return (
      <Pressable testID="theme-cycle" accessibilityRole="button" accessibilityLabel={`${t("appearance.mode")}: ${current}`} accessibilityHint={t("appearance.cycleHint")}
        onPress={() => setMode(nextMode(mode))}
        style={({ hovered, pressed, focused }: any) => ({
          width: 34, height: 32, borderRadius: radius.sm, alignItems: "center", justifyContent: "center",
          backgroundColor: hovered || pressed ? c.bgAlt : c.surface,
          borderWidth: focused ? 2 : 1, borderColor: focused ? c.focus : c.lineStrong, opacity: pressed ? 0.8 : 1,
        })}>
        <FadeIn key={mode} duration={motion.fast} offset={0}>
          <Icon name={mode === "light" ? "sun" : mode === "dark" ? "moon" : "monitor"} size={17} color={c.inkSoft} bg={c.surface} />
        </FadeIn>
      </Pressable>
    );
  }

  return (
    <View accessibilityRole={"radiogroup" as any} accessibilityLabel={t("appearance.mode")}
      style={{ flexDirection: "row", alignItems: "center", gap: 2, padding: 2, borderWidth: 1, borderColor: c.lineStrong, borderRadius: radius.sm, backgroundColor: c.surface }}>
      {OPTIONS.map((o) => {
        const active = mode === o.value;
        return (
          <Pressable key={o.value} testID={`theme-${o.value}`} accessibilityRole="radio" accessibilityState={{ checked: active }} aria-checked={active}
            accessibilityLabel={t(o.title)} onPress={() => setMode(o.value)}
            style={({ hovered, pressed, focused }: any) => ({
              width: 30, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 6,
              backgroundColor: active ? c.primarySoft : hovered || pressed ? c.bgAlt : "transparent",
              borderWidth: focused ? 1.5 : active ? 1 : 0, borderColor: focused ? c.focus : c.primary,
              opacity: pressed ? 0.8 : 1,
            })}>
            <FadeIn key={active ? "on" : "off"} duration={motion.fast} offset={0}>
              <Icon name={o.icon} size={16} color={active ? c.primary : c.muted} bg={active ? c.primarySoft : c.surface} />
            </FadeIn>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Full appearance section for Settings: labelled choices, selected state and persistence note. */
export function AppearanceSettings() {
  const t = useT(); const c = useTheme(); const mode = useThemeMode((s) => s.mode); const setMode = useThemeMode((s) => s.setMode);
  return (
    <View style={{ gap: space.md }}>
      <View style={{ gap: 2 }}>
        <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("appearance.title")}</Text>
        <Text style={{ color: c.muted, ...type.small }}>{t("appearance.help")}</Text>
      </View>
      <View accessibilityRole={"radiogroup" as any} accessibilityLabel={t("appearance.title")} style={{ gap: space.sm }}>
        {OPTIONS.map((o) => {
          const active = mode === o.value;
          return (
            <Pressable key={o.value} testID={`appearance-${o.value}`} accessibilityRole="radio" accessibilityState={{ checked: active }} aria-checked={active}
              accessibilityLabel={t(o.title)} accessibilityHint={t(o.description)} onPress={() => setMode(o.value)}
              style={({ hovered, pressed, focused }: any) => ({
                flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md,
                borderRadius: radius.md, borderWidth: focused ? 2 : 1,
                borderColor: focused ? c.focus : active ? c.primary : c.line,
                backgroundColor: active ? c.primarySoft : hovered || pressed ? c.surfaceMuted : c.surface,
              })}>
              <View style={{ width: 34, height: 34, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: active ? c.surface : c.surfaceMuted, borderWidth: 1, borderColor: active ? c.primary : c.line }}>
                <Icon name={o.icon} size={18} color={active ? c.primary : c.inkSoft} bg={active ? c.surface : c.surfaceMuted} />
              </View>
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={{ color: c.ink, ...type.h3 }}>{t(o.title)}</Text>
                <Text style={{ color: c.muted, fontSize: 12 }}>{t(o.description)}</Text>
              </View>
              <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: active ? 5 : 1.5, borderColor: active ? c.primary : c.lineStrong, backgroundColor: c.surface }} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
