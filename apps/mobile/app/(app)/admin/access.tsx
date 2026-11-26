import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  Badge, Button, Card, ConfirmDialog, DataTable, Empty, ErrorState, Field, Loading,
  Modal, Screen, Segmented, useToasts,
} from "../../../src/components/ui";
import { useT } from "../../../src/localization";
import { request, useImpersonation, useSession } from "../../../src/services/api";
import { space, type, useTheme } from "../../../src/theme/tokens";

interface AdminUser {
  id: string; email: string; full_name: string; role: "owner" | "manager" | "system_admin";
  active: boolean; account_status: string; shop_id: string | null; shop_name: string | null;
  phone: string | null; last_seen_at: string | null; created_at: string;
}
interface AdminShop {
  id: string; name: string; currency: string; status: "active" | "suspended";
  owner: string | null; owner_id: string | null; managers: number; manager_names: string | null;
  users: number; created_at: string; location: string | null;
}
interface AccessSession {
  id: string; reason: string; started_at: string; expires_at: string; ended_at: string | null;
  revoked_at: string | null; status: "active" | "ended" | "expired" | "revoked";
  admin_user_id: string; admin_name: string; admin_email: string;
  target_user: string | null; target_user_email: string | null; target_shop: string | null;
}
interface AuditAction {
  id: string; action: string; entity: string; entity_id: string | null; reason: string | null;
  created_at: string; sensitive: boolean; on_behalf_of: string | null;
}
type Tab = "users" | "shops" | "sessions";
type Target = { kind: "user"; user: AdminUser } | { kind: "shop"; shop: AdminShop };

/**
 * User & Shop Management.
 *
 * This screen never asks for or handles a target password. Choosing "Access account" creates a
 * short-lived, server-validated administrative session, swaps the visible identity, and keeps the
 * administrator's own identity for audit. The persistent banner (root layout) is the only way back.
 */
export default function AdminAccess() {
  const t = useT(); const c = useTheme(); const router = useRouter();
  const toast = useToasts((s) => s.push);
  const enterUser = useImpersonation((s) => s.enterUser);
  const enterShop = useImpersonation((s) => s.enterShop);
  const currentUserId = useSession((s) => s.user?.id);

  const [tab, setTab] = useState<Tab>("users");
  const [input, setInput] = useState(""); const [query, setQuery] = useState("");
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [shops, setShops] = useState<AdminShop[] | null>(null);
  const [sessions, setSessions] = useState<AccessSession[] | null>(null);
  const [failed, setFailed] = useState(false);

  const [target, setTarget] = useState<Target | null>(null);
  const [reason, setReason] = useState(""); const [reasonErr, setReasonErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [review, setReview] = useState<{ session: AccessSession; rows: AuditAction[] | null } | null>(null);
  const [revoking, setRevoking] = useState<AccessSession | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const suffix = query ? `?q=${encodeURIComponent(query)}` : "";
    try {
      const [u, s, h] = await Promise.all([
        request<AdminUser[]>(`/admin/users${suffix}`),
        request<AdminShop[]>(`/admin/shops${suffix}`),
        request<AccessSession[]>("/admin/impersonation/history"),
      ]);
      setUsers(u); setShops(s); setSessions(h);
    } catch { setFailed(true); }
  }, [query]);
  useEffect(() => { void load(); }, [load]);

  function openTarget(next: Target) {
    setTarget(next); setReason(""); setReasonErr(null);
  }

  async function confirmAccess() {
    if (!target) return;
    if (reason.trim().length < 3) { setReasonErr(t("admin.reasonRequired")); return; }
    setReasonErr(null); setBusy(true);
    try {
      if (target.kind === "user") {
        await enterUser(target.user.id, reason.trim());
        toast(t("access.enteredUser").replace("{name}", target.user.full_name));
      } else {
        await enterShop(target.shop.id, reason.trim());
        toast(t("access.enteredShop").replace("{name}", target.shop.name));
      }
      setTarget(null);
      router.replace("/");
    } catch { setReasonErr(t("access.failed")); setBusy(false); }
  }

  async function openReview(session: AccessSession) {
    setReview({ session, rows: null });
    try {
      const rows = await request<AuditAction[]>(`/admin/impersonation/${session.id}/actions`);
      setReview((r) => (r?.session.id === session.id ? { ...r, rows } : r));
    } catch {
      setReview((r) => (r?.session.id === session.id ? { ...r, rows: [] } : r));
    }
  }

  async function confirmRevoke() {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await request(`/admin/impersonation/${revoking.id}/revoke`, { method: "POST" });
      toast(t("access.revoked")); setRevoking(null); await load();
    } catch { toast(t("common.error"), "danger"); }
    finally { setRevokeBusy(false); }
  }

  const roleLabel = (r: AdminUser["role"]) => t(`role.${r}` as "role.owner");
  const sessionBadge = (s: AccessSession) => {
    const expired = s.status === "active" && new Date(s.expires_at).getTime() <= Date.now();
    if (expired) return <Badge tone="warn" label={t("access.sessionExpired")} />;
    if (s.status === "active") return <Badge tone="ok" dot label={t("access.sessionActive")} />;
    if (s.status === "revoked") return <Badge tone="danger" label={t("access.sessionRevoked")} />;
    if (s.status === "expired") return <Badge tone="warn" label={t("access.sessionExpired")} />;
    return <Badge tone="neutral" label={t("access.sessionEnded")} />;
  };
  const canRevoke = (s: AccessSession) => s.status === "active"
    && s.admin_user_id === currentUserId
    && new Date(s.expires_at).getTime() > Date.now();

  return (
    <Screen title={t("access.title")} subtitle={t("access.subtitle")} testID="admin-access-screen">
      <Segmented<Tab> label={t("access.title")} value={tab} onChange={setTab} options={[
        { value: "users", label: t("access.tabUsers") },
        { value: "shops", label: t("access.tabShops") },
        { value: "sessions", label: t("access.tabSessions") },
      ]} />

      {tab !== "sessions" ? (
        <View style={{ flexDirection: "row", gap: space.md, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Field testID="access-search" label={t("common.search")} value={input}
            onChangeText={setInput} onSubmitEditing={() => setQuery(input.trim())}
            placeholder={tab === "users" ? t("access.searchUsers") : t("access.searchShops")}
            containerStyle={{ flexBasis: 320, flexGrow: 1 }} />
          <Button kind="secondary" label={t("common.search")} onPress={() => setQuery(input.trim())} />
          <Button kind="quiet" label={t("admin.refresh")} onPress={() => void load()} />
        </View>
      ) : null}

      {failed ? <ErrorState onRetry={() => void load()} /> : (
        <>
          {tab === "users" ? (
            !users ? <Loading /> : (
              <DataTable rows={users} rowTestID={(u) => `access-user-${u.id}`}
                rowTitle={(u) => <View style={{ gap: 2 }}>
                  <Text style={{ color: c.ink, fontWeight: "700" }}>{u.full_name}</Text>
                  <Text style={{ color: c.muted, fontSize: 11 }}>{u.email}{u.phone ? ` · ${u.phone}` : ""}</Text>
                </View>}
                cols={[
                  { key: "full_name", title: t("access.user"), width: 2.2, render: (u) => (
                    <View style={{ gap: 2 }}>
                      <Text style={{ color: c.ink, fontWeight: "600", fontSize: 14 }}>{u.full_name}</Text>
                      <Text style={{ color: c.muted, fontSize: 11 }}>{u.email}{u.phone ? ` · ${u.phone}` : ""}</Text>
                    </View>) },
                  { key: "shop_name", title: t("admin.shop"), width: 1.5, render: (u) => (
                    <Text style={{ color: c.inkSoft, fontSize: 13 }}>{u.shop_name ?? "—"}</Text>) },
                  { key: "role", title: t("admin.role"), width: 1, render: (u) => (
                    <Badge tone={u.role === "system_admin" ? "info" : u.role === "owner" ? "ok" : "neutral"} label={roleLabel(u.role)} />) },
                  { key: "account_status", title: t("access.status"), width: 1, render: (u) => (
                    u.role === "system_admin" ? <Text style={{ color: c.muted, fontSize: 11 }}>{t("access.systemAdminNoAccess")}</Text>
                      : u.active && u.account_status === "active"
                        ? <Badge tone="ok" label={t("admin.stActive")} />
                        : <Badge tone="danger" label={t("admin.stPendingActivation")} />) },
                  { key: "actions", title: "", width: 1.35, align: "right", render: (u) => (
                    <Button size="sm" label={t("access.access")}
                      disabled={u.role === "system_admin" || !u.active || u.account_status !== "active"}
                      onPress={() => openTarget({ kind: "user", user: u })} />) },
                ]}
                empty={<Empty icon="users" title={t("access.noUsers")} description={t("admin.noUsersDesc")} />} />
            )
          ) : null}

          {tab === "shops" ? (
            !shops ? <Loading /> : (
              <DataTable rows={shops} rowTestID={(s) => `access-shop-${s.id}`}
                rowTitle={(s) => <View style={{ gap: 2 }}>
                  <Text style={{ color: c.ink, fontWeight: "700" }}>{s.name}</Text>
                  <Text style={{ color: c.muted, fontSize: 11 }}>{s.owner ?? "—"}{s.location ? ` · ${s.location}` : ""}</Text>
                </View>}
                cols={[
                  { key: "name", title: t("access.shop"), width: 2, render: (s) => (
                    <View style={{ gap: 2 }}>
                      <Text style={{ color: c.ink, fontWeight: "600", fontSize: 14 }}>{s.name}</Text>
                      <Text style={{ color: c.muted, fontSize: 11 }}>{s.owner ?? "—"}{s.location ? ` · ${s.location}` : ""}</Text>
                    </View>) },
                  { key: "manager_names", title: t("role.manager"), width: 1.5, render: (s) => (
                    <Text style={{ color: c.inkSoft, fontSize: 13 }}>{s.manager_names ?? "—"}</Text>) },
                  { key: "users", title: t("admin.users"), width: 0.7, align: "right", render: (s) => (
                    <Text style={{ color: c.inkSoft, fontSize: 13 }}>{s.users}</Text>) },
                  { key: "status", title: t("access.status"), width: 1, render: (s) => s.status === "active"
                    ? <Badge tone="ok" label={t("admin.stActive")} />
                    : <Badge tone="danger" label={t("admin.stSuspended")} /> },
                  { key: "actions", title: "", width: 1.2, align: "right", render: (s) => (
                    <Button size="sm" label={t("access.enterShop")} disabled={s.status !== "active"}
                      onPress={() => openTarget({ kind: "shop", shop: s })} />) },
                ]}
                empty={<Empty icon="box" title={t("access.noShops")} description={t("admin.noShopsDesc")} />} />
            )
          ) : null}

          {tab === "sessions" ? (
            !sessions ? <Loading /> : (
              <DataTable rows={sessions} rowTestID={(s) => `access-session-${s.id}`}
                rowTitle={(s) => <View style={{ gap: 3 }}>
                  <Text style={{ color: c.ink, fontWeight: "700" }}>{s.target_user ?? s.target_shop ?? "—"}</Text>
                  <Text style={{ color: c.muted, fontSize: 11 }}>{s.admin_name} · {new Date(s.started_at).toLocaleString()}</Text>
                </View>}
                cols={[
                  { key: "target_user", title: t("access.target"), width: 1.7, render: (s) => (
                    <View style={{ gap: 2 }}>
                      <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{s.target_user ?? s.target_shop ?? "—"}</Text>
                      <Text style={{ color: c.muted, fontSize: 11 }}>{s.target_user_email ?? s.target_shop ?? ""}</Text>
                    </View>) },
                  { key: "reason", title: t("access.reason"), width: 2, render: (s) => (
                    <Text style={{ color: c.inkSoft, fontSize: 12 }}>{s.reason}</Text>) },
                  { key: "started_at", title: t("access.started"), width: 1.3, render: (s) => (
                    <Text style={{ color: c.muted, fontSize: 11 }}>{new Date(s.started_at).toLocaleString()}</Text>) },
                  { key: "status", title: t("access.status"), width: 0.9, render: sessionBadge },
                  { key: "actions", title: "", width: 1.5, align: "right", render: (s) => (
                    <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      <Button size="sm" kind="secondary" label={t("access.review")} onPress={() => void openReview(s)} />
                      {canRevoke(s) ? <Button size="sm" kind="dangerQuiet" label={t("access.revoke")} onPress={() => setRevoking(s)} /> : null}
                    </View>) },
                ]}
                empty={<Empty icon="shield" title={t("access.noSessions")} description={t("access.noSessionsDesc")} />} />
            )
          ) : null}
        </>
      )}

      <ConfirmDialog open={!!target}
        title={target?.kind === "shop" ? t("access.shopTitle") : t("access.accessTitle")}
        message={target ? (target.kind === "shop"
          ? t("access.shopMessage").replace("{name}", target.shop.name)
          : t("access.accessMessage").replace("{name}", target.user.full_name)) : ""}
        confirmLabel={target?.kind === "shop" ? t("access.confirmShop") : t("access.confirm")}
        busy={busy} onCancel={() => { if (!busy) setTarget(null); }} onConfirm={() => void confirmAccess()}>
        <Field testID="access-reason" required label={t("access.reason")} value={reason}
          error={reasonErr} onChangeText={(v) => { setReasonErr(null); setReason(v); }}
          placeholder={t("admin.reasonPlaceholder")} hint={t("access.reasonHelp")} />
      </ConfirmDialog>

      <ConfirmDialog open={!!revoking} tone="danger"
        title={t("access.revokeTitle")} message={t("access.revokeMessage")}
        confirmLabel={t("access.revoke")} busy={revokeBusy}
        onCancel={() => setRevoking(null)} onConfirm={() => void confirmRevoke()} />

      <Modal open={!!review} onClose={() => setReview(null)} scroll
        title={t("access.review")}
        description={review ? `${review.session.target_user ?? review.session.target_shop ?? ""} · ${new Date(review.session.started_at).toLocaleString()}` : ""}>
        {!review ? null : !review.rows ? <Loading /> : review.rows.length === 0
          ? <Text style={{ color: c.muted, fontSize: 13 }}>{t("access.noActions")}</Text>
          : <View style={{ gap: space.sm }}>
              {review.rows.map((a) => (
                <Card key={a.id} style={{ padding: space.sm, gap: 3 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                    <Badge tone={a.sensitive ? "danger" : "neutral"} label={a.action} />
                    <Text style={{ color: c.muted, fontSize: 11 }}>{new Date(a.created_at).toLocaleString()}</Text>
                  </View>
                  <Text style={{ color: c.inkSoft, fontSize: 12 }}>{a.entity}{a.entity_id ? ` · ${a.entity_id}` : ""}</Text>
                  {a.on_behalf_of ? <Text style={{ color: c.muted, fontSize: 11 }}>{t("impersonation.bannerUser").replace("{name}", a.on_behalf_of)}</Text> : null}
                  {a.reason ? <Text style={{ color: c.muted, fontSize: 11 }}>{a.reason}</Text> : null}
                </Card>
              ))}
            </View>}
      </Modal>
    </Screen>
  );
}
