import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Badge, Button, Card, Empty, ErrorState, Loading, Screen, Segmented } from "../../../src/components/ui";
import { useT } from "../../../src/localization";
import { request } from "../../../src/services/api";
import { space, type, useTheme } from "../../../src/theme/tokens";

interface Entry { id: string; action: string; entity: string; entity_id: string | null; reason: string | null; created_at: string; actor: string | null; actor_email: string | null }

const LIMIT = 50;
type Filter = "" | "auth" | "admin" | "application";

/**
 * Platform security & audit log. The server only returns account, session and administrative
 * actions (auth.*, admin.*, shop.*, staff.*, application.*) — a shop's sales, purchases and
 * expenses are deliberately not exposed to platform administration.
 */
export default function AdminAudit() {
  const t = useT(); const c = useTheme();
  const [filter, setFilter] = useState<Filter>("");
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);

  const load = useCallback(async (offset = 0) => {
    setFailed(false);
    try {
      const qs = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
      if (filter) qs.set("q", filter);
      const page = await request<Entry[]>(`/admin/audit?${qs.toString()}`);
      setRows((prev) => (offset === 0 ? page : [...(prev ?? []), ...page]));
    } catch { setFailed(true); }
  }, [filter]);

  useEffect(() => { void load(0); }, [load]);

  const tone = (action: string) =>
    action.includes("failed") || action.includes("blocked") || action.includes("reuse") ? "danger"
      : action.includes("revoke") || action.includes("suspend") || action.includes("reject") ? "warn"
      : action.includes("login") || action.includes("activate") || action.includes("approve") ? "ok"
      : "neutral";

  return (
    <Screen title={t("admin.auditTitle")} subtitle={t("admin.auditSubtitle")}
      actions={<Button kind="secondary" label={t("admin.refresh")} onPress={() => void load(0)} />}>
      <Segmented label={t("admin.auditFilter")} value={filter} onChange={(v) => setFilter(v as Filter)}
        options={[
          { value: "", label: t("admin.filterAll") },
          { value: "auth", label: t("admin.filterAuth") },
          { value: "admin", label: t("admin.filterAdmin") },
          { value: "application", label: t("admin.filterApplications") },
        ]} />

      {failed ? <ErrorState onRetry={() => void load(0)} /> : !rows ? <Loading /> : !rows.length ? (
        <Card tone="muted"><Empty icon="search" title={t("admin.auditEmpty")} description={t("admin.auditEmptyDesc")} /></Card>
      ) : (
        <Card padded={false} style={{ overflow: "hidden" }}>
          {rows.map((e, i) => (
            <View key={e.id} style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.md, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.line }}>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                  <Badge tone={tone(e.action) as any} label={e.action} />
                  <Text style={{ color: c.muted, fontSize: 11 }}>{e.entity}</Text>
                </View>
                <Text style={{ color: c.inkSoft, fontSize: 13 }}>{e.actor ? `${e.actor} · ${e.actor_email ?? ""}` : t("admin.systemActor")}</Text>
                {e.reason ? <Text style={{ color: c.accent, fontSize: 12 }}>{t("admin.reasonLabel")}: {e.reason}</Text> : null}
              </View>
              <Text style={{ color: c.muted, fontSize: 11, textAlign: "right", maxWidth: 150 }}>{new Date(e.created_at).toLocaleString()}</Text>
            </View>
          ))}
        </Card>
      )}

      {rows && rows.length >= LIMIT ? (
        <Button kind="secondary" label={t("admin.loadMore")} loading={moreBusy}
          onPress={async () => { setMoreBusy(true); try { await load(rows.length); } finally { setMoreBusy(false); }} } />
      ) : null}
    </Screen>
  );
}
