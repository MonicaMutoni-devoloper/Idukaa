import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { formatQty, formatRwf, lineAmount } from "@sms/shared";
import {
  Badge, Banner, Button, Card, ConfirmDialog, Empty, Field, KeyValue, Loading, Modal,
  Screen, Segmented, useToasts,
} from "../../src/components/ui";
import { useT, type Key } from "../../src/localization";
import { listProducts, type LocalProduct } from "../../src/database";
import {
  approveCorrection, discardQueuedCorrection, loadCorrection, loadCorrectionSale, loadCorrections,
  queueCorrectionRequest, rejectCorrection, requestCorrectionInfo, settleCorrectionRefund,
  type Correction, type CorrectionDetail, type CorrectionLine, type CorrectionSaleContext,
} from "../../src/services/corrections";
import { useSession } from "../../src/services/api";
import { useSync } from "../../src/synchronization/engine";
import { radius, space, type, useTheme } from "../../src/theme/tokens";

type EditLine = {
  key: string;
  productId: string;
  name: string;
  unit: string;
  sellingUnit: string;
  factor: number;
  qtyText: string;
  priceText: string;
};

const STATUS_TONE = (s: string) =>
  s === "completed" ? "ok" : s === "rejected" || s === "sync_error" ? "danger" : s === "pending_sync" ? "info" : "warn";
const short = (id: string | null | undefined) => id ? `${id.slice(0, 8)}…` : "—";
const money = (n: number) => formatRwf(Math.max(0, Math.round(n || 0)));
const qtyText = (n: number) => formatQty(Math.max(0, Math.round(n || 0)));
const int = (v: string) => {
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** Translate the API's 403 reason instead of calling every refusal "not the owner". */
function refusalKey(e: any): Key {
  const code = String(e?.body?.message ?? e?.body?.error ?? "");
  if (code === "subscription_inactive") return "corr.subscriptionInactive";
  if (code === "shop_suspended") return "corr.shopSuspended";
  if (code === "shop_access_denied" || code === "shop_membership_missing") return "corr.shopAccessDenied";
  if (code === "role_not_allowed") return "corr.ownerOnly";
  if (e?.status === 403) return "corr.ownerOnly";
  if (e?.status === 404) return "corr.notFound";
  return "common.error";
}

/** Turn the outbox's stored refusal into a sentence the requester can act on. */
function syncProblem(code: string | null | undefined, t: (key: Key) => string): string {
  const value = String(code ?? "").trim();
  const known: Record<string, Key> = {
    network: "corr.syncNetwork",
    sale_not_found: "corr.syncSaleMissing",
    sale_not_posted: "corr.syncNotPosted",
    sale_already_reversed: "corr.syncSaleReversed",
    sale_is_corrected_sale: "corr.syncIsCorrected",
    sale_already_corrected: "corr.syncAlreadyCorrected",
    correction_pending: "corr.syncCorrectionPending",
    duplicate_value: "corr.syncAlreadyCorrected",
    sale_has_returns: "corr.syncHasReturns",
    role_not_allowed: "corr.syncRole",
  };
  if (known[value]) return t(known[value]);
  if (value.includes("schema_out_of_date")) return t("corr.syncSchema");
  if (value.startsWith("server_5")) return t("corr.syncServer");
  if (value.startsWith("server_4")) return t("corr.syncServer");
  if (value.startsWith("invalid_operation")) return t("corr.syncInvalid");
  return value ? `${t("corr.syncRejected")} ${value}` : t("corr.syncUnknown");
}

export default function Corrections() {
  const t = useT(); const c = useTheme(); const toast = useToasts((s) => s.push);
  const router = useRouter();
  const user = useSession((s) => s.user)!;
  const online = useSync((s) => s.online);
  const recordsVersion = useSync((s) => s.recordsVersion);
  const params = useLocalSearchParams<{ saleId?: string; alertId?: string }>();

  const [rows, setRows] = useState<Correction[]>([]);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<"server" | "cache">("server");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CorrectionDetail | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [context, setContext] = useState<CorrectionSaleContext | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [products, setProducts] = useState<LocalProduct[]>([]);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [fulfillment, setFulfillment] = useState<"not_handed_over" | "handed_over">("not_handed_over");
  const [lines, setLines] = useState<EditLine[]>([]);
  const [discountText, setDiscountText] = useState("0");
  const [paidText, setPaidText] = useState("0");
  const [alertId, setAlertId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [productSearch, setProductSearch] = useState("");

  const [decisionOpen, setDecisionOpen] = useState<"approve" | "reject" | "info" | "refund" | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [syncActionBusy, setSyncActionBusy] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const openedParam = useRef<string | null>(null);

  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await loadCorrections();
      setRows(r.corrections); setSource(r.source); setSavedAt(r.savedAt);
    } catch (e: any) {
      setError(t(refusalKey(e)));
    } finally { setLoading(false); }
  }, [t]);
  useEffect(() => { void load(); }, [load, recordsVersion, online]);

  const loadProducts = useCallback(async () => {
    try { setProducts(await listProducts("")); } catch { setProducts([]); }
  }, []);

  const openForm = useCallback(async (saleId: string, linkedAlert?: string | null) => {
    setFormOpen(true); setFormLoading(true); setFormError(null); setAlertId(linkedAlert ?? null);
    try {
      const [ctx, prods] = await Promise.all([loadCorrectionSale(saleId), listProducts("")]);
      setProducts(prods);
      setContext(ctx.context);
      setFulfillment(ctx.context.eligibility.fulfillmentDefault);
      setReason(""); setEvidence(""); setDiscountText(String(ctx.context.sale.discount));
      setPaidText(String(ctx.context.sale.amountPaid));
      const map = new Map(prods.map((p) => [p.id, p]));
      setLines(ctx.context.lines.map((l) => editFromLine(l, map)));
      if (ctx.source === "cache") setError(t("corr.offlineSale"));
    } catch {
      setFormError(t("corr.loadFailed"));
    } finally { setFormLoading(false); }
  }, [t]);

  useEffect(() => {
    if (!params.saleId || openedParam.current === params.saleId) return;
    openedParam.current = params.saleId;
    void loadProducts();
    void openForm(params.saleId, params.alertId ?? null);
  }, [params.saleId, params.alertId, loadProducts, openForm]);

  const openDetail = async (id: string) => {
    setDetailId(id); setSelected(null); setDetailLoading(true); setError(null);
    try {
      const r = await loadCorrection(id);
      setSelected(r.correction);
    } catch (e: any) {
      // A local-only request has no server row yet. Keep its detail open so the stored refusal is
      // visible instead of replacing it with a misleading "not found on the server" banner.
      const queued = rows.find((x) => x.id === id && (x.pendingSync || x.displayStatus === "sync_error"));
      if (queued) setSelected({ ...queued, events: [], correctedSale: null } as CorrectionDetail);
      else setError(t(refusalKey(e)));
    } finally { setDetailLoading(false); }
  };

  const closeDetail = () => { setDetailId(null); setSelected(null); setDecisionOpen(null); setDecisionNote(""); setRefundAmount(""); setDiscardOpen(false); };

  const discardLocal = async (id: string) => {
    setSyncActionBusy(true); setError(null);
    try {
      await discardQueuedCorrection(id);
      toast(t("corr.discarded"));
      closeDetail();
      await load();
    } catch { setError(t("common.error")); } finally { setSyncActionBusy(false); }
  };

  const gross = lines.reduce((s, l) => s + lineAmount(inputSellingQty(l), int(l.priceText)), 0);
  const discount = int(discountText);
  const net = Math.max(0, gross - discount);
  const paid = int(paidText);
  const refund = Math.max(0, paid - net);
  const additional = Math.max(0, net - paid);
  const physicalMismatch = fulfillment === "handed_over" && context ? !samePhysical(context.lines, lines) : false;
  const canSubmit = !!context?.eligibility.canRequest && reason.trim().length >= 3 && lines.length > 0
    && lines.every((l) => !!l.productId && inputSellingQty(l) > 0 && int(l.priceText) >= 0)
    && discount >= 0 && discount <= gross && paid >= 0 && !physicalMismatch && !submitting;

  const submit = async () => {
    if (!canSubmit || !context) return;
    setSubmitting(true); setFormError(null);
    try {
      await queueCorrectionRequest({
        saleId: context.sale.id,
        reason: reason.trim(),
        evidence: evidence.trim() || undefined,
        fulfillment,
        discount,
        amountPaid: paid,
        alertId,
        lines: lines.map((l) => ({
          productId: l.productId,
          qty: baseQty(l),
          sellingQty: inputSellingQty(l),
          unitPrice: int(l.priceText),
        })),
      }, context);
      toast(t("corr.submitted"));
      setFormOpen(false); setContext(null); setReason(""); setEvidence(""); setLines([]);
      await load();
    } catch (e: any) {
      setFormError(e?.body?.message ? String(e.body.message) : t("common.error"));
    } finally { setSubmitting(false); }
  };

  const decide = async () => {
    if (!selected || !decisionOpen) return;
    setDecisionBusy(true); setError(null);
    try {
      let next: CorrectionDetail;
      if (decisionOpen === "approve") next = await approveCorrection(selected.id, decisionNote.trim() || undefined);
      else if (decisionOpen === "reject") next = await rejectCorrection(selected.id, decisionNote.trim());
      else if (decisionOpen === "info") next = await requestCorrectionInfo(selected.id, decisionNote.trim());
      else next = await settleCorrectionRefund(selected.id, int(refundAmount), decisionNote.trim());
      setSelected(next);
      setDecisionOpen(null); setDecisionNote(""); setRefundAmount("");
      toast(t(decisionOpen === "approve" ? "corr.approved" : decisionOpen === "reject" ? "corr.rejected" : decisionOpen === "info" ? "corr.infoSent" : "corr.refundSaved"));
      await load();
    } catch (e: any) {
      setError(e?.status === 403 || e?.status === 404 ? t(refusalKey(e)) : e?.body?.message ? String(e.body.message) : t("common.error"));
    } finally { setDecisionBusy(false); }
  };

  const selectedDisplay = selected?.displayStatus ?? selected?.status ?? "pending_approval";
  // The server knows the active shop membership; a cached session role may predate a promotion.
  const canDecide = selected?.canDecide ?? user.role === "owner";

  return (
    <Screen title={t("corr.title")} subtitle={t("corr.subtitle")} actions={
      formOpen ? <Button testID="corr-cancel-form" kind="secondary" label={t("corr.back")} onPress={() => { setFormOpen(false); setContext(null); }} /> : null
    }>
      {error ? <Banner tone="warn" text={error} /> : null}
      {source === "cache" ? (
        <Banner tone="warn" text={`${t("corr.cached")}${savedAt ? ` · ${new Date(savedAt).toLocaleString()}` : ""}`} />
      ) : null}
      {!online ? <Banner tone="warn" text={t("corr.offlineApproval")} /> : null}

      {formOpen ? (
        <View style={{ gap: space.md }}>
          {formLoading ? <Loading /> : formError ? <Banner tone="danger" text={formError} /> : context ? (
            <>
              <Card style={{ gap: space.sm }}>
                <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap", alignItems: "center" }}>
                  <Badge tone="neutral" label={`${t("corr.originalSale")} · ${short(context.sale.id)}`} />
                  {alertId ? <Badge tone="warn" label={t("corr.alertLink")} /> : null}
                </View>
                <Text style={{ color: c.ink, fontWeight: "800", fontSize: 16 }}>{money(context.sale.net)}</Text>
                <Text style={{ color: c.muted, fontSize: 12 }}>
                  {new Date(context.sale.at).toLocaleString()} · {t("corr.cashier")}: {context.sale.cashier}
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
                  <KeyValue label={t("corr.gross")} value={money(context.sale.gross)} />
                  <KeyValue label={t("corr.discount")} value={money(context.sale.discount)} />
                  <KeyValue label={t("corr.paid")} value={money(context.sale.amountPaid)} />
                </View>
                {!context.eligibility.canRequest ? (
                  <Banner tone="danger" text={context.eligibility.reason ? t(`corr.blocked.${context.eligibility.reason}` as Key) : t("corr.blocked")} />
                ) : null}
              </Card>

              <Card style={{ gap: space.md }}>
                <Field testID="corr-reason" label={t("corr.reason")} value={reason} onChangeText={setReason}
                  hint={t("corr.reasonHint")} multiline required />
                <Field testID="corr-evidence" label={t("corr.evidence")} value={evidence} onChangeText={setEvidence}
                  hint={t("corr.evidenceHint")} multiline />
                <Segmented<"not_handed_over" | "handed_over"> label={t("corr.fulfillment")} value={fulfillment}
                  onChange={(v) => { setFulfillment(v); }}
                  options={[
                    { value: "not_handed_over", label: t("corr.notHanded") },
                    { value: "handed_over", label: t("corr.handed") },
                  ]} />
                <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>
                  {fulfillment === "handed_over" ? t("corr.fulfillmentHelp") : t("corr.fulfillmentImpact.restock")}
                </Text>
              </Card>

              <Card style={{ gap: space.sm }}>
                <Text style={{ color: c.ink, fontWeight: "700" }}>{t("corr.proposedLines")}</Text>
                {lines.map((l, index) => (
                  <View key={l.key} style={{ gap: space.sm, paddingVertical: space.sm, borderTopWidth: index ? 1 : 0, borderTopColor: c.line }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                      <Pressable testID={`corr-product-${index}`} accessibilityRole="button" onPress={() => { setPickerFor(l.key); setProductSearch(""); }}
                        style={({ pressed }: any) => ({ flex: 1, paddingVertical: 9, paddingHorizontal: space.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: c.lineStrong, backgroundColor: pressed ? c.surfaceMuted : c.surface })}>
                        <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{l.name || t("corr.selectProduct")}</Text>
                        <Text style={{ color: c.muted, fontSize: 11 }}>{l.unit} · {l.sellingUnit}</Text>
                      </Pressable>
                      {lines.length > 1 ? <Button size="sm" kind="dangerQuiet" label={t("corr.removeLine")} onPress={() => setLines((x) => x.filter((y) => y.key !== l.key))} /> : null}
                    </View>
                    <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
                      <Field testID={`corr-qty-${index}`} containerStyle={{ flexBasis: 110 }} label={`${t("corr.qty")} (${l.sellingUnit})`}
                        value={l.qtyText} onChangeText={(x) => setLines((prev) => prev.map((y) => y.key === l.key ? { ...y, qtyText: x } : y))} keyboardType="decimal-pad" />
                      <Field testID={`corr-price-${index}`} containerStyle={{ flexBasis: 130 }} label={`${t("corr.price")} (RWF/${l.sellingUnit})`}
                        value={l.priceText} onChangeText={(x) => setLines((prev) => prev.map((y) => y.key === l.key ? { ...y, priceText: x } : y))} keyboardType="number-pad" />
                      <View style={{ justifyContent: "flex-end", paddingBottom: 11 }}>
                        <Text style={{ color: c.muted, fontSize: 11 }}>{t("corr.lineTotal")}</Text>
                        <Text style={{ color: c.ink, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{money(lineAmount(inputSellingQty(l), int(l.priceText)))}</Text>
                      </View>
                    </View>
                  </View>
                ))}
                <Button testID="corr-add-line" size="sm" kind="secondary" label={t("corr.addLine")} onPress={() => {
                  const p = products[0];
                  setLines((prev) => [...prev, p ? newEditLine(p) : { key: `l-${Date.now()}`, productId: "", name: "", unit: "", sellingUnit: "unit", factor: 1, qtyText: "1", priceText: "0" }]);
                }} />
              </Card>

              <Card style={{ gap: space.md }}>
                <Field testID="corr-discount" label={t("corr.discount")} value={discountText} onChangeText={setDiscountText} keyboardType="number-pad" />
                <View style={{ gap: 2 }}>
                  <KeyValue label={t("corr.paid")} value={money(paid)} />
                  <Text style={{ color: c.muted, fontSize: 12 }}>{t("corr.collectedFixed")}</Text>
                </View>
                <View style={{ gap: 2 }}>
                  <KeyValue label={t("corr.gross")} value={money(gross)} />
                  <KeyValue label={t("corr.discount")} value={money(discount)} />
                  <KeyValue strong label={t("corr.net")} value={money(net)} />
                  <KeyValue label={t("corr.paid")} value={money(paid)} />
                  {refund > 0 ? <KeyValue strong label={t("corr.refundDue")} value={money(refund)} /> : null}
                  {additional > 0 ? <KeyValue strong label={t("corr.additionalDue")} value={money(additional)} /> : null}
                  {refund === 0 && additional === 0 ? <KeyValue label={t("corr.noDifference")} value={money(0)} /> : null}
                </View>
                <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>
                  {fulfillment === "handed_over" ? t("corr.fulfillmentImpact.noRestock") : t("corr.fulfillmentImpact.restock")}
                </Text>
                {physicalMismatch ? <Banner tone="danger" text={t("corr.noProductChange")} /> : null}
                {!online ? <Banner tone="warn" text={t("corr.queuedHelp")} /> : null}
                <Button testID="corr-submit" label={t("corr.submit")} disabled={!canSubmit} loading={submitting} onPress={() => void submit()} />
              </Card>
            </>
          ) : null}
        </View>
      ) : null}

      <Card style={{ gap: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Text style={{ color: c.ink, ...type.h2, flex: 1 }}>{t("corr.list")}</Text>
          {loading ? <Loading label={t("common.loading")} /> : null}
        </View>
        {!loading && !rows.length ? <Empty title={t("corr.empty")} description={t("corr.emptyDesc")} /> : null}
        {rows.map((r) => {
          const display = r.displayStatus ?? r.status;
          return (
            <Pressable key={r.id} testID={`corr-row-${r.id}`} accessibilityRole="button" onPress={() => void openDetail(r.id)}
              style={({ pressed }: any) => ({ gap: 6, padding: space.md, borderRadius: radius.sm, borderWidth: 1, borderColor: c.line, backgroundColor: pressed ? c.surfaceMuted : c.bgAlt })}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                <Badge tone={STATUS_TONE(display) as any} label={t(`corr.status.${display}` as Key)} />
                <Text style={{ color: c.ink, fontWeight: "700", flex: 1, minWidth: 130 }}>{short(r.saleId)}</Text>
                <Text style={{ color: c.muted, fontSize: 11 }}>{r.requestedAt ? new Date(r.requestedAt).toLocaleString() : ""}</Text>
              </View>
              <Text numberOfLines={2} style={{ color: c.inkSoft, fontSize: 13 }}>{r.reason}</Text>
              <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
                <Text style={{ color: c.muted, fontSize: 11 }}>{t("corr.original")}: {money(r.original.net)}</Text>
                <Text style={{ color: c.ink, fontSize: 11, fontWeight: "600" }}>{t("corr.proposed")}: {money(r.proposed.net)}</Text>
                {r.expectedRefund > 0 ? <Text style={{ color: c.danger, fontSize: 11 }}>{t("corr.refundDue")} {money(r.expectedRefund)}</Text> : null}
                {r.expectedAdditional > 0 ? <Text style={{ color: c.accent, fontSize: 11 }}>{t("corr.additionalDue")} {money(r.expectedAdditional)}</Text> : null}
                {r.displayStatus === "pending_sync" ? <Text style={{ color: c.info, fontSize: 11 }}>{t("corr.pendingSync")}</Text> : null}
              </View>
              {r.displayStatus === "sync_error" ? (
                <Text numberOfLines={2} style={{ color: c.danger, fontSize: 11 }}>{syncProblem(r.syncError, t)}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </Card>

      {/* Product picker: the catalogue already on this device, so it works offline. */}
      <Modal open={!!pickerFor} onClose={() => setPickerFor(null)} title={t("corr.selectProduct")} scroll>
        <Field label={t("common.search")} value={productSearch} onChangeText={setProductSearch} autoCorrect={false} />
        <View style={{ gap: 4 }}>
          {products.filter((p) => `${p.name} ${p.code}`.toLowerCase().includes(productSearch.toLowerCase())).slice(0, 80).map((p) => (
            <Pressable key={p.id} accessibilityRole="button" onPress={() => {
              setLines((prev) => prev.map((l) => l.key === pickerFor ? { ...editFromProduct(p), key: l.key, qtyText: l.qtyText, priceText: l.priceText } : l));
              setPickerFor(null);
            }} style={({ pressed }: any) => ({ paddingVertical: 10, paddingHorizontal: space.sm, borderBottomWidth: 1, borderBottomColor: c.line, backgroundColor: pressed ? c.surfaceMuted : "transparent" })}>
              <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{p.name}</Text>
              <Text style={{ color: c.muted, fontSize: 11 }}>{p.code} · {p.selling_unit ?? p.unit} · {money(p.selling_price)}</Text>
            </Pressable>
          ))}
          {!products.length ? <Text style={{ color: c.muted, fontSize: 12 }}>{t("corr.noProducts")}</Text> : null}
        </View>
      </Modal>

      {/* Request detail / owner review. */}
      <Modal open={!!detailId} onClose={closeDetail} title={t("corr.review")} width={720} scroll
        footer={<Button kind="secondary" label={t("corr.close")} onPress={closeDetail} />}>
        {detailLoading ? <Loading /> : selected ? (
          <View style={{ gap: space.md }}>
            {selected.pendingSync ? <Banner tone="warn" text={t("corr.queuedHelp")} /> : null}
            {selected.syncError ? <Banner tone="danger" text={syncProblem(selected.syncError, t)} /> : null}
            {selected.displayStatus === "sync_error" ? (
              <Button testID="corr-discard-local" size="sm" kind="dangerQuiet" label={t("corr.discardLocal")}
                disabled={syncActionBusy} onPress={() => setDiscardOpen(true)} />
            ) : null}
            {selected.alertId ? <Badge tone="warn" label={t("corr.alertLink")} /> : null}
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <Badge tone={STATUS_TONE(selectedDisplay) as any} label={t(`corr.status.${selectedDisplay}` as Key)} />
              <Text style={{ color: c.muted, fontSize: 11 }}>{selected.requestedByName ?? "—"} · {selected.requestedAt ? new Date(selected.requestedAt).toLocaleString() : ""}</Text>
            </View>
            <Card tone="muted" style={{ padding: space.md, gap: 4 }}>
              <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("corr.reason")}</Text>
              <Text style={{ color: c.inkSoft, fontSize: 13, lineHeight: 19 }}>{selected.reason}</Text>
              {selected.evidence ? <Text style={{ color: c.muted, fontSize: 12 }}>{selected.evidence}</Text> : null}
            </Card>

            <Text style={{ color: c.ink, fontWeight: "700" }}>{t("corr.compare")}</Text>
            <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: radius.sm, overflow: "hidden" }}>
              {[
                [t("corr.gross"), selected.original.gross, selected.proposed.gross],
                [t("corr.discount"), selected.original.discount, selected.proposed.discount],
                [t("corr.net"), selected.original.net, selected.proposed.net],
                [t("corr.paid"), selected.original.collected, selected.proposed.collected],
              ].map(([label, before, after], i) => (
                <View key={String(label)} style={{ flexDirection: "row", paddingVertical: 8, paddingHorizontal: space.sm, gap: space.sm, borderTopWidth: i ? 1 : 0, borderTopColor: c.line, backgroundColor: i % 2 ? c.bgAlt : c.surface }}>
                  <Text style={{ flex: 1.2, color: c.muted, fontSize: 12 }}>{label}</Text>
                  <Text style={{ flex: 1, color: c.inkSoft, textAlign: "right", fontSize: 12, fontVariant: ["tabular-nums"] }}>{money(Number(before))}</Text>
                  <Text style={{ flex: 1, color: c.ink, textAlign: "right", fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{money(Number(after))}</Text>
                </View>
              ))}
            </View>

            <View style={{ gap: 2 }}>
              <KeyValue label={t("corr.stockImpact")} value={selected.fulfillment === "handed_over" ? t("corr.fulfillmentImpact.noRestock") : t("corr.fulfillmentImpact.restock")} />
              <KeyValue label={t("corr.expectedRefund")} value={money(selected.expectedRefund)} />
              <KeyValue label={t("corr.expectedAdditional")} value={money(selected.expectedAdditional)} />
              {selected.expectedRefund > 0 ? <KeyValue strong label={t("corr.remainingRefund")} value={money(selected.expectedRefund - selected.amountRefunded)} /> : null}
              {selected.moneyStatus === "refund_due" ? <Banner tone="warn" text={t("corr.refundDueStatus")} /> : null}
              {selected.moneyStatus === "balance_due" ? <Text style={{ color: c.muted, fontSize: 12 }}>{t("corr.balanceDueStatus")}</Text> : null}
            </View>

            <View style={{ gap: 5 }}>
              <Text style={{ color: c.ink, fontWeight: "700" }}>{t("corr.originalLines")}</Text>
              {selected.original.lines.map((l, i) => <Line key={`o-${l.productId}-${i}`} l={l} c={c} />)}
              <Text style={{ color: c.ink, fontWeight: "700", marginTop: 4 }}>{t("corr.proposedLines")}</Text>
              {selected.proposed.lines.map((l, i) => <Line key={`p-${l.productId}-${i}`} l={l} c={c} proposed />)}
            </View>

            {selected.correctedSaleId || selected.reversalId ? (
              <View style={{ gap: 2 }}>
                {selected.reversalId ? <KeyValue label={t("corr.reversal")} value={short(selected.reversalId)} /> : null}
                {selected.correctedSaleId ? <KeyValue label={t("corr.correctedSale")} value={short(selected.correctedSaleId)} /> : null}
              </View>
            ) : null}

            {canDecide && !selected.pendingSync && selected.displayStatus !== "sync_error" ? (
              <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap", borderTopWidth: 1, borderTopColor: c.line, paddingTop: space.md }}>
                {selected.actions.approve ? <Button testID="corr-approve" label={t("corr.approve")} disabled={!online} onPress={() => { setDecisionNote(""); setDecisionOpen("approve"); }} /> : null}
                {selected.actions.reject ? <Button testID="corr-reject" kind="dangerQuiet" label={t("corr.reject")} disabled={!online} onPress={() => { setDecisionNote(""); setDecisionOpen("reject"); }} /> : null}
                {selected.actions.requestInfo ? <Button testID="corr-info" kind="secondary" label={t("corr.requestInfo")} disabled={!online} onPress={() => { setDecisionNote(""); setDecisionOpen("info"); }} /> : null}
                {selected.actions.settleRefund ? <Button testID="corr-refund" kind="secondary" label={t("corr.settleRefund")} disabled={!online} onPress={() => { setRefundAmount(""); setDecisionNote(""); setDecisionOpen("refund"); }} /> : null}
              </View>
            ) : null}
            {!canDecide && !selected.pendingSync && selected.displayStatus !== "sync_error" ? <Text style={{ color: c.muted, fontSize: 12 }}>{t("corr.ownerOnly")}</Text> : null}

            <View style={{ gap: 5 }}>
              <Text style={{ color: c.ink, fontWeight: "700" }}>{t("corr.timeline")}</Text>
              {selected.events.length ? selected.events.map((e) => (
                <View key={e.id} style={{ borderTopWidth: 1, borderTopColor: c.line, paddingVertical: 6, gap: 2 }}>
                  <Text style={{ color: c.ink, fontSize: 12, fontWeight: "700" }}>{e.action.replace(/_/g, " ")}</Text>
                  <Text style={{ color: c.muted, fontSize: 11 }}>{new Date(e.at).toLocaleString()} · {e.actor ?? "—"}</Text>
                  {e.note ? <Text style={{ color: c.inkSoft, fontSize: 12, lineHeight: 17 }}>{e.note}</Text> : null}
                </View>
              )) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("corr.noHistory")}</Text>}
              {selectedDisplay === "pending_approval" ? <Text style={{ color: c.accent, fontSize: 12, fontWeight: "600", paddingTop: 6 }}>{t("corr.nextApproval")}</Text> : null}
              {selectedDisplay === "reconciliation_required" ? <Text style={{ color: c.accent, fontSize: 12, fontWeight: "600", paddingTop: 6 }}>{t("corr.nextRefund")}</Text> : null}
              {selectedDisplay === "rejected" ? <Text style={{ color: c.danger, fontSize: 12, fontWeight: "600", paddingTop: 6 }}>{t("corr.stopped")}</Text> : null}
            </View>
          </View>
        ) : <Banner tone="danger" text={t("common.error")} />}
      </Modal>

      <ConfirmDialog open={decisionOpen === "approve"} title={t("corr.approveTitle")} message={t("corr.approveHelp")}
        confirmLabel={t("corr.approve")} busy={decisionBusy} disabled={!online}
        onCancel={() => setDecisionOpen(null)} onConfirm={() => void decide()}>
        <Field testID="corr-approve-note" label={t("corr.approvalNote")} value={decisionNote} onChangeText={setDecisionNote} hint={t("corr.noteOptional")} />
      </ConfirmDialog>

      <ConfirmDialog open={decisionOpen === "reject"} title={t("corr.reject")} message={t("corr.rejectReason")}
        confirmLabel={t("corr.reject")} tone="danger" busy={decisionBusy} disabled={!online || decisionNote.trim().length < 3}
        onCancel={() => setDecisionOpen(null)} onConfirm={() => void decide()}>
        <Field testID="corr-reject-note" label={t("corr.rejectReason")} value={decisionNote} onChangeText={setDecisionNote} required />
      </ConfirmDialog>

      <Modal open={decisionOpen === "info"} onClose={() => setDecisionOpen(null)} title={t("corr.requestInfo")}
        footer={<>
          <Button kind="secondary" label={t("common.cancel")} onPress={() => setDecisionOpen(null)} />
          <Button label={t("corr.requestInfo")} loading={decisionBusy} disabled={!online || decisionNote.trim().length < 3} onPress={() => void decide()} />
        </>}>
        <Field testID="corr-info-note" label={t("corr.infoRequest")} value={decisionNote} onChangeText={setDecisionNote} multiline required />
      </Modal>

      <ConfirmDialog open={discardOpen} title={t("corr.discardTitle")} message={t("corr.discardHelp")}
        confirmLabel={t("corr.discardLocal")} tone="danger" busy={syncActionBusy}
        onCancel={() => setDiscardOpen(false)} onConfirm={() => selected ? void discardLocal(selected.id) : undefined} />

      <Modal open={decisionOpen === "refund"} onClose={() => setDecisionOpen(null)} title={t("corr.settleRefund")}
        footer={<>
          <Button kind="secondary" label={t("common.cancel")} onPress={() => setDecisionOpen(null)} />
          <Button label={t("corr.settleRefund")} loading={decisionBusy}
            disabled={!online || int(refundAmount) <= 0 || decisionNote.trim().length < 3}
            onPress={() => void decide()} />
        </>}>
        <Field testID="corr-refund-amount" label={t("corr.refundAmount")} value={refundAmount} onChangeText={setRefundAmount} keyboardType="number-pad" />
        <Field testID="corr-refund-note" label={t("corr.refundNote")} value={decisionNote} onChangeText={setDecisionNote} multiline required />
      </Modal>
    </Screen>
  );
}

function Line({ l, c, proposed }: { l: CorrectionLine; c: any; proposed?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: space.sm, paddingVertical: 5, borderTopWidth: 1, borderTopColor: c.line }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.ink, fontSize: 12, fontWeight: "600" }}>{l.name ?? l.productId.slice(0, 8)}</Text>
        <Text style={{ color: c.muted, fontSize: 11 }}>{l.code ?? ""} · {formatRwf(l.unitPrice)} / {l.sellingUnit ?? l.unit ?? "unit"}</Text>
      </View>
      <Text style={{ color: c.inkSoft, fontSize: 12, fontVariant: ["tabular-nums"] }}>{qtyText(l.sellingQty ?? l.qtyEntered ?? l.qty)}</Text>
      <Text style={{ color: c.ink, fontSize: 12, fontWeight: proposed ? "700" : "500", fontVariant: ["tabular-nums"], minWidth: 70, textAlign: "right" }}>{formatRwf(l.lineAmount)}</Text>
    </View>
  );
}

function editFromLine(l: CorrectionLine, products: Map<string, LocalProduct>): EditLine {
  const p = products.get(l.productId);
  const entered = l.qtyEntered ?? l.qty;
  // Derive the conversion from the sale line itself. A later catalogue edit can change the
  // product's selling unit; using today's factor would send a base quantity the server rejects.
  const factor = entered > 0 && l.qty > 0
    ? Math.max(1, Math.round(l.qty / entered))
    : Math.max(1, p?.units_per_selling ?? 1);
  return {
    key: `l-${Math.random().toString(36).slice(2)}-${l.productId}`,
    productId: l.productId,
    name: l.name ?? p?.name ?? l.productId.slice(0, 8),
    unit: p?.unit ?? l.unit ?? "unit",
    sellingUnit: p?.selling_unit ?? l.sellingUnit ?? p?.unit ?? l.unit ?? "unit",
    factor,
    qtyText: String(entered / 1000),
    priceText: String(l.unitPrice),
  };
}

function editFromProduct(p: LocalProduct): Omit<EditLine, "key"> {
  return {
    productId: p.id, name: p.name, unit: p.unit,
    sellingUnit: p.selling_unit ?? p.unit,
    factor: Math.max(1, p.units_per_selling ?? 1),
    qtyText: "1", priceText: String(p.selling_price ?? 0),
  };
}
function newEditLine(p: LocalProduct): EditLine {
  return { key: `l-${Math.random().toString(36).slice(2)}-${p.id}`, ...editFromProduct(p) };
}
function inputSellingQty(l: EditLine): number {
  const n = Number(String(l.qtyText).replace(/,/g, "").trim());
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 1000)) : 0;
}
function baseQty(l: EditLine): number {
  return inputSellingQty(l) * Math.max(1, l.factor);
}
function samePhysical(original: CorrectionLine[], lines: EditLine[]): boolean {
  const a = new Map<string, number>();
  const b = new Map<string, number>();
  for (const l of original) a.set(l.productId, (a.get(l.productId) ?? 0) + l.qty);
  for (const l of lines) if (l.productId) b.set(l.productId, (b.get(l.productId) ?? 0) + baseQty(l));
  if (a.size !== b.size) return false;
  for (const [id, q] of a) if (b.get(id) !== q) return false;
  return true;
}
