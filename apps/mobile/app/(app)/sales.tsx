import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { formatQty, formatRwf } from "@sms/shared";
import { useRouter } from "expo-router";
import { Badge, Banner, Button, Card, Empty, Field, Loading, Modal, Screen, Segmented, useToasts } from "../../src/components/ui";
import { useT } from "../../src/localization";
import { enqueue, listProducts, type LocalProduct } from "../../src/database";
import { request, useSession } from "../../src/services/api";
import { readOfflineSnapshot, saveOfflineSnapshot } from "../../src/services/offline-data";
import { syncNow, useSync } from "../../src/synchronization/engine";
import { uuid } from "../../src/services/util";
import { space, type, useTheme } from "../../src/theme/tokens";

type Tab = "sales" | "returns" | "prices";
type Condition = "resalable" | "damaged" | "expired" | "inspection";
const CONDITIONS: Condition[] = ["resalable", "damaged", "expired", "inspection"];

interface SaleLine { productId: string; name: string; code: string | null; unit: string; qty: number; unitPrice: number; lineAmount: number }
interface Sale {
  id: string; at: string; gross_amount: number; discount: number; amount_paid: number;
  payment_method: string; status: string; customer: string | null; by: string; units: number;
  products: string; lines: SaleLine[]; refunded: number;
  return_status: "none" | "partial" | "full" | "cancelled";
}
interface ReturnLine { productId: string; name: string; unit: string; qty: number; unitPrice: number; refund: number; unitCost: number | null; condition: Condition; restocked: boolean }
interface SaleReturn { id: string; saleId: string; at: string; reason: string; note: string | null; approvalRef: string | null; by: string | null; refund: number; costReversed: number; lines: ReturnLine[] }
interface PreviewLine { productId: string; name: string; unit: string; soldQty: number; returnedQty: number; remainingQty: number; netUnitPrice: number; net: number; refunded: number; unitCost: number | null }
interface ReturnPreview { sale: { id: string; at: string; status: string; gross: number; discount: number; net: number; customer: string | null }; lines: PreviewLine[]; fullyReturned: boolean }
interface PricePreview {
  product: { id: string; name: string; currentPrice: number; onHand: number; avgCost: number; costPerSellingUnit: number; pendingPrice: number | null; pendingAt: string | null };
  proposed: { price: number; grossProfitPerUnit: number; grossMarginBps: number | null; potentialRevenue: number; expectedGrossProfit: number };
  warnings: { code: "below_cost" | "cost_unknown" | "no_stock"; amount?: number }[];
}
interface PriceChange { id: string; oldPrice: number; newPrice: number; reason: string; actor: string | null; effectiveAt: string; approvalRef: string | null }

const day = 86_400_000;
const conditionTone = (c: Condition) => (c === "resalable" ? "ok" : c === "damaged" ? "danger" : c === "expired" ? "warn" : "neutral") as "ok" | "danger" | "warn" | "neutral";

export default function Sales() {
  const t = useT(); const c = useTheme(); const router = useRouter(); const user = useSession((s) => s.user)!; const toast = useToasts((s) => s.push);
  const recordsVersion = useSync((s) => s.recordsVersion);
  const [tab, setTab] = useState<Tab>("sales");
  const [sales, setSales] = useState<Sale[]>([]);
  const [returns, setReturns] = useState<SaleReturn[]>([]);
  const [products, setProducts] = useState<LocalProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    const shopId = user.shopId;
    if (shopId) {
      const saved = await readOfflineSnapshot<{ sales: Sale[]; returns: SaleReturn[] }>(`offline.sales:${shopId}`).catch(() => null);
      if (saved) { setSales(saved.data.sales); setReturns(saved.data.returns); setCachedAt(saved.savedAt); setLoading(false); }
    }
    setProducts((await listProducts().catch(() => [] as LocalProduct[])));
    try {
      const to = new Date(Date.now() + day).toISOString();
      const from = new Date(Date.now() - 120 * day).toISOString();
      const [s, r] = await Promise.all([
        request<Sale[]>(`/reports/transactions?kind=sales&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500`),
        request<{ returns: SaleReturn[] }>("/returns?limit=200"),
      ]);
      setSales(s); setReturns(r.returns); setCachedAt(null);
      if (shopId) await saveOfflineSnapshot(`offline.sales:${shopId}`, { sales: s, returns: r.returns }).catch(() => undefined);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }, [user.shopId]);
  useEffect(() => { void load(); }, [load, recordsVersion]);

  async function refresh() {
    setSyncing(true);
    try { await syncNow(); } catch { /* the sync engine reports its own verdicts */ }
    finally { setSyncing(false); await load(); }
  }

  /* ── cancellation ─────────────────────────────────────────────────────── */
  const [cancelSale, setCancelSale] = useState<Sale | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelApproval, setCancelApproval] = useState("");
  const [cancelRestock, setCancelRestock] = useState(true);
  const [cancelBusy, setCancelBusy] = useState(false);

  function openCancel(sale: Sale) {
    setCancelSale(sale); setCancelReason(""); setCancelApproval(""); setCancelRestock(true); setError(null);
  }
  async function submitCancel() {
    if (!cancelSale) return;
    if (cancelReason.trim().length < 3) { setError(t("sales.reasonHelp")); return; }
    setCancelBusy(true); setError(null);
    try {
      await request(`/sales/${cancelSale.id}/cancel`, {
        method: "POST",
        body: {
          reason: cancelReason.trim(), cancellationId: uuid(), restock: cancelRestock,
          approvalRef: cancelApproval.trim() || undefined,
        },
      });
      setCancelSale(null); toast(t("sales.cancelled")); await load(); void syncNow();
    } catch (e: any) {
      const code = String(e?.body?.message ?? e?.message ?? "");
      setError(code.includes("sale_has_returns") ? t("sales.hasReturns")
        : code.includes("approval_ref") ? t("sales.approvalHelp")
        : code.includes("sale_already_reversed") ? t("sales.status.cancelled")
        : t("sales.cancelFailed"));
    } finally { setCancelBusy(false); }
  }

  /* ── returns ──────────────────────────────────────────────────────────── */
  const [returnSale, setReturnSale] = useState<Sale | null>(null);
  const [preview, setPreview] = useState<ReturnPreview | null>(null);
  const [returnLines, setReturnLines] = useState<Record<string, { qty: string; condition: Condition }>>({});
  const [returnReason, setReturnReason] = useState("");
  const [returnNote, setReturnNote] = useState("");
  const [returnApproval, setReturnApproval] = useState("");
  const [returnBusy, setReturnBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);

  async function openReturn(sale: Sale) {
    setReturnSale(sale); setPreview(null); setReturnReason(""); setReturnNote(""); setReturnApproval(""); setError(null);
    setReturnLines(Object.fromEntries(sale.lines.map((l) => [l.productId, { qty: "", condition: "resalable" as Condition }])));
    setPreviewBusy(true);
    try { setPreview(await request<ReturnPreview>(`/returns/preview/${sale.id}`)); }
    catch {
      // Offline (or the preview failed): build the same shape from the cached sale. The server
      // re-validates the remaining quantity when the queued return is pushed, so this is only a
      // convenience, never the authority.
      const agg = new Map<string, PreviewLine>();
      for (const l of sale.lines) {
        const x = agg.get(l.productId) ?? { productId: l.productId, name: l.name, unit: l.unit, soldQty: 0, returnedQty: 0, remainingQty: 0, netUnitPrice: l.unitPrice, net: 0, refunded: 0, unitCost: null };
        x.soldQty += l.qty; x.net += l.lineAmount; x.remainingQty += l.qty;
        agg.set(l.productId, x);
      }
      setPreview({ sale: { id: sale.id, at: sale.at, status: sale.status, gross: sale.gross_amount, discount: sale.discount, net: sale.gross_amount - sale.discount, customer: sale.customer }, lines: [...agg.values()], fullyReturned: false });
    } finally { setPreviewBusy(false); }
  }

  const returnTotal = useMemo(() => {
    if (!preview) return 0;
    return preview.lines.reduce((sum, l) => {
      const raw = returnLines[l.productId]?.qty ?? "";
      const qty = Math.max(0, Math.round(Number(raw) * 1000));
      if (!qty) return sum;
      return sum + Math.min(l.remainingQty, qty) * (l.remainingQty > 0 ? l.netUnitPrice / 1000 : 0);
    }, 0);
  }, [preview, returnLines]);

  async function submitReturn() {
    if (!returnSale || !preview) return;
    const lines: { productId: string; qty: number; condition: Condition }[] = [];
    for (const l of preview.lines) {
      const raw = returnLines[l.productId]?.qty ?? "";
      if (!raw.trim()) continue;
      const qty = Math.round(Number(raw) * 1000);
      if (!Number.isFinite(qty) || qty <= 0) { setError(t("sales.qty")); return; }
      if (qty > l.remainingQty) { setError(`${l.name}: ${formatQty(l.remainingQty)} ${t("sales.remaining")}`); return; }
      lines.push({ productId: l.productId, qty, condition: returnLines[l.productId]?.condition ?? "resalable" });
    }
    if (!lines.length) { setError(t("sales.returnTitle")); return; }
    if (returnReason.trim().length < 3) { setError(t("sales.reasonHelp")); return; }
    setReturnBusy(true); setError(null);
    try {
      const at = new Date().toISOString();
      const returnId = uuid();
      const deltas: Record<string, number> = {};
      for (const l of lines) if (l.condition === "resalable") deltas[l.productId] = (deltas[l.productId] ?? 0) + l.qty;
      // Queued first (durable), then pushed: an offline return is never lost, and the server checks
      // it against the sale and earlier returns before any stock moves.
      await enqueue(user.id, returnId, "sale.return", {
        returnId, saleId: returnSale.id, returnedAt: at, reason: returnReason.trim(),
        note: returnNote.trim() || undefined, approvalRef: returnApproval.trim() || undefined, lines,
      }, deltas, undefined, at, { record: false });
      setReturnSale(null); toast(t("sales.returnSaved")); await refresh();
    } catch (e: any) {
      const code = String(e?.body?.message ?? e?.message ?? "");
      setError(code.includes("return_approval_required") ? t("sales.approvalHelp") : t("sales.returnFailed"));
    }
    finally { setReturnBusy(false); }
  }

  /* ── prices ───────────────────────────────────────────────────────────── */
  const [priceProduct, setPriceProduct] = useState<LocalProduct | null>(null);
  const [newPrice, setNewPrice] = useState("");
  const [priceReason, setPriceReason] = useState("");
  const [priceApproval, setPriceApproval] = useState("");
  const [pricePreview, setPricePreview] = useState<PricePreview | null>(null);
  const [priceBusy, setPriceBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<PriceChange[]>([]);

  function openPrice(p: LocalProduct) {
    setPriceProduct(p); setNewPrice(String(p.selling_price)); setPriceReason(""); setPriceApproval("");
    setPricePreview(null); setPreviewError(null); setError(null);
  }
  async function previewPrice() {
    if (!priceProduct) return;
    const value = Math.round(Number(newPrice));
    if (!Number.isFinite(value) || value < 0) { setPreviewError(t("sales.newPrice")); return; }
    setPriceBusy(true); setPreviewError(null);
    try { setPricePreview(await request<PricePreview>(`/products/${priceProduct.id}/price-preview?newPrice=${value}`)); }
    catch { setPreviewError(t("sales.offlineOnly")); }
    finally { setPriceBusy(false); }
  }
  async function submitPrice() {
    if (!priceProduct) return;
    const value = Math.round(Number(newPrice));
    if (!Number.isFinite(value) || value < 0) { setPreviewError(t("sales.newPrice")); return; }
    if (priceReason.trim().length < 3) { setPreviewError(t("sales.priceReasonHelp")); return; }
    if (value === priceProduct.selling_price) { setPreviewError(t("sales.currentPrice")); return; }
    setPriceBusy(true); setPreviewError(null);
    const payload = {
      priceId: uuid(), newPrice: value, reason: priceReason.trim(),
      expectedPrice: priceProduct.selling_price, approvalRef: priceApproval.trim() || undefined,
    };
    try {
      await request(`/products/${priceProduct.id}/price`, { method: "POST", body: payload });
      setPriceProduct(null); toast(t("sales.priceSaved")); await load(); void syncNow();
    } catch (e: any) {
      if (e?.status && e.status < 500) {
        const code = String(e?.body?.message ?? e?.message ?? "");
        setPreviewError(code.includes("price_changed_on_server") ? t("sales.priceConflict")
          : code.includes("below_cost_approval") ? t("sales.priceApprovalHelp") : t("sales.priceFailed"));
      } else {
        // Transport failure: queue the change with the price the device saw. If the server's price
        // has moved on since, the push is reported as a conflict instead of overwriting it.
        await enqueue(user.id, payload.priceId, "product.price.set", { productId: priceProduct.id, ...payload }, {}, undefined, new Date().toISOString(), { record: false });
        setPriceProduct(null); toast(t("sales.priceQueued")); await refresh();
      }
    } finally { setPriceBusy(false); }
  }
  async function showHistory(productId: string) {
    if (historyFor === productId) { setHistoryFor(null); return; }
    setHistoryFor(productId); setHistory([]);
    try { setHistory((await request<{ changes: PriceChange[] }>(`/products/${productId}/prices?limit=50`)).changes); }
    catch { toast(t("common.error")); }
  }

  const statusBadge = (sale: Sale) => {
    if (sale.status === "reversed") return <Badge tone="danger" label={t("sales.status.cancelled")} />;
    if (sale.status === "pending_approval") return <Badge tone="warn" label={t("sales.pendingApproval")} />;
    if (sale.return_status === "full") return <Badge tone="warn" label={t("sales.status.full")} />;
    if (sale.return_status === "partial") return <Badge tone="warn" label={t("sales.status.partial")} />;
    return <Badge tone="ok" label={t("sales.synced")} />;
  };

  return (
    <Screen title={t("sales.title")} subtitle={t("sales.subtitle")}
      actions={<Button label={syncing ? t("common.loading") : t("common.retry")} kind="secondary" loading={syncing} onPress={() => void refresh()} />}>
      <Segmented value={tab} onChange={setTab} options={[
        { value: "sales", label: `${t("sales.tabSales")} (${sales.length})` },
        { value: "returns", label: `${t("sales.tabReturns")} (${returns.length})` },
        { value: "prices", label: t("sales.tabPrices") },
      ]} />
      {error ? <Banner tone="danger" text={error} /> : null}
      {cachedAt ? <Banner tone="warn" text={t("offline.cached").replace("{time}", new Date(cachedAt).toLocaleString())} /> : null}
      {loading ? <Loading /> : failed && !sales.length ? <Banner tone="warn" text={t("sales.emptyDesc")} /> : (
        <>
          {tab === "sales" ? (sales.length ? sales.map((sale) => {
            const net = Number(sale.gross_amount) - Number(sale.discount);
            return (
              <Card key={sale.id} style={{ gap: space.sm }}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                  <Text style={{ color: c.ink, ...type.h2, flexGrow: 1 }}>{sale.customer || sale.products || sale.id.slice(0, 8)}</Text>
                  {statusBadge(sale)}
                  <Text style={{ color: c.ink, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{formatRwf(net)}</Text>
                </View>
                <Text style={{ color: c.muted, fontSize: 12 }}>
                  {new Date(sale.at).toLocaleString()} · {sale.by} · {sale.payment_method}
                  {sale.refunded ? ` · ${t("sales.refunded")} ${formatRwf(Number(sale.refunded))}` : ""}
                </Text>
                <View style={{ gap: 3 }}>
                  {sale.lines.map((line, i) => (
                    <Text key={`${line.productId}-${i}`} style={{ color: c.inkSoft, fontSize: 12 }}>
                      {line.name} · {formatQty(line.qty)} × {formatRwf(line.unitPrice)} = {formatRwf(line.lineAmount)}
                    </Text>
                  ))}
                </View>
                {sale.status === "posted" ? (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                    {sale.return_status !== "full" ? <Button kind="secondary" size="sm" label={t("sales.return")} onPress={() => void openReturn(sale)} /> : null}
                    {(user.role === "owner" || user.role === "manager") ? <Button kind="secondary" size="sm" label={t("corr.action")} onPress={() => router.push(`/corrections?saleId=${encodeURIComponent(sale.id)}` as any)} /> : null}
                    {user.role === "owner" ? <Button kind="dangerQuiet" size="sm" label={t("sales.cancel")} onPress={() => openCancel(sale)} /> : null}
                  </View>
                ) : null}
              </Card>
            );
          }) : <Card tone="muted"><Empty icon="cart" title={t("sales.empty")} description={t("sales.emptyDesc")} /></Card>) : null}

          {tab === "returns" ? (returns.length ? returns.map((r) => (
            <Card key={r.id} style={{ gap: space.sm }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                <Text style={{ color: c.ink, ...type.h2, flexGrow: 1 }}>{t("sales.tabReturns")} · {r.saleId.slice(0, 8)}</Text>
                <Text style={{ color: c.ink, fontWeight: "800" }}>{formatRwf(r.refund)}</Text>
              </View>
              <Text style={{ color: c.muted, fontSize: 12 }}>{new Date(r.at).toLocaleString()} · {t("sales.by")} {r.by ?? "—"} · {r.reason}</Text>
              {r.note ? <Text style={{ color: c.inkSoft, fontSize: 12 }}>{r.note}</Text> : null}
              {r.lines.map((line, i) => (
                <View key={`${line.productId}-${i}`} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                  <Text style={{ color: c.inkSoft, fontSize: 12, flexGrow: 1 }}>
                    {line.name} · {formatQty(line.qty)} · {formatRwf(line.refund)}
                  </Text>
                  <Badge tone={conditionTone(line.condition)} label={t(`sales.cond.${line.condition}` as any)} />
                  <Text style={{ color: c.muted, fontSize: 11 }}>{line.restocked ? t("sales.restocked") : t("sales.notRestocked")}</Text>
                </View>
              ))}
            </Card>
          )) : <Card tone="muted"><Empty icon="receipt" title={t("sales.noReturns")} /></Card>) : null}

          {tab === "prices" ? (
            <>
              <Text style={{ color: c.muted, ...type.small }}>{t("sales.pricesSubtitle")}</Text>
              {products.length ? products.map((p) => (
                <Card key={p.id} style={{ gap: space.sm }}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
                    <Text style={{ color: c.ink, ...type.h2, flexGrow: 1 }}>{p.name}</Text>
                    <Text style={{ color: c.ink, fontWeight: "800" }}>{formatRwf(p.selling_price)}</Text>
                  </View>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{p.code || p.unit} · {t("sales.stock")}: {formatQty(p.on_hand)}</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                    <Button size="sm" label={t("sales.changePrice")} onPress={() => openPrice(p)} />
                    <Button size="sm" kind="secondary" label={t("sales.priceHistory")} onPress={() => void showHistory(p.id)} />
                  </View>
                  {historyFor === p.id ? (
                    <View style={{ gap: 3 }}>
                      {history.length ? history.map((h) => (
                        <Text key={h.id} style={{ color: c.inkSoft, fontSize: 12 }}>
                          {formatRwf(h.oldPrice)} → {formatRwf(h.newPrice)} · {new Date(h.effectiveAt).toLocaleDateString()} · {h.actor ?? "—"} · {h.reason}
                        </Text>
                      )) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("sales.noPriceHistory")}</Text>}
                    </View>
                  ) : null}
                </Card>
              )) : <Card tone="muted"><Empty title={t("sales.selectProduct")} description={t("sales.emptyDesc")} /></Card>}
            </>
          ) : null}
        </>
      )}

      <Modal open={!!cancelSale} onClose={() => setCancelSale(null)} title={t("sales.cancelTitle")}
        description={t("sales.cancelMessage")} scroll
        footer={<>
          <Button kind="secondary" label={t("common.cancel")} onPress={() => setCancelSale(null)} disabled={cancelBusy} />
          <Button kind="danger" label={t("sales.confirmCancel")} onPress={() => void submitCancel()} loading={cancelBusy} disabled={cancelBusy} />
        </>}>
        <Field label={t("sales.reason")} value={cancelReason} onChangeText={setCancelReason} hint={t("sales.reasonHelp")} required testID="cancel-reason" />
        <Field label={t("sales.approvalRef")} value={cancelApproval} onChangeText={setCancelApproval} hint={t("sales.approvalHelp")} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Switch value={cancelRestock} onValueChange={setCancelRestock} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: c.ink, ...type.small }}>{t("sales.restock")}</Text>
            <Text style={{ color: c.muted, fontSize: 11 }}>{t("sales.restockHelp")}</Text>
          </View>
        </View>
        <Text style={{ color: c.muted, fontSize: 11 }}>{t("sales.cancelNote")}</Text>
      </Modal>

      <Modal open={!!returnSale} onClose={() => setReturnSale(null)} title={t("sales.returnTitle")}
        description={t("sales.returnSubtitle")} scroll
        footer={<>
          <Text style={{ color: c.ink, fontWeight: "800", flexGrow: 1 }}>{t("sales.refundTotal")}: {formatRwf(Math.round(returnTotal))}</Text>
          <Button kind="secondary" label={t("common.cancel")} onPress={() => setReturnSale(null)} disabled={returnBusy} />
          <Button label={t("sales.submitReturn")} onPress={() => void submitReturn()} loading={returnBusy} disabled={returnBusy} />
        </>}>
        {previewBusy ? <Loading /> : preview ? preview.lines.map((l) => (
          <View key={l.productId} style={{ gap: space.xs, paddingBottom: space.sm, borderBottomWidth: 1, borderBottomColor: c.line }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              <Text style={{ color: c.ink, ...type.body, flexGrow: 1 }}>{l.name}</Text>
              <Text style={{ color: c.muted, fontSize: 12 }}>{t("sales.remaining")}: {formatQty(l.remainingQty)}</Text>
            </View>
            <Field label={t("sales.qty")} value={returnLines[l.productId]?.qty ?? ""} keyboardType="decimal-pad"
              onChangeText={(x) => setReturnLines((s) => ({ ...s, [l.productId]: { qty: x, condition: s[l.productId]?.condition ?? "resalable" } }))}
              placeholder="0" testID={`return-qty-${l.productId}`} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
              {CONDITIONS.map((cond) => {
                const active = (returnLines[l.productId]?.condition ?? "resalable") === cond;
                return (
                  <Pressable key={cond} accessibilityRole="button" accessibilityState={{ selected: active }}
                    onPress={() => setReturnLines((s) => ({ ...s, [l.productId]: { qty: s[l.productId]?.qty ?? "", condition: cond } }))}
                    style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1,
                      borderColor: active ? c.accent : c.line, backgroundColor: active ? c.surfaceMuted : "transparent" }}>
                    <Text style={{ color: active ? c.ink : c.muted, fontSize: 12, fontWeight: active ? "700" : "500" }}>{t(`sales.cond.${cond}` as any)}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )) : null}
        <Field label={t("sales.reason")} value={returnReason} onChangeText={setReturnReason} hint={t("sales.reasonHelp")} required />
        <Field label={t("sales.returnNote")} value={returnNote} onChangeText={setReturnNote} />
        <Field label={t("sales.approvalRef")} value={returnApproval} onChangeText={setReturnApproval} hint={t("sales.approvalHelp")} />
      </Modal>

      <Modal open={!!priceProduct} onClose={() => setPriceProduct(null)} title={t("sales.changePrice")}
        description={priceProduct ? `${priceProduct.name} · ${t("sales.currentPrice")}: ${formatRwf(priceProduct.selling_price)}` : undefined} scroll
        footer={<>
          <Button kind="secondary" label={t("common.cancel")} onPress={() => setPriceProduct(null)} disabled={priceBusy} />
          <Button label={t("sales.preview")} onPress={() => void previewPrice()} loading={priceBusy} disabled={priceBusy} />
          <Button label={t("sales.changePrice")} onPress={() => void submitPrice()} loading={priceBusy} disabled={priceBusy} />
        </>}>
        <Field label={t("sales.newPrice")} value={newPrice} onChangeText={(x) => { setNewPrice(x); setPricePreview(null); }} keyboardType="number-pad" required />
        <Field label={t("sales.priceReason")} value={priceReason} onChangeText={setPriceReason} hint={t("sales.priceReasonHelp")} required />
        <Field label={t("sales.priceApproval")} value={priceApproval} onChangeText={setPriceApproval} hint={t("sales.priceApprovalHelp")} />
        {previewError ? <Banner tone="danger" text={previewError} /> : null}
        {pricePreview ? (
          <Card tone={pricePreview.warnings.some((w) => w.code === "below_cost") ? "warn" : "muted"} style={{ gap: 4 }}>
            <Text style={{ color: c.ink, ...type.h3 }}>{t("sales.preview")}</Text>
            <Text style={{ color: c.inkSoft, fontSize: 12 }}>{t("sales.avgCost")}: {formatRwf(pricePreview.product.costPerSellingUnit)} · {t("sales.stock")}: {formatQty(pricePreview.product.onHand)}</Text>
            <Text style={{ color: pricePreview.proposed.grossProfitPerUnit < 0 ? c.danger : c.ink, fontSize: 13, fontWeight: "700" }}>
              {t("sales.grossProfit")}: {formatRwf(pricePreview.proposed.grossProfitPerUnit)}
              {pricePreview.proposed.grossMarginBps !== null ? ` · ${t("sales.margin")}: ${(pricePreview.proposed.grossMarginBps / 100).toFixed(1)}%` : ""}
            </Text>
            <Text style={{ color: c.inkSoft, fontSize: 12 }}>{t("sales.potentialRevenue")}: {formatRwf(pricePreview.proposed.potentialRevenue)}</Text>
            <Text style={{ color: c.inkSoft, fontSize: 12 }}>{t("sales.expectedProfit")}: {formatRwf(pricePreview.proposed.expectedGrossProfit)}</Text>
            <Text style={{ color: c.muted, fontSize: 11 }}>{t("sales.projectionNote")}</Text>
            {pricePreview.warnings.map((w) => (
              <Text key={w.code} style={{ color: w.code === "below_cost" ? c.danger : c.muted, fontSize: 11 }}>
                {w.code === "below_cost" ? t("sales.belowCost") : w.code === "no_stock" ? t("sales.noStock") : t("sales.costUnknown")}
              </Text>
            ))}
          </Card>
        ) : null}
      </Modal>
    </Screen>
  );
}
