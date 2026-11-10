import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Badge, Banner, Button, Card, ConfirmDialog, Field, PasswordField, Screen, Segmented, useWide } from "../../src/components/ui";
import { AppearanceSettings } from "../../src/components/theme-switcher";
import { PwaInstallCard } from "../../src/components/pwa-install";
import { OfflineDownloadCard } from "../../src/components/offline-download";
import { storageBackend } from "../../src/database/local";
import { useLang, useT, type Key } from "../../src/localization";
import { request, useSession } from "../../src/services/api";
import { syncNow, useSync } from "../../src/synchronization/engine";
import { installedApp } from "../../src/services/updates";
import { space, type, useTheme } from "../../src/theme/tokens";

interface Me { id: string; email: string; name: string; role: "owner" | "manager" | "system_admin"; shopId: string | null; shopName: string | null }
interface ShopProfile { id: string; name: string; currency: string; createdAt: string }
interface ShopPolicy { managerFinancialAccess: boolean; belowCostPolicy: "acknowledge" | "block"; maxDiscountPercent: number }
type Note = { tone: "ok" | "danger"; text: string } | null;

export default function Settings() {
  const t = useT(); const c = useTheme(); const wide = useWide(); const router = useRouter();
  const { user, token, logout, apply } = useSession(); const { lang, set } = useLang();
  const pending = useSync((s) => s.pending); const issues = useSync((s) => s.issues);
  const lastSync = useSync((s) => s.lastSync); const online = useSync((s) => s.online); const running = useSync((s) => s.running);
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false);
  const storage = storageBackend();
  const appVersion = installedApp().version;

  // Account + shop: read from the server so the email and shop name are the real ones.
  const [me, setMe] = useState<Me | null>(null);
  const [shop, setShop] = useState<ShopProfile | null>(null);
  useEffect(() => {
    if (!token) return;
    let live = true;
    request<Me>("/auth/me").then((r) => { if (live) setMe(r); }).catch(() => { /* keep the cached session */ });
    if (user?.shopId) request<ShopProfile>("/shop/profile").then((r) => { if (live) setShop(r); }).catch(() => {});
    return () => { live = false; };
  }, [token, user?.shopId]);

  // Profile name
  const [name, setName] = useState(user?.name ?? "");
  const [nameNote, setNameNote] = useState<Note>(null); const [nameBusy, setNameBusy] = useState(false);
  useEffect(() => { if (me) setName(me.name); }, [me?.name]);

  const saveName = async () => {
    const value = name.trim();
    if (value.length < 2) { setNameNote({ tone: "danger", text: t("settings.nameInvalid") }); return; }
    setNameBusy(true); setNameNote(null);
    try {
      const r = await request<Me>("/auth/me", { method: "PATCH", body: { fullName: value } });
      setMe(r);
      if (user) await apply({ user: { ...user, name: r.name } });
      setNameNote({ tone: "ok", text: t("settings.nameSaved") });
    } catch { setNameNote({ tone: "danger", text: t("common.error") }); }
    finally { setNameBusy(false); }
  };

  // Password change
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwNote, setPwNote] = useState<Note>(null); const [pwBusy, setPwBusy] = useState(false);
  const savePassword = async () => {
    if (pw.next.length < 10) { setPwNote({ tone: "danger", text: t("settings.passwordTooShort") }); return; }
    if (pw.next !== pw.confirm) { setPwNote({ tone: "danger", text: t("settings.passwordMismatch") }); return; }
    setPwBusy(true); setPwNote(null);
    try {
      const r = await request<{ token: string; refreshToken?: string }>("/auth/password", { method: "POST", body: { currentPassword: pw.current, newPassword: pw.next } });
      await apply({ token: r.token, refreshToken: r.refreshToken });
      setPw({ current: "", next: "", confirm: "" });
      setPwNote({ tone: "ok", text: t("settings.passwordChanged") });
    } catch (e: any) {
      const reason = `${e?.body?.error ?? ""} ${e?.message ?? ""}`;
      setPwNote({
        tone: "danger",
        text: reason.includes("current_password_incorrect") ? t("settings.passwordWrong")
          : reason.includes("password_unchanged") ? t("settings.passwordSame")
          : /letter and a number/.test(reason) ? t("settings.passwordWeak")
          : /at least 10/.test(reason) ? t("settings.passwordTooShort")
          : t("common.error"),
      });
    } finally { setPwBusy(false); }
  };

  // Shop details (owner)
  const [shopName, setShopName] = useState("");
  const [shopNote, setShopNote] = useState<Note>(null); const [shopBusy, setShopBusy] = useState(false);
  useEffect(() => { if (shop) setShopName(shop.name); }, [shop?.name]);
  const saveShop = async () => {
    if (shopName.trim().length < 2) { setShopNote({ tone: "danger", text: t("settings.nameInvalid") }); return; }
    setShopBusy(true); setShopNote(null);
    try {
      const r = await request<ShopProfile>("/shop/profile", { method: "PATCH", body: { name: shopName.trim() } });
      setShop(r); setShopNote({ tone: "ok", text: t("settings.shopSaved") });
    } catch { setShopNote({ tone: "danger", text: t("common.error") }); }
    finally { setShopBusy(false); }
  };

  // Shop policy (owner) — enforced by the API, not just hidden in the UI.
  const [policy, setPolicy] = useState<ShopPolicy | null>(null);
  const [discountInput, setDiscountInput] = useState("100");
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyMsg, setPolicyMsg] = useState<Note>(null);

  useEffect(() => {
    if (user?.role !== "owner") return;
    let live = true;
    request<ShopPolicy>("/shop/settings")
      .then((p) => { if (!live) return; setPolicy(p); setDiscountInput(String(p.maxDiscountPercent)); })
      .catch(() => { if (live) setPolicyMsg({ tone: "danger", text: t("common.error") }); });
    return () => { live = false; };
  }, [user?.role]);

  const savePolicy = async () => {
    if (!policy) return;
    const max = /^\d{1,3}$/.test(discountInput.trim()) ? Number(discountInput.trim()) : NaN;
    if (!Number.isInteger(max) || max < 0 || max > 100) { setPolicyMsg({ tone: "danger", text: t("settings.maxDiscountError") }); return; }
    setPolicyBusy(true); setPolicyMsg(null);
    try {
      const p = await request<ShopPolicy>("/shop/settings", { method: "PATCH", body: { ...policy, maxDiscountPercent: max } });
      setPolicy(p); setDiscountInput(String(p.maxDiscountPercent));
      setPolicyMsg({ tone: "ok", text: t("settings.policySaved") });
    } catch { setPolicyMsg({ tone: "danger", text: t("common.error") }); }
    finally { setPolicyBusy(false); }
  };

  const [syncing, setSyncing] = useState(false);
  const runSync = async () => {
    setSyncing(true);
    try { await syncNow(true); } finally { setSyncing(false); }
  };

  const shopLabel = shop?.name ?? me?.shopName ?? null;
  const email = me?.email ?? null;

  return (
    <Screen title={t("nav.settings")} subtitle={t("settings.subtitle")}>
      <View style={{ flexDirection: wide ? "row" : "column", gap: space.lg, alignItems: "stretch" }}>
        <Card style={{ flex: 1, gap: space.sm }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("settings.account")}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.primarySoft, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: c.primaryStrong, fontWeight: "800", fontSize: 16 }}>{(me?.name ?? user?.name ?? "?").slice(0, 1).toUpperCase()}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.ink, fontWeight: "700", fontSize: 16 }}>{me?.name ?? user?.name}</Text>
              <Text style={{ color: c.muted, fontSize: 12 }}>{t(`role.${user?.role}` as Key)}</Text>
            </View>
            <Badge tone="ok" label={t("common.active")} dot />
          </View>
          <View style={{ borderTopWidth: 1, borderTopColor: c.line, paddingTop: space.sm, gap: 4 }}>
            <Text style={{ color: c.muted, fontSize: 12 }}>{t("settings.email")}: <Text style={{ color: c.inkSoft, fontWeight: "600" }}>{email ?? "—"}</Text></Text>
            {user?.role !== "system_admin" ? (
              <Text style={{ color: c.muted, fontSize: 12 }}>{t("settings.shop")}: <Text style={{ color: c.inkSoft, fontWeight: "600" }}>{shopLabel ?? "—"}</Text></Text>
            ) : null}
          </View>
        </Card>

        <Card style={{ flex: 1, gap: space.md }}>
          <View style={{ gap: 2 }}>
            <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("settings.profile")}</Text>
            <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("settings.profileHelp")}</Text>
          </View>
          {nameNote ? <Banner tone={nameNote.tone} text={nameNote.text} /> : null}
          <Field testID="settings-name" label={t("settings.fullName")} value={name} onChangeText={(x) => { setNameNote(null); setName(x); }} maxLength={120} />
          <Button testID="settings-save-name" label={t("common.save")} loading={nameBusy} onPress={() => void saveName()} />
        </Card>
      </View>

      <Card style={{ gap: space.md }}>
        <View style={{ gap: 2 }}>
          <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("settings.security")}</Text>
          <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("settings.securityHelp")}</Text>
        </View>
        {pwNote ? <Banner tone={pwNote.tone} text={pwNote.text} /> : null}
        <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
          <PasswordField testID="settings-current-password" label={t("settings.currentPassword")} value={pw.current}
            onChangeText={(x) => { setPwNote(null); setPw({ ...pw, current: x }); }} autoComplete="current-password" textContentType="password" />
          <PasswordField testID="settings-new-password" label={t("settings.newPassword")} value={pw.next}
            onChangeText={(x) => { setPwNote(null); setPw({ ...pw, next: x }); }} autoComplete="new-password" textContentType="newPassword" hint={t("settings.passwordHelp")} />
          <PasswordField testID="settings-confirm-password" label={t("settings.confirmPassword")} value={pw.confirm}
            onChangeText={(x) => { setPwNote(null); setPw({ ...pw, confirm: x }); }} autoComplete="new-password" textContentType="newPassword" />
        </View>
        <Button testID="settings-save-password" label={t("settings.changePassword")} loading={pwBusy}
          disabled={!pw.current || !pw.next || !pw.confirm} onPress={() => void savePassword()} />
      </Card>

      <Card style={{ gap: space.md }}>
        <View style={{ gap: 2 }}>
          <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("settings.accountSecurity")}</Text>
          <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("settings.accountSecurityHelp")}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
          <Button testID="settings-security" kind="secondary" label={t("settings.twoFactor")} onPress={() => router.push("/security")} />
          <Button testID="settings-notifications" kind="secondary" label={t("settings.notifications")} onPress={() => router.push("/notifications")} />
        </View>
      </Card>

      {user?.role === "owner" ? (
        <Card style={{ gap: space.md }}>
          <View style={{ gap: 2 }}>
            <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("settings.shopDetails")}</Text>
            <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("settings.shopNameHelp")}</Text>
          </View>
          {shopNote ? <Banner tone={shopNote.tone} text={shopNote.text} /> : null}
          <Field testID="settings-shop-name" label={t("settings.shopName")} value={shopName} onChangeText={(x) => { setShopNote(null); setShopName(x); }} maxLength={120} />
          <Button testID="settings-save-shop" label={t("common.save")} loading={shopBusy} onPress={() => void saveShop()} />
        </Card>
      ) : null}

      {user?.role === "owner" ? (
        <Card style={{ gap: space.md }}>
          <View style={{ gap: 2 }}>
            <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("settings.shopPolicy")}</Text>
            <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("settings.shopPolicyHelp")}</Text>
          </View>
          {policyMsg ? <Banner tone={policyMsg.tone} text={policyMsg.text} /> : null}
          {policy ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                <Switch testID="policy-manager-finance" value={policy.managerFinancialAccess} onValueChange={(v) => setPolicy({ ...policy, managerFinancialAccess: v })} />
                <View style={{ flex: 1, gap: 1 }}>
                  <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{t("settings.managerFinance")}</Text>
                  <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("settings.managerFinanceHelp")}</Text>
                </View>
              </View>
              <View style={{ gap: 4 }}>
                <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{t("settings.belowCost")}</Text>
                <Segmented<"acknowledge" | "block"> label={t("settings.belowCost")} value={policy.belowCostPolicy}
                  onChange={(v) => setPolicy({ ...policy, belowCostPolicy: v })}
                  options={[{ value: "acknowledge", label: t("settings.belowCostAck") }, { value: "block", label: t("settings.belowCostBlock") }]} />
                <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>
                  {policy.belowCostPolicy === "block" ? t("settings.belowCostBlockHelp") : t("settings.belowCostAckHelp")}
                </Text>
              </View>
              <Field testID="policy-max-discount" label={t("settings.maxDiscount")} value={discountInput} keyboardType="number-pad" onChangeText={setDiscountInput} hint={t("settings.maxDiscountHelp")} />
              <Button testID="policy-save" label={t("common.save")} loading={policyBusy} onPress={() => void savePolicy()} />
            </>
          ) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("common.loading")}</Text>}
        </Card>
      ) : null}

      <View style={{ flexDirection: wide ? "row" : "column", gap: space.lg, alignItems: "stretch" }}>
        <Card style={{ flex: 1, gap: space.md }}>
          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("common.language")}</Text>
          <Segmented value={lang} onChange={set} label={t("common.language")} options={[{ value: "en", label: "English" }, { value: "rw", label: "Kinyarwanda" }]} />
          <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("settings.languageHelp")}</Text>
        </Card>

        <Card style={{ flex: 1, gap: space.md }}>
          <AppearanceSettings />
          <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("appearance.persistHelp")}</Text>
        </Card>
      </View>

      <PwaInstallCard />
      <OfflineDownloadCard />

      <Card style={{ gap: space.md }}>
        <View style={{ gap: 2 }}>
          <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("settings.device")}</Text>
          <Text style={{ color: c.muted, fontSize: 12 }}>{t("settings.storageHelp")}</Text>
        </View>
        <View style={{ gap: 4 }}>
          <Text style={{ color: c.muted, fontSize: 12 }}>{t("settings.storage")}: <Text style={{ color: c.inkSoft, fontWeight: "600" }}>{storage === "sqlite" ? t("sync.storageSqlite") : storage === "indexeddb" ? t("sync.storageIdb") : t("sync.storageLs")}</Text></Text>
          <Text style={{ color: c.muted, fontSize: 12 }}>{t("sync.pending")}: <Text style={{ color: pending ? c.accent : c.inkSoft, fontWeight: "700" }}>{pending}</Text>
            {issues ? <Text style={{ color: c.danger, fontWeight: "700" }}>{" · "}{t("sync.needsReview")}: {issues}</Text> : null}
          </Text>
          <Text style={{ color: c.muted, fontSize: 12 }}>{t("sync.lastSync")}: <Text style={{ color: c.inkSoft, fontWeight: "600" }}>{lastSync ? new Date(lastSync).toLocaleString() : t("common.never")}</Text></Text>
          <Text style={{ color: online ? c.success : c.accent, fontSize: 12, fontWeight: "600" }}>{online ? t("sync.online") : t("sync.offline")}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
          <Button testID="settings-sync" kind="secondary" label={t("sync.now")} loading={syncing || running} onPress={() => void runSync()} />
          <Button kind="quiet" label={t("nav.sync")} onPress={() => router.push("/sync")} />
        </View>
        {storage !== "sqlite" ? <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("sync.webWarning")}</Text> : null}
      </Card>

      <Card style={{ gap: space.md }}>
        <View style={{ gap: 2 }}>
          <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{t("settings.signOutTitle")}</Text>
          <Text style={{ color: c.muted, fontSize: 12 }}>{t("settings.signOutHelp")}</Text>
        </View>
        <Button testID="settings-signout" kind="secondary" label={t("common.signOut")} onPress={() => setConfirm(true)} />
        <Text style={{ color: c.muted, fontSize: 11 }}>{`v${appVersion}`}</Text>
      </Card>

      <ConfirmDialog open={confirm} title={t("settings.signOutTitle")} message={pending ? t("settings.signOutPending").replace("{n}", String(pending)) : t("settings.signOutHelp")}
        confirmLabel={t("common.signOut")} busy={busy} onCancel={() => setConfirm(false)} onConfirm={async () => {
          setBusy(true);
          try { await logout(); router.replace("/login"); } finally { setBusy(false); setConfirm(false); }
        }} />
    </Screen>
  );
}
