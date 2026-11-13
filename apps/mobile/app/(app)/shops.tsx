import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { presetRange } from "@sms/shared";
import { Badge, Banner, Button, Card, Empty, Field, Modal, Screen, Segmented, useToasts } from "../../src/components/ui";
import { useT } from "../../src/localization";
import { bindShop } from "../../src/database";
import { request, useSession } from "../../src/services/api";
import { syncNow } from "../../src/synchronization/engine";
import {
  checkoutSubscription, getCommandCentre, getMemberships, getPlans, switchShop,
  type CommandCentre, type Plan, type ShopMembership,
} from "../../src/services/business";
import { space, type, useTheme } from "../../src/theme/tokens";

type Range = "today" | "week" | "month";
const PRESET = { today: "today", week: "week", month: "month" } as const;

export default function Shops() {
  const t = useT(); const c = useTheme(); const router = useRouter();
  const user = useSession((s) => s.user)!;
  const toast = useToasts((s) => s.push);
  const [shops, setShops] = useState<ShopMembership[]>([]);
  const [centre, setCentre] = useState<CommandCentre | null>(null);
  const [range, setRange] = useState<Range>("month");
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState(""); const [location, setLocation] = useState(""); const [category, setCategory] = useState("");
  const [plans, setPlans] = useState<Plan[]>([]); const [planCode, setPlanCode] = useState("starter");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await getMemberships(); setShops(list);
      if (user.role === "owner") {
        const p = presetRange(PRESET[range], Date.now());
        setCentre(await getCommandCentre(p.from, p.to));
      }
    } catch (e: any) {
      setError(e?.status === 403 ? t("shops.pending") : t("common.error"));
    } finally { setLoading(false); }
  }, [range, t, user.role]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void getPlans().then(setPlans).catch(() => undefined); }, []);

  async function open(shop: ShopMembership) {
    if (shop.active || switching) return;
    setSwitching(shop.id); setError(null);
    try {
      const result = await switchShop(shop.id);
      await bindShop(result.shopId);
      await useSession.getState().apply({ user: { ...user, shopId: result.shopId, role: result.role } });
      toast(t("shops.switched"));
      await syncNow(true);
      router.replace("/" as any);
    } catch { setError(t("common.error")); }
    finally { setSwitching(null); }
  }

  async function create() {
    if (name.trim().length < 2) return;
    setBusy(true); setError(null);
    try {
      const shop = await request<{ id: string }>("/shop", { method: "POST", body: { name: name.trim(), location: location.trim() || undefined, category: category.trim() || undefined } });
      await checkoutSubscription(planCode, shop.id);
      setCreateOpen(false); setName(""); setLocation(""); setCategory("");
      toast(t("shops.created"));
      await load();
    } catch (e: any) {
      setError(e?.body?.message === "subscription_inactive" ? t("shops.pending") : t("common.error"));
    } finally { setBusy(false); }
  }

  async function subscribe(shop: ShopMembership) {
    setBusy(true);
    try { await checkoutSubscription(planCode, shop.id); await load(); }
    catch { setError(t("common.error")); }
    finally { setBusy(false); }
  }

  if (user.role !== "owner") {
    return <Screen title={t("shops.title")}><Banner tone="warn" text={t("offline.center.noShop")} /></Screen>;
  }

  return (
    <Screen title={t("shops.title")} subtitle={t("shops.subtitle")}
      actions={<Button testID="shops-create" label={t("shops.create")} onPress={() => setCreateOpen(true)} />}>
      {error ? <Banner tone="danger" text={error} /> : null}
      {centre ? (
        <Card style={{ gap: space.md }}>
          <Text style={{ color: c.ink, ...type.h2 }}>{t("shops.combined")}</Text>
          <Segmented<Range> label={t("shops.dateRange")} value={range} onChange={setRange} options={[
            { value: "today", label: t("shops.today") }, { value: "week", label: t("shops.week") }, { value: "month", label: t("shops.month") },
          ]} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
            <Metric label={t("shops.sales")} value={centre.totals.sales} />
            <Metric label={t("shops.expenses")} value={centre.totals.expenses} />
            <Metric label={t("shops.profit")} value={centre.totals.profit} />
            <Metric label={t("shops.credit")} value={centre.totals.outstandingCredit} />
            <Metric label={t("shops.stockAlerts")} value={centre.totals.stockAlerts} plain />
            <Metric label={t("shops.alerts")} value={centre.totals.openAlerts} plain />
          </View>
          {centre.shopsRequiringPayment ? <Banner tone="warn" text={`${centre.shopsRequiringPayment} · ${t("shops.pending")}`} /> : null}
          <Text style={{ color: c.muted, fontSize: 11 }}>{t("offline.center.measureNote")}</Text>
        </Card>
      ) : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        {shops.map((shop) => (
          <Card key={shop.id} style={{ flexGrow: 1, flexBasis: 280, gap: space.sm, borderColor: shop.active ? c.success : c.line }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Text style={{ flex: 1, color: c.ink, fontWeight: "800", fontSize: 16 }}>{shop.name}</Text>
              {shop.active ? <Badge tone="ok" dot label={t("shops.active")} /> : null}
            </View>
            <Text style={{ color: c.muted, fontSize: 12 }}>{[shop.location, shop.category].filter(Boolean).join(" · ") || "—"}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              <Badge tone={shop.subscriptionStatus === "active" ? "ok" : "warn"} label={shop.subscriptionStatus === "active" ? t("shops.active") : t("shops.pending")} />
              <Badge label={`${t("shops.plan")}: ${shop.planName ?? "—"}`} />
              <Badge label={`${t("shops.employees")}: ${shop.employeeCount}`} />
              <Badge tone={shop.openAlerts ? "warn" : "neutral"} label={`${t("shops.alerts")}: ${shop.openAlerts}`} />
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {!shop.active ? <Button size="sm" label={t("shops.switch")} loading={switching === shop.id} disabled={busy} onPress={() => void open(shop)} /> : null}
              {shop.subscriptionStatus !== "active" ? <Button size="sm" kind="secondary" label={t("shops.subscribe")} disabled={busy} onPress={() => void subscribe(shop)} /> : null}
            </View>
            {shop.subscriptionStatus !== "active" ? <Text style={{ color: c.muted, fontSize: 11 }}>{t("shops.awaiting")}</Text> : null}
          </Card>
        ))}
        {!shops.length && !loading ? <Empty title={t("shops.all")} /> : null}
      </View>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={t("shops.create")} footer={
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button kind="secondary" label={t("common.cancel")} onPress={() => setCreateOpen(false)} />
          <Button label={t("shops.create")} loading={busy} disabled={name.trim().length < 2} onPress={() => void create()} />
        </View>
      }>
        <View style={{ gap: space.md }}>
          <Field label={t("shops.name")} value={name} onChangeText={setName} />
          <Field label={t("shops.location")} value={location} onChangeText={setLocation} />
          <Field label={t("shops.category")} value={category} onChangeText={setCategory} />
          <Text style={{ color: c.ink, fontWeight: "700", fontSize: 13 }}>{t("shops.subscription")}</Text>
          <Segmented<string> label={t("shops.plan")} value={planCode} onChange={setPlanCode}
            options={plans.map((p) => ({ value: p.code, label: `${p.name} · ${p.priceRwf} RWF` }))} />
          <Text style={{ color: c.muted, fontSize: 12 }}>{t("shops.awaiting")}</Text>
        </View>
      </Modal>
    </Screen>
  );
}

function Metric({ label, value, plain }: { label: string; value: number; plain?: boolean }) {
  const c = useTheme();
  return (
    <View style={{ minWidth: 130, gap: 2 }}>
      <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{label}</Text>
      <Text style={{ color: c.ink, fontSize: 18, fontWeight: "800", fontVariant: ["tabular-nums"] }}>
        {plain ? value.toLocaleString() : `${Math.round(value).toLocaleString()} RWF`}
      </Text>
    </View>
  );
}
