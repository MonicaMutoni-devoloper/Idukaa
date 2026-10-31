import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Badge, Banner, Button, Card, ErrorState, Loading, Screen } from "../../../src/components/ui";
import { useT } from "../../../src/localization";
import { request } from "../../../src/services/api";
import { space, type, useTheme } from "../../../src/theme/tokens";

/** Every figure on this screen comes from GET /admin/overview — real counts, never placeholders. */
interface Overview {
  shops: { total: number; active: number; suspended: number };
  applications: { total: number; pending: number; info: number; approved: number; rejected: number };
  users: { total: number; owners: number; managers: number; admins: number; active: number; suspended: number };
  recentApplications: { id: string; shop_name: string; contact_name: string; status: string; submitted_at: string }[];
  recentActions: { id: string; action: string; entity: string; reason: string | null; created_at: string; actor: string | null }[];
  securityEvents30d: number;
  openConflicts: number;
  database: { status: string; time: string };
  generatedAt: string;
}

function Metric({ label, value, hint, testID, tone }: { label: string; value: string; hint?: string; testID?: string; tone?: string }) {
  const c = useTheme();
  return (
    <Card style={{ flexGrow: 1, flexBasis: 180, gap: 4 }}>
      <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{label}</Text>
      <Text testID={testID} style={{ color: tone === "warn" ? c.accent : c.ink, ...type.money }}>{value}</Text>
      {hint ? <Text style={{ color: c.muted, fontSize: 12 }}>{hint}</Text> : null}
    </Card>
  );
}

export default function AdminOverview() {
  const t = useT(); const c = useTheme();
  const [data, setData] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try { setData(await request<Overview>("/admin/overview")); } catch { setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const appBadge = (s: string) =>
    s === "PENDING_REVIEW" ? <Badge tone="warn" dot label={t("admin.stPending")} />
      : s === "APPROVED" ? <Badge tone="ok" label={t("admin.stApproved")} />
      : s === "REJECTED" ? <Badge tone="danger" label={t("admin.stRejected")} />
      : <Badge tone="info" label={t("admin.stInfo")} />;

  return (
    <Screen title={t("admin.overview")} subtitle={t("admin.overviewDesc")} actions={<Button kind="secondary" label={t("admin.refresh")} onPress={() => void load()} />}>
      <Banner tone="warn" title={t("admin.onlyAccounts")} text={t("admin.note")} />
      {failed ? <ErrorState onRetry={() => void load()} /> : !data ? <Loading /> : (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
            <Metric testID="admin-stat-shops" label={t("admin.shops")} value={String(data.shops.total)}
              hint={`${data.shops.active} ${t("admin.activeLabel")}${data.shops.suspended ? ` · ${data.shops.suspended} ${t("admin.suspendedLabel")}` : ""}`} />
            <Metric testID="admin-stat-pending" label={t("admin.awaitingApproval")} value={String(data.applications.pending + data.applications.info)}
              hint={t("admin.awaitingApprovalHelp")} tone={data.applications.pending + data.applications.info ? "warn" : undefined} />
            <Metric testID="admin-stat-users" label={t("admin.users")} value={String(data.users.total)}
              hint={`${data.users.owners} ${t("role.owner")} · ${data.users.managers} ${t("role.manager")}`} />
            <Metric testID="admin-stat-events" label={t("admin.securityEvents")} value={String(data.securityEvents30d)} hint={t("admin.securityEventsHelp")} />
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
            <Card style={{ flexGrow: 1, flexBasis: 180, gap: 4 }}>
              <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("admin.systemStatus")}</Text>
              <Badge dot tone={data.database.status === "ok" ? "ok" : "danger"} label={data.database.status === "ok" ? t("admin.ok") : data.database.status} />
              <Text style={{ color: c.muted, fontSize: 12 }}>{t("admin.dbTime")}: {new Date(data.database.time).toLocaleString()}</Text>
            </Card>
            <Card style={{ flexGrow: 1, flexBasis: 180, gap: 4 }}>
              <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("admin.openConflicts")}</Text>
              <Text style={{ color: data.openConflicts ? c.accent : c.ink, ...type.money }}>{data.openConflicts}</Text>
              <Text style={{ color: c.muted, fontSize: 12 }}>{t("admin.openConflictsHelp")}</Text>
            </Card>
            <Card style={{ flexGrow: 1, flexBasis: 180, gap: 4 }}>
              <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("admin.applications")}</Text>
              <Text style={{ color: c.ink, ...type.money }}>{data.applications.total}</Text>
              <Text style={{ color: c.muted, fontSize: 12 }}>{data.applications.approved} {t("admin.stApproved").toLowerCase()} · {data.applications.rejected} {t("admin.stRejected").toLowerCase()}</Text>
            </Card>
          </View>

          <Card style={{ gap: space.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <Text style={{ color: c.ink, ...type.h2, flex: 1 }}>{t("admin.recentApplications")}</Text>
              <Badge label={`${data.recentApplications.length}`} />
            </View>
            {data.recentApplications.length ? data.recentApplications.map((a) => (
              <View key={a.id} style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 7, borderTopWidth: 1, borderTopColor: c.line }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.ink, fontWeight: "600", fontSize: 14 }}>{a.shop_name}</Text>
                  <Text style={{ color: c.muted, fontSize: 11 }}>{a.contact_name} · {new Date(a.submitted_at).toLocaleDateString()}</Text>
                </View>
                {appBadge(a.status)}
              </View>
            )) : <Text style={{ color: c.muted, fontSize: 13 }}>{t("admin.appEmpty")}</Text>}
          </Card>

          <Card style={{ gap: space.sm }}>
            <Text style={{ color: c.ink, ...type.h2 }}>{t("admin.recentActions")}</Text>
            {data.recentActions.length ? data.recentActions.map((a) => (
              <View key={a.id} style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 7, borderTopWidth: 1, borderTopColor: c.line }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.inkSoft, fontSize: 13, fontWeight: "600" }}>{a.action}</Text>
                  <Text style={{ color: c.muted, fontSize: 11 }}>{a.actor ?? t("admin.systemActor")} · {new Date(a.created_at).toLocaleString()}</Text>
                </View>
                {a.reason ? <Badge tone="warn" label={t("admin.withReason")} /> : null}
              </View>
            )) : <Text style={{ color: c.muted, fontSize: 13 }}>{t("admin.noActions")}</Text>}
          </Card>
        </>
      )}
    </Screen>
  );
}
