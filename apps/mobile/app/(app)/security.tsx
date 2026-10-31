import { useEffect, useState } from "react";
import { Image, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Badge, Banner, Button, Card, ConfirmDialog, Field, Loading, PasswordField, Screen } from "../../src/components/ui";
import { useT } from "../../src/localization";
import { ApiError, NetworkError, request, useSession } from "../../src/services/api";
import { useSync } from "../../src/synchronization/engine";
import { radius, space, useTheme } from "../../src/theme/tokens";

interface Status { enabled: boolean; recoveryCodesRemaining: number; encryptionConfigured: boolean }
interface Setup { secret: string; otpauth: string; qrDataUrl: string }
type Note = { tone: "ok" | "danger" | "warn"; text: string } | null;

function reasonText(e: unknown, t: ReturnType<typeof useT>): string {
  if (e instanceof NetworkError) return t("notifications.offline");
  const reason = (e as any)?.body?.error;
  if (reason === "current_password_incorrect") return t("settings.passwordWrong");
  if (reason === "invalid_code") return t("security.invalidCode");
  if (reason === "two_factor_not_configured") return t("security.notConfigured");
  if (reason === "two_factor_already_enabled") return t("security.alreadyEnabled");
  if (reason === "two_factor_not_enabled") return t("security.notEnabled");
  if (reason === "two_factor_setup_required") return t("security.setupExpired");
  if (e instanceof ApiError && e.status === 401) return t("security.sessionExpired");
  return t("common.error");
}

export default function Security() {
  const t = useT(); const c = useTheme(); const router = useRouter();
  const online = useSync((s) => s.online);
  const logoutAll = useSession((s) => s.logoutAll);
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState<"setup" | "enable" | "disable" | "regenerate" | "logout" | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  function load() {
    setFailed(false);
    request<Status>("/auth/2fa").then(setStatus).catch(() => setFailed(true));
  }
  useEffect(load, []);

  async function run(kind: NonNullable<typeof busy>, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(kind); setNote(null);
    try { await fn(); }
    catch (e) { setNote({ tone: "danger", text: reasonText(e, t) }); }
    finally { setBusy(null); }
  }

  const startSetup = () => run("setup", async () => {
    const r = await request<Setup>("/auth/2fa/setup", { method: "POST", body: { password } });
    setSetup(r); setCodes(null); setCode("");
  });

  const enable = () => run("enable", async () => {
    const r = await request<{ recoveryCodes: string[] }>("/auth/2fa/enable", { method: "POST", body: { password, code: code.trim() } });
    setCodes(r.recoveryCodes); setSetup(null); setPassword(""); setCode("");
    setStatus(await request<Status>("/auth/2fa"));
    setNote({ tone: "ok", text: t("security.enabled") });
  });

  const disable = () => run("disable", async () => {
    await request("/auth/2fa/disable", { method: "POST", body: { password, code: code.trim() } });
    setConfirmDisable(false); setCodes(null); setPassword(""); setCode("");
    setStatus(await request<Status>("/auth/2fa"));
    setNote({ tone: "ok", text: t("security.disabled") });
  });

  const regenerate = () => run("regenerate", async () => {
    const r = await request<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", { method: "POST", body: { password, code: code.trim() } });
    setCodes(r.recoveryCodes); setPassword(""); setCode("");
    setStatus(await request<Status>("/auth/2fa"));
    setNote({ tone: "ok", text: t("security.regenerated") });
  });

  const signOutEverywhere = () => run("logout", async () => {
    await logoutAll();
    router.replace("/login");
  });

  if (!status) {
    return (
      <Screen title={t("security.title")} subtitle={t("security.subtitle")}>
        {failed ? (
          <Card tone="danger" style={{ gap: space.md }}>
            <Text style={{ color: c.danger, fontSize: 14 }}>{online ? t("security.loadFailed") : t("notifications.offline")}</Text>
            <Button kind="secondary" label={t("common.retry")} onPress={load} />
          </Card>
        ) : <Loading />}
      </Screen>
    );
  }

  const canUse2fa = status.encryptionConfigured;
  return (
    <Screen title={t("security.title")} subtitle={t("security.subtitle")}>
      {!online ? <Banner tone="warn" text={t("notifications.offline")} /> : null}
      {note ? <Banner tone={note.tone === "warn" ? "warn" : note.tone} text={note.text} /> : null}

      <Card style={{ gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("security.twoFactor")}</Text>
            <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("security.twoFactorHelp")}</Text>
          </View>
          <Badge tone={status.enabled ? "ok" : "neutral"} label={status.enabled ? t("security.on") : t("security.off")} dot />
        </View>

        {!canUse2fa ? (
          <Banner tone="warn" title={t("security.notConfigured")} text={t("security.notConfiguredHelp")} />
        ) : null}

        {codes ? (
          <Card tone="warn" style={{ gap: space.sm }}>
            <Text style={{ color: c.ink, fontWeight: "700", fontSize: 13 }}>{t("security.recoveryCodes")}</Text>
            <Text style={{ color: c.inkSoft, fontSize: 12, lineHeight: 18 }}>{t("security.recoveryHelp")}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {codes.map((rc) => (
                <Text key={rc} selectable style={{ fontFamily: "monospace", fontSize: 14, color: c.ink, backgroundColor: c.surface, borderWidth: 1, borderColor: c.lineStrong, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4 }}>
                  {rc}
                </Text>
              ))}
            </View>
            <Button testID="security-codes-saved" size="sm" kind="secondary" label={t("security.savedCodes")} onPress={() => setCodes(null)} />
          </Card>
        ) : null}

        {!status.enabled && canUse2fa ? (
          setup ? (
            <View style={{ gap: space.md }}>
              <Text style={{ color: c.inkSoft, fontSize: 13, lineHeight: 19 }}>{t("security.scanQr")}</Text>
              <Image testID="security-qr" source={{ uri: setup.qrDataUrl }} style={{ width: 220, height: 220, alignSelf: "center", borderRadius: radius.sm, backgroundColor: "#fff" }} resizeMode="contain" />
              <View style={{ gap: 4 }}>
                <Text style={{ color: c.muted, fontSize: 12 }}>{t("security.manualKey")}</Text>
                <Text testID="security-secret" selectable style={{ color: c.ink, fontSize: 14, fontFamily: "monospace", letterSpacing: 1 }}>{setup.secret}</Text>
                <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("security.manualHelp")}</Text>
              </View>
              <Field testID="security-setup-code" label={t("security.codeLabel")} value={code} onChangeText={(v) => { setNote(null); setCode(v); }}
                keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" hint={t("security.codeHint")} />
              <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
                <Button testID="security-enable" label={busy === "enable" ? t("common.loading") : t("security.enable")} loading={busy === "enable"} disabled={code.replace(/\s/g, "").length !== 6 || !password} onPress={() => void enable()} />
                <Button kind="quiet" label={t("common.cancel")} disabled={!!busy} onPress={() => { setSetup(null); setCode(""); }} />
              </View>
            </View>
          ) : (
            <View style={{ gap: space.sm }}>
              <PasswordField testID="security-password" label={t("security.passwordConfirm")} value={password} onChangeText={(v) => { setNote(null); setPassword(v); }}
                autoComplete="current-password" textContentType="password" />
              <Button testID="security-setup" label={busy === "setup" ? t("common.loading") : t("security.setup")} loading={busy === "setup"} disabled={!password} onPress={() => void startSetup()} />
            </View>
          )
        ) : null}

        {status.enabled ? (
          <View style={{ gap: space.md, borderTopWidth: 1, borderTopColor: c.line, paddingTop: space.md }}>
            <Text style={{ color: c.muted, fontSize: 12 }}>{t("security.codesRemaining").replace("{n}", String(status.recoveryCodesRemaining))}</Text>
            <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
              <PasswordField testID="security-manage-password" label={t("security.passwordConfirm")} value={password} onChangeText={(v) => { setNote(null); setPassword(v); }}
                autoComplete="current-password" textContentType="password" />
              <Field testID="security-manage-code" label={t("security.codeLabel")} value={code} onChangeText={(v) => { setNote(null); setCode(v); }}
                keyboardType="default" autoCapitalize="characters" autoComplete="one-time-code" hint={t("security.codeOrRecoveryHint")} />
            </View>
            <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
              <Button testID="security-regenerate" kind="secondary" label={busy === "regenerate" ? t("common.loading") : t("security.regenerate")}
                loading={busy === "regenerate"} disabled={!password || !code.trim()} onPress={() => void regenerate()} />
              <Button testID="security-disable" kind="dangerQuiet" label={t("security.disable")} disabled={!password || !code.trim()} onPress={() => setConfirmDisable(true)} />
            </View>
          </View>
        ) : null}
      </Card>

      <Card style={{ gap: space.md }}>
        <View style={{ gap: 2 }}>
          <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("security.sessions")}</Text>
          <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("security.sessionsHelp")}</Text>
        </View>
        <Button testID="security-logout-all" kind="secondary" label={t("security.logoutAll")} loading={busy === "logout"} onPress={() => setConfirmLogout(true)} />
      </Card>

      <ConfirmDialog open={confirmDisable} title={t("security.disableTitle")} message={t("security.disableHelp")}
        confirmLabel={t("security.disable")} tone="danger" busy={busy === "disable"}
        onCancel={() => setConfirmDisable(false)} onConfirm={() => void disable()} />

      <ConfirmDialog open={confirmLogout} title={t("security.logoutAllTitle")} message={t("security.logoutAllMessage")}
        confirmLabel={t("security.logoutAll")} tone="danger" busy={busy === "logout"}
        onCancel={() => setConfirmLogout(false)} onConfirm={() => void signOutEverywhere()} />
    </Screen>
  );
}
