import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { Shake } from "../src/components/motion";
import { Banner, Button, Card, Field, PasswordField } from "../src/components/ui";
import { useT } from "../src/localization";
import { ApiError, NetworkError, request, useSession } from "../src/services/api";
import { kvSet } from "../src/database";
import { space, type, useTheme } from "../src/theme/tokens";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * "Create a Shop" — the public owner registration form. Exactly five fields; the submission
 * creates a PENDING application only: no account, no shop and no dashboard access exist until an
 * administrator approves it (the server enforces all of that — this screen never decides).
 */
export default function Register() {
  const t = useT(); const c = useTheme(); const router = useRouter();
  const { token } = useSession();

  const [username, setUsername] = useState("");
  const [shopName, setShopName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [shake, setShake] = useState(0);

  if (token) return <Redirect href="/" />;

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (username.trim().length < 2) e.username = t("reg.errUsername");
    if (shopName.trim().length < 2) e.shopName = t("reg.errShopName");
    if (!EMAIL_RE.test(email.trim())) e.email = t("reg.errEmail");
    if (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) e.password = t("reg.errPassword");
    if (phone.replace(/\D/g, "").length < 10) e.phone = t("reg.errPhone");
    setErrs(e);
    if (Object.keys(e).length) setShake((n) => n + 1);
    return Object.keys(e).length === 0;
  }

  async function submit() {
    if (busy) return;
    setErr(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const r = await request<{ statusToken: string }>("/applications", {
        method: "POST", auth: false,
        body: {
          contactName: username.trim(), shopName: shopName.trim(), email: email.trim(),
          phone: phone.trim(), password,
        },
      });
      // The status credential is the applicant's only way to follow their file and answer an
      // information request (there is no account yet). Keep it on this device for the status page.
      // Stored per e-mail as well: a second application submitted from the same browser must not
      // make "Track your application" show the other applicant's file.
      await kvSet("application.statusToken", r.statusToken);
      await kvSet(`application.statusToken:${email.trim().toLowerCase()}`, r.statusToken);
      setDone(true);
    } catch (e: any) {
      setErr(e instanceof ApiError && e.status === 409 ? t("reg.errorTaken")
        : e instanceof NetworkError ? t("login.network")
        : t("common.error"));
      setShake((n) => n + 1);
    } finally { setBusy(false); }
  }

  const form = (
    <View style={{ width: "100%", maxWidth: 460, gap: space.lg }}>
      <View style={{ gap: 4 }}>
        <Text accessibilityRole="header" style={{ color: c.ink, ...type.display }}>{t("reg.title")}</Text>
        <Text style={{ color: c.muted, ...type.body }}>{t("reg.subtitle")}</Text>
      </View>

      {done ? (
        <View testID="reg-done" style={{ gap: space.lg }}>
          <Banner tone="ok" title={t("reg.successTitle")} text={t("reg.successText")} />
          <View style={{ gap: space.sm }}>
            <Button testID="reg-check-status" full kind="secondary" label={t("reg.checkStatus")}
              onPress={() => router.push("/application-status")} />
            <Button testID="reg-goto-login" full label={t("reg.signIn")} onPress={() => router.replace("/login")} />
          </View>
        </View>
      ) : (
        <Shake trigger={shake}>
          <Card style={{ gap: space.lg }}>
            <Field testID="reg-username" required label={t("reg.username")} value={username}
              error={errs.username ?? null} onChangeText={(v) => { setErrs((e) => ({ ...e, username: "" })); setUsername(v); }}
              autoCapitalize="words" autoCorrect={false} returnKeyType="next" />
            <Field testID="reg-shop" required label={t("reg.shopName")} value={shopName}
              error={errs.shopName ?? null} onChangeText={(v) => { setErrs((e) => ({ ...e, shopName: "" })); setShopName(v); }}
              returnKeyType="next" />
            <Field testID="reg-email" required label={t("reg.email")} value={email}
              error={errs.email ?? null} onChangeText={(v) => { setErrs((e) => ({ ...e, email: "" })); setEmail(v); }}
              autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="emailAddress" returnKeyType="next" />
            <PasswordField testID="reg-password" required label={t("reg.password")} value={password}
              error={errs.password ?? null} hint={t("reg.passwordHint")}
              onChangeText={(v) => { setErrs((e) => ({ ...e, password: "" })); setPassword(v); }}
              autoCapitalize="none" autoCorrect={false} autoComplete="new-password" textContentType="newPassword" returnKeyType="next" />
            <Field testID="reg-phone" required label={t("reg.phone")} value={phone}
              error={errs.phone ?? null} onChangeText={(v) => { setErrs((e) => ({ ...e, phone: "" })); setPhone(v); }}
              placeholder="+250…" keyboardType="phone-pad" returnKeyType="go" onSubmitEditing={() => void submit()} />
            {err ? <Banner tone="danger" text={err} /> : null}
            <Button testID="reg-submit" full label={busy ? t("reg.submitting") : t("reg.submit")} loading={busy}
              disabled={!username.trim() || !shopName.trim() || !email.trim() || !password || !phone.trim()}
              onPress={() => void submit()} />
          </Card>
        </Shake>
      )}

      <Button testID="reg-signin" kind="quiet" full label={t("reg.signInPrompt")} onPress={() => router.replace("/login")} />
    </View>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, paddingVertical: space.xxl, alignItems: "center" }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, width: "100%", maxWidth: 460, marginBottom: space.xl }}>
        <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: c.primaryStrong, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: c.onPrimary, fontWeight: "800", fontSize: 17 }}>S</Text>
        </View>
        <View>
          <Text style={{ color: c.ink, fontWeight: "800", fontSize: 15 }}>{t("app.name")}</Text>
          <Text style={{ color: c.muted, fontSize: 11 }}>{t("brand.tagline")}</Text>
        </View>
      </View>
      {form}
    </ScrollView>
  );
}
