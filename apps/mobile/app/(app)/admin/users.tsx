import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Badge, Button, Card, ConfirmDialog, DataTable, Empty, ErrorState, Field, Loading, PasswordField, Screen, Segmented, useToasts } from "../../../src/components/ui";
import { useT } from "../../../src/localization";
import { request } from "../../../src/services/api";
import { space, type, useTheme } from "../../../src/theme/tokens";

interface AdminUser { id: string; email: string; role: string; active: boolean; account_status: string; full_name: string; shop_id: string | null; created_at: string }
interface Shop { id: string; name: string }

export default function AdminUsers() {
  const t = useT(); const c = useTheme(); const toast = useToasts((s) => s.push);
  const [users, setUsers] = useState<AdminUser[] | null>(null); const [shops, setShops] = useState<Shop[]>([]); const [failed, setFailed] = useState(false);
  const [f, setF] = useState({ fullName: "", email: "", password: "" }); const [role, setRole] = useState<"owner" | "manager">("manager"); const [shop, setShop] = useState<string>("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [revoke, setRevoke] = useState<AdminUser | null>(null); const [revoking, setRevoking] = useState(false);
  const [activate, setActivate] = useState<AdminUser | null>(null); const [activating, setActivating] = useState(false);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [u, s] = await Promise.all([
        request<AdminUser[]>(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`),
        request<Shop[]>("/admin/shops"),
      ]);
      setUsers(u); setShops(s);
      if (!shop && s.length) setShop(s[0]!.id);
    } catch { setFailed(true); }
  }, [shop, q]);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    const email = f.email.trim();
    if (!f.fullName.trim() || !email.includes("@") || !shop || f.password.length < 10) { setErr(t("admin.createInvalid")); return; }
    setErr(null); setBusy(true);
    try {
      await request("/admin/users", { method: "POST", body: { email, fullName: f.fullName.trim(), role, shopId: shop, password: f.password } });
      setF({ fullName: "", email: "", password: "" }); toast(t("admin.created")); await load();
    } catch { setErr(t("common.error")); } finally { setBusy(false); }
  }

  async function confirmRevoke() {
    if (!revoke) return;
    setRevoking(true);
    try { await request(`/admin/users/${revoke.id}/revoke`, { method: "POST" }); toast(t("admin.revoked")); setRevoke(null); await load(); }
    catch { setErr(t("common.error")); } finally { setRevoking(false); }
  }

  /** Reactivation only ever applies to a revoked account; pending activations stay token-gated. */
  async function confirmActivate() {
    if (!activate) return;
    setActivating(true);
    try { await request(`/admin/users/${activate.id}/activate`, { method: "POST" }); toast(t("admin.activated")); setActivate(null); await load(); }
    catch { setErr(t("common.error")); } finally { setActivating(false); }
  }

  const statusBadge = (u: AdminUser) => u.account_status === "suspended"
    ? <Badge tone="danger" dot label={t("admin.stSuspended")} />
    : u.account_status === "pending_activation" ? <Badge tone="info" label={t("admin.stPendingActivation")} />
    : <Badge tone={u.active ? "ok" : "danger"} label={u.active ? t("admin.active") : t("admin.inactive")} />;

  const shopName = (id: string | null) => shops.find((s) => s.id === id)?.name ?? "—";

  return (
    <Screen title={t("admin.users")} subtitle={t("admin.usersDesc")}>
      <Card style={{ gap: space.md }}>
        <Text style={{ color: c.ink, ...type.h2 }}>{t("admin.createUser")}</Text>
        <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
          <Field testID="admin-user-name" label={t("admin.fullName")} value={f.fullName} onChangeText={(x) => setF({ ...f, fullName: x })} />
          <Field testID="admin-user-email" label={t("admin.email")} value={f.email} onChangeText={(x) => setF({ ...f, email: x })} autoCapitalize="none" keyboardType="email-address" />
        </View>
        <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
          <PasswordField testID="admin-user-password" label={t("admin.password")} value={f.password} onChangeText={(x) => setF({ ...f, password: x })} hint={t("admin.passwordHelp")} autoComplete="new-password" />
          <View style={{ gap: 5, flexGrow: 1, flexBasis: 150 }}>
            <Text style={{ color: c.inkSoft, fontSize: 12, fontWeight: "600" }}>{t("admin.role")}</Text>
            <Segmented value={role} onChange={setRole} options={[{ value: "manager", label: t("role.manager") }, { value: "owner", label: t("role.owner") }]} />
          </View>
        </View>
        <View style={{ gap: 5 }}>
          <Text style={{ color: c.inkSoft, fontSize: 12, fontWeight: "600" }}>{t("admin.shop")}</Text>
          {shops.length ? <Segmented value={shop} onChange={setShop} options={shops.map((s) => ({ value: s.id, label: s.name }))} /> : <Text style={{ color: c.muted, fontSize: 12 }}>{t("admin.noShops")}</Text>}
        </View>
        {err ? <Text style={{ color: c.danger, fontSize: 13 }}>{err}</Text> : null}
        <Button testID="admin-user-create" label={t("admin.create")} loading={busy} onPress={() => void create()} disabled={!shops.length} />
      </Card>

      <View style={{ flexDirection: "row", gap: space.md, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field testID="admin-user-search" label={t("common.search")} value={q} onChangeText={setQ}
          placeholder={t("admin.userSearchPlaceholder")} containerStyle={{ flexBasis: 260, flexGrow: 1 }} />
        <Button kind="secondary" label={t("admin.refresh")} onPress={() => void load()} />
      </View>

      {failed ? <ErrorState onRetry={() => void load()} /> : !users ? <Loading /> : (
        <DataTable rows={users} rowTitle={(u) => <Text style={{ color: c.ink, fontWeight: "700" }}>{u.full_name}</Text>} cols={[
          { key: "full_name", title: t("admin.fullName"), width: 1.8, render: (u) => <View><Text style={{ color: c.ink, fontWeight: "600", fontSize: 14 }}>{u.full_name}</Text><Text style={{ color: c.muted, fontSize: 11 }}>{u.email}</Text></View> },
          { key: "role", title: t("admin.role"), width: 1.1, render: (u) => <Badge tone={u.role === "system_admin" ? "info" : "neutral"} label={String(u.role).replace("_", " ")} /> },
          { key: "shop", title: t("admin.shop"), width: 1.4, render: (u) => <Text style={{ color: c.inkSoft, fontSize: 13 }}>{u.role === "system_admin" ? "—" : shopName(u.shop_id)}</Text> },
          { key: "active", title: t("common.status"), width: 1.2, render: (u) => statusBadge(u) },
          { key: "actions", title: "", width: 1.4, align: "right", render: (u) => u.role !== "system_admin" && u.active
            ? <Button size="sm" kind="dangerQuiet" label={t("admin.revoke")} onPress={() => setRevoke(u)} />
            : u.role !== "system_admin" && u.account_status === "suspended"
              ? <Button size="sm" kind="secondary" label={t("admin.activateUser")} onPress={() => setActivate(u)} />
              : <Text style={{ color: c.muted, fontSize: 12 }}>—</Text> },
        ]} empty={<Empty icon="users" title={users.length ? t("admin.noMatch") : t("admin.noUsers")} description={users.length ? t("admin.noMatch") : t("admin.noUsersDesc")} />} />
      )}

      <ConfirmDialog open={!!revoke} tone="danger" title={t("admin.revokeTitle")} message={revoke ? t("admin.revokeMessage").replace("{name}", revoke.full_name) : ""}
        confirmLabel={t("admin.revoke")} busy={revoking} onCancel={() => setRevoke(null)} onConfirm={() => void confirmRevoke()} />

      <ConfirmDialog open={!!activate} title={t("admin.activateTitle")} message={activate ? t("admin.activateMessage").replace("{name}", activate.full_name) : ""}
        confirmLabel={t("admin.activateUser")} busy={activating} onCancel={() => setActivate(null)} onConfirm={() => void confirmActivate()} />
    </Screen>
  );
}
