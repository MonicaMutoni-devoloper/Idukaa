import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { formatRwf } from "@sms/shared";
import { Badge, Banner, Button, Card, Empty, Field, Loading, Screen, useToasts } from "../../../src/components/ui";
import { useT } from "../../../src/localization";
import { getPendingSubscriptions, verifySubscription, type PendingSubscription } from "../../../src/services/business";
import { space, type, useTheme } from "../../../src/theme/tokens";

/** System-admin activation desk. No frontend payment claim can activate a shop from here. */
export default function AdminSubscriptions() {
  const t = useT(); const c = useTheme(); const toast = useToasts((s) => s.push);
  const [rows, setRows] = useState<PendingSubscription[]>([]);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await getPendingSubscriptions()); }
    catch { setError(t("common.error")); }
    finally { setLoading(false); }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  async function verify(row: PendingSubscription) {
    setBusy(row.id); setError(null);
    try {
      await verifySubscription(row.id, refs[row.id]?.trim() || undefined);
      toast(t("admin.subActivated"));
      await load();
    } catch { setError(t("common.error")); }
    finally { setBusy(null); }
  }

  return (
    <Screen title={t("admin.subscriptions")} subtitle={t("admin.subscriptionsDesc")}
      actions={<Button kind="secondary" label={t("admin.refresh")} onPress={() => void load()} />}>
      {error ? <Banner tone="danger" text={error} /> : null}
      {loading ? <Loading /> : rows.length ? (
        <View style={{ gap: space.md }}>
          {rows.map((row) => (
            <Card key={row.id} style={{ gap: space.sm }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                <Text style={{ flex: 1, minWidth: 140, color: c.ink, fontWeight: "800", fontSize: 15 }}>{row.shopName}</Text>
                <Badge tone="warn" label={row.status.replace("_", " ")} />
              </View>
              <Text style={{ color: c.muted, fontSize: 12 }}>
                {row.planName} · {formatRwf(row.priceRwf)} · {row.durationDays} {t("admin.subDays")}
              </Text>
              <Text style={{ color: c.muted, fontSize: 11 }}>
                {t("admin.subRequested")}: {new Date(row.createdAt).toLocaleString()}
              </Text>
              <Field label={t("admin.subReference")} value={refs[row.id] ?? ""} onChangeText={(v) => setRefs((r) => ({ ...r, [row.id]: v }))}
                placeholder={t("admin.subReferenceHint")} />
              <Button testID={`verify-${row.id}`} label={t("admin.subVerify")} loading={busy === row.id} onPress={() => void verify(row)} />
            </Card>
          ))}
        </View>
      ) : <Empty title={t("admin.subEmpty")} description={t("admin.subEmptyDesc")} />}
    </Screen>
  );
}
