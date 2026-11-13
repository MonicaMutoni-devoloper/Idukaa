import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { formatQty, formatRwf } from "@sms/shared";
import { Badge, Banner, Button, Card, DataTable, Empty, ErrorState, Field, Loading, Screen, Segmented, useToasts } from "../../src/components/ui";
import { useT, type Key } from "../../src/localization";
import { request, useSession } from "../../src/services/api";
import { decideCreditSale, getPendingCreditSales, type PendingCreditSale } from "../../src/services/business";
import { useSync } from "../../src/synchronization/engine";
import { readOfflineSnapshot, snapshotKeys } from "../../src/services/offline-data";
import { space, type, useTheme } from "../../src/theme/tokens";

type Tab = "credit" | "adjustments" | "investigations" | "conflicts" | "activity";
const statusTone = (s: string) => (s === "open" ? "danger" : s === "investigating" ? "warn" : s === "resolved" || s === "closed" ? "ok" : "neutral") as "danger" | "warn" | "ok" | "neutral";

export default function Approvals() {
  const t = useT(); const c = useTheme(); const user = useSession((s) => s.user)!; const toast = useToasts((s) => s.push);
  // A manager's adjustment/receipt can arrive while the owner is already looking at this screen.
  // The realtime nudge runs a pull, whose revision bump reloads the pending decisions in place.
  const recordsVersion = useSync((s) => s.recordsVersion);
  const businessVersion = useSync((s) => s.businessVersion);
  const [tab, setTab] = useState<Tab>("credit");
  const [credit, setCredit] = useState<PendingCreditSale[]>([]);
  const [adj, setAdj] = useState<any[]>([]); const [inv, setInv] = useState<any[]>([]); const [conf, setConf] = useState<any[]>([]); const [log, setLog] = useState<any[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null); const [failed, setFailed] = useState(false); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  interface CachedApprovals { credit?: PendingCreditSale[]; adjustments: any[]; investigations: any[]; conflicts: any[]; log: any[] }

  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    if (user.shopId) {
      const saved = await readOfflineSnapshot<CachedApprovals>(snapshotKeys.approvals(user.shopId)).catch(() => null);
      if (saved) {
        setCredit(saved.data.credit ?? []); setAdj(saved.data.adjustments); setInv(saved.data.investigations); setConf(saved.data.conflicts); setLog(saved.data.log);
        setCachedAt(saved.savedAt); setLoading(false);
      }
    }
    try {
      const [cr, a, i, cf, lg] = await Promise.all([getPendingCreditSales(), request<any[]>("/audit/adjustments/pending"), request<any[]>("/audit/investigations"), request<any[]>("/audit/conflicts"), request<any[]>("/audit/log")]);
      setCredit(cr); setAdj(a); setInv(i); setConf(cf); setLog(lg); setCachedAt(null);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }, [user.shopId]);
  useEffect(() => { if (user.role === "owner") void load(); else setLoading(false); }, [load, user.role, recordsVersion, businessVersion]);

  const noteFor = (id: string) => {
    const n = (notes[id] ?? "").trim();
    if (n.length < 3) { setErr(t("appr.reasonRequired")); return null; }
    setErr(null); return n;
  };

  async function decideCredit(id: string, approve: boolean) {
    const note = noteFor(id); if (!note) return;
    setBusy(id);
    try { await decideCreditSale(id, approve, note); toast(approve ? t("appr.approved") : t("appr.rejected")); await load(); }
    catch { setErr(t("common.error")); } finally { setBusy(null); }
  }
  async function decide(id: string, approve: boolean) {
    const note = noteFor(id); if (!note) return;
    setBusy(id);
    try { await request(`/audit/adjustments/${id}/decide`, { method: "POST", body: { approve, note } }); toast(approve ? t("appr.approved") : t("appr.rejected")); await load(); }
    catch { setErr(t("common.error")); } finally { setBusy(null); }
  }
  async function resolve(id: string) {
    const note = noteFor(id); if (!note) return;
    setBusy(id);
    try { await request(`/audit/conflicts/${id}/resolve`, { method: "POST", body: { note } }); toast(t("appr.resolved")); await load(); }
    catch { setErr(t("common.error")); } finally { setBusy(null); }
  }
  async function setStatus(id: string, status: string) {
    setBusy(id);
    try { await request(`/audit/investigations/${id}`, { method: "PATCH", body: { status } }); toast(t("appr.statusUpdated")); await load(); }
    catch { setErr(t("common.error")); } finally { setBusy(null); }
  }

  if (user.role !== "owner") return <Screen title={t("appr.title")}><Banner tone="warn" text={t("appr.ownerOnly")} /></Screen>;

  const reasonField = (id: string, placeholder: string) => (
    <Field testID={`reason-${id}`} label={t("appr.reason")} value={notes[id] ?? ""} onChangeText={(x) => setNotes((n) => ({ ...n, [id]: x }))} placeholder={placeholder} hint={t("appr.reasonHelp")} />
  );

  return (
    <Screen title={t("appr.title")} subtitle={t("appr.subtitle")}>
      <Segmented value={tab} onChange={setTab} options={[
        { value: "credit", label: `${t("appr.credit")} (${credit.length})` },
        { value: "adjustments", label: `${t("appr.adjustments")} (${adj.length})` },
        { value: "investigations", label: `${t("appr.investigations")} (${inv.filter((x) => x.status !== "closed").length})` },
        { value: "conflicts", label: `${t("appr.conflicts")} (${conf.length})` },
        { value: "activity", label: t("appr.activity") },
      ]} />
      {err ? <Banner tone="danger" text={err} /> : null}
      {cachedAt ? <Banner tone="warn" text={t("offline.cached").replace("{time}", new Date(cachedAt).toLocaleString())} /> : null}
      {loading ? <Loading /> : failed ? <ErrorState onRetry={() => void load()} /> : (
        <>
          {tab === "credit" ? (credit.length ? credit.map((sale) => (
            <Card key={sale.id} style={{ gap: space.md }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                <Text style={{ color: c.ink, ...type.h2, flexGrow: 1 }}>{sale.customer}</Text>
                <Badge tone="warn" label={t("appr.creditSale")} />
                <Text style={{ color: c.ink, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{formatRwf(sale.credit)}</Text>
              </View>
              <Text style={{ color: c.muted, fontSize: 12 }}>{new Date(sale.at).toLocaleString()} · {sale.by}</Text>
              <View style={{ gap: 3 }}>
                {sale.lines.map((line, index) => (
                  <Text key={`${line.productId}-${index}`} style={{ color: c.inkSoft, fontSize: 12 }}>
                    {line.name} · {formatQty(line.qty)} · {formatRwf(line.lineAmount)}
                  </Text>
                ))}
              </View>
              {reasonField(sale.id, t("appr.decisionNote"))}
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <Button testID={`credit-approve-${sale.id}`} label={t("appr.approve")} loading={busy === sale.id} onPress={() => void decideCredit(sale.id, true)} />
                <Button kind="dangerQuiet" label={t("appr.reject")} disabled={busy === sale.id} onPress={() => void decideCredit(sale.id, false)} />
              </View>
            </Card>
          )) : <Card tone="muted"><Empty icon="checkSquare" title={t("appr.noCredit")} description={t("appr.noCreditDesc")} /></Card>) : null}

          {tab === "adjustments" ? (adj.length ? adj.map((a) => (
            <Card key={a.id} style={{ gap: space.md }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                <Text style={{ color: c.ink, ...type.h2, flexGrow: 1 }}>{a.product_name}</Text>
                <Badge tone="warn" label={String(a.reason).replace("_", " ")} />
                <Text style={{ color: c.ink, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{Number(a.qty) > 0 ? "+" : ""}{formatQty(Number(a.qty))}</Text>
              </View>
              <Text style={{ color: c.inkSoft, fontSize: 13 }}>{a.note}</Text>
              {a.refund_amount ? <Text style={{ color: c.muted, fontSize: 12 }}>{t("appr.refund")}: {formatRwf(Number(a.refund_amount))}</Text> : null}
              {reasonField(a.id, t("appr.decisionNote"))}
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <Button testID={`approve-${a.id}`} label={t("appr.approve")} loading={busy === a.id} onPress={() => void decide(a.id, true)} />
                <Button kind="dangerQuiet" label={t("appr.reject")} disabled={busy === a.id} onPress={() => void decide(a.id, false)} />
              </View>
            </Card>
          )) : <Card tone="muted"><Empty icon="checkSquare" title={t("appr.noPending")} description={t("appr.noPendingDesc")} /></Card>) : null}

          {tab === "investigations" ? (inv.length ? inv.map((i) => (
            <Card key={i.id} style={{ gap: space.sm }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                <View style={{ flexGrow: 1 }}>
                  <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{i.reference}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{i.product_name} · {new Date(i.created_at).toLocaleDateString()}</Text>
                </View>
                <Badge tone={statusTone(i.status)} label={String(i.status).replace("_", " ")} />
                <Text style={{ color: Number(i.difference) < 0 ? c.danger : c.ink, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{Number(i.difference) > 0 ? "+" : ""}{formatQty(Number(i.difference))}</Text>
              </View>
              <Text style={{ color: c.muted, fontSize: 12 }}>{t("appr.countNote")}</Text>
              <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
                {(["investigating", "resolved", "closed"] as const).map((s) => (
                  <Button key={s} size="sm" kind={i.status === s ? "primary" : "secondary"} label={t(`appr.state.${s}` as Key)} disabled={busy === i.id || i.status === s} onPress={() => void setStatus(i.id, s)} />
                ))}
              </View>
            </Card>
          )) : <Card tone="muted"><Empty icon="search" title={t("appr.noInvestigations")} description={t("appr.noInvestigationsDesc")} /></Card>) : null}

          {tab === "conflicts" ? (conf.length ? conf.map((x) => (
            <Card key={x.op_id} tone="danger" style={{ gap: space.sm }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" }}>
                <Text style={{ color: c.ink, fontWeight: "700", flexGrow: 1 }}>{String(x.type).replace(".", " · ")}</Text>
                <Badge tone="danger" label={t("sync.conflict")} />
              </View>
              <Text style={{ color: c.inkSoft, fontSize: 13 }}>{x.message}</Text>
              <Text style={{ color: c.muted, fontSize: 11 }}>{new Date(x.received_at).toLocaleString()} · {x.device_id}</Text>
              {reasonField(x.op_id, t("appr.conflictNote"))}
              <Button kind="secondary" label={t("appr.resolve")} loading={busy === x.op_id} onPress={() => void resolve(x.op_id)} />
            </Card>
          )) : <Card tone="muted"><Empty icon="alert" title={t("appr.noConflicts")} description={t("appr.noConflictsDesc")} /></Card>) : null}

          {tab === "activity" ? (
            <DataTable rows={log} cols={[
              { key: "at", title: t("common.date"), width: 1.4, render: (r) => <Text style={{ color: c.inkSoft, fontSize: 12 }}>{new Date(r.at).toLocaleString()}</Text> },
              { key: "action", title: t("appr.event"), width: 1.6 },
              { key: "actor", title: t("appr.actor"), width: 1.2 },
              { key: "entity", title: t("appr.entity"), width: 1 },
            ]} empty={<Empty icon="chart" title={t("appr.noActivity")} description={t("appr.noActivityDesc")} />} />
          ) : null}
        </>
      )}
    </Screen>
  );
}
