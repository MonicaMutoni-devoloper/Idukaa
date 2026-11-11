import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Crypto from "expo-crypto";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../src/services/api";
import { usePwaInstall } from "../src/services/pwa-install";
import { initDb, kvGet, kvSet } from "../src/database";
import { refreshCounts, startSyncEngine, syncNow } from "../src/synchronization/engine";
import { Banner, Button, Toaster } from "../src/components/ui";
import { applyWebChrome, loadThemeMode, useEffectiveScheme, space, useTheme } from "../src/theme/tokens";
import { loadLang, useT } from "../src/localization";
import { BrandIntro } from "../src/components/brand-intro";
import { INTRO_SEEN_KEY, INTRO_SEEN_VALUE, type IntroMode } from "../src/services/intro";

async function initDbPlatform() {
  await initDb();
  if (!(await kvGet("device_id"))) await kvSet("device_id", Crypto.randomUUID());
}

export default function Root() {
  const [ready, setReady] = useState(false);
  // Root is mounted exactly once for the life of the app, so this overlay can never replay on a
  // route change, a shop switch, a sync or a sign-in. Only a real launch resolves a new mode.
  const [intro, setIntro] = useState<IntroMode>("loading");
  const introResolved = useRef(false);
  // Listen from the first paint: Chrome can offer installation before Settings is ever opened.
  useEffect(() => { usePwaInstall.getState().start(); }, []);
  const [updateReady, setUpdateReady] = useState(false);
  const token = useSession((s) => s.token);
  const c = useTheme();
  const t = useT();
  const insets = useSafeAreaInsets();
  const scheme = useEffectiveScheme();

  /**
   * Safe PWA update: the service worker installs with skipWaiting() + clients.claim(), so a new
   * version can take over a tab that is already running older code — an SPA never reloads itself,
   * which is how users end up on a stale bundle after a deploy. `controllerchange` fires for that
   * handover, but also when a first-time visitor's worker claims the page; a page that already had
   * a controller is the only one that was superseded, so only those are offered an update.
   */
  useEffect(() => {
    const nav: any = typeof navigator === "undefined" ? undefined : navigator;
    if (!nav || !("serviceWorker" in nav)) return; // native builds have no service worker
    const hadController = !!nav.serviceWorker.controller;
    const onChange = () => { if (hadController) setUpdateReady(true); };
    nav.serviceWorker.addEventListener("controllerchange", onChange);
    return () => nav.serviceWorker.removeEventListener("controllerchange", onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await initDbPlatform();
      // The flag belongs to this installation, not to an account or shop. Read it as soon as the
      // store exists, then let the scenes play while the session, theme and language keep loading.
      const seen = await kvGet(INTRO_SEEN_KEY).then((v) => v === INTRO_SEEN_VALUE).catch(() => false);
      if (!cancelled) {
        introResolved.current = true;
        setIntro(seen ? "returning" : "first");
      }
      await Promise.all([useSession.getState().load(), loadLang(), loadThemeMode()]);
      await refreshCounts();
      if (cancelled) return;
      setReady(true);
      startSyncEngine();
    })().catch((error) => {
      console.error("Startup failed", error);
      if (!cancelled) {
        // A storage failure must not leave the brand overlay blocking a spinner forever.
        if (!introResolved.current) setIntro("done");
        setReady(true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { if (token) void syncNow(); }, [token]);
  useEffect(() => { applyWebChrome(scheme); }, [scheme]);

  const finishIntro = useCallback(() => {
    setIntro("done");
    // Completion and skipping both count: a user who chose Skip should not see it again.
    void kvSet(INTRO_SEEN_KEY, INTRO_SEEN_VALUE).catch(() => { /* the current session is still marked */ });
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style={intro !== "done" ? "light" : scheme === "dark" ? "light" : "dark"} />
      {ready ? <Slot /> : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
          <ActivityIndicator size="large" color={c.primary} />
        </View>
      )}
      {updateReady ? (
        /* Never reloads on its own: mid-entry work (a sale, a form) must not be interrupted. */
        <View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + space.md, left: 0, right: 0, alignItems: "center", paddingHorizontal: space.lg }}>
          <View style={{ width: "100%", maxWidth: 520 }}>
            <Banner tone="ok" title={t("update.title")} text={t("update.text")}
              action={<Button size="sm" kind="secondary" label={t("update.action")}
                onPress={() => { const l = (globalThis as any).location; if (l?.reload) l.reload(); }} />} />
          </View>
        </View>
      ) : null}
      <Toaster />
      {intro !== "done" ? <BrandIntro mode={intro} onDone={finishIntro} /> : null}
    </SafeAreaProvider>
  );
}
