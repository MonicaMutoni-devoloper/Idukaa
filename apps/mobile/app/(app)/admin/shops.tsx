import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Badge, Button, Card, ConfirmDialog, DataTable, Empty, ErrorState, Field, Loading, Screen, useToasts } from "../../../src/components/ui";
import { useT } from "../../../src/localization";
import { request } from "../../../src/services/api";
import { space, type, useTheme } from "../../../src/theme/tokens";

interface Shop { id: string; name: string; currency: string; status: "active" | "suspended"; owner: string | null; users: number; created_at: string; location: string | null; suspended_reason: string | null }

/**
 * Platform shop directory. Suspension is metadata: sales, stock and audit history are never
 * touched, the reason is mandatory and recorded server-side, and the confirmation dialog makes the
 * consequence explicit before anything is sent.
 */
export default function AdminShops() {
  const t = useT(); const c = useTheme(); const toast = useToasts((s) => s.push);
  const [shops, setShops] = useState<Shop[] | null>(null); const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  const [name, setName] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<{ shop: Shop; kind: "suspend" | "reactivate" } | null>(null);
  const [reason, setReason] = useState(""); const [reasonErr, setReasonErr] = useState<string | null>(null); const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try { setShops(await request<Shop[]>(`/admin/shops${q ? `?q=${encodeURIComponent(q)}` : ""}`)); } catch { setFailed(true); }
  }, [q]);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    if (!name.trim()) { setErr(t("v.required")); return; }
    setErr(null); setBusy(true);
    try {
      await request("/admin/shops", { method: "POST", body: { name: name.trim() } });
      setName(""); toast(t("admin.created")); await load();
    } catch { setErr(t("common.error")); } finally { setBusy(false); }
  }

  async function confirmAction() {
    if (!target) return;
    if (reason.trim().length < 3) { setReasonErr(t("admin.reasonRequired")); return; }
    setReasonErr(null); setBusyId(target.shop.id);
    try {
      await request(`/admin/shops/${target.shop.id}/${target.kind === "suspend" ? "suspend" : "reactivate"}`, { method: "POST", body: { reason: reason.trim() } });
      toast(target.kind === "suspend" ? t("admin.shopSuspended") : t("admin.shopReactivated"));
      setTarget(null); setReason(""); await load();
    } catch { setReasonErr(t("common.error")); } finally { setBusyId(null); }
  }

  return (
    <Screen title={t("admin.shops")} subtitle={t("admin.shopsDesc")}>
      <Card style={{ gap: space.md }}>
        <Text style={{ color: c.ink, ...type.h2 }}>{t("admin.createShop")}</Text>
        <View style={{ flexDirection: "row", gap: space.md, alignItems: "flex-start", flexWrap: "wrap" }}>
          <Field testID="admin-shop-name" label={t("admin.shopName")} value={name} onChangeText={(x) => { setErr(null); setName(x); }} error={err} placeholder={t("admin.shopNamePlaceholder")} />
          <View style={{ paddingTop: 22 }}><Button testID="admin-shop-create" label={t("admin.create")} loading={busy} onPress={() => void create()} /></View>
        </View>
        <Text style={{ color: c.muted, fontSize: 12 }}>{t("admin.shopHelp")}</Text>
      </Card>

      <View style={{ flexDirection: "row", gap: space.md, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field testID="admin-shop-search" label={t("common.search")} value={q} onChangeText={setQ} placeholder={t("admin.shopSearchPlaceholder")} containerStyle={{ flexBasis: 260, flexGrow: 1 }} />
        <Button kind="secondary" label={t("admin.refresh")} onPress={() => void load()} />
      </View>

      {failed ? <ErrorState onRetry={() => void load()} /> : !shops ? <Loading /> : (
        <DataTable rows={shops} rowTestID={(s) => `admin-shop-${s.id}`}
          rowTitle={(s) => <View style={{ gap: 2 }}>
            <Text style={{ color: c.ink, fontWeight: "700" }}>{s.name}</Text>
            <Text style={{ color: c.muted, fontSize: 11 }}>{s.owner ?? "—"}{s.location ? ` · ${s.location}` : ""}</Text>
          </View>}
          cols={[
            { key: "name", title: t("admin.shopName"), width: 2, render: (s) => <View><Text style={{ color: c.ink, fontWeight: "600", fontSize: 14 }}>{s.name}</Text><Text style={{ color: c.muted, fontSize: 11 }}>{s.owner ?? "—"}{s.location ? ` · ${s.location}` : ""}</Text></View> },
            { key: "status", title: t("common.status"), width: 1, render: (s) => s.status === "suspended"
              ? <Badge tone="danger" dot label={t("admin.stSuspended")} />
              : <Badge tone="ok" label={t("admin.stActive")} /> },
            { key: "users", title: t("admin.users"), width: 0.8, align: "right", render: (s) => <Text style={{ color: c.inkSoft, fontSize: 13 }}>{s.users}</Text> },
            { key: "created_at", title: t("admin.created"), width: 1.2, align: "right", render: (s) => <Text style={{ color: c.muted, fontSize: 12 }}>{new Date(s.created_at).toLocaleDateString()}</Text> },
            { key: "actions", title: "", width: 1.3, align: "right", render: (s) => s.status === "suspended"
              ? <Button size="sm" kind="secondary" label={t("admin.reactivate")} onPress={() => { setTarget({ shop: s, kind: "reactivate" }); setReason(""); setReasonErr(null); }} />
              : <Button size="sm" kind="dangerQuiet" label={t("admin.suspend")} onPress={() => { setTarget({ shop: s, kind: "suspend" }); setReason(""); setReasonErr(null); }} /> },
          ]}
          empty={<Empty icon="box" title={shops.length ? t("admin.noMatch") : t("admin.noShops")} description={shops.length ? t("admin.noMatch") : t("admin.noShopsDesc")} />} />
      )}

      <ConfirmDialog open={!!target} tone={target?.kind === "reactivate" ? "primary" : "danger"}
        title={target?.kind === "suspend" ? t("admin.suspendTitle") : t("admin.reactivateTitle")}
        message={target ? (target.kind === "suspend" ? t("admin.suspendMessage").replace("{name}", target.shop.name) : t("admin.reactivateMessage").replace("{name}", target.shop.name)) : ""}
        confirmLabel={target?.kind === "suspend" ? t("admin.suspend") : t("admin.reactivate")}
        busy={!!busyId} onCancel={() => setTarget(null)} onConfirm={() => void confirmAction()}>
        <Field testID="admin-shop-reason" required label={t("admin.reasonLabel")} value={reason} error={reasonErr}
          onChangeText={(v) => { setReasonErr(null); setReason(v); }} placeholder={t("admin.reasonPlaceholder")} hint={t("admin.reasonHelp")} />
      </ConfirmDialog>
    </Screen>
  );
}
