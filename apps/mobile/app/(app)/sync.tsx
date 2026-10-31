import { useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import { Badge, Banner, Button, Card, DataTable, Empty, Screen, SyncProgress } from "../../src/components/ui";
import { listOutbox, storageBackend, type OutboxRow } from "../../src/database/local";
import { useT, type Key } from "../../src/localization";
import { useSession } from "../../src/services/api";
import { syncNow, useSync } from "../../src/synchronization/engine";
import { space, type, useTheme } from "../../src/theme/tokens";

const tone = (s: string) => (s === "synced" ? "ok" : s === "conflict" || s === "rejected" ? "danger" : s === "pending_approval" ? "info" : "warn") as "ok" | "danger" | "info" | "warn";

export default function SyncScreen() {
  const t = useT(); const c = useTheme(); const user = useSession((s) => s.user)!;
  const { online, running, lastSync, authRequired, pending, issues, awaitingApproval, dataVersion } = useSync();
  const [rows, setRows] = useState<OutboxRow[]>([]);

  useEffect(() => {
    const load = () => void listOutbox(user.id).then(setRows).catch(() => setRows([]));
    load(); const timer = setInterval(load, 3000); return () => clearInterval(timer);
  }, [user.id, dataVersion, pending, issues]);

  const storage = storageBackend();
  const statusLabel = (s: string): Key => (s === "synced" ? "sync.synced" : s === "conflict" || s === "rejected" ? "sync.conflict" : s === "pending_approval" ? "appr.pending" : "sync.pending");

  return (
    <Screen title={t("nav.sync")} subtitle={t("sync.subtitle")}
      actions={<Button testID="sync-now" label={running ? t("common.loading") : t("sync.now")} disabled={!online} onPress={() => void syncNow(true)} />}>
      {authRequired ? <Banner tone="danger" title={t("sync.failed")} text={t("sync.authRequired")} /> : null}

      <SyncProgress />

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        <Card style={{ flexGrow: 1, flexBasis: 200, gap: 6 }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("sync.connection")}</Text>
          <Badge dot tone={online ? "ok" : "warn"} label={online ? t("sync.online") : t("sync.offline")} />
          <Text style={{ color: c.muted, fontSize: 12 }}>{t("sync.lastSync")}: {lastSync ? new Date(lastSync).toLocaleString() : t("common.never")}</Text>
        </Card>
        <Card style={{ flexGrow: 1, flexBasis: 150, gap: 4 }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("sync.pending")}</Text>
          <Text testID="sync-pending-count" style={{ color: pending ? c.accent : c.ink, ...type.money }}>{pending}</Text>
          <Text style={{ color: c.muted, fontSize: 12 }}>{t("sync.awaitingApproval")}: {awaitingApproval}</Text>
        </Card>
        <Card style={{ flexGrow: 1, flexBasis: 150, gap: 4 }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("sync.needsReview")}</Text>
          <Text style={{ color: issues ? c.danger : c.ink, ...type.money }}>{issues}</Text>
          <Text style={{ color: c.muted, fontSize: 12 }}>{t("sync.issuesHelp")}</Text>
        </Card>
        <Card style={{ flexGrow: 1, flexBasis: 190, gap: 4 }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("sync.storage")}</Text>
          <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{storage === "sqlite" ? t("sync.storageSqlite") : storage === "indexeddb" ? t("sync.storageIdb") : t("sync.storageLs")}</Text>
          <Text style={{ color: c.muted, fontSize: 12 }}>{t("sync.storageHelp")}</Text>
        </Card>
      </View>

      <View style={{ gap: space.sm }}>
        <Text style={{ color: c.ink, ...type.h2 }}>{t("sync.queue")}</Text>
        <DataTable rows={rows} rowTitle={(r) => <Text style={{ color: c.ink, fontWeight: "700" }}>{r.type}</Text>} cols={[
          { key: "type", title: t("sync.opType"), width: 1.5 },
          { key: "status", title: t("common.status"), width: 1.2, render: (r) => <Badge tone={tone(r.status)} label={t(statusLabel(r.status))} /> },
          { key: "created_at", title: t("sync.savedAt"), width: 1.6, render: (r) => <Text style={{ color: c.inkSoft, fontSize: 12 }}>{new Date(r.created_at).toLocaleString()}</Text> },
          { key: "attempts", title: t("sync.attempts"), align: "right", width: 0.8, render: (r) => <Text style={{ color: c.muted, fontSize: 12 }}>{r.attempts}</Text> },
          { key: "message", title: t("sync.message"), width: 2, render: (r) => <Text style={{ color: r.message ? c.danger : c.muted, fontSize: 12 }}>{r.message ?? "—"}</Text> },
        ]} empty={<Empty icon="sync" title={t("sync.emptyQueue")} description={t("sync.emptyQueueDesc")} />} />
      </View>

      <Card tone="muted" style={{ gap: 6 }}>
        <Text style={{ color: c.ink, fontWeight: "700", fontSize: 13 }}>{t("sync.howItWorks")}</Text>
        <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("sync.help")}</Text>
        {Platform.OS === "web" ? <Text style={{ color: c.accent, fontSize: 12, lineHeight: 18 }}>{t("sync.webWarning")}</Text> : null}
      </Card>
    </Screen>
  );
}
