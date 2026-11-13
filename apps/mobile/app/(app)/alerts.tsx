import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Badge, Banner, Button, Card, Empty, Field, Modal, Screen, Segmented, useToasts } from "../../src/components/ui";
import { useT } from "../../src/localization";
import { getAlert, getAlerts, detectAlerts, changeAlertStatus, type Alert } from "../../src/services/business";
import { space, type, useTheme } from "../../src/theme/tokens";

type Filter = "open" | "investigating" | "resolved" | "legitimate" | "all";
const TONE = (s: Alert["severity"]) => s === "critical" ? "danger" : s === "warning" ? "warn" : "neutral";

export default function Alerts() {
  const t = useT(); const c = useTheme(); const toast = useToasts((s) => s.push);
  const [rows, setRows] = useState<Alert[]>([]);
  const [filter, setFilter] = useState<Filter>("open");
  const [selected, setSelected] = useState<Alert | null>(null);
  const [note, setNote] = useState("");
  const [action, setAction] = useState<"investigating" | "resolved" | "legitimate">("investigating");
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await getAlerts(filter === "all" ? undefined : filter)); }
    catch (e: any) { setError(e?.status === 403 ? t("shops.pending") : t("common.error")); }
  }, [filter, t]);
  useEffect(() => { void load(); }, [load]);

  async function detect() {
    setDetecting(true); setError(null);
    try {
      const result = await detectAlerts();
      toast(t("alerts.detected").replace("{created}", String(result.created)).replace("{updated}", String(result.updated)));
      if (!result.sufficientHistory) setError(t("alerts.insufficient"));
      await load();
    } catch { setError(t("common.error")); }
    finally { setDetecting(false); }
  }

  async function open(alert: Alert) {
    setSelected(alert); setNote(""); setAction("investigating");
    try { setSelected(await getAlert(alert.id)); } catch { /* keep the list row */ }
  }

  async function applyStatus() {
    if (!selected || note.trim().length < 3) return;
    setBusy(true);
    try {
      const updated = await changeAlertStatus(selected.id, action, note.trim());
      setSelected({ ...selected, ...updated }); setNote(""); toast(t("common.saved")); await load();
    } catch { setError(t("common.error")); }
    finally { setBusy(false); }
  }

  return (
    <Screen title={t("alerts.title")} subtitle={t("alerts.subtitle")}
      actions={<Button testID="alerts-detect" label={t("alerts.detect")} loading={detecting} onPress={() => void detect()} />}>
      {error ? <Banner tone={error === t("alerts.insufficient") ? "warn" : "danger"} text={error} /> : null}
      <Segmented<Filter> label={t("alerts.severity")} value={filter} onChange={setFilter} options={[
        { value: "open", label: t("alerts.open") }, { value: "investigating", label: t("alerts.investigating") },
        { value: "resolved", label: t("alerts.resolved") }, { value: "legitimate", label: t("alerts.legitimate") },
        { value: "all", label: t("shops.all") },
      ]} />
      <View style={{ gap: space.sm }}>
        {rows.map((alert) => (
          <Card key={alert.id} style={{ gap: space.sm }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" }}>
              <Badge tone={TONE(alert.severity)} dot label={t(`alerts.${alert.severity}` as any)} />
              <Text style={{ flex: 1, minWidth: 140, color: c.ink, fontWeight: "800", fontSize: 15 }}>{alert.title}</Text>
              <Badge tone={alert.status === "open" ? "warn" : alert.status === "investigating" ? "info" : "ok"}
                label={t(`alerts.${alert.status}` as any)} />
            </View>
            <Text style={{ color: c.inkSoft, fontSize: 13, lineHeight: 19 }}>{alert.explanation}</Text>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
              <Text style={{ color: c.muted, fontSize: 11 }}>{new Date(alert.lastSeenAt).toLocaleString()}</Text>
              <Button size="sm" kind="secondary" label={t("common.details")} onPress={() => void open(alert)} />
            </View>
          </Card>
        ))}
        {!rows.length ? <Empty title={t("alerts.none")} description={t("alerts.history")} /> : null}
      </View>

      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.title ?? ""} scroll
        footer={<Button kind="secondary" label={t("common.close")} onPress={() => setSelected(null)} />}>
        {selected ? (
          <View style={{ gap: space.md }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              <Badge tone={TONE(selected.severity)} label={t(`alerts.${selected.severity}` as any)} />
              <Badge label={selected.category} />
              <Badge label={t(`alerts.${selected.status}` as any)} />
            </View>
            <Text style={{ color: c.inkSoft, fontSize: 13, lineHeight: 20 }}>{selected.explanation}</Text>
            <View style={{ gap: 4 }}>
              <Text style={{ color: c.ink, fontWeight: "700" }}>{t("alerts.evidence")}</Text>
              {Object.entries(selected.evidence ?? {}).map(([key, value]) => (
                <View key={key} style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md, borderTopWidth: 1, borderTopColor: c.line, paddingVertical: 5 }}>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{key}</Text>
                  <Text style={{ color: c.ink, fontSize: 12, fontWeight: "600", flexShrink: 1, textAlign: "right" }}>{String(value)}</Text>
                </View>
              ))}
            </View>
            {selected.events?.length ? (
              <View style={{ gap: 4 }}>
                <Text style={{ color: c.ink, fontWeight: "700" }}>{t("alerts.history")}</Text>
                {selected.events.map((e) => <Text key={e.id} style={{ color: c.muted, fontSize: 12 }}>{new Date(e.at).toLocaleString()} · {e.action} · {e.actor ?? "—"} · {e.note ?? ""}</Text>)}
              </View>
            ) : null}
            {selected.status !== "resolved" && selected.status !== "legitimate" ? (
              <View style={{ gap: space.sm, borderTopWidth: 1, borderTopColor: c.line, paddingTop: space.md }}>
                <Segmented<typeof action> label={t("alerts.note")} value={action} onChange={setAction} options={[
                  { value: "investigating", label: t("alerts.investigate") },
                  { value: "resolved", label: t("alerts.resolve") },
                  { value: "legitimate", label: t("alerts.legitimateAction") },
                ]} />
                <Field label={t("alerts.note")} value={note} onChangeText={setNote} multiline />
                <Button label={t("common.save")} loading={busy} disabled={note.trim().length < 3} onPress={() => void applyStatus()} />
              </View>
            ) : null}
            <Text style={{ color: c.muted, fontSize: 11 }}>{t("alerts.history")}</Text>
          </View>
        ) : null}
      </Modal>
    </Screen>
  );
}
