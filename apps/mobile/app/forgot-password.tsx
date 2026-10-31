import { useState } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Field, Screen } from "../src/components/ui";
import { useT } from "../src/localization";
import { ApiError, NetworkError, request } from "../src/services/api";
import { radius, space, useTheme } from "../src/theme/tokens";

interface ForgotResponse { ok: true; devToken?: string; devUrl?: string; devExpiresAt?: string }

export default function ForgotPassword() {
  const t = useT(); const c = useTheme(); const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<ForgotResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy || !email.trim()) return;
    setBusy(true); setError(null);
    try {
      // The API answers the same way whether or not the account exists.
      setSent(await request<ForgotResponse>("/auth/password/forgot", { method: "POST", body: { email: email.trim() }, auth: false }));
    } catch (e: any) {
      setError(e instanceof NetworkError ? t("forgot.offline")
        : e instanceof ApiError && e.status === 429 ? t("forgot.rateLimited")
        : t("common.error"));
    } finally { setBusy(false); }
  }

  return (
    <Screen title={t("forgot.title")} subtitle={t("forgot.subtitle")} maxWidth={520}>
      <Card style={{ gap: space.md }}>
        {sent ? (
          <>
            <Banner tone="ok" title={t("forgot.sent")} text={t("forgot.sentHelp")} />
            {sent.devToken ? (
              <View style={{ gap: space.sm, borderWidth: 1, borderColor: c.accent, borderRadius: radius.sm, padding: space.md, backgroundColor: c.warnBg }}>
                <Text style={{ color: c.ink, fontWeight: "700", fontSize: 13 }}>{t("forgot.devTitle")}</Text>
                <Text style={{ color: c.inkSoft, fontSize: 12, lineHeight: 18 }}>{t("forgot.devHelp")}</Text>
                <Text testID="forgot-dev-token" selectable style={{ color: c.ink, fontSize: 12, fontFamily: "monospace" }}>{sent.devToken}</Text>
                <Button testID="forgot-open-reset" label={t("forgot.openReset")} onPress={() => router.push({ pathname: "/reset-password", params: { token: sent.devToken! } })} />
              </View>
            ) : null}
            <Button testID="forgot-back" kind="secondary" label={t("forgot.backToLogin")} onPress={() => router.replace("/login")} />
          </>
        ) : (
          <>
            <Field testID="forgot-email" label={t("login.email")} value={email} onChangeText={(v) => { setError(null); setEmail(v); }}
              autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="emailAddress" returnKeyType="go" onSubmitEditing={() => void submit()} />
            {error ? <Banner tone="danger" text={error} /> : null}
            <Button testID="forgot-submit" full label={busy ? t("common.loading") : t("forgot.submit")} loading={busy} disabled={!email.trim()} onPress={() => void submit()} />
            <Button testID="forgot-cancel" kind="quiet" label={t("forgot.backToLogin")} onPress={() => router.replace("/login")} />
          </>
        )}
      </Card>
    </Screen>
  );
}
