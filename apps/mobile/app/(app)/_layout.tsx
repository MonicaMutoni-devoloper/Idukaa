import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";
import { Redirect, Slot, usePathname, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Banner, Button, SyncBadge, useWide } from "../../src/components/ui";
import { Icon, navIcon } from "../../src/components/icons";
import { ThemeSwitcher } from "../../src/components/theme-switcher";
import { useLang, useT, type Key } from "../../src/localization";
import { useSession } from "../../src/services/api";
import { activeNav, allNav, bottomNav, NAV } from "../../src/navigation";
import { kvGet, kvSet } from "../../src/database";
import { motion, radius, space, type, useTheme } from "../../src/theme/tokens";
import { useSync } from "../../src/synchronization/engine";

const testId = (prefix: string, href: string) => `${prefix}-${href === "/" ? "home" : href.replace(/^\/+/, "").replace(/\//g, "-")}`;
const SIDEBAR_KEY = "sidebar_collapsed";

function Brand({ compact, inverse }: { compact?: boolean; inverse?: boolean }) {
  const c = useTheme(); const t = useT();
  const ink = inverse ? c.sidebarInk : c.ink;
  const soft = inverse ? c.sidebarMuted : c.muted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: c.primaryStrong, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: c.onPrimary, fontWeight: "800", fontSize: 15 }}>S</Text>
      </View>
      {compact ? null : (
        <View>
          <Text numberOfLines={1} style={{ color: ink, fontWeight: "800", fontSize: 14 }}>{t("app.name")}</Text>
          <Text numberOfLines={1} style={{ color: soft, fontSize: 10 }}>{t("brand.tagline")}</Text>
        </View>
      )}
    </View>
  );
}

function TabIndicator({ active }: { active: boolean }) {
  const c = useTheme(); const v = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: active ? 1 : 0, duration: motion.fast, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  }, [active, v]);
  return (
    <Animated.View style={{
      height: 3, borderRadius: 2, backgroundColor: active ? c.primary : c.lineStrong,
      width: v.interpolate({ inputRange: [0, 1], outputRange: [6, 18] }),
      opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }),
    }} />
  );
}

export default function AppLayout() {
  const { user, expired, logout } = useSession();
  const t = useT(); const c = useTheme(); const wide = useWide(); const path = usePathname(); const router = useRouter();
  const { lang, set } = useLang(); const insets = useSafeAreaInsets();
  const online = useSync((s) => s.online);
  const [collapsed, setCollapsed] = useState(false);
  const sidebar = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let alive = true;
    kvGet(SIDEBAR_KEY).then((v) => { if (alive && v === "1") setCollapsed(true); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    Animated.timing(sidebar, { toValue: collapsed ? 0 : 1, duration: motion.slow, easing: Easing.inOut(Easing.cubic), useNativeDriver: false }).start();
  }, [collapsed, sidebar]);

  // The web keeps only a short-lived access token in memory. After an offline reload there is no
  // token until the network returns, but the signed-in user is known and cached data stays usable.
  // Server access is still refused by the API until a fresh token is issued.
  if (!user) return <Redirect href="/login" />;
  // Role boundary: administrators only see the administration area; shop users never see it.
  // The phone tab bar puts the fifth slot on /more, and that screen links to /notifications,
  // /security and /settings, so those destinations must be reachable too — otherwise tapping More
  // (or an item on it) silently bounces back to the admin overview.
  const reachable =
    path.startsWith("/admin") || path === "/more" || allNav(user.role).some((i) => activeNav(i.href, path));
  if (user.role === "system_admin" && !reachable) return <Redirect href="/admin" />;
  if (user.role !== "system_admin" && path.startsWith("/admin")) return <Redirect href="/" />;

  const groups = NAV[user.role] ?? [];
  const current = [...allNav(user.role)].sort((a, b) => b.href.length - a.href.length).find((i) => activeNav(i.href, path));

  const languageSwitch = (
    <Pressable testID="lang-toggle" accessibilityRole="button" accessibilityLabel={t("common.language")} onPress={() => set(lang === "en" ? "rw" : "en")}
      style={({ hovered, pressed, focused }: any) => ({ paddingHorizontal: 9, height: 32, justifyContent: "center", borderWidth: focused ? 2 : 1, borderColor: focused ? c.focus : c.lineStrong, borderRadius: radius.sm, backgroundColor: hovered || pressed ? c.bgAlt : c.surface })}>
      <Text style={{ color: c.inkSoft, fontWeight: "700", fontSize: 11 }}>{lang === "en" ? "RW" : "EN"}</Text>
    </Pressable>
  );

  // One recovery point on every screen: the server rejected the refresh credential, so the user has
  // to sign in again. Nothing local is touched — the outbox keeps syncing after the new sign-in.
  const expiredBanner = expired ? (
    <View style={{ paddingHorizontal: wide ? space.xl : space.lg, paddingTop: space.sm }}>
      <Banner tone="danger" title={t("session.expiredTitle")} text={t("session.expired")}
        action={<Button testID="session-signin" label={t("session.signIn")} onPress={() => void logout().then(() => router.replace("/login"))} />} />
    </View>
  ) : null;

  const syncControl = (
    <Pressable onPress={() => user.role !== "system_admin" && router.push("/sync")} disabled={user.role === "system_admin"}
      accessibilityRole="button" accessibilityLabel={`${t("nav.sync")}: ${online ? t("sync.online") : t("sync.offline")}`}>
      {wide ? <SyncBadge /> : (
        <View pointerEvents="none"><SyncStatusDot /></View>
      )}
    </Pressable>
  );

  const top = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: wide ? space.xl : space.lg, paddingTop: wide ? 10 : insets.top + 8, paddingBottom: 10, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.line }}>
      {wide ? (
        <View style={{ flex: 1, flexDirection: "row", alignItems: "baseline", gap: space.sm, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{current ? t(current.key) : t("app.name")}</Text>
          {current?.description ? <Text numberOfLines={1} style={{ color: c.muted, fontSize: 12 }}>· {t(current.description)}</Text> : null}
        </View>
      ) : (
        <>
          <Brand compact />
          <View style={{ flex: 1 }} />
        </>
      )}
      {syncControl}
      <ThemeSwitcher compact={!wide} />
      {languageSwitch}
      {wide ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.sm }}>
          <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.primarySoft, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: c.primaryStrong, fontWeight: "800", fontSize: 12 }}>{user.name.slice(0, 1).toUpperCase()}</Text>
          </View>
          <View>
            <Text style={{ color: c.ink, fontSize: 12, fontWeight: "700" }} numberOfLines={1}>{user.name}</Text>
            <Text style={{ color: c.muted, fontSize: 10 }}>{t(`role.${user.role}` as Key)}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );

  if (wide) {
    const width = sidebar.interpolate({ inputRange: [0, 1], outputRange: [72, 248] });
    const labelOpacity = sidebar.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0, 0, 1] });
    return (
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: c.bg }}>
        <Animated.View testID="sidebar" style={{ width, backgroundColor: c.sidebar, borderRightWidth: 1, borderRightColor: c.sidebarLine, paddingTop: space.lg, paddingBottom: space.md, overflow: "hidden" }}>
          <View style={{ flex: 1 }}>
            <View style={{ paddingHorizontal: collapsed ? 0 : space.lg, marginBottom: space.xl, alignItems: collapsed ? "center" : "flex-start" }}>
              <Brand compact={collapsed} inverse />
            </View>
            {groups.map((g) => (
              <View key={g.label} style={{ marginBottom: space.lg }}>
                {collapsed ? <View style={{ height: 1, marginHorizontal: space.md, marginBottom: 6, backgroundColor: c.sidebarLine }} /> : (
                  <Animated.Text style={{ color: c.sidebarMuted, ...type.caption, textTransform: "uppercase", paddingHorizontal: space.lg, marginBottom: 6, opacity: labelOpacity }}>{t(g.label)}</Animated.Text>
                )}
                {g.items.map((item) => {
                  const on = activeNav(item.href, path);
                  return (
                    <Pressable key={item.href} testID={testId("nav", item.href)} accessibilityRole="link" accessibilityState={{ selected: on }}
                      accessibilityLabel={t(item.key)} onPress={() => router.push(item.href as any)}
                      style={({ hovered, pressed, focused }: any) => ({
                        flexDirection: "row", alignItems: "center", marginHorizontal: space.sm, marginBottom: 2, borderRadius: radius.sm,
                        backgroundColor: on ? c.sidebarActive : hovered || pressed ? c.sidebarHover : "transparent",
                        borderWidth: focused ? 1 : 0, borderColor: c.focus,
                      })}>
                      <View style={{ width: 3, height: 20, borderRadius: 2, backgroundColor: on ? c.sidebarIndicator : "transparent", marginLeft: 2 }} />
                      <View style={{ width: collapsed ? undefined : 34, alignItems: "center", paddingVertical: 9 }}>
                        <Icon name={navIcon(item.href)} size={17} color={on ? c.sidebarIndicator : c.sidebarMuted} bg={c.sidebar} />
                      </View>
                      {collapsed ? null : (
                        <Animated.Text numberOfLines={1} style={{ color: on ? c.sidebarInk : c.sidebarMuted, fontWeight: on ? "700" : "500", fontSize: 14, paddingVertical: 10, paddingRight: 10, opacity: labelOpacity }}>{t(item.key)}</Animated.Text>
                      )}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: collapsed ? 0 : space.lg, justifyContent: collapsed ? "center" : "space-between" }}>
            {collapsed ? null : (
              <Animated.View style={{ gap: 3, flex: 1, opacity: labelOpacity }}>
                <Text style={{ color: c.sidebarMuted, fontSize: 11 }}>{t("shell.offlineNote")}</Text>
                <Text style={{ color: c.sidebarMuted, fontSize: 10 }}>v1.0.0</Text>
              </Animated.View>
            )}
            <Pressable testID="sidebar-toggle" accessibilityRole="button" accessibilityLabel={collapsed ? t("shell.expand") : t("shell.collapse")}
              accessibilityState={{ expanded: !collapsed }} onPress={() => setCollapsed((v) => { const next = !v; void kvSet(SIDEBAR_KEY, next ? "1" : "0").catch(() => {}); return next; })}
              style={({ hovered, pressed, focused }: any) => ({ width: 32, height: 32, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: hovered || pressed ? c.sidebarHover : "transparent", borderWidth: focused ? 1 : 0, borderColor: c.focus })}>
              <Icon name={collapsed ? "chevronRight" : "chevronLeft"} size={16} color={c.sidebarMuted} />
            </Pressable>
          </View>
        </Animated.View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {top}
          {expiredBanner}
          <Slot />
        </View>
      </View>
    );
  }

  const tabs = bottomNav(user.role);
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {top}
      {expiredBanner}
      <View style={{ flex: 1 }}><Slot /></View>
      <View style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.surface, paddingBottom: insets.bottom }}>
        {tabs.map((item) => {
          const on = activeNav(item.href, path);
          return (
            <Pressable key={item.href} testID={testId("tab", item.href)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={t(item.key)}
              onPress={() => router.push(item.href as any)}
              style={({ pressed }) => ({ flex: 1, minHeight: 56, alignItems: "center", justifyContent: "center", gap: 4, opacity: pressed ? 0.7 : 1 })}>
              <TabIndicator active={on} />
              <Text numberOfLines={1} style={{ color: on ? c.primaryStrong : c.muted, fontWeight: "700", fontSize: 11, paddingHorizontal: 2 }}>{t(item.key)}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function SyncStatusDot() {
  const c = useTheme(); const t = useT();
  const { online, pending, issues, running } = useSync();
  const tone = issues ? c.danger : !online || pending ? c.accent : c.success;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, height: 32, paddingHorizontal: 8, borderRadius: radius.sm, borderWidth: 1, borderColor: c.lineStrong, backgroundColor: c.surface }}
      accessibilityLabel={`${online ? t("sync.online") : t("sync.offline")}${pending ? `, ${pending} ${t("sync.pending")}` : ""}`}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tone, opacity: running ? 0.6 : 1 }} />
      <Text style={{ color: c.inkSoft, fontSize: 11, fontWeight: "600" }}>{online ? t("sync.online") : t("sync.offline")}</Text>
    </View>
  );
}
