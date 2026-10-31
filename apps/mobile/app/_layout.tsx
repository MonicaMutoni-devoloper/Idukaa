import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Crypto from "expo-crypto";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useSession } from "../src/services/api";
import { initDb, kvGet, kvSet } from "../src/database";
import { refreshCounts, startSyncEngine, syncNow } from "../src/synchronization/engine";
import { Toaster } from "../src/components/ui";
import { applyWebChrome, loadThemeMode, useEffectiveScheme, useTheme } from "../src/theme/tokens";
import { loadLang } from "../src/localization";

async function initDbPlatform() {
  await initDb();
  if (!(await kvGet("device_id"))) await kvSet("device_id", Crypto.randomUUID());
}

export default function Root() {
  const [ready, setReady] = useState(false);
  const token = useSession((s) => s.token);
  const c = useTheme();
  const scheme = useEffectiveScheme();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await initDbPlatform();
      await Promise.all([useSession.getState().load(), loadLang(), loadThemeMode()]);
      await refreshCounts();
      if (cancelled) return;
      setReady(true);
      startSyncEngine();
    })().catch((error) => {
      console.error("Startup failed", error);
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { if (token) void syncNow(); }, [token]);
  useEffect(() => { applyWebChrome(scheme); }, [scheme]);

  return (
    <SafeAreaProvider>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {ready ? <Slot /> : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
          <ActivityIndicator size="large" color={c.primary} />
        </View>
      )}
      <Toaster />
    </SafeAreaProvider>
  );
}
