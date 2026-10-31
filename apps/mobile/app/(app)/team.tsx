import { useCallback, useEffect, useState } from "react";
import { Platform, Share, Text, View } from "react-native";
import { Redirect } from "expo-router";
import { Badge, Banner, Button, Card, ConfirmDialog, Empty, ErrorState, Field, Loading, Modal, Screen } from "../../src/components/ui";
import { Appear } from "../../src/components/motion";
import { useT, type Key } from "../../src/localization";
import { ApiError, NetworkError, request, useSession } from "../../src/services/api";
import { useSync } from "../../src/synchronization/engine";
import { space, type, useTheme } from "../../src/theme/tokens";

/**
 * Owner-only team management. It drives the existing backend:
 *   GET  /shop/staff                       — staff + invitations (shop comes from the owner's session)
 *   POST /shop/staff/invitations           — creates a pending manager invitation (returns the link ONCE)
 *   POST /shop/staff/invitations/:id/resend — rotates the token, old link dies, returns the new link
 *   POST /shop/staff/invitations/:id/revoke — terminal
 * Acceptance lives on the public /invite screen. No e-mail or SMS provider is configured, so the
 * owner shares the returned link themselves — the UI says so honestly instead of pretending to send.
 */
interface StaffRow { id: string; email: string; full_name: string; role: "owner" | "manager"; active: boolean; account_status: string }
interface InvitationRow { id: string; email: string; full_name: string; phone: string | null; status: "invited" | "active" | "expired" | "revoked"; created_at: string; expires_at: string; accepted_at: string | null; invited_by_name: string }
interface StaffPayload { staff: StaffRow[]; invitations: InvitationRow[] }
interface CreatedLink { url: string; email: string; name: string; expiresAt: string; resent: boolean }

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";

function mapError(e: unknown, t: (k: Key) => string): string {
  if (e instanceof NetworkError) return t("team.offline");
  const m = String((e as any)?.body?.message ?? (e as any)?.message ?? "");
  if (m.includes("invitation_exists")) return t("team.errExists");
  if (m.includes("staff_already_in_shop")) return t("team.errInShop");
  if (m.includes("invitation_target_ineligible")) return t("team.errIneligible");
  if (e instanceof ApiError && e.status === 400 && /mail/i.test(m)) return t("team.errEmail");
  if (e instanceof ApiError && e.status === 403) return t("team.ownerOnly");
  return t("common.error");
}

export default function Team() {
  const t = useT(); const c = useTheme();
  const user = useSession((s) => s.user);
  const online = useSync((s) => s.online);

  const [data, setData] = useState<StaffPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [link, setLink] = useState<CreatedLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoke, setRevoke] = useState<InvitationRow | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    request<StaffPayload>("/shop/staff").then(setData).catch(() => setFailed(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!user) return <Redirect href="/login" />;
  // The API refuses every /shop/staff call for other roles; the redirect keeps the UI honest too.
  if (user.role !== "owner") return <Redirect href="/" />;

  const createInvite = async () => {
    const name = fullName.trim();
    if (name.length < 2) { setFormErr(t("team.errName")); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setFormErr(t("team.errEmail")); return; }
    setBusy(true); setFormErr(null); setNotice(null); setCopied(false);
    try {
      const r = await request<{ id: string; inviteUrl: string; email: string; full_name: string; expires_at: string }>(
        "/shop/staff/invitations", { method: "POST", body: { fullName: name, email: email.trim(), phone: phone.trim() || undefined } });
      setFullName(""); setEmail(""); setPhone("");
      setLink({ url: r.inviteUrl, email: r.email, name: r.full_name, expiresAt: r.expires_at, resent: false });
      load();
    } catch (e) { setFormErr(mapError(e, t)); }
    finally { setBusy(false); }
  };

  const resend = async (row: InvitationRow) => {
    setBusyId(row.id); setNotice(null); setCopied(false);
    try {
      const r = await request<{ inviteUrl: string; expires_at: string }>(`/shop/staff/invitations/${row.id}/resend`, { method: "POST" });
      setLink({ url: r.inviteUrl, email: row.email, name: row.full_name, expiresAt: r.expires_at, resent: true });
      load();
    } catch (e) { setNotice({ tone: "danger", text: mapError(e, t) }); }
    finally { setBusyId(null); }
  };

  const confirmRevoke = async () => {
    if (!revoke) return;
    setRevokeBusy(true);
    try {
      await request(`/shop/staff/invitations/${revoke.id}/revoke`, { method: "POST" });
      setRevoke(null); setNotice({ tone: "ok", text: t("team.revokedMsg") }); load();
    } catch (e) { setRevoke(null); setNotice({ tone: "danger", text: mapError(e, t) }); }
    finally { setRevokeBusy(false); }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(link.url);
        setCopied(true);
      } else {
        await Share.share({ message: link.url });
      }
    } catch { /* the link stays visible on screen for manual copying */ }
  };

  const statusBadge = (s: string) =>
    s === "invited" ? <Badge tone="warn" label={t("team.pending")} />
    : s === "active" ? <Badge tone="ok" label={t("team.accepted")} />
    : s === "expired" ? <Badge tone="neutral" label={t("team.expired")} />
    : <Badge tone="danger" label={t("team.revoked")} />;

  return (
    <Screen title={t("nav.team")} subtitle={t("team.subtitle")} testID="team-screen">
      {online ? null : <Banner tone="warn" text={t("team.offline")} />}
      {notice ? <Banner tone={notice.tone} text={notice.text} /> : null}

      <Card style={{ gap: space.md }}>
        <Text style={{ color: c.ink, ...type.h2 }}>{t("team.inviteTitle")}</Text>
        <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("team.inviteHelp")}</Text>
        <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
          <Field containerStyle={{ flexBasis: 200 }} testID="team-name" required label={t("team.fullName")} value={fullName}
            onChangeText={(v) => { setFormErr(null); setFullName(v); }} placeholder={t("team.fullNamePlaceholder")} autoCapitalize="words" />
          <Field containerStyle={{ flexBasis: 200 }} testID="team-email" required label={t("team.email")} value={email}
            onChangeText={(v) => { setFormErr(null); setEmail(v); }} placeholder="name@example.com" autoCapitalize="none"
            keyboardType="email-address" autoCorrect={false} hint={t("team.emailHint")} />
          <Field containerStyle={{ flexBasis: 160 }} testID="team-phone" label={t("team.phone")} value={phone}
            onChangeText={setPhone} placeholder="+250…" keyboardType="phone-pad" hint={t("team.phoneHelp")} />
        </View>
        {formErr ? <Banner tone="danger" text={formErr} /> : null}
        <Button testID="team-submit" full label={busy ? t("team.creating") : t("team.create")} loading={busy}
          disabled={!fullName.trim() || !email.trim()} onPress={() => void createInvite()} />
      </Card>

      <Card style={{ gap: space.sm }}>
        <Text style={{ color: c.ink, ...type.h2 }}>{t("team.staffTitle")}</Text>
        {!data ? <Loading /> : failed ? <ErrorState text={t("team.loadFailed")} onRetry={load} /> : data.staff.map((s, i) => (
          <Appear key={s.id} index={i}>
          <View testID="team-staff-row" style={{ flexDirection: "row", alignItems: "center", gap: space.sm,
            paddingVertical: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.line }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ color: c.ink, fontWeight: "600", fontSize: 14 }}>{s.full_name}</Text>
              <Text numberOfLines={1} style={{ color: c.muted, fontSize: 11 }}>{s.email}</Text>
            </View>
            {s.active ? null : <Badge tone="danger" label={t("team.suspended")} />}
            <Badge tone={s.role === "owner" ? "info" : "neutral"} label={t(s.role === "owner" ? "role.owner" : "role.manager")} />
          </View>
          </Appear>
        ))}
      </Card>

      <Card style={{ gap: space.sm }}>
        <Text style={{ color: c.ink, ...type.h2 }}>{t("team.invitationsTitle")}</Text>
        {!data ? <Loading /> : failed ? null : data.invitations.length === 0 ? (
          <Empty icon="users" title={t("team.noInvitations")} description={t("team.noInvitationsDesc")} />
        ) : data.invitations.map((inv, i) => (
          <Appear key={inv.id} index={i}>
          <View testID="team-invitation-row" style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap",
            paddingVertical: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.line }}>
            <View style={{ flex: 1, minWidth: 160 }}>
              <Text numberOfLines={1} style={{ color: c.ink, fontWeight: "600", fontSize: 14 }}>{inv.full_name}</Text>
              <Text numberOfLines={1} style={{ color: c.muted, fontSize: 11 }}>{inv.email}</Text>
              <Text style={{ color: c.muted, fontSize: 10 }}>
                {inv.status === "active" && inv.accepted_at ? t("team.acceptedAt").replace("{date}", when(inv.accepted_at)) : t("team.expiresAt").replace("{date}", when(inv.expires_at))}
              </Text>
            </View>
            {statusBadge(inv.status)}
            {inv.status === "invited" || inv.status === "expired" ? (
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <Button size="sm" kind="secondary" testID={`team-resend-${inv.id}`} label={t("team.resend")} loading={busyId === inv.id}
                  onPress={() => void resend(inv)} />
                <Button size="sm" kind="dangerQuiet" testID={`team-revoke-${inv.id}`} label={t("team.revoke")} onPress={() => setRevoke(inv)} />
              </View>
            ) : null}
          </View>
          </Appear>
        ))}
        {data && data.invitations.length ? <Text style={{ color: c.muted, fontSize: 11 }}>{t("team.resendHelp")}</Text> : null}
      </Card>

      <Modal open={!!link} onClose={() => setLink(null)} title={link?.resent ? t("team.resendTitle") : t("team.createdTitle")}
        description={t("team.createdHelp").replace("{name}", link?.name ?? "").replace("{date}", when(link?.expiresAt))}
        footer={<>
          <Button kind="secondary" testID="team-copy" label={t("team.copy")} onPress={() => void copyLink()} />
          <Button testID="team-done" label={t("team.done")} onPress={() => setLink(null)} />
        </>}>
        <View style={{ gap: space.sm }}>
          <Text style={{ color: c.muted, fontSize: 11, fontWeight: "700", textTransform: "uppercase" }}>{t("team.linkLabel")}</Text>
          <View style={{ backgroundColor: c.bgAlt, borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: space.md }}>
            <Text selectable testID="team-invite-url" style={{ color: c.ink, fontSize: 12 }}>{link?.url ?? ""}</Text>
          </View>
          <Banner tone="warn" text={t("team.linkWarning")} />
          {copied ? <Text style={{ color: c.success, fontSize: 12, fontWeight: "600" }}>{t("team.copied")}</Text> : null}
        </View>
      </Modal>

      <ConfirmDialog open={!!revoke} title={t("team.revokeTitle")} message={t("team.revokeHelp").replace("{email}", revoke?.email ?? "")}
        confirmLabel={t("team.revoke")} tone="danger" busy={revokeBusy}
        onCancel={() => setRevoke(null)} onConfirm={() => void confirmRevoke()} />
    </Screen>
  );
}
