import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Banner, Button, Card, Field, Loading, Screen } from "../src/components/ui";
import { useT } from "../src/localization";
import { ApiError, NetworkError, request } from "../src/services/api";
import { kvGet, kvSet } from "../src/database";
import { space, type, useTheme } from "../src/theme/tokens";

/**
 * Public applicant status page. An applicant has no account yet, so the ONLY credential is the
 * status token issued at submission — kept on this device by register.tsx (and enterable by hand
 * on another device). Through it the applicant can follow their file, answer an information
 * request and (for password-less legacy applications) activate the account. Every decision and
 * transition is made by the server; this screen only displays and replies.
 */
interface StatusView {
  id: string;
  status: string; // PENDING_REVIEW | ADDITIONAL_INFORMATION_REQUIRED | APPROVED | REJECTED
  contactName: string;
  shopName: string;
  submittedAt: string;
  reviewedAt: string | null;
  infoMessage: string | null;
  decisionReason: string | null;
  accountActive: boolean;
  activation: { available: boolean } | null;
}

const TOKEN_KEY = "application.statusToken";

export default function ApplicationStatus() {
  const t = useT(); const c = useTheme(); const router = useRouter();
  const params = useLocalSearchParams<{ email?: string }>();
  const [pending, setPending] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<StatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [reply, setReply] = useState("");
  const [replyErr, setReplyErr] = useState<string | null>(null);
  const [replied, setReplied] = useState(false);

  const [pw, setPw] = useState("");
  const [pwErr, setPwErr] = useState<string | null>(null);

  async function load(tok: string) {
    if (!tok) return;
    setBusy(true); setErr(null);
    try {
      const v = await request<StatusView>("/applications/status", {
        method: "POST", auth: false, body: { statusToken: tok },
      });
      setToken(tok); setView(v);
      await kvSet(TOKEN_KEY, tok); // remember it on this device for the next visit
    } catch (e: any) {
      setView(null); setToken(tok);
      setErr(e instanceof NetworkError ? t("login.network")
        : e instanceof ApiError && e.status === 400 ? t("track.invalid")
          : t("common.error"));
    } finally { setBusy(false); setPending(false); }
  }

  useEffect(() => {
    // Prefer the token stored for the e-mail being tracked (register.tsx saves one per applicant):
    // a browser that submitted two applications must open the right file, not merely the last one.
    const email = typeof params.email === "string" ? params.email.trim().toLowerCase() : "";
    void (async () => {
      const scoped = email ? await kvGet(`${TOKEN_KEY}:${email}`) : null;
      const tok = scoped ?? (await kvGet(TOKEN_KEY));
      if (tok) void load(tok);
      else setPending(false);
    })();
  }, []);

  async function respond() {
    if (busy || !token) return;
    if (reply.trim().length < 3) { setReplyErr(t("track.replyRequired")); return; }
    setBusy(true); setErr(null); setReplyErr(null);
    try {
      await request("/applications/respond", {
        method: "POST", auth: false, body: { statusToken: token, message: reply.trim() },
      });
      setReply(""); setReplied(true);
      await load(token); // back to PENDING_REVIEW on the server
    } catch (e: any) {
      setErr(e instanceof NetworkError ? t("login.network")
        : e instanceof ApiError && e.status === 409 ? t("track.invalid")
          : t("common.error"));
    } finally { setBusy(false); }
  }

  async function activate() {
    if (busy || !token) return;
    if (pw.length < 10 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) { setPwErr(t("reg.errPassword")); return; }
    setBusy(true); setErr(null); setPwErr(null);
    try {
      await request("/applications/activate", {
        method: "POST", auth: false, body: { statusToken: token, password: pw },
      });
      setPw("");
      await load(token); // accountActive is now true
    } catch (e: any) {
      setErr(e instanceof NetworkError ? t("login.network")
        : e instanceof ApiError && typeof e.message === "string" && e.message !== "Bad Request" ? t("track.activationFailed")
          : t("common.error"));
    } finally { setBusy(false); }
  }

  const row = (label: string, value: string) => (
    <View key={label} style={{ flexDirection: "row", gap: space.md }}>
      <Text style={{ color: c.muted, fontSize: 12, width: 90 }}>{label}</Text>
      <Text style={{ color: c.inkSoft, fontSize: 12, flex: 1 }}>{value}</Text>
    </View>
  );

  const tokenEntry = (
    <>
      {!view && !token ? <Banner tone="warn" text={t("track.noToken")} /> : null}
      <Field testID="track-token" label={t("track.tokenLabel")} hint={t("track.tokenHint")}
        value={token ?? ""} onChangeText={(v) => { setErr(null); setToken(v); }}
        autoCapitalize="none" autoCorrect={false} returnKeyType="go"
        onSubmitEditing={() => void load((token ?? "").trim())} />
      {err ? <Banner tone="danger" text={err} /> : null}
      <Button testID="track-check" full label={busy ? t("common.loading") : t("track.check")} loading={busy}
        disabled={!(token ?? "").trim()} onPress={() => void load((token ?? "").trim())} />
    </>
  );

  return (
    <Screen title={t("track.title")} subtitle={t("track.subtitle")} maxWidth={520}>
      <Card style={{ gap: space.md }}>
        {pending ? <Loading /> : !view ? (
          tokenEntry
        ) : (
          <>
            <View style={{ gap: 2 }}>
              <Text style={{ color: c.ink, ...type.h2 }}>{view.shopName}</Text>
              <Text style={{ color: c.inkSoft, fontSize: 13, fontWeight: "600" }}>{view.contactName}</Text>
            </View>
            {row(t("track.submitted"), new Date(view.submittedAt).toLocaleString())}

            {replied && view.status === "PENDING_REVIEW" ? <Banner tone="ok" text={t("track.replySent")} /> : null}

            {view.status === "PENDING_REVIEW" ? (
              <Banner tone="warn" text={t("track.pending")} />
            ) : null}

            {view.status === "ADDITIONAL_INFORMATION_REQUIRED" ? (
              <View style={{ gap: space.sm }}>
                <Banner tone="warn" title={t("track.infoTitle")} text={view.infoMessage ?? t("track.pending")} />
                <Field testID="track-reply" required label={t("track.replyLabel")} placeholder={t("track.replyPlaceholder")}
                  value={reply} error={replyErr} multiline
                  onChangeText={(v) => { setReplyErr(null); setReply(v); }} />
                <Button testID="track-respond" label={busy ? t("common.loading") : t("track.sendReply")} loading={busy}
                  onPress={() => void respond()} />
              </View>
            ) : null}

            {view.status === "REJECTED" ? (
              <Banner tone="danger" title={t("track.rejectedTitle")} text={view.decisionReason ?? t("track.rejectedText")} />
            ) : null}

            {view.status === "APPROVED" ? (
              <View style={{ gap: space.sm }}>
                <Banner tone="ok" title={t("track.approvedTitle")}
                  text={view.accountActive ? t("track.approvedText")
                    : view.activation?.available ? t("track.activateHelp")
                      : t("track.activationLapsed")} />
                {!view.accountActive && view.activation?.available ? (
                  <>
                    <Field testID="track-password" required label={t("track.activateLabel")}
                      hint={t("reg.passwordHint")} value={pw} error={pwErr} secureTextEntry
                      onChangeText={(v) => { setPwErr(null); setPw(v); }} />
                    <Button testID="track-activate" label={busy ? t("common.loading") : t("track.activate")} loading={busy}
                      onPress={() => void activate()} />
                  </>
                ) : null}
              </View>
            ) : null}

            <Button testID="track-signin" full label={t("track.signIn")} onPress={() => router.replace("/login")} />
            <Button testID="track-another" kind="quiet" label={t("track.checkAnother")}
              onPress={() => { setView(null); setErr(null); setReplied(false); }} />
          </>
        )}
      </Card>
      {!view && !pending ? (
        <Button testID="track-back" kind="quiet" label={t("track.backToLogin")} onPress={() => router.replace("/login")} />
      ) : null}
    </Screen>
  );
}
