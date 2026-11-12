import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Badge, Button, Card } from "./ui";
import { useT, type Key } from "../localization";
import { useSession } from "../services/api";
import { useOfflineData } from "../services/offline-data";
import { summarizeOffline, type OfflineCategoryKey, type OfflineCategoryState } from "../services/offline-policy";
import { syncNow } from "../synchronization/engine";
import { radius, space, type, useTheme } from "../theme/tokens";

const LABEL: Record<OfflineCategoryKey, Key> = {
  catalogue: "offline.cat.catalogue",
  reports: "offline.cat.reports",
  profitability: "offline.cat.profitability",
  saleDetails: "offline.cat.saleDetails",
  team: "offline.cat.team",
  approvals: "offline.cat.approvals",
  notifications: "offline.cat.notifications",
  settings: "offline.cat.settings",
  policy: "offline.cat.policy",
};

const STATE_LABEL: Record<OfflineCategoryState, Key> = {
  available: "offline.state.available",
  stale: "offline.state.stale",
  missing: "offline.state.missing",
  downloading: "offline.state.downloading",
  error: "offline.state.error",
  forbidden: "offline.state.forbidden",
};

const toneFor = (s: OfflineCategoryState): "ok" | "warn" | "danger" | "neutral" | "info" =>
  s === "available" ? "ok" : s === "stale" || s === "downloading" ? "warn" : s === "error" ? "danger" : "neutral";

/** Honest, category-level offline readiness. Never claims "available" without a stored copy. */
export function OfflineDownloadCard({ compact = false }: { compact?: boolean }) {
  const t = useT(); const c = useTheme();
  const user = useSession((s) => s.user);
  const status = useOfflineData((s) => s.status);
  const preparing = useOfflineData((s) => s.preparing);
  const error = useOfflineData((s) => s.error);
  const load = useOfflineData((s) => s.load);
  const refresh = useOfflineData((s) => s.refresh);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void load(); }, [load]);

  if (!user || user.role === "system_admin" || !user.shopId) return null;

  const summary = summarizeOffline(status?.categories ?? []);
  const run = async () => {
    setBusy(true);
    try {
      await syncNow(true);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const headline = preparing ? t("offline.preparing") : summary.ready ? t("offline.readyAll") : summary.needsRefresh ? t("offline.needsRefresh") : t("offline.notReady");

  return (
    <View testID="offline-download-card"><Card style={{ gap: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("offline.title")}</Text>
          <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("offline.help")}</Text>
        </View>
        {preparing ? <ActivityIndicator size="small" color={c.muted} /> : null}
        <Badge tone={summary.ready ? "ok" : summary.needsRefresh ? "warn" : "neutral"} label={headline} />
      </View>

      {compact ? (
        <Text style={{ color: c.muted, fontSize: 12 }}>
          {t("offline.compact").replace("{n}", String(summary.available)).replace("{total}", String((status?.categories ?? []).length))}
        </Text>
      ) : (
        <View testID="offline-status" style={{ gap: 6 }}>
          {(status?.categories ?? []).map((row) => (
            <View key={row.key} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor:
                row.state === "available" ? c.success : row.state === "stale" || row.state === "downloading" ? c.warning : row.state === "error" ? c.danger : c.lineStrong }} />
              <Text style={{ flex: 1, color: c.inkSoft, fontSize: 13 }}>{t(LABEL[row.key])}</Text>
              <Badge tone={toneFor(row.state)} label={t(STATE_LABEL[row.state])} />
            </View>
          ))}
          {!status ? <Text style={{ color: c.muted, fontSize: 12 }}>{t("offline.notPrepared")}</Text> : null}
        </View>
      )}

      <View style={{ gap: 3 }}>
        <Text style={{ color: c.muted, fontSize: 12 }}>
          {t("offline.lastDownload")}: <Text style={{ color: c.inkSoft, fontWeight: "600" }}>
            {status ? new Date(status.savedAt).toLocaleString() : t("common.never")}
          </Text>
        </Text>
        <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("offline.scope")}</Text>
        {error ? <Text style={{ color: c.danger, fontSize: 12 }}>{error}</Text> : null}
      </View>

      <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
        <Button testID="offline-download" label={busy || preparing ? t("offline.downloading") : t("offline.update")}
          loading={busy || preparing} onPress={() => void run()} />
      </View>
      <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("offline.autoNote")}</Text>
    </Card></View>
  );
}

/** Compact Overview strip: one honest line, full detail stays on Settings. */
export function OfflineReadinessStrip() {
  const t = useT(); const c = useTheme();
  const status = useOfflineData((s) => s.status);
  const preparing = useOfflineData((s) => s.preparing);
  const load = useOfflineData((s) => s.load);
  useEffect(() => { void load(); }, [load]);
  const summary = summarizeOffline(status?.categories ?? []);
  const label = preparing ? t("offline.preparing") : summary.ready ? t("offline.readyAll") : summary.needsRefresh ? t("offline.needsRefresh") : t("offline.notPrepared");
  return (
    <View testID="offline-readiness-strip" style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.sm, backgroundColor: c.surfaceMuted, borderWidth: 1, borderColor: c.line }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: summary.ready ? c.success : summary.needsRefresh ? c.warning : c.lineStrong }} />
      <Text style={{ flex: 1, color: c.inkSoft, fontSize: 12, fontWeight: "600" }}>{t("offline.readiness")}: {label}</Text>
      <Text style={{ color: c.muted, fontSize: 11 }}>{status ? new Date(status.savedAt).toLocaleTimeString() : t("common.never")}</Text>
    </View>
  );
}
