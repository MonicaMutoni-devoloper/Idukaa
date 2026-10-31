import { useCallback, useEffect, useState } from "react";
import { Redirect } from "expo-router";
import { Text, View } from "react-native";
import { Badge, Banner, Button, Card, Empty, ErrorState, Field, Loading, Modal, Screen, useToasts } from "../../../src/components/ui";
import { useT } from "../../../src/localization";
import { request, useSession } from "../../../src/services/api";
import { space, type, useTheme } from "../../../src/theme/tokens";

interface Application {
  id: string; contact_name: string; email: string; phone: string; shop_name: string;
  location: string; category: string; note: string; status: string;
  info_message: string | null; decision_reason: string | null;
  submitted_at: string; reviewed_at: string | null;
}

/**
 * Administrator review of owner applications. Every decision is POSTed to the existing
 * `/admin/applications/:id` endpoints — role enforcement and state validation live on the server,
 * so this screen can only ever ask for a decision, never grant one.
 */
export default function AdminApplications() {
  const t = useT(); const c = useTheme(); const user = useSession((s) => s.user)!;
  const toast = useToasts((s) => s.push);
  const [rows, setRows] = useState<Application[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Application | null>(null);
  const [reason, setReason] = useState("");
  const [reasonErr, setReasonErr] = useState<string | null>(null);
  const [requesting, setRequesting] = useState<Application | null>(null);
  const [infoMsg, setInfoMsg] = useState("");
  const [infoErr, setInfoErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    request<Application[]>("/admin/applications").then(setRows).catch(() => setFailed(true));
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (user.role !== "system_admin") return <Redirect href="/" />;

  const decidable = (s: string) => s === "PENDING_REVIEW" || s === "ADDITIONAL_INFORMATION_REQUIRED";
  const statusBadge = (s: string) =>
    s === "PENDING_REVIEW" ? <Badge tone="warn" dot label={t("admin.stPending")} />
    : s === "APPROVED" ? <Badge tone="ok" label={t("admin.stApproved")} />
    : s === "REJECTED" ? <Badge tone="danger" label={t("admin.stRejected")} />
    : <Badge tone="info" label={t("admin.stInfo")} />;

  async function decide(a: Application, approve: boolean) {
    setBusy(a.id);
    try {
      await request(`/admin/applications/${a.id}/${approve ? "approve" : "reject"}`, {
        method: "POST", body: approve ? {} : { reason: reason.trim() },
      });
      toast(approve ? t("admin.appApproved") : t("admin.appRejected"), approve ? "ok" : "warn");
      setRejecting(null); setReason(""); setReasonErr(null);
      load();
    } catch {
      toast(t("common.error"), "danger");
    } finally { setBusy(null); }
  }

  /** Third transition of the same workflow: ask the applicant something and return the file to review. */
  async function requestInfo(a: Application) {
    if (infoMsg.trim().length < 3) { setInfoErr(t("admin.requestInfoRequired")); return; }
    setBusy(a.id);
    try {
      await request(`/admin/applications/${a.id}/request-info`, { method: "POST", body: { message: infoMsg.trim() } });
      toast(t("admin.appInfoSent"), "ok");
      setRequesting(null); setInfoMsg(""); setInfoErr(null);
      load();
    } catch {
      toast(t("common.error"), "danger");
    } finally { setBusy(null); }
  }

  const row = (label: string, value: string) => (
    <View key={label} style={{ flexDirection: "row", gap: space.md }}>
      <Text style={{ color: c.muted, fontSize: 12, width: 90 }}>{label}</Text>
      <Text style={{ color: c.inkSoft, fontSize: 12, flex: 1 }}>{value}</Text>
    </View>
  );

  return (
    <Screen title={t("admin.applications")} subtitle={t("admin.applicationsDesc")}
      actions={<Button kind="secondary" label={t("admin.refresh")} onPress={load} />}>
      {failed ? <ErrorState onRetry={load} /> : !rows ? <Loading /> : !rows.length ? (
        <Card tone="muted"><Empty icon="users" title={t("admin.appEmpty")} description={t("admin.appEmptyDesc")} /></Card>
      ) : rows.map((a) => (
        <View key={a.id} testID={`app-card-${a.id}`} style={{ gap: space.sm }}>
        <Card style={{ gap: space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
            <Text style={{ color: c.ink, ...type.h2, flexGrow: 1 }}>{a.shop_name}</Text>
            {statusBadge(a.status)}
          </View>
          <Text style={{ color: c.inkSoft, fontSize: 13, fontWeight: "600" }}>{a.contact_name}</Text>
          {row(t("admin.appEmail"), a.email)}
          {row(t("admin.appPhone"), a.phone)}
          {a.location ? row(t("admin.appLocation"), a.location) : null}
          {a.category ? row(t("admin.appCategory"), a.category) : null}
          {row(t("admin.appSubmitted"), new Date(a.submitted_at).toLocaleString())}
          {a.note ? <Text style={{ color: c.muted, fontSize: 12 }}>{a.note}</Text> : null}
          {a.status === "REJECTED" && a.decision_reason ? <Banner tone="danger" text={a.decision_reason} /> : null}
          {a.status === "ADDITIONAL_INFORMATION_REQUIRED" && a.info_message ? <Banner tone="warn" text={a.info_message} /> : null}
          {decidable(a.status) ? (
            <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap", marginTop: space.xs }}>
              <Button testID={`app-approve-${a.id}`} label={t("admin.approve")} loading={busy === a.id}
                disabled={busy === a.id} onPress={() => void decide(a, true)} />
              <Button testID={`app-request-${a.id}`} kind="secondary" label={t("admin.requestInfo")}
                disabled={busy === a.id}
                onPress={() => { setRequesting(a); setInfoMsg(a.info_message ?? ""); setInfoErr(null); }} />
              <Button testID={`app-reject-${a.id}`} kind="dangerQuiet" label={t("admin.reject")}
                disabled={busy === a.id} onPress={() => { setRejecting(a); setReason(""); setReasonErr(null); }} />
            </View>
          ) : null}
        </Card>
        </View>
      ))}

      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title={t("admin.rejectTitle")}
        description={t("admin.rejectHelp")}
        footer={<>
          <Button kind="secondary" label={t("common.cancel")} onPress={() => setRejecting(null)} disabled={busy === rejecting?.id} />
          <Button kind="danger" testID="app-reject-confirm" label={t("admin.reject")} loading={busy === rejecting?.id}
            onPress={() => {
              if (reason.trim().length < 3) { setReasonErr(t("admin.rejectReasonRequired")); return; }
              if (rejecting) void decide(rejecting, false);
            }} />
        </>}>
        <Field testID="app-reason" required label={t("admin.rejectLabel")} value={reason} error={reasonErr}
          onChangeText={(v) => { setReasonErr(null); setReason(v); }} placeholder={t("admin.rejectLabel")} />
      </Modal>

      <Modal open={!!requesting} onClose={() => setRequesting(null)} title={t("admin.requestInfoTitle")}
        description={t("admin.requestInfoHelp")}
        footer={<>
          <Button kind="secondary" label={t("common.cancel")} onPress={() => setRequesting(null)} disabled={busy === requesting?.id} />
          <Button kind="primary" testID="app-info-confirm" label={t("admin.requestInfo")} loading={busy === requesting?.id}
            onPress={() => {
              if (infoMsg.trim().length < 3) { setInfoErr(t("admin.requestInfoRequired")); return; }
              if (requesting) void requestInfo(requesting);
            }} />
        </>}>
        <Field testID="app-info-message" required label={t("admin.requestInfoLabel")} value={infoMsg} error={infoErr}
          onChangeText={(v) => { setInfoErr(null); setInfoMsg(v); }}
          placeholder={t("admin.requestInfoPlaceholder")} hint={t("admin.requestInfoHint")} multiline />
      </Modal>
    </Screen>
  );
}
