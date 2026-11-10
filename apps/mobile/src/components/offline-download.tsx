import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Badge, Button, Card } from "./ui";
import { useT } from "../localization";
import { useSession } from "../services/api";
import { downloadOfflineData, getOfflineDataStatus, type OfflineDataStatus } from "../services/offline-data";
import { syncNow } from "../synchronization/engine";
import { space, useTheme } from "../theme/tokens";

/**
 * "Download the rest of the shop for offline" control.
 *
 * The sync engine already keeps the catalogue, stock and locally recorded work current. Reports
 * and server-originated transactions need an explicit download because fetching every report
 * period automatically after every sync would waste data and battery on a phone. This card makes
 * that boundary visible, shows when the last complete download succeeded, and never calls a
 * partial download complete.
 */
export function OfflineDownloadCard() {
  const t = useT(); const c = useTheme();
  const user = useSession((s) => s.user);
  const [status, setStatus] = useState<OfflineDataStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => { void getOfflineDataStatus().then(setStatus).catch(() => setStatus(null)); }, []);

  if (!user || user.role === "system_admin" || !user.shopId) return null;

  const failed = status?.periods.flatMap((p) => Object.entries(p.modules)
    .filter(([name, ok]) => !ok && (name !== "financial" || status.financials))
    .map(([name]) => t(`offline.module.${name}` as any))) ?? [];

  const run = async () => {
    setBusy(true); setError(false);
    try {
      // Pull first so the download is the latest server state, not the state from app launch.
      await syncNow(true);
      setStatus(await downloadOfflineData());
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View testID="offline-download-card"><Card style={{ gap: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("offline.title")}</Text>
          <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("offline.help")}</Text>
        </View>
        {status?.complete ? <Badge tone="ok" dot label={t("offline.ready")} /> : null}
        {status && !status.complete ? <Badge tone="warn" label={t("offline.partialBadge")} /> : null}
      </View>

      <View testID="offline-status" style={{ gap: 3 }}>
        <Text style={{ color: c.muted, fontSize: 12 }}>
          {t("offline.lastDownload")}: <Text style={{ color: c.inkSoft, fontWeight: "600" }}>
            {status ? new Date(status.savedAt).toLocaleString() : t("common.never")}
          </Text>
        </Text>
        <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("offline.scope")}</Text>
        {failed.length ? <Text style={{ color: c.danger, fontSize: 12 }}>{t("offline.failedModules").replace("{list}", [...new Set(failed)].join(", "))}</Text> : null}
      </View>

      {error ? <Text style={{ color: c.danger, fontSize: 12 }}>{t("offline.failed")}</Text> : null}

      <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
        <Button testID="offline-download" label={busy ? t("offline.downloading") : status ? t("offline.update") : t("offline.download")}
          loading={busy} onPress={() => void run()} />
      </View>
      <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("offline.autoNote")}</Text>
    </Card></View>
  );
}
