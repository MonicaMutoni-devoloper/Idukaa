import { useCallback, useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { formatRwf } from "@sms/shared";
import { Badge, Banner, Button, Card, Empty, Loading, Screen } from "../../src/components/ui";
import { Appear } from "../../src/components/motion";
import { useT, type Key } from "../../src/localization";
import { request, useSession } from "../../src/services/api";
import { useSync } from "../../src/synchronization/engine";
import { readOfflineSnapshot, snapshotKeys } from "../../src/services/offline-data";
import { space, type, useTheme } from "../../src/theme/tokens";

interface Preferences { lowStock: boolean; outOfStock: boolean; salesActivity: boolean; inventoryUpdates: boolean; security: true }
interface Item { id: string; category: string; kind: string; data: Record<string, unknown>; readAt: string | null; createdAt: string }
interface Inbox { items: Item[]; unread: number; preferences: Preferences }

const OPTIONAL: { key: keyof Omit<Preferences, "security">; label: Key; help: Key }[] = [
  { key: "lowStock", label: "notifications.lowStock", help: "notifications.lowStockHelp" },
  { key: "outOfStock", label: "notifications.outOfStock", help: "notifications.outOfStockHelp" },
  { key: "salesActivity", label: "notifications.salesActivity", help: "notifications.salesActivityHelp" },
  { key: "inventoryUpdates", label: "notifications.inventoryUpdates", help: "notifications.inventoryUpdatesHelp" },
];

const money = (v: unknown) => formatRwf(Number(v ?? 0));

export default function Notifications() {
  const t = useT(); const c = useTheme();
  const user = useSession((s) => s.user);
  const online = useSync((s) => s.online);
  const [data, setData] = useState<Inbox | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [marking, setMarking] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    if (user?.shopId && user.id) {
      void readOfflineSnapshot<Inbox>(snapshotKeys.notifications(user.shopId, user.id)).then((saved) => {
        if (saved) { setData((cur) => cur ?? saved.data); setCachedAt(saved.savedAt); }
      }).catch(() => undefined);
    }
    request<Inbox>("/notifications")
      .then((r) => { setData(r); setCachedAt(null); })
      .catch(() => setFailed(true));
  }, [user?.shopId, user?.id]);
  useEffect(() => { load(); }, [load]);

  async function toggle(key: keyof Omit<Preferences, "security">, value: boolean) {
    if (!data || saving) return;
    const previous = data.preferences;
    setData({ ...data, preferences: { ...previous, [key]: value } });
    setSaving(true); setNotice(null);
    try {
      const preferences = await request<Preferences>("/notifications/preferences", { method: "PUT", body: { [key]: value } });
      setData((d) => (d ? { ...d, preferences } : d));
      setNotice({ tone: "ok", text: t("notifications.saved") });
    } catch {
      setData((d) => (d ? { ...d, preferences: previous } : d)); // revert the optimistic switch
      setNotice({ tone: "danger", text: t("notifications.saveFailed") });
    } finally { setSaving(false); }
  }

  async function markAll() {
    if (marking) return;
    setMarking(true);
    try {
      await request("/notifications/read", { method: "POST", body: {} });
      setData((d) => (d ? { ...d, unread: 0, items: d.items.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })) } : d));
    } catch { setNotice({ tone: "danger", text: t("notifications.saveFailed") }); }
    finally { setMarking(false); }
  }

  function describe(i: Item) {
    const key = `notif.kind.${i.kind}` as Key;
    const template = t(key);
    if (!template) return t("notifications.unknown");
    return Object.entries(i.data).reduce((text, [k, v]) => {
      const value = k === "net" || k === "total" ? money(v) : String(v ?? "");
      return text.split(`{${k}}`).join(value);
    }, template);
  }

  if (!data) {
    return (
      <Screen title={t("notifications.title")} subtitle={t("notifications.subtitle")}>
        {failed ? (
          <Card tone="danger" style={{ gap: space.md }}>
            <Text style={{ color: c.danger, fontSize: 14 }}>{online ? t("notifications.loadFailed") : t("notifications.offline")}</Text>
            <Button kind="secondary" label={t("common.retry")} onPress={load} />
          </Card>
        ) : <Loading />}
      </Screen>
    );
  }

  const prefs = data.preferences;
  return (
    <Screen title={t("notifications.title")} subtitle={t("notifications.subtitle")}>
      {!online ? <Banner tone="warn" text={t("notifications.offline")} /> : null}
      {cachedAt ? <Banner tone="warn" text={t("offline.cached").replace("{time}", new Date(cachedAt).toLocaleString())} /> : null}
      {notice ? <Banner tone={notice.tone} text={notice.text} /> : null}

      <Card style={{ gap: space.md }}>
        <View style={{ gap: 2 }}>
          <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("notifications.preferences")}</Text>
          <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("notifications.preferencesHelp")}</Text>
        </View>
        {OPTIONAL.map((row) => (
          <View key={row.key} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <Switch testID={`pref-${row.key}`} value={prefs[row.key]} disabled={saving} onValueChange={(v) => void toggle(row.key, v)} />
            <View style={{ flex: 1, gap: 1 }}>
              <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{t(row.label)}</Text>
              <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t(row.help)}</Text>
            </View>
          </View>
        ))}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, borderTopWidth: 1, borderTopColor: c.line, paddingTop: space.md }}>
          <Switch testID="pref-security" value disabled accessibilityLabel={t("notifications.security")} />
          <View style={{ flex: 1, gap: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{t("notifications.security")}</Text>
              <Badge tone="info" label={t("notifications.alwaysOn")} />
            </View>
            <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("notifications.securityHelp")}</Text>
          </View>
        </View>
      </Card>

      <Card style={{ gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("notifications.inbox")}</Text>
            <Text style={{ color: c.muted, fontSize: 12 }}>{t("notifications.unread").replace("{n}", String(data.unread))}</Text>
          </View>
          <Button testID="notifications-mark-read" size="sm" kind="secondary" label={t("notifications.markRead")} loading={marking} disabled={!data.unread} onPress={() => void markAll()} />
        </View>
        {data.items.length ? (
          <View style={{ gap: space.sm }}>
            {data.items.map((i, idx) => (
              <Appear key={i.id} index={idx}>
              <View testID={`notification-${i.id}`} style={{ flexDirection: "row", gap: space.md, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: c.line }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 6, backgroundColor: i.readAt ? c.lineStrong : i.category === "security" ? c.danger : c.primary }} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: c.ink, fontSize: 13, lineHeight: 19, fontWeight: i.readAt ? "400" : "600" }}>{describe(i)}</Text>
                  <Text style={{ color: c.muted, fontSize: 11 }}>{new Date(i.createdAt).toLocaleString()}</Text>
                </View>
              </View>
              </Appear>
            ))}
          </View>
        ) : <Empty title={t("notifications.empty")} description={t("notifications.emptyDesc")} />}
      </Card>

      <Text style={{ color: c.muted, fontSize: 11, lineHeight: 17, ...type.small }}>{t("notifications.deliveryNote")}</Text>
    </Screen>
  );
}
