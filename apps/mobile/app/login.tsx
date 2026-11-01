import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { Shake } from "../src/components/motion";
import { Banner, Button, Card, Field, PasswordField, Segmented, useWide } from "../src/components/ui";
import { useLang, useT } from "../src/localization";
import { useSession, ApiError, NetworkError } from "../src/services/api";
import { space, type, useTheme } from "../src/theme/tokens";

function Bullet({ text }: { text: string }) {
  const c = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
      <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: c.sidebarInk, opacity: 0.7, alignItems: "center", justifyContent: "center", marginTop: 2 }}>
        <View style={{ width: 4, height: 7, borderRadius: 1, borderRightWidth: 1.5, borderBottomWidth: 1.5, borderColor: c.sidebarInk, transform: [{ rotate: "40deg" }], marginTop: -2 }} />
      </View>
      <Text style={{ color: c.sidebarInk, opacity: 0.92, fontSize: 14, lineHeight: 20, flex: 1 }}>{text}</Text>
    </View>
  );
}

export default function Login() {
  const t = useT(); const c = useTheme(); const wide = useWide(); const router = useRouter();
  const { token, login, verifyTwoFactor, cancelTwoFactor } = useSession();
  const { lang, set } = useLang();
  const [email, setEmail] = useState(""); const [pw, setPw] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  // Bumped on every failed attempt so the form can shake once per real error, not on every render.
  const [errCount, setErrCount] = useState(0);
  const [step, setStep] = useState<"password" | "code">("password");
  const [code, setCode] = useState("");
  if (token) return <Redirect href="/" />;

  async function go() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await login(email.trim(), pw);
      if (r.twoFactorRequired) { setCode(""); setStep("code"); }
    }
    catch (e: any) {
      setErrCount((n) => n + 1);
      // Only a caller who proved the registration password is told the state of their file.
      const code = e instanceof ApiError && typeof e.body?.message === "string" ? e.body.message : null;
      setErr(
        e instanceof NetworkError ? t("login.network")
        :        code === "application_info_required" ? t("login.infoRequired")
        : code === "application_pending_review" ? t("login.pendingReview")
        : code === "application_rejected" ? t("login.rejected")
        : code === "account_not_activated" ? t("login.notActivated")
        : code === "account_suspended" ? t("login.suspended")
        : code === "shop_suspended" ? t("login.shopSuspended")
        : e?.status === 401 ? t("login.error")
        : t("common.error"));
    }
    finally { setBusy(false); }
  }

  async function verify() {
    if (busy || !code.trim()) return;
    setBusy(true); setErr(null);
    try { await verifyTwoFactor(code.trim()); }
    catch (e: any) {
      setErrCount((n) => n + 1);
      const reason = e?.body?.error;
      setErr(e instanceof NetworkError ? t("login.network")
        : reason === "two_factor_challenge_invalid" ? t("login.codeExpired")
        : reason === "two_factor_locked" ? t("login.codeLocked")
        : e instanceof ApiError && e.status === 401 ? t("login.codeInvalid")
        : t("common.error"));
    }
    finally { setBusy(false); }
  }

  function back() {
    cancelTwoFactor(); setStep("password"); setCode(""); setErr(null);
  }

  const form = (
    <View style={{ width: "100%", maxWidth: 420, gap: space.lg }}>
      <View style={{ gap: 4 }}>
        <Text style={{ color: c.ink, ...type.display }}>{step === "code" ? t("login.twoFactorTitle") : t("login.welcome")}</Text>
        <Text style={{ color: c.muted, ...type.body }}>{step === "code" ? t("login.twoFactorHelp") : t("login.subtitle")}</Text>
      </View>
      <Shake trigger={errCount}>
      <Card style={{ gap: space.lg }}>
        {step === "password" ? (
          <>
            <Field testID="login-email" label={t("login.email")} hint={t("login.emailHint")} value={email} onChangeText={(v) => { setErr(null); setEmail(v); }}
              autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="emailAddress" returnKeyType="next" />
            <PasswordField testID="login-password" label={t("login.password")} value={pw} onChangeText={(v) => { setErr(null); setPw(v); }}
              autoComplete="current-password" textContentType="password" returnKeyType="go" onSubmitEditing={() => void go()} />
            {err ? <Banner tone="danger" text={err} /> : null}
            <Button testID="login-submit" full label={busy ? t("login.signingIn") : t("login.submit")} loading={busy} disabled={!email.trim() || !pw} onPress={() => void go()} />
            <Button testID="login-create-shop" kind="secondary" full label={t("login.createShop")}
              onPress={() => { cancelTwoFactor(); setErr(null); router.push("/register"); }} />
            <Button testID="login-forgot" kind="quiet" label={t("login.forgot")} onPress={() => { cancelTwoFactor(); router.push("/forgot-password"); }} />
            <Button testID="login-track" kind="quiet" label={t("login.track")} onPress={() => { cancelTwoFactor(); setErr(null); const e = email.trim().toLowerCase(); router.push(e ? `/application-status?email=${encodeURIComponent(e)}` : "/application-status"); }} />
            <Text style={{ color: c.muted, fontSize: 12, lineHeight: 17 }}>{t("login.localFirst")}</Text>
          </>
        ) : (
          <>
            <Field testID="login-code" label={t("login.code")} value={code} onChangeText={(v) => { setErr(null); setCode(v); }}
              autoCapitalize="characters" autoCorrect={false} keyboardType="default" returnKeyType="go" onSubmitEditing={() => void verify()}
              hint={t("login.twoFactorCodeHint")} autoComplete="one-time-code" />
            {err ? <Banner tone="danger" text={err} /> : null}
            <Button testID="login-verify" full label={busy ? t("common.loading") : t("login.verify")} loading={busy} disabled={!code.trim()} onPress={() => void verify()} />
            <Button testID="login-back" kind="quiet" label={t("login.back")} onPress={back} />
          </>
        )}
      </Card>
      </Shake>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md }}>
        <Text style={{ color: c.muted, fontSize: 12 }}>{t("common.language")}</Text>
        <Segmented value={lang} onChange={set} options={[{ value: "en", label: "English" }, { value: "rw", label: "Kinyarwanda" }]} />
      </View>
    </View>
  );

  if (!wide) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, paddingVertical: space.xxl, alignItems: "center" }}>
        <View style={{ width: "100%", maxWidth: 420, gap: space.xl }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: c.primaryStrong, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: c.onPrimary, fontWeight: "800", fontSize: 17 }}>S</Text>
            </View>
            <View>
              <Text style={{ color: c.ink, fontWeight: "800", fontSize: 15 }}>{t("app.name")}</Text>
              <Text style={{ color: c.muted, fontSize: 11 }}>{t("brand.tagline")}</Text>
            </View>
          </View>
          {form}
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: c.bg }}>
      <View style={{ width: "46%", backgroundColor: c.sidebar, padding: space.xxxl, justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: c.primaryStrong, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: c.onPrimary, fontWeight: "800", fontSize: 16 }}>S</Text>
          </View>
          <View>
            <Text style={{ color: c.sidebarInk, fontWeight: "800", fontSize: 15 }}>{t("app.name")}</Text>
            <Text style={{ color: c.sidebarMuted, fontSize: 11 }}>{t("brand.tagline")}</Text>
          </View>
        </View>
        <View style={{ gap: space.lg, maxWidth: 400 }}>
          <Text style={{ color: c.sidebarInk, fontSize: 34, lineHeight: 42, fontWeight: "800", letterSpacing: -0.6 }}>{t("login.hero")}</Text>
          <View style={{ gap: 12, marginTop: 4 }}>
            <Bullet text={t("login.pitch1")} />
            <Bullet text={t("login.pitch2")} />
            <Bullet text={t("login.pitch3")} />
          </View>
        </View>
        <Text style={{ color: c.sidebarMuted, fontSize: 12 }}>{t("login.localFirst")}</Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center", padding: space.xxxl }}>
        {form}
      </ScrollView>
    </View>
  );
}
