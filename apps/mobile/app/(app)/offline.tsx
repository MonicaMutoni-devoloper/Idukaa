import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  Badge, Banner, Button, Card, ConfirmDialog, Empty, KeyValue, Screen, Segmented, useWide,
} from "../../src/components/ui";
import { useT, type Key } from "../../src/localization";
import { useSession } from "../../src/services/api";
import {
  cancelOfflinePreparation, getShopCreatedAt, prepareOfflineData, refreshArchiveMonth, useOfflineData,
} from "../../src/services/offline-data";
import {
  archiveMonthKeys, monthRangeFor, summarizeOffline, type OfflineCategoryKey, type OfflineCategoryState,
} from "../../src/services/offline-policy";
import {
  MB, RETENTION_LIMIT_OPTIONS, formatBytes as formatSize, planRetention, type RetentionMode, type RetentionSettings,
} from "../../src/services/offline-retention";
import {
  clearArchiveFloor, measureOfflineStorage, readRetention, runCacheCleanup, saveRetention, type StorageOverview,
} from "../../src/services/offline-storage";
import { syncNow, useSync } from "../../src/synchronization/engine";
import { space, type, useTheme } from "../../src/theme/tokens";

const LABEL: Record<OfflineCategoryKey, Key> = {
  catalogue: "offline.cat.catalogue", reports: "offline.cat.reports", profitability: "offline.cat.profitability",
  saleDetails: "offline.cat.saleDetails", team: "offline.cat.team", approvals: "offline.cat.approvals",
  notifications: "offline.cat.notifications", settings: "offline.cat.settings", policy: "offline.cat.policy",
};
const STATE_LABEL: Record<OfflineCategoryState, Key> = {
  available: "offline.state.available", stale: "offline.state.stale", missing: "offline.state.missing",
  downloading: "offline.state.downloading", error: "offline.state.error", forbidden: "offline.state.forbidden",
};
const toneFor = (s: OfflineCategoryState): "ok" | "warn" | "danger" | "neutral" | "info" =>
  s === "available" ? "ok" : s === "stale" || s === "downloading" ? "warn" : s === "error" ? "danger" : "neutral";

const MODE_KEY: Record<RetentionMode, Key> = {
  recent: "offline.center.mode.recent", months12: "offline.center.mode.12",
  months24: "offline.center.mode.24", auto: "offline.center.mode.auto",
};
const EXPLAIN_KEY: Record<RetentionMode, Key> = {
  recent: "offline.center.explain.recent", months12: "offline.center.explain.12",
  months24: "offline.center.explain.24", auto: "offline.center.explain.auto",
};

const PAGE_SIZE = 12;

interface Note { tone: "ok" | "danger" | "warn"; text: string }

export default function OfflineCenter() {
  const t = useT(); const c = useTheme(); const wide = useWide(); const router = useRouter();
  const user = useSession((s) => s.user);
  const online = useSync((s) => s.online);
  const lastSync = useSync((s) => s.lastSync);
  const pending = useSync((s) => s.pending);
  const awaitingApproval = useSync((s) => s.awaitingApproval);
  const status = useOfflineData((s) => s.status);
  const preparing = useOfflineData((s) => s.preparing);
  const loadStatus = useOfflineData((s) => s.load);

  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [settings, setSettings] = useState<RetentionSettings | null>(null);
  const [draft, setDraft] = useState<RetentionSettings | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshingMonth, setRefreshingMonth] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);

  const shopId = user?.shopId ?? null;
  const load = useCallback(async (showSpinner = false) => {
    if (!user?.shopId) { setLoading(false); return; }
    if (showSpinner) setLoading(true);
    try {
      const [measured, savedSettings] = await Promise.all([
        measureOfflineStorage(user.shopId, user.id),
        readRetention(user.shopId),
      ]);
      setOverview(measured); setSettings(savedSettings); setDraft(savedSettings);
      await loadStatus();
    } catch {
      setNote({ tone: "danger", text: t("common.error") });
    } finally { if (showSpinner) setLoading(false); }
    // The shop profile is a network call and must not hold the whole center in a loading state.
    // The archive list appears as soon as this resolves; measurement and saved history are already
    // usable while it is in flight.
    void getShopCreatedAt(user.shopId).then(setCreatedAt).catch(() => undefined);
  }, [loadStatus, t, user?.id, user?.shopId]);

  useEffect(() => { void load(); }, [load]);

  if (!user || user.role === "system_admin" || !user.shopId) {
    return <Screen title={t("offline.center.title")}><Banner tone="warn" text={t("offline.center.noShop")} /></Screen>;
  }

  const summary = summarizeOffline(status?.categories ?? []);
  const months = useMemo(() => {
    if (createdAt) return archiveMonthKeys(createdAt);
    return [...(overview?.markers.keys() ?? [])].sort().reverse();
  }, [createdAt, overview?.markers]);
  const savedMonths = useMemo(() => new Set(overview?.markers.keys() ?? []), [overview?.markers]);
  const archiveSaved = months.filter((m) => savedMonths.has(m)).length;
  const periodsReady = (status?.periods ?? []).filter((p) =>
    p.modules.dashboard && p.modules.inventory && p.modules.movements && p.modules.sales && (!status?.financials || p.modules.financial),
  ).length;
  const pages = Math.max(1, Math.ceil(months.length / PAGE_SIZE));
  const visibleMonths = months.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const cleanupPlan = useMemo(
    () => overview && settings ? planRetention({ entries: overview.entries, settings, availableBytes: overview.usage.availableBytes }) : null,
    [overview, settings],
  );
  const dirty = !!settings && !!draft && (
    settings.mode !== draft.mode || settings.limitMb !== draft.limitMb || settings.wifiOnly !== draft.wifiOnly
  );
  const activeLimit = settings?.limitMb ?? draft?.limitMb ?? 0;
  const limitPct = overview && activeLimit ? Math.min(100, Math.round((overview.downloadedBytes / (activeLimit * MB)) * 100)) : 0;
  const cleanupCount = cleanupPlan?.remove.length ?? 0;

  const download = async (older = false) => {
    const shop = user.shopId;
    if (!shop) return;
    setBusy(true); setNote(null);
    try {
      if (older) await clearArchiveFloor(shop, user.id);
      await syncNow(true);
      await prepareOfflineData(true);
      await load();
      setNote({ tone: online ? "ok" : "warn", text: online ? t("offline.center.downloadStarted") : t("offline.failed") });
    } catch {
      setNote({ tone: "danger", text: t("common.error") });
    } finally { setBusy(false); }
  };

  const refreshMonth = async (month: string) => {
    setRefreshingMonth(month); setNote(null);
    try {
      const result = await refreshArchiveMonth(month);
      if (!result.ok) {
        setNote({ tone: "warn", text: result.error === "wifi_required" ? t("offline.center.wifiError") : t("offline.center.refreshFailed") });
      } else {
        setNote({ tone: "ok", text: t("offline.center.refreshed") });
      }
      await load();
    } finally { setRefreshingMonth(null); }
  };

  const openMonth = (month: string) => {
    const range = monthRangeFor(month);
    if (!range) return;
    router.push({ pathname: "/reports", params: { from: range.from, to: range.to, kind: "sales" } } as any);
  };

  const applySettings = async () => {
    const shop = user.shopId;
    if (!draft || !shop) return;
    setBusy(true);
    try {
      await saveRetention(shop, draft);
      setSettings(draft); setApplyOpen(false);
      await load();
      setNote({ tone: "ok", text: t("offline.center.policySaved") });
    } catch { setNote({ tone: "danger", text: t("common.error") }); }
    finally { setBusy(false); }
  };

  const cleanup = async () => {
    const shop = user.shopId;
    if (!settings || !shop) return;
    setBusy(true);
    try {
      const result = await runCacheCleanup(shop, user.id, settings);
      setCleanupOpen(false);
      await load();
      setNote({ tone: "ok", text: t("offline.center.cleanupDone").replace("{size}", formatSize(result.bytesFreed)) });
    } catch { setNote({ tone: "danger", text: t("common.error") }); }
    finally { setBusy(false); }
  };

  const startedDownload = busy || preparing;
  const storageTone = overview?.level === "critical" ? "danger" : overview?.level === "warning" ? "warn" : "ok";
  const storageMessage = overview?.level === "critical" ? t("offline.center.storageCritical")
    : overview?.level === "warning" ? t("offline.center.storageWarning") : "";

  return (
    <Screen
      title={t("offline.center.title")}
      subtitle={t("offline.center.subtitle")}
      actions={<Button testID="offline-center-refresh" kind="secondary" label={t("offline.center.refresh")} loading={loading} onPress={() => void load(true)} />}
    >
      {note ? <Banner tone={note.tone} text={note.text} /> : null}
      {storageMessage ? <Banner tone={storageTone === "ok" ? "warn" : storageTone} title={t("offline.center.storage")} text={storageMessage} /> : null}
      {status?.archive?.waitingForWifi ? <Banner tone="warn" text={t("offline.center.waitingWifi")} /> : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <Badge dot tone={summary.ready ? "ok" : summary.needsRefresh ? "warn" : "neutral"}
          label={preparing ? t("offline.preparing") : summary.ready ? t("offline.readyAll") : summary.needsRefresh ? t("offline.needsRefresh") : t("offline.notPrepared")} />
        <Text style={{ color: c.muted, fontSize: 12 }}>{t("offline.center.updated")}: {status ? new Date(status.savedAt).toLocaleString() : t("common.never")}</Text>
      </View>

      <View style={{ flexDirection: wide ? "row" : "column", gap: space.lg, alignItems: "stretch" }}>
        <Card style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("offline.center.storage")}</Text>
          <KeyValue label={t("offline.center.total")} value={formatSize(overview?.usage.totalBytes)} />
          <KeyValue label={t(overview?.usage.backend === "sqlite" ? "offline.center.available" : "offline.center.availableWeb")}
            value={overview?.usage.availableBytes == null ? t("offline.center.unavailable") : formatSize(overview.usage.availableBytes)} />
          <View style={{ height: 8, borderRadius: 4, backgroundColor: c.line, overflow: "hidden", marginVertical: 6 }}>
            <View style={{ width: `${limitPct}%`, height: 8, borderRadius: 4, backgroundColor: storageTone === "danger" ? c.danger : storageTone === "warn" ? c.warning : c.success }} />
          </View>
          <Text style={{ color: c.muted, fontSize: 11 }}>{t("offline.center.limitUse").replace("{used}", formatSize(overview?.downloadedBytes)).replace("{limit}", `${activeLimit} MB`)}</Text>
        </Card>
        <Card style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("offline.center.downloaded")}</Text>
          <KeyValue label={t("offline.center.archiveStorage")} value={formatSize(overview?.archiveBytes)} />
          <KeyValue label={t("offline.center.reports")} value={formatSize(overview?.reportsBytes)} />
          <KeyValue label={t("offline.center.saleDetails")} value={formatSize(overview?.saleDetailBytes)} />
          <KeyValue label={t("offline.center.otherCache")} value={formatSize(overview?.otherCacheBytes)} />
        </Card>
        <Card style={{ flex: 1, gap: 3 }} tone="muted">
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("offline.center.protectedTitle")}</Text>
          <KeyValue label={t("offline.center.business")} value={formatSize(overview?.businessBytes)} />
          <KeyValue label={t("offline.center.pendingStorage")} value={formatSize(overview?.pendingBytes)} />
          <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("offline.center.protectedHelp")}</Text>
        </Card>
      </View>
      <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("offline.center.measureNote")}</Text>

      <View style={{ flexDirection: wide ? "row" : "column", gap: space.lg, alignItems: "stretch" }}>
        <Card style={{ flex: 1, gap: 5 }}>
          <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("offline.center.availability")}</Text>
          <KeyValue label={t("offline.center.periods")} value={`${periodsReady + archiveSaved}`} />
          <KeyValue label={t("offline.center.archiveMonths")} value={`${archiveSaved} / ${months.length || "—"}`} />
          <KeyValue label={t("offline.center.pendingOps")} value={`${pending + awaitingApproval}`} />
          <KeyValue label={t("offline.center.lastSync")} value={lastSync ? new Date(lastSync).toLocaleString() : t("common.never")} />
          <KeyValue label={t("offline.center.lastPreparation")} value={status ? new Date(status.savedAt).toLocaleString() : t("common.never")} />
          <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("offline.center.forbidden")}</Text>
        </Card>
        <Card style={{ flex: wide ? 1.4 : 1, gap: 5 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Text style={{ flex: 1, color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("offline.center.progress")}</Text>
            {startedDownload ? <ActivityIndicator size="small" color={c.muted} /> : null}
          </View>
          <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>
            {preparing ? t("offline.center.downloading") : t("offline.center.idle")}
          </Text>
          {status?.archive ? (
            <>
              <KeyValue label={t("offline.center.oldest")} value={status.archive.oldestSavedMonth ?? t("common.never")} />
              {status.archive.limited ? <Banner tone="warn" text={t("offline.center.limited").replace("{month}", status.archive.earliestMonth ?? "—")} /> : null}
              {status.archive.lastCleanupBytes ? <Text style={{ color: c.muted, fontSize: 11 }}>{t("offline.center.lastCleanup").replace("{size}", formatSize(status.archive.lastCleanupBytes))}</Text> : null}
            </>
          ) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("offline.center.historyUnknown")}</Text>}
          <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
            <Button testID="offline-download-next" label={t("offline.center.downloadNext")} loading={busy || preparing}
              disabled={!online || busy || preparing} onPress={() => void download(false)} />
            <Button testID="offline-download-older" kind="secondary" label={t("offline.center.downloadOlder")}
              disabled={!online || busy || preparing || settings?.mode !== "auto"} onPress={() => void download(true)} />
            {preparing ? <Button testID="offline-cancel" kind="dangerQuiet" label={t("offline.center.cancel")} onPress={cancelOfflinePreparation} /> : null}
          </View>
        </Card>
      </View>

      <Card style={{ gap: space.md }}>
        <View style={{ gap: 2 }}>
          <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("offline.center.archive")}</Text>
          <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("offline.center.archiveHelp")}</Text>
        </View>
        {!months.length ? <Empty title={t("offline.center.historyUnknown")} description={t("offline.center.historyUnknownHelp")} />
          : (
            <View style={{ gap: 6 }}>
              {visibleMonths.map((month) => {
                const saved = savedMonths.has(month);
                return (
                  <View key={month} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap", paddingVertical: 3 }}>
                    <View style={{ flex: 1, minWidth: 120 }}>
                      <Text style={{ color: c.ink, fontWeight: "700", fontSize: 13 }}>{month}</Text>
                      <Text style={{ color: c.muted, fontSize: 11 }}>{saved ? t("offline.center.saved") : t("offline.center.missing")}</Text>
                    </View>
                    <Badge tone={saved ? "ok" : "neutral"} label={saved ? t("offline.state.available") : t("offline.center.notDownloaded")} />
                    {saved ? (
                      <>
                        <Button size="sm" kind="secondary" testID={`offline-open-${month}`} label={t("offline.center.openMonth")} onPress={() => openMonth(month)} />
                        <Button size="sm" kind="quiet" testID={`offline-refresh-${month}`} label={t("offline.center.refreshMonth")}
                          loading={refreshingMonth === month} disabled={!online || !!refreshingMonth || preparing} onPress={() => void refreshMonth(month)} />
                      </>
                    ) : (
                      <Button size="sm" kind="quiet" label={t("offline.center.retry")} disabled={!online || busy || preparing} onPress={() => void download(false)} />
                    )}
                  </View>
                );
              })}
              {pages > 1 ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                  <Button size="sm" kind="quiet" label="‹" disabled={page === 0} onPress={() => setPage((p) => Math.max(0, p - 1))} />
                  <Text style={{ color: c.muted, fontSize: 12 }}>{t("offline.center.page").replace("{page}", String(page + 1)).replace("{pages}", String(pages))}</Text>
                  <Button size="sm" kind="quiet" label="›" disabled={page >= pages - 1} onPress={() => setPage((p) => Math.min(pages - 1, p + 1))} />
                </View>
              ) : null}
            </View>
          )}
      </Card>

      <View style={{ flexDirection: wide ? "row" : "column", gap: space.lg, alignItems: "stretch" }}>
        <Card style={{ flex: 1, gap: space.md }}>
          <View style={{ gap: 2 }}>
            <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("offline.center.retention")}</Text>
            <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("offline.center.retentionHelp")}</Text>
          </View>
          {draft ? (
            <>
              <Segmented<RetentionMode> label={t("offline.center.retention")} value={draft.mode}
                onChange={(mode) => setDraft({ ...draft, mode })}
                options={([
                  { value: "recent", label: t(MODE_KEY.recent) },
                  { value: "months12", label: t(MODE_KEY.months12) },
                  { value: "months24", label: t(MODE_KEY.months24) },
                  { value: "auto", label: t(MODE_KEY.auto) },
                ] as const)} />
              <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t(EXPLAIN_KEY[draft.mode])}</Text>
              {draft.mode === "auto" ? (
                <View style={{ gap: 5 }}>
                  <Text style={{ color: c.inkSoft, fontWeight: "600", fontSize: 12 }}>{t("offline.center.limit")}</Text>
                  <Segmented<string> label={t("offline.center.limit")} value={String(draft.limitMb)}
                    onChange={(v) => setDraft({ ...draft, limitMb: Number(v) })}
                    options={RETENTION_LIMIT_OPTIONS.map((mb) => ({ value: String(mb), label: `${mb} MB` }))} />
                  <Text style={{ color: c.muted, fontSize: 11 }}>{t("offline.center.limitHelp")}</Text>
                </View>
              ) : null}
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                <Switch testID="offline-wifi-only" value={draft.wifiOnly} onValueChange={(wifiOnly) => setDraft({ ...draft, wifiOnly })} />
                <View style={{ flex: 1, gap: 1 }}>
                  <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{t("offline.center.wifi")}</Text>
                  <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("offline.center.wifiHelp")}</Text>
                </View>
              </View>
              <Button testID="offline-apply-policy" label={t("offline.center.apply")} disabled={!dirty || busy}
                onPress={() => setApplyOpen(true)} />
            </>
          ) : null}
        </Card>

        <Card style={{ flex: 1, gap: space.md }}>
          <View style={{ gap: 2 }}>
            <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("offline.center.cleanup")}</Text>
            <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("offline.center.cleanupHelp")}</Text>
          </View>
          {cleanupCount ? (
            <Banner tone="warn" text={t("offline.center.cleanupPreview")
              .replace("{count}", String(cleanupCount))
              .replace("{size}", formatSize(cleanupPlan?.bytesFreed ?? 0))
              .replace("{months}", String(new Set(cleanupPlan?.remove.map((e) => e.period).filter(Boolean)).size))} />
          ) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("offline.center.cleanupNone")}</Text>}
          <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("offline.center.cleanupAutomatic")}</Text>
          <Button testID="offline-cleanup" kind="dangerQuiet" label={t("offline.center.cleanup")} disabled={!cleanupCount || busy}
            onPress={() => setCleanupOpen(true)} />
        </Card>
      </View>

      <Card style={{ gap: space.sm }}>
        <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("offline.center.categories")}</Text>
        {(status?.categories ?? []).map((row) => (
          <View key={row.key} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor:
              row.state === "available" ? c.success : row.state === "stale" || row.state === "downloading" ? c.warning : row.state === "error" ? c.danger : c.lineStrong }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.inkSoft, fontSize: 13 }}>{t(LABEL[row.key])}</Text>
              <Text style={{ color: c.muted, fontSize: 11 }}>{row.savedAt ? new Date(row.savedAt).toLocaleString() : t("common.never")}</Text>
            </View>
            <Badge tone={toneFor(row.state)} label={t(STATE_LABEL[row.state])} />
          </View>
        ))}
        {!status ? <Text style={{ color: c.muted, fontSize: 12 }}>{t("offline.notPrepared")}</Text> : null}
      </Card>

      <ConfirmDialog open={applyOpen} title={t("offline.center.confirmPolicyTitle")}
        message={`${t("offline.center.confirmPolicy")}\n\n${draft ? t(EXPLAIN_KEY[draft.mode]) : ""}`}
        confirmLabel={t("offline.center.apply")} busy={busy} onCancel={() => setApplyOpen(false)} onConfirm={() => void applySettings()} />

      <ConfirmDialog open={cleanupOpen} title={t("offline.center.cleanupConfirmTitle")}
        message={t("offline.center.cleanupConfirm")} confirmLabel={t("offline.center.cleanup")} tone="danger" busy={busy}
        onCancel={() => setCleanupOpen(false)} onConfirm={() => void cleanup()}>
        {cleanupPlan?.remove.length ? (
          <View style={{ gap: 2 }}>
            <Text style={{ color: c.muted, fontSize: 12 }}>{t("offline.center.cleanupPreview")
              .replace("{count}", String(cleanupPlan.remove.length))
              .replace("{size}", formatSize(cleanupPlan.bytesFreed))
              .replace("{months}", String(new Set(cleanupPlan.remove.map((e) => e.period).filter(Boolean)).size))}</Text>
            <Text style={{ color: c.inkSoft, fontSize: 12 }}>{[...new Set(cleanupPlan.remove.map((e) => e.period).filter(Boolean))].sort().reverse().join(", ")}</Text>
          </View>
        ) : null}
      </ConfirmDialog>
    </Screen>
  );
}
