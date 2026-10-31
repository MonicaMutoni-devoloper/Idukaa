import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Card, Loading, PasswordField, Screen } from "../src/components/ui";
import { useT } from "../src/localization";
import { ApiError, NetworkError, request } from "../src/services/api";
import { space, useTheme } from "../src/theme/tokens";

type State = "checking" | "valid" | "invalid";

export default function ResetPassword() {
  const t = useT(); const c = useTheme(); const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = typeof params.token === "string" ? params.token : "";
  const [state, setState] = useState<State>(token ? "checking" : "invalid");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) return;
    let live = true;
    request<{ valid: boolean }>("/auth/password/reset/verify", { method: "POST", body: { token }, auth: false })
      .then((r) => { if (live) setState(r.valid ? "valid" : "invalid"); })
      .catch(() => { if (live) setState("invalid"); });
    return () => { live = false; };
  }, [token]);

  async function submit() {
    if (busy) return;
    if (password.length < 10) { setError(t("reset.tooShort")); return; }
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) { setError(t("reset.weak")); return; }
    if (password !== confirm) { setError(t("reset.mismatch")); return; }
    setBusy(true); setError(null);
    try {
      await request("/auth/password/reset", { method: "POST", body: { token, password }, auth: false });
      setDone(true);
    } catch (e: any) {
      const reason = `${e?.body?.error ?? ""} ${e?.message ?? ""}`;
      setError(e instanceof NetworkError ? t("forgot.offline")
        : reason.includes("reset_token_invalid") ? t("reset.invalidHelp")
        : /at least 10/.test(reason) ? t("reset.tooShort")
        : /letter and a number/.test(reason) ? t("reset.weak")
        : t("common.error"));
    } finally { setBusy(false); }
  }

  if (state === "checking") {
    return <Screen title={t("reset.title")} subtitle={t("reset.checking")} maxWidth={520}><Loading /></Screen>;
  }

  if (done) {
    return (
      <Screen title={t("reset.title")} maxWidth={520}>
        <Card style={{ gap: space.md }}>
          <Banner tone="ok" title={t("reset.success")} text={t("reset.successHelp")} />
          <Button testID="reset-to-login" label={t("reset.goToLogin")} onPress={() => router.replace("/login")} />
        </Card>
      </Screen>
    );
  }

  if (state === "invalid") {
    return (
      <Screen title={t("reset.invalidTitle")} maxWidth={520}>
        <Card style={{ gap: space.md }}>
          <Text style={{ color: c.muted, fontSize: 14, lineHeight: 21 }}>{t("reset.invalidHelp")}</Text>
          <Button testID="reset-request-new" label={t("reset.requestNew")} onPress={() => router.replace("/forgot-password")} />
          <Button testID="reset-back" kind="quiet" label={t("forgot.backToLogin")} onPress={() => router.replace("/login")} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title={t("reset.title")} subtitle={t("reset.subtitle")} maxWidth={520}>
      <Card style={{ gap: space.md }}>
        <PasswordField testID="reset-password" label={t("reset.newPassword")} value={password} onChangeText={(v) => { setError(null); setPassword(v); }}
          autoComplete="new-password" textContentType="newPassword" hint={t("settings.passwordHelp")} />
        <PasswordField testID="reset-confirm" label={t("reset.confirm")} value={confirm} onChangeText={(v) => { setError(null); setConfirm(v); }}
          autoComplete="new-password" textContentType="newPassword" onSubmitEditing={() => void submit()} />
        {error ? <Banner tone="danger" text={error} /> : null}
        <Button testID="reset-submit" full label={busy ? t("common.loading") : t("reset.submit")}
          loading={busy} disabled={!password || !confirm} onPress={() => void submit()} />
        <Button kind="quiet" label={t("forgot.backToLogin")} onPress={() => router.replace("/login")} />
      </Card>
    </Screen>
  );
}
