import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Card, ErrorState, Loading, PasswordField, Screen } from "../src/components/ui";
import { useT } from "../src/localization";
import { ApiError, NetworkError, request, useSession } from "../src/services/api";
import { space, type, useTheme } from "../src/theme/tokens";

/**
 * Public acceptance page for the staff-invitation link the owner shares (STAFF_INVITE_URL → /invite).
 * Nothing is e-mailed: the owner hands over the one-time link. A brand-new manager chooses their own
 * password here (the owner never sees it); an address that already has an account must be signed in
 * first, so an invitation can never quietly move somebody else's account into another shop.
 */
type Preview =
  | { status: "invited"; shopName: string; email: string; fullName: string; expiresAt: string; existingAccount: boolean }
  | { status: "expired" | "revoked" | "active" | "invalid" | "network" };

export default function Invite() {
  const t = useT(); const c = useTheme(); const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = typeof params.token === "string" ? params.token : "";
  const sessionUser = useSession((s) => s.user);

  const [preview, setPreview] = useState<Preview | null>(null); // null = checking
  const [attempt, setAttempt] = useState(0);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ shop: string } | null>(null);

  useEffect(() => {
    if (!token) { setPreview({ status: "invalid" }); return; }
    let live = true;
    setPreview(null); setError(null);
    request<Preview>("/staff-invitations/preview", { method: "POST", body: { token }, auth: false })
      .then((r) => { if (live) setPreview(r); })
      .catch((e) => { if (live) setPreview({ status: e instanceof NetworkError ? "network" : "invalid" }); });
    return () => { live = false; };
  }, [token, attempt]);

  const invited = preview && preview.status === "invited" ? preview : null;

  async function acceptNew() {
    if (password.length < 10) { setError(t("reset.tooShort")); return; }
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) { setError(t("reset.weak")); return; }
    if (password !== confirm) { setError(t("reset.mismatch")); return; }
    setBusy(true); setError(null);
    try {
      const r = await request<{ ok: true; shopName: string }>("/staff-invitations/accept", { method: "POST", body: { token, password }, auth: false });
      setDone({ shop: r.shopName });
    } catch (e: any) {
      const m = String(e?.body?.message ?? e?.message ?? "");
      setError(e instanceof NetworkError ? t("forgot.offline")
        : m.includes("invitation_expired") ? t("invite.expiredHelp")
        : m.includes("invitation_email_in_use") ? t("invite.existingHelp").replace("{email}", invited?.email ?? "")
        : m.includes("invitation_invalid") ? t("invite.invalidHelp")
        : m.includes("invitation_active") ? t("invite.usedHelp")
        : /at least 10/i.test(m) ? t("reset.tooShort")
        : /letter and a number/i.test(m) ? t("reset.weak")
        : t("common.error"));
    } finally { setBusy(false); }
  }

  /** Existing account with a live session for the invited address: move it into the shop. */
  async function acceptExisting() {
    setBusy(true); setError(null);
    try {
      const r = await request<{ ok: true }>("/staff-invitations/accept-auth", { method: "POST", body: { token } });
      void r;
      setDone({ shop: invited?.shopName ?? "" });
    } catch (e: any) {
      const m = String(e?.body?.message ?? e?.message ?? "");
      setError(e instanceof NetworkError ? t("forgot.offline")
        : m.includes("invitation_expired") ? t("invite.expiredHelp")
        : m.includes("invitation_email_mismatch") || m.includes("invitation_target_ineligible") ? t("invite.emailMismatch").replace("{email}", invited?.email ?? "")
        : m.includes("staff_already_in_shop") ? t("invite.usedHelp")
        : m.includes("invitation_invalid") ? t("invite.invalidHelp")
        : t("common.error"));
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <Screen title={t("invite.title")} maxWidth={520} testID="invite-screen">
        <Card style={{ gap: space.md }}>
          <Banner tone="ok" title={t("invite.successTitle").replace("{shop}", done.shop)} text={t("invite.successHelp")} />
          <Button testID="invite-to-login" label={t("reset.goToLogin")} onPress={() => router.replace("/login")} />
        </Card>
      </Screen>
    );
  }

  if (preview === null) {
    return <Screen title={t("invite.title")} maxWidth={520} testID="invite-screen"><Loading label={t("invite.checking")} /></Screen>;
  }

  if (preview.status === "network") {
    return (
      <Screen title={t("invite.title")} maxWidth={520} testID="invite-screen">
        <ErrorState text={t("forgot.offline")} onRetry={() => setAttempt((a) => a + 1)} />
        <Button kind="quiet" label={t("forgot.backToLogin")} onPress={() => router.replace("/login")} />
      </Screen>
    );
  }

  if (preview.status !== "invited") {
    const title = preview.status === "expired" ? t("invite.expiredTitle")
      : preview.status === "revoked" ? t("invite.revokedTitle")
      : preview.status === "active" ? t("invite.usedTitle")
      : t("invite.invalidTitle");
    const help = preview.status === "expired" ? t("invite.expiredHelp")
      : preview.status === "revoked" ? t("invite.revokedHelp")
      : preview.status === "active" ? t("invite.usedHelp")
      : t("invite.invalidHelp");
    return (
      <Screen title={t("invite.title")} maxWidth={520} testID="invite-screen">
        <Card style={{ gap: space.md }}>
          <Banner tone="warn" title={title} text={help} />
          <Button testID="invite-to-login" label={preview.status === "active" ? t("login.submit") : t("forgot.backToLogin")}
            onPress={() => router.replace("/login")} />
        </Card>
      </Screen>
    );
  }

  // preview.status === "invited"
  const expires = new Date(preview.expiresAt).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <Screen title={t("invite.title")} maxWidth={520} testID="invite-screen">
      <Card style={{ gap: space.md }}>
        <Text style={{ color: c.ink, ...type.h2 }}>{t("invite.heading").replace("{shop}", preview.shopName)}</Text>
        <View style={{ gap: 2 }}>
          <Text style={{ color: c.ink, fontSize: 14, fontWeight: "600" }}>{preview.fullName}</Text>
          <Text style={{ color: c.muted, fontSize: 12 }}>{preview.email}</Text>
          <Text style={{ color: c.muted, fontSize: 11 }}>{t("invite.expiresAt").replace("{date}", expires)}</Text>
        </View>

        {preview.existingAccount ? (
          sessionUser ? (
            /* Already signed in on this device: the server still verifies the address matches
               the invitation (invitation_email_mismatch / invitation_target_ineligible). */
            <>
              <Banner tone="warn" title={t("invite.existingTitle")} text={t("invite.acceptExistingHelp")} />
              {error ? <Banner tone="danger" text={error} /> : null}
              <Button testID="invite-accept-existing" full label={t("invite.acceptExisting")} loading={busy}
                onPress={() => void acceptExisting()} />
            </>
          ) : (
            <>
              <Banner tone="warn" title={t("invite.existingTitle")}
                text={t("invite.existingHelp").replace("{email}", preview.email)} />
              <Button testID="invite-sign-in" full label={t("login.submit")} onPress={() => router.replace("/login")} />
            </>
          )
        ) : (
          <>
            <PasswordField testID="invite-password" label={t("invite.password")} value={password}
              onChangeText={(v) => { setError(null); setPassword(v); }} autoComplete="new-password" textContentType="newPassword"
              hint={t("settings.passwordHelp")} />
            <PasswordField testID="invite-confirm" label={t("invite.confirm")} value={confirm}
              onChangeText={(v) => { setError(null); setConfirm(v); }} autoComplete="new-password" textContentType="newPassword"
              onSubmitEditing={() => void acceptNew()} />
            {error ? <Banner tone="danger" text={error} /> : null}
            <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("invite.ownerNote")}</Text>
            <Button testID="invite-submit" full label={busy ? t("common.loading") : t("invite.accept")} loading={busy}
              disabled={!password || !confirm} onPress={() => void acceptNew()} />
          </>
        )}
        <Button kind="quiet" label={t("forgot.backToLogin")} onPress={() => router.replace("/login")} />
      </Card>
    </Screen>
  );
}
