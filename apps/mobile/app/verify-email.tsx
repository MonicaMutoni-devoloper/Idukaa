import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Card, Field, Loading, Screen } from "../src/components/ui";
import { useT } from "../src/localization";
import { ApiError, NetworkError, request } from "../src/services/api";
import { space, useTheme } from "../src/theme/tokens";

/**
 * Landing page for the link in the confirmation e-mail, and the place to ask for a new one.
 *
 * The API answers `verification_token_invalid` for both an unknown link and an expired one — the
 * person holding a stale link cannot fix the difference, so the screen offers the same two ways out
 * either way: send a new link, or sign in.
 */

type State = "checking" | "ok" | "invalid";

export default function VerifyEmail() {
  const t = useT(); const c = useTheme(); const router = useRouter();
  const params = useLocalSearchParams<{ token?: string; email?: string }>();
  const token = typeof params.token === "string" ? params.token : "";
  const [state, setState] = useState<State>(token ? "checking" : "invalid");
  const [verified, setVerified] = useState("");
  const [email, setEmail] = useState(typeof params.email === "string" ? params.email : "");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    request<{ ok: true; email: string }>("/auth/email/verify", { method: "POST", body: { token }, auth: false })
      .then((r) => { if (live) { setVerified(r.email); setState("ok"); } })
      .catch(() => { if (live) setState("invalid"); });
    return () => { live = false; };
  }, [token]);

  async function resend() {
    if (busy || !email.trim()) return;
    setBusy(true); setError(null);
    try {
      // The API never says whether the address exists, so this cannot be used to test addresses.
      await request("/auth/email/resend", { method: "POST", body: { email: email.trim() }, auth: false });
      setSent(true);
    } catch (e: any) {
      setError(e instanceof NetworkError ? t("forgot.offline")
        : e instanceof ApiError && e.status === 429 ? t("forgot.rateLimited")
        : e instanceof ApiError && e.status === 503 ? t("common.mailUnavailable")
        : t("common.error"));
    } finally { setBusy(false); }
  }

  if (state === "checking") {
    return <Screen title={t("verify.title")} subtitle={t("verify.checking")} maxWidth={520}><Loading /></Screen>;
  }

  if (state === "ok") {
    return (
      <Screen title={t("verify.title")} maxWidth={520}>
        <Card style={{ gap: space.md }}>
          <Banner tone="ok" title={t("verify.okTitle")} text={verified ? t("verify.okHelpEmail").replace("{email}", verified) : t("verify.okHelp")} />
          <Button testID="verify-to-login" label={t("verify.signIn")} onPress={() => router.replace("/login")} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title={t("verify.invalidTitle")} subtitle={token ? t("verify.invalidHelp") : t("verify.subtitle")} maxWidth={520}>
      <Card style={{ gap: space.md }}>
        {sent ? (
          <>
            <Banner tone="ok" title={t("verify.resent")} text={t("verify.resentHelp")} />
            <Button testID="verify-back" label={t("verify.signIn")} onPress={() => router.replace("/login")} />
          </>
        ) : (
          <>
            <Text style={{ color: c.muted, fontSize: 14, lineHeight: 21 }}>{t("verify.resendHelp")}</Text>
            <Field testID="verify-email" label={t("login.email")} value={email} onChangeText={(v) => { setError(null); setEmail(v); }}
              autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="emailAddress"
              returnKeyType="go" onSubmitEditing={() => void resend()} />
            {error ? <Banner tone="danger" text={error} /> : null}
            <Button testID="verify-resend" full label={busy ? t("common.loading") : t("verify.resend")} loading={busy}
              disabled={!email.trim()} onPress={() => void resend()} />
            <Button testID="verify-login" kind="quiet" label={t("verify.signIn")} onPress={() => router.replace("/login")} />
          </>
        )}
      </Card>
    </Screen>
  );
}
