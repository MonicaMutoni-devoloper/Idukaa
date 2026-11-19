import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { categoriesForRole, type AlertAction, type ResolutionCategory as AlertResolutionCategory } from "@sms/shared";
import { Badge, Banner, Button, Card, Empty, Field, KeyValue, Modal, Screen, Segmented, Skeleton, useToasts } from "../../src/components/ui";
import { DayField } from "../../src/components/date-range-picker";
import { useT, type Key } from "../../src/localization";
import {
  detectAlerts, getAlertStaff, getAlertSettings, saveAlertSettings,
  type Alert, type AlertDetail, type AlertFilters, type AlertStaff, type AlertStatusGroup, type AlertSummary,
} from "../../src/services/business";
import { loadAlertCached, loadAlertsCached, actOnAlertQueued, type AlertSource } from "../../src/services/alert-cache";
import { useSession } from "../../src/services/api";
import { useSync } from "../../src/synchronization/engine";
import { radius, space, type, useTheme } from "../../src/theme/tokens";

type StatusFilter = "all" | AlertStatusGroup;
/** An alert with this device's queued decisions applied (the outbox is the only pending state). */
type Row = Alert & { pending: boolean; pendingCount: number; conflicted: boolean };
type Selected = AlertDetail & { pending: boolean; pendingCount: number; conflicted: boolean };

const LEVEL_TONE = (s: string) => (s === "critical" ? "danger" : s === "high" ? "warn" : s === "medium" ? "info" : "neutral");
const STATUS_TONE = (s: string) =>
  s === "open" ? "warn" : s === "investigating" ? "info" : s === "action_required" ? "warn" : s === "escalated" ? "danger" : "ok";
const CATEGORY_KEY: Record<string, Key> = {
  discount: "alerts.catDiscount", stock_reduction: "alerts.catStock", margin: "alerts.catMargin",
  adjustments: "alerts.catAdjustments", expense: "alerts.catExpense", credit_risk: "alerts.catCredit",
  reversed_sale: "alerts.catReversed", cash: "alerts.catCash",
};
const RESOLUTION_KEY: Record<AlertResolutionCategory, Key> = {
  approved_activity: "alerts.resApproved", human_error: "alerts.resHuman",
  suspicious_activity: "alerts.resSuspicious", false_positive: "alerts.resFalse", other: "alerts.resOther",
};
const EVENT_KEY: Record<string, Key> = {
  detected: "alerts.event.detected", investigate: "alerts.event.investigate", assign: "alerts.event.assign",
  note: "alerts.event.note", escalate: "alerts.event.escalate", escalated: "alerts.event.escalate",
  resolve: "alerts.event.resolve", resolved: "alerts.event.resolve", reopen: "alerts.event.reopen",
  reopened: "alerts.event.reopened", correction_completed: "alerts.event.correction_completed",
  correction_rejected: "alerts.event.correction_rejected",
};
const THRESHOLD_KEYS = [
  "discountPercentMin", "repeatedDiscountCount", "adjustmentCountMin", "expenseMultiple",
  "stockMultiple", "creditUsedPercent", "voidedSalesMin", "lookbackDays",
] as const;

export default function Alerts() {
  const t = useT(); const c = useTheme(); const router = useRouter(); const toast = useToasts((s) => s.push);
  const user = useSession((s) => s.user)!;
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<AlertSummary | null>(null);
  const [source, setSource] = useState<AlertSource>("server");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);
  // A sync verdict, a reconnect or a new queued decision changes what the overlay should show.
  const recordsVersion = useSync((s) => s.recordsVersion);
  const online = useSync((s) => s.online);
  const [staff, setStaff] = useState<AlertStaff[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusFilter>("open");
  const [severity, setSeverity] = useState<string>("");
  const [category, setCategory] = useState<string>("");
  const [employee, setEmployee] = useState<string>("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [opening, setOpening] = useState(false);
  const [action, setAction] = useState<AlertAction>("investigate");
  const [note, setNote] = useState("");
  const [resolutionCategory, setResolutionCategory] = useState<AlertResolutionCategory | null>(null);
  const [correctiveAction, setCorrectiveAction] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [escalateTo, setEscalateTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [thresholds, setThresholds] = useState<Record<string, string>>({});

  const filters: AlertFilters = useMemo(() => ({
    status: status === "all" ? undefined : status,
    severity: severity || undefined, category: category || undefined, employee: employee || undefined,
    search: search.trim() || undefined, from: from || undefined, to: to || undefined,
  }), [status, severity, category, employee, search, from, to]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await loadAlertsCached(filters);
      setRows(r.alerts); setSummary(r.summary);
      setSource(r.source); setSavedAt(r.savedAt);
      setPendingCount(r.pending); setConflictCount(r.conflicts);
    } catch (e: any) {
      setError(e?.status === 403 ? t("alerts.forbidden") : t("common.error"));
    } finally { setLoading(false); }
  }, [filters, t]);
  useEffect(() => { void load(); }, [load, recordsVersion, online]);
  useEffect(() => { void getAlertStaff().then(setStaff).catch(() => setStaff([])); }, []);
  useEffect(() => {
    if (user.role !== "owner") return;
    void getAlertSettings().then((s) => setThresholds(Object.fromEntries(Object.entries(s.thresholds).map(([k, v]) => [k, String(v)]))))
      .catch(() => undefined);
  }, [user.role]);

  async function detect() {
    setDetecting(true); setError(null);
    try {
      const r = await detectAlerts();
      toast(t("alerts.detected").replace("{created}", String(r.created)).replace("{updated}", String(r.updated)));
      if (!r.sufficientHistory) setError(t("alerts.insufficient"));
      await load();
    } catch { setError(t("common.error")); }
    finally { setDetecting(false); }
  }

  async function open(alert: Alert) {
    setOpening(true); setError(null);
    try {
      const d = await loadAlertCached(alert.id);
      setSelected(d.alert); setNote(""); setCorrectiveAction(""); setResolutionCategory(null);
      setAssignee(d.alert.assignedTo ?? null); setEscalateTo(d.alert.escalatedTo ?? null);
      const first = (Object.keys(d.alert.actions) as AlertAction[]).find((a) => d.alert.actions[a]);
      setAction(first ?? "note");
    } catch { setError(t("common.error")); }
    finally { setOpening(false); }
  }

  async function submit() {
    if (!selected || note.trim().length < 3) return;
    if (action === "resolve" && !resolutionCategory) return;
    setBusy(true);
    try {
      // Durable on this device first; the expected version means a decision made elsewhere wins.
      await actOnAlertQueued(selected.id, {
        action, note: note.trim(),
        category: action === "resolve" ? resolutionCategory : undefined,
        correctiveAction: action === "resolve" ? (correctiveAction.trim() || null) : undefined,
        assignedTo: action === "assign" ? assignee : undefined,
        escalateTo: action === "escalate" ? escalateTo : undefined,
        expectedUpdatedAt: selected.updatedAt ?? null,
      });
      const fresh = await loadAlertCached(selected.id).catch(() => null);
      if (fresh) setSelected(fresh.alert);
      setNote(""); setCorrectiveAction(""); setResolutionCategory(null);
      toast(t("alerts.queued"));
      await load();
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "");
      setError(msg.includes("forbidden") ? t("alerts.forbidden") : t("common.error"));
    } finally { setBusy(false); }
  }

  async function saveThresholds() {
    const numeric: Record<string, number> = {};
    for (const k of THRESHOLD_KEYS) {
      const v = Number(thresholds[k]);
      if (Number.isFinite(v) && v >= 0) numeric[k] = v;
    }
    try {
      const r = await saveAlertSettings(numeric);
      setThresholds(Object.fromEntries(Object.entries(r.thresholds).map(([k, v]) => [k, String(v)])));
      setSettingsOpen(false); toast(t("alerts.saved"));
    } catch { setError(t("common.error")); }
  }

  const categories: AlertResolutionCategory[] = selected
    ? [...categoriesForRole(user.role as "owner" | "manager")]
    : [];
  const actionOptions = selected
    ? ([
        selected.actions.investigate ? { value: "investigate" as AlertAction, label: t("alerts.investigate") } : null,
        selected.actions.assign ? { value: "assign" as AlertAction, label: t("alerts.assign") } : null,
        { value: "note" as AlertAction, label: t("alerts.addNote") },
        selected.actions.escalate ? { value: "escalate" as AlertAction, label: t("alerts.escalate") } : null,
        selected.actions.resolve ? { value: "resolve" as AlertAction, label: t("alerts.resolve") } : null,
        selected.actions.reopen ? { value: "reopen" as AlertAction, label: t("alerts.reopen") } : null,
      ].filter(Boolean) as { value: AlertAction; label: string }[])
    : [];

  return (
    <Screen title={t("alerts.title")} subtitle={t("alerts.subtitle")}
      actions={<View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
        {user.role === "owner" ? <Button testID="alerts-settings" size="sm" kind="secondary" label={t("alerts.settings")} onPress={() => setSettingsOpen(true)} /> : null}
        <Button testID="alerts-detect" label={t("alerts.detect")} loading={detecting} onPress={() => void detect()} />
      </View>}>
      {error ? <Banner tone={error === t("alerts.insufficient") ? "warn" : "danger"} text={error} /> : null}
      {source === "cache" ? (
        <Banner tone="warn" text={`${t("alerts.offline")}${savedAt ? ` · ${t("alerts.cachedAt").replace("{when}", new Date(savedAt).toLocaleString())}` : ""}`} />
      ) : null}
      {pendingCount > 0 ? <Banner tone="warn" text={t("alerts.pendingBanner").replace("{count}", String(pendingCount))} /> : null}
      {conflictCount > 0 ? <Banner tone="danger" text={t("alerts.conflictBanner").replace("{count}", String(conflictCount))} /> : null}

      {summary ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {([
            ["alerts.total", summary.total, "neutral"],
            ["alerts.open", summary.open, "warn"],
            ["alerts.investigating", summary.investigating, "info"],
            ["alerts.escalated", summary.escalated, "danger"],
            ["alerts.resolved", summary.resolved, "ok"],
          ] as [Key, number, "neutral" | "warn" | "info" | "danger" | "ok"][]).map(([label, value, tone]) => (
            <Card key={label} style={{ flexGrow: 1, flexBasis: 130, gap: 2, padding: space.md }}>
              <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t(label)}</Text>
              <Text style={{ color: c.ink, fontSize: 22, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{value}</Text>
              <Badge tone={tone} label={label === "alerts.total" ? t("alerts.all") : t(label)} />
            </Card>
          ))}
        </View>
      ) : null}

      <Card style={{ gap: space.sm }}>
        <Segmented<StatusFilter> label={t("alerts.status")} value={status} onChange={setStatus} options={[
          { value: "all", label: t("alerts.all") }, { value: "open", label: t("alerts.open") },
          { value: "investigating", label: t("alerts.investigating") },
          { value: "action_required", label: t("alerts.actionRequired") },
          { value: "escalated", label: t("alerts.escalated") }, { value: "resolved", label: t("alerts.resolved") },
        ]} />
        <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
          <Field testID="alerts-search" containerStyle={{ flexBasis: 220, flexGrow: 1 }} label={t("common.search")} value={search}
            placeholder={t("alerts.searchPlaceholder")} onChangeText={setSearch} autoCorrect={false} />
          <DayField containerStyle={{ flexBasis: 140 }} label={t("alerts.from")} value={from} onChangeText={setFrom} />
          <DayField containerStyle={{ flexBasis: 140 }} label={t("alerts.to")} value={to} onChangeText={setTo} />
        </View>
        <Segmented<string> label={t("alerts.severity")} value={severity} onChange={setSeverity} options={[
          { value: "", label: t("alerts.all") }, { value: "critical", label: t("alerts.critical") },
          { value: "high", label: t("alerts.high") }, { value: "medium", label: t("alerts.medium") },
          { value: "low", label: t("alerts.low") },
        ]} />
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          <Pressable testID="alerts-category-all" accessibilityRole="button" onPress={() => setCategory("")}
            style={({ pressed }: any) => chipStyle(c, category === "", pressed)}>
            <Text style={chipText(c, category === "")}>{t("alerts.all")}</Text>
          </Pressable>
          {Object.keys(CATEGORY_KEY).map((k) => (
            <Pressable key={k} testID={`alerts-category-${k}`} accessibilityRole="button" onPress={() => setCategory(category === k ? "" : k)}
              style={({ pressed }: any) => chipStyle(c, category === k, pressed)}>
              <Text style={chipText(c, category === k)}>{t(CATEGORY_KEY[k]!)}</Text>
            </Pressable>
          ))}
        </View>
        {staff.length > 1 ? (
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            <Pressable accessibilityRole="button" onPress={() => setEmployee("")} style={({ pressed }: any) => chipStyle(c, employee === "", pressed)}>
              <Text style={chipText(c, employee === "")}>{t("alerts.anyEmployee")}</Text>
            </Pressable>
            {staff.map((s) => (
              <Pressable key={s.id} accessibilityRole="button" onPress={() => setEmployee(employee === s.id ? "" : s.id)}
                style={({ pressed }: any) => chipStyle(c, employee === s.id, pressed)}>
                <Text style={chipText(c, employee === s.id)}>{s.name}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </Card>

      {loading && !rows.length ? <Skeleton height={90} /> : null}
      <View style={{ gap: space.sm }}>
        {rows.map((alert) => (
          <Card key={alert.id} style={{ gap: space.sm }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" }}>
              <Badge tone={LEVEL_TONE(alert.severityLevel)} dot label={t(`alerts.${alert.severityLevel}` as Key)} />
              <Text style={{ flex: 1, minWidth: 140, color: c.ink, fontWeight: "800", fontSize: 15 }}>{alert.title}</Text>
              <Badge tone={STATUS_TONE(alert.statusGroup)} label={t(`alerts.${alert.statusGroup}` as Key)} />
              {alert.pending ? <Badge tone="info" label={t("alerts.pendingTag")} /> : null}
              {alert.conflicted ? <Badge tone="danger" label={t("alerts.conflictTag")} /> : null}
            </View>
            <Text style={{ color: c.inkSoft, fontSize: 13, lineHeight: 19 }}>{alert.explanation}</Text>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm, flexWrap: "wrap", alignItems: "center" }}>
              <Text style={{ color: c.muted, fontSize: 11 }}>
                {t(CATEGORY_KEY[alert.category] ?? "alerts.category")} · {new Date(alert.lastSeenAt).toLocaleString()}
                {alert.assignedToName ? ` · ${t("alerts.assignedTo")}: ${alert.assignedToName}` : ""}
              </Text>
              <Button testID={`alert-details-${alert.id}`} size="sm" kind="secondary" label={t("common.details")} loading={opening} onPress={() => void open(alert)} />
            </View>
          </Card>
        ))}
        {!rows.length && !loading ? <Empty title={t("alerts.none")} description={t("alerts.noneOpen")} /> : null}
      </View>

      {/* Details: what was detected, the records behind it, the investigation so far, and the actions. */}
      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.title ?? ""} width={760} scroll
        footer={<>
          {selected?.entityType === "sale" && selected.entityId && (user.role === "owner" || user.role === "manager") ? (
            <Button testID="alert-correct" kind="secondary" label={t("corr.action")} onPress={() => {
              const saleId = selected.entityId!; const alertId = selected.id;
              setSelected(null);
              router.push(`/corrections?saleId=${encodeURIComponent(saleId)}&alertId=${encodeURIComponent(alertId)}` as any);
            }} />
          ) : null}
          <Button kind="secondary" label={t("common.close")} onPress={() => setSelected(null)} />
        </>}>
        {selected ? (
          <View style={{ gap: space.md }}>
            {selected.conflicted ? <Banner tone="danger" text={t("alerts.conflictBanner").replace("{count}", String(1))} /> : null}
            {selected.pending ? <Banner tone="warn" text={t("alerts.pendingBanner").replace("{count}", String(selected.pendingCount))} /> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" }}>
              <Badge tone={LEVEL_TONE(selected.severityLevel)} label={t(`alerts.${selected.severityLevel}` as Key)} />
              <Badge label={t(CATEGORY_KEY[selected.category] ?? "alerts.category")} />
              <Badge tone={STATUS_TONE(selected.statusGroup)} label={t(`alerts.${selected.statusGroup}` as Key)} />
              {selected.resolvedByName ? <Text style={{ color: c.muted, fontSize: 11 }}>{t("alerts.resolvedBy")}: {selected.resolvedByName}</Text> : null}
            </View>
            <Text style={{ color: c.inkSoft, fontSize: 13, lineHeight: 20 }}>{selected.explanation}</Text>

            <View style={{ gap: 2 }}>
              <KeyValue label={t("alerts.detectedAt")} value={new Date(selected.firstSeenAt).toLocaleString()} />
              <KeyValue label={t("alerts.lastSeen")} value={new Date(selected.lastSeenAt).toLocaleString()} />
              <KeyValue label={t("alerts.relatedTransaction")} value={selected.entityId ? `${selected.entityType ?? ""} ${selected.entityId.slice(0, 8)}…` : "—"} />
              <KeyValue label={t("alerts.assignedTo")} value={selected.assignedToName ?? t("alerts.unassigned")} />
            </View>

            {selected.supporting.fields.length ? (
              <View style={{ gap: 2 }}>
                <Text style={{ color: c.ink, fontWeight: "700" }}>{t("alerts.supporting")}</Text>
                {selected.supporting.fields.map((f, i) => <KeyValue key={`${f.label}-${i}`} label={f.label} value={String(f.value ?? "—")} />)}
                {selected.supporting.related.map((r) => (
                  <Text key={`${r.label}-${r.id}`} style={{ color: c.muted, fontSize: 11 }}>
                    {r.label}: {r.id.slice(0, 8)}…{r.at ? ` · ${new Date(r.at).toLocaleString()}` : ""}
                  </Text>
                ))}
              </View>
            ) : null}

            {selected.notes ? (
              <Card tone="muted" style={{ gap: 2, padding: space.md }}>
                <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("alerts.investigationNotes")}</Text>
                <Text style={{ color: c.inkSoft, fontSize: 12, lineHeight: 18 }}>{selected.notes}</Text>
              </Card>
            ) : null}

            {selected.resolution.category ? (
              <Card tone="muted" style={{ gap: 2, padding: space.md }}>
                <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("alerts.resolution")}</Text>
                <KeyValue label={t("alerts.resolutionCategory")} value={t((RESOLUTION_KEY[selected.resolution.category] ?? "alerts.resOther") as Key)} />
                {selected.resolution.note ? <KeyValue label={t("alerts.note")} value={selected.resolution.note} /> : null}
                {selected.resolution.correctiveAction ? <KeyValue label={t("alerts.correctiveAction")} value={selected.resolution.correctiveAction} /> : null}
                {selected.resolution.escalatedToName ? <KeyValue label={t("alerts.escalatedTo")} value={selected.resolution.escalatedToName} /> : null}
                {selected.resolvedAt ? <KeyValue label={t("alerts.resolvedAt")} value={new Date(selected.resolvedAt).toLocaleString()} /> : null}
              </Card>
            ) : null}

            <View style={{ gap: space.sm, borderTopWidth: 1, borderTopColor: c.line, paddingTop: space.md }}>
              <Text style={{ color: c.ink, fontWeight: "700" }}>{t("alerts.action")}</Text>
              <Segmented<AlertAction> label={t("alerts.action")} value={action} onChange={setAction} options={actionOptions} />
              {action === "assign" ? (
                <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                  {staff.map((s) => (
                    <Pressable key={s.id} accessibilityRole="button" onPress={() => setAssignee(s.id)}
                      style={({ pressed }: any) => chipStyle(c, assignee === s.id, pressed)}>
                      <Text style={chipText(c, assignee === s.id)}>{s.name}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              {action === "escalate" ? (
                <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                  {staff.filter((s) => s.role === "owner").map((s) => (
                    <Pressable key={s.id} accessibilityRole="button" onPress={() => setEscalateTo(escalateTo === s.id ? null : s.id)}
                      style={({ pressed }: any) => chipStyle(c, escalateTo === s.id, pressed)}>
                      <Text style={chipText(c, escalateTo === s.id)}>{s.name}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              {action === "resolve" ? (
                <>
                  <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                    {categories.map((cat) => (
                      <Pressable key={cat} testID={`alert-resolution-${cat}`} accessibilityRole="button" onPress={() => setResolutionCategory(cat)}
                        style={({ pressed }: any) => chipStyle(c, resolutionCategory === cat, pressed)}>
                        <Text style={chipText(c, resolutionCategory === cat)}>{t((RESOLUTION_KEY[cat] ?? "alerts.resOther") as Key)}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Field label={t("alerts.correctiveAction")} value={correctiveAction} onChangeText={setCorrectiveAction}
                    hint={t("alerts.correctiveHint")} multiline />
                </>
              ) : null}
              <Field testID="alert-note" label={action === "reopen" ? t("alerts.reason") : t("alerts.note")} value={note} onChangeText={setNote}
                hint={t("alerts.noteHint")} multiline />
              <Button testID="alert-submit" label={t("common.save")} loading={busy}
                disabled={note.trim().length < 3 || (action === "resolve" && !resolutionCategory) || (action === "assign" && !assignee) || selected.pending}
                onPress={() => void submit()} />
            </View>

            <View style={{ gap: 6 }}>
              <Text style={{ color: c.ink, fontWeight: "700" }}>{t("alerts.timeline")}</Text>
              {selected.events.length ? selected.events.map((e) => (
                <View key={e.id} style={{ borderTopWidth: 1, borderTopColor: c.line, paddingVertical: 6, gap: 2 }}>
                  <Text style={{ color: c.ink, fontSize: 12, fontWeight: "700" }}>
                    {EVENT_KEY[e.action] ? t(EVENT_KEY[e.action]!) : e.action}
                    {e.previous_status || e.new_status ? ` · ${e.previous_status ?? "—"} → ${e.new_status ?? "—"}` : ""}
                  </Text>
                  <Text style={{ color: c.muted, fontSize: 11 }}>{new Date(e.at).toLocaleString()} · {e.actor ?? "—"}</Text>
                  {e.note ? <Text style={{ color: c.inkSoft, fontSize: 12, lineHeight: 17 }}>{e.note}</Text> : null}
                </View>
              )) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("alerts.noHistory")}</Text>}
            </View>
          </View>
        ) : null}
      </Modal>

      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title={t("alerts.settings")} width={560} scroll
        footer={<>
          <Button kind="secondary" label={t("common.cancel")} onPress={() => setSettingsOpen(false)} />
          <Button label={t("common.save")} onPress={() => void saveThresholds()} />
        </>}>
        <View style={{ gap: space.sm }}>
          <Text style={{ color: c.muted, fontSize: 12 }}>{t("alerts.thresholdsHint")}</Text>
          {THRESHOLD_KEYS.map((k) => (
            <Field key={k} testID={`alert-threshold-${k}`} label={t(`alerts.th.${k}`)} value={thresholds[k] ?? ""} keyboardType="number-pad"
              onChangeText={(x) => setThresholds((p) => ({ ...p, [k]: x }))} />
          ))}
        </View>
      </Modal>
    </Screen>
  );
}

function chipStyle(c: any, active: boolean, pressed: boolean) {
  return {
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: radius.sm, borderWidth: 1,
    borderColor: active ? c.primary : c.line, backgroundColor: active ? c.primarySoft : pressed ? c.pressed : c.surface,
  };
}
function chipText(c: any, active: boolean) {
  return { color: active ? c.primaryStrong : c.inkSoft, fontSize: 12, fontWeight: "600" as const };
}
