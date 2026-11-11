import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { formatQty, formatRwf, lineAmount, toBaseQty, type PaymentMethod } from "@sms/shared";
import { Badge, Banner, Button, Card, Empty, Field, Modal, Screen, Segmented, useToasts, useWide } from "../../src/components/ui";
import { Appear, Disclosure, Dismiss, Shake } from "../../src/components/motion";
import { Icon } from "../../src/components/icons";
import { cartSellingQty, maxSellingMilli, mergeCartQty, stepSellingQty, validateQuickAddQty } from "../../src/services/sell-quick-add";
import { enqueue, listProducts, type LocalProduct } from "../../src/database/local";
import { useT } from "../../src/localization";
import { request, useSession } from "../../src/services/api";
import { fullResync, refreshCounts, syncNow, useSync } from "../../src/synchronization/engine";
import { parseRwf, qtyOrNull, uuid } from "../../src/services/util";
import { elevation, radius, space, type, useTheme } from "../../src/theme/tokens";

interface Line { p: LocalProduct; qty: string; price: string }

/** Selling-unit helpers: `qty` in a line is entered in the product's SELLING unit; stock checks,
 * the outbox delta and the ledger are always in BASE units (see shared units.ts). */
const sellingUnitOf = (p: LocalProduct) => p.selling_unit ?? p.unit;
const unitsSellingOf = (p: LocalProduct) => p.units_per_selling ?? 1;

function QtyButton({ label, onPress, disabled, testID }: { label: string; onPress: () => void; disabled?: boolean; testID?: string }) {
  const c = useTheme();
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
      style={({ pressed, hovered }: any) => ({
        width: 48, height: 48, borderRadius: radius.sm, alignItems: "center", justifyContent: "center",
        borderWidth: 1, borderColor: c.lineStrong, backgroundColor: disabled ? c.disabledBg : pressed ? c.pressed : hovered ? c.hover : c.surface,
        opacity: disabled ? 0.65 : 1,
      })}>
      <Text style={{ color: disabled ? c.disabledInk : c.ink, fontSize: 22, lineHeight: 26, fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );
}


export default function Sell() {
  const t = useT(); const c = useTheme(); const wide = useWide();
  const user = useSession((s) => s.user)!; const v = useSync((s) => s.dataVersion);
  const online = useSync((s) => s.online); const lastError = useSync((s) => s.lastError);
  const [q, setQ] = useState(""); const [list, setList] = useState<LocalProduct[]>([]); const [lines, setLines] = useState<Line[]>([]);
  const [discount, setDiscount] = useState("0"); const [paid, setPaid] = useState<string | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [maxDiscount, setMaxDiscount] = useState<number | null>(null);
  const [saved, setSaved] = useState<{ total: number; count: number; ref: string; paid: number; change: number; at: string; method: PaymentMethod } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  // Bumped on every failed validation so the cart shakes once per real error; `leaving` holds rows
  // that are animating out and are only dropped from `lines` when Dismiss calls back.
  const [errCount, setErrCount] = useState(0); const [leaving, setLeaving] = useState<string[]>([]);
  const [all, setAll] = useState<LocalProduct[]>([]);
  const [retQuery, setRetQuery] = useState(""); const [retProduct, setRetProduct] = useState<LocalProduct | null>(null);
  const [retQty, setRetQty] = useState("1"); const [retAmount, setRetAmount] = useState("0");
  const [retReceipt, setRetReceipt] = useState(""); const [retNote, setRetNote] = useState("");
  const [retBusy, setRetBusy] = useState(false); const [retErr, setRetErr] = useState<string | null>(null); const [retSaved, setRetSaved] = useState(false);
  // Quick-add is a draft on top of the real cart: closing it discards the draft, never the cart.
  const [quick, setQuick] = useState<LocalProduct | null>(null);
  const [quickQty, setQuickQty] = useState("1"); const [quickErr, setQuickErr] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const toast = useToasts((s) => s.push);

  const load = useCallback(() => listProducts(q).then(setList).catch(() => setList([])), [q]);
  useEffect(() => { void load(); }, [load, v, saved]);
  // The cap is enforced by the API too; fetching it here lets the cashier see the limit before saving.
  useEffect(() => {
    let live = true;
    request<{ maxDiscountPercent: number }>("/shop/settings")
      .then((s) => { if (live) setMaxDiscount(s.maxDiscountPercent); })
      .catch(() => { if (live) setMaxDiscount(null); });
    return () => { live = false; };
  }, []);
  useEffect(() => { void listProducts("").then(setAll).catch(() => setAll([])); }, [v, saved]);

  const retMatches = all.filter((p) => {
    const needle = retQuery.trim().toLowerCase();
    return !needle || p.name.toLowerCase().includes(needle) || (p.code ?? "").toLowerCase().includes(needle);
  }).slice(0, 8);

  async function saveReturn() {
    const qn = qtyOrNull(retQty); const amount = parseRwf(retAmount); const note = retNote.trim();
    if (!retProduct || qn === null) { setRetErr(t("sell.returnInvalid")); return; }
    if (amount === null) { setRetErr(t("v.invalid")); return; }
    if (note.length < 3) { setRetErr(t("sell.returnNoteRequired")); return; }
    setRetErr(null); setRetBusy(true);
    const fullNote = `${note}${retReceipt.trim() ? ` · ${t("sell.receipt")}: ${retReceipt.trim().slice(0, 40)}` : ""}`.slice(0, 500);
    try {
      await enqueue(user.id, uuid(), "adjustment.request", {
        adjustmentId: uuid(), productId: retProduct.id, qty: qn, reason: "sale_return", refundAmount: amount, note: fullNote,
      });
      setRetProduct(null); setRetQuery(""); setRetQty("1"); setRetAmount("0"); setRetReceipt(""); setRetNote("");
      setRetSaved(true);
      await refreshCounts(); void syncNow();
    } catch { setRetErr(t("common.error")); } finally { setRetBusy(false); }
  }

  const eff = (p: LocalProduct) => p.on_hand + p.pending_delta;
  const amount = (l: Line) => (qtyOrNull(l.qty) && parseRwf(l.price) !== null ? lineAmount(qtyOrNull(l.qty)!, parseRwf(l.price)!) : 0);
  const gross = lines.reduce((s, l) => s + amount(l), 0);
  const disc = parseRwf(discount) ?? 0;
  const total = Math.max(0, gross - disc);
  const tendered = paid === null ? total : parseRwf(paid);
  const appliedPaid = tendered === null ? 0 : Math.min(tendered, total); // change is not revenue
  const change = tendered === null ? 0 : Math.max(0, tendered - total);
  const balance = tendered === null ? 0 : Math.max(0, total - tendered);

  const quickStock = quick ? eff(quick) : 0;
  const quickFactor = quick ? unitsSellingOf(quick) : 1;
  const quickCheck = quick ? validateQuickAddQty(quickQty, quickStock, quickFactor) : null;
  const quickSubtotal = quick && quickCheck?.ok
    ? lineAmount(quickCheck.qty, parseRwf(String(quick.selling_price)) ?? quick.selling_price)
    : 0;
  const overStockText = (p: LocalProduct, max: number) =>
    t("sell.overStock").replace("{qty}", formatQty(max)).replace("{unit}", sellingUnitOf(p));
  const quickError = quickCheck?.ok === false
    ? (quickCheck.reason === "stock" ? overStockText(quick!, quickCheck.max) : t("sell.qtyPositive"))
    : quickErr;

  function openQuick(p: LocalProduct) {
    setSaved(null); setSaveError(null); setQuick(p); setQuickQty("1"); setQuickErr(null);
  }
  function closeQuick() {
    setQuick(null); setQuickQty("1"); setQuickErr(null);
  }
  function addQuick() {
    if (!quick || !quickCheck?.ok) return;
    const existing = lines.find((x) => x.p.id === quick.id);
    const merged = existing
      ? mergeCartQty(existing.qty, quickCheck.qty, quickStock, quickFactor)
      : formatQty(quickCheck.qty);
    if (!merged) { setQuickErr(overStockText(quick, maxSellingMilli(quickStock, quickFactor))); return; }
    setSaved(null); setSaveError(null);
    setLines((ls) => (existing
      ? ls.map((x) => (x.p.id === quick.id ? { ...x, qty: merged, price: String(quick.selling_price) } : x))
      : [...ls, { p: quick, qty: merged, price: String(quick.selling_price) }]));
    toast(`${quick.name} ${t("sell.addedToCart")}`);
    closeQuick();
  }

  // A draft sale is not in the outbox yet: warn before a page close loses it.
  useEffect(() => {
    if (Platform.OS !== "web" || !lines.length) return;
    const warn = (e: Event) => { e.preventDefault(); (e as any).returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [lines.length]);

  const update = (i: number, patch: Partial<Line>) => setLines((a) => a.map((y, j) => (j === i ? { ...y, ...patch } : y)));
  const step = (i: number, delta: number) => {
    const qn = qtyOrNull(lines[i]!.qty) ?? 0; const next = Math.max(1, qn + delta * 1000);
    update(i, { qty: String(next / 1000) });
  };

  async function save() {
    const e: Record<string, string> = {};
    lines.forEach((l, i) => {
      const qn = qtyOrNull(l.qty);
      if (!qn) e[`q${i}`] = t("v.positive");
      else if (toBaseQty(qn, unitsSellingOf(l.p)) > eff(l.p)) e[`q${i}`] = `${t("sell.insufficient")} · ${formatQty(eff(l.p))} ${l.p.unit}`;
      if (parseRwf(l.price) === null) e[`p${i}`] = t("v.invalid");
    });
    if (parseRwf(discount) === null || disc > gross) e.d = t("v.invalid");
    else if (user.role !== "owner" && maxDiscount !== null && gross > 0 && disc > Math.floor((gross * maxDiscount) / 100))
      e.d = t("sell.discountLimit").replace("{pct}", String(maxDiscount));
    if (tendered === null) e.paid = t("v.invalid");
    setErrs(e);
    if (Object.keys(e).length) setErrCount((n) => n + 1);
    if (!lines.length || Object.keys(e).length) return;

    const saleTotal = total, count = lines.length, saleId = uuid(), at = new Date().toISOString();
    const payload = { saleId, soldAt: at, discount: disc, amountPaid: appliedPaid, paymentMethod: method, lines: lines.map((l) => {
      const natural = qtyOrNull(l.qty)!;                         // milli SELLING units as entered
      return { productId: l.p.id, qty: toBaseQty(natural, unitsSellingOf(l.p)), unitPrice: parseRwf(l.price)!, sellingQty: natural };
    }) };
    const deltas: Record<string, number> = {}; payload.lines.forEach((l) => (deltas[l.productId] = (deltas[l.productId] ?? 0) - l.qty));
    setBusy(true); setSaveError(null);
    try {
      // `at` is passed as the record timestamp so today's local figures place the sale on the
      // Kigali business day it was made, not on whichever day the sync later ran.
      await enqueue(user.id, uuid(), "sale.create", payload, deltas, undefined, at); // durable BEFORE success is shown
      setLines([]); setDiscount("0"); setPaid(null); setErrs({});
      setSaved({ total: saleTotal, count, ref: `RC-${saleId.slice(0, 8).toUpperCase()}`, paid: appliedPaid, change, at, method });
      await refreshCounts(); void syncNow();
    } catch {
      setSaveError(t("sell.saveFailed"));
    } finally { setBusy(false); }
  }

  return (
    <View style={{ flex: 1 }}>
    <Screen title={t("sell.title")} subtitle={t("sell.subtitle")}>
      {saved ? (
        <>
          <Banner tone="ok" title={`${t("sell.savedTitle")} · ${t("common.total")} ${formatRwf(saved.total)}`} text={t("sell.savedText")} />
          <Card style={{ gap: space.sm }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
            <Text style={{ color: c.inkSoft, fontSize: 12 }}>{t("sell.receipt")}: <Text style={{ color: c.ink, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{saved.ref}</Text></Text>
            <Text style={{ color: c.muted, fontSize: 12 }}>{t("reports.cashier")}: <Text style={{ color: c.ink, fontWeight: "600" }}>{user.name}</Text></Text>
            <Text style={{ color: c.muted, fontSize: 12 }}>{new Date(saved.at).toLocaleString()}</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
            <Text style={{ color: c.muted, fontSize: 12 }}>{t("common.paid")}: <Text style={{ color: c.ink, fontWeight: "700" }}>{formatRwf(saved.paid)}</Text></Text>
            <Text testID="sell-change" style={{ color: c.muted, fontSize: 12 }}>{t("sell.change")}: <Text style={{ color: saved.change ? c.accent : c.ink, fontWeight: "700" }}>{formatRwf(saved.change)}</Text></Text>
            <Text testID="sell-saved-method" style={{ color: c.muted, fontSize: 12 }}>{t("sell.paymentMethod")}: <Text style={{ color: c.ink, fontWeight: "700" }}>{t(`sell.${saved.method}` as any)}</Text></Text>
            <Text style={{ color: c.muted, fontSize: 12 }}>{saved.count} {t("dash.items")}</Text>
          </View>
          </Card>
        </>
      ) : null}
      {saveError ? <Banner tone="danger" title={t("sell.notSaved")} text={saveError} /> : null}
      {/* An empty shelf must never look like an empty shop: say whether the catalogue has simply
          not arrived on this device yet, and offer the one repair that works (a full re-pull). */}
      {!list.length ? (
        <Banner tone="warn" title={t("catalogue.emptyTitle")}
          text={online ? t("catalogue.emptyOnline") : t("catalogue.emptyOffline")}
          action={<Button size="sm" kind="secondary" label={t("catalogue.reload")} onPress={() => void fullResync()} />} />
      ) : null}

      <View style={{ flexDirection: wide ? "row" : "column", gap: space.lg, alignItems: "flex-start" }}>
        <View style={{ flex: wide ? 1.35 : undefined, width: wide ? undefined : "100%", gap: space.md }}>
          <Field testID="sell-search" label={t("common.search")} placeholder={t("sell.searchPlaceholder")} value={q} onChangeText={setQ} autoCorrect={false} />
          {list.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {list.slice(0, 24).map((p, idx) => {
                const stock = eff(p); const out = stock <= 0;
                return (
                  <Pressable key={p.id} testID={`sell-product-${idx}`} accessibilityRole="button" accessibilityLabel={p.name} onPress={() => openQuick(p)}
                    style={({ hovered, pressed }: any) => ({ width: wide ? 168 : "47%", flexGrow: wide ? 0 : 1, minHeight: 82, padding: space.md, borderWidth: 1, borderColor: c.line, borderRadius: radius.md, backgroundColor: c.surface, gap: 4, opacity: pressed ? 0.82 : hovered ? 0.95 : 1 })}>
                    <Text numberOfLines={2} style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{p.name}</Text>
                    <Text style={{ color: c.inkSoft, fontSize: 12, fontVariant: ["tabular-nums"] }}>{formatRwf(p.selling_price)}{unitsSellingOf(p) !== 1 || sellingUnitOf(p) !== p.unit ? ` / ${sellingUnitOf(p)}` : ""}</Text>
                    {out ? <Badge tone="danger" dot label={t("sell.outOfStock")} />
                      : stock <= p.low_threshold ? <Badge tone="warn" dot label={`${formatQty(stock)} ${p.unit} ${t("sell.left")}`} />
                      : <Text style={{ color: c.muted, fontSize: 11, fontWeight: "600" }}>{`${formatQty(stock)} ${p.unit} ${t("sell.left")}`}</Text>}
                  </Pressable>
                );
              })}
            </View>
          ) : <Card tone="muted"><Empty icon="search" title={t("sell.noProducts")} description={t("sell.noProductsDesc")} /></Card>}
        </View>

        <Shake trigger={errCount} style={{ flex: wide ? 1 : undefined, width: wide ? undefined : "100%" }}>
        <View style={{ gap: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Text style={{ color: c.ink, ...type.h2, flex: 1 }}>{t("sell.cart")}</Text>
            {lines.length ? <Badge label={`${lines.length}`} /> : null}
          </View>

          {lines.length ? lines.map((l, i) => (
            <Dismiss key={l.p.id} active={!leaving.includes(l.p.id)}
              onDone={() => { setLines((a) => a.filter((x) => x.p.id !== l.p.id)); setLeaving((v) => v.filter((id) => id !== l.p.id)); }}>
            <Appear index={i}>
            <Card style={{ gap: space.sm, padding: space.md }}>
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{l.p.name}</Text>
                  <Text style={{ color: c.muted, fontSize: 11 }}>{t("sell.remaining")} {formatQty(eff(l.p))} {l.p.unit} · {formatRwf(l.p.selling_price)} / {sellingUnitOf(l.p)}</Text>
                </View>
                <Button size="sm" kind="quiet" label={t("common.remove")} onPress={() => setLeaving((v) => [...v, l.p.id])} />
              </View>
              <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start", flexWrap: "wrap" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexGrow: 1, flexBasis: 150 }}>
                  <Button size="sm" kind="secondary" label="−" onPress={() => step(i, -1)} />
                  <View style={{ flex: 1 }}><Field testID={`sell-qty-${i}`} label={`${t("common.qty")} (${sellingUnitOf(l.p)})`} value={l.qty} keyboardType="decimal-pad" error={errs[`q${i}`]} onChangeText={(x) => update(i, { qty: x })} /></View>
                  <Button size="sm" kind="secondary" label="+" onPress={() => step(i, 1)} />
                </View>
                <View style={{ flexGrow: 1, flexBasis: 130 }}>
                  <Field testID={`sell-price-${i}`} label={`${t("common.price")} / ${sellingUnitOf(l.p)}`} value={l.price} keyboardType="number-pad" error={errs[`p${i}`]} onChangeText={(x) => update(i, { price: x })} />
                </View>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: c.muted, fontSize: 12 }}>{t("sell.lineTotal")}{unitsSellingOf(l.p) !== 1 ? ` (${formatQty(toBaseQty(qtyOrNull(l.qty) ?? 0, unitsSellingOf(l.p)))} ${l.p.unit})` : ""}</Text>
                <Text style={{ color: c.ink, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatRwf(amount(l))}</Text>
              </View>
            </Card>
            </Appear>
            </Dismiss>
          )          ) : <Card tone="muted"><Empty icon="cart" title={t("sell.emptyCart")} description={t("sell.emptyCartDesc")} /></Card>}

          {lines.length ? (
            <Card style={{ gap: space.md }}>
              <View style={{ gap: 4 }}>
                <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("sell.paymentMethod")}</Text>
                <Segmented<PaymentMethod> label={t("sell.paymentMethod")} value={method} onChange={setMethod} options={[
                  { value: "cash", label: t("sell.cash") }, { value: "momo", label: t("sell.momo") },
                  { value: "bank", label: t("sell.bank") }, { value: "credit", label: t("sell.credit") },
                ]} />
              </View>
              <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
                <Field testID="sell-discount" label={t("common.discount")} value={discount} keyboardType="number-pad" error={errs.d} onChangeText={setDiscount}
                  hint={user.role !== "owner" && maxDiscount !== null && maxDiscount < 100 ? t("sell.discountLimitHint").replace("{pct}", String(maxDiscount)) : undefined} />
                <Field testID="sell-paid" label={t("common.paid")} value={paid ?? String(total)} keyboardType="number-pad" error={errs.paid} onChangeText={setPaid}
                  hint={change > 0 ? `${t("sell.change")}: ${formatRwf(change)}` : balance > 0 ? `${t("sell.balance")}: ${formatRwf(balance)}` : t("sell.fullyPaid")} />
              </View>
              <View style={{ borderTopWidth: 1, borderTopColor: c.line, paddingTop: space.sm, gap: 3 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}><Text style={{ color: c.muted, fontSize: 13 }}>{t("sell.subtotal")}</Text><Text style={{ color: c.inkSoft, fontVariant: ["tabular-nums"] }}>{formatRwf(gross)}</Text></View>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}><Text style={{ color: c.ink, fontWeight: "700" }}>{t("common.total")}</Text><Text style={{ color: c.ink, ...type.money }}>{formatRwf(total)}</Text></View>
              </View>
              <Button testID="sell-save" full label={t("sell.save")} loading={busy} onPress={() => void save()} />
            </Card>
          ) : null}
        </View>
        </Shake>
      </View>

      {retSaved ? <Banner tone="ok" title={t("sell.returnSaved")} text={t("sell.returnSavedText")} /> : null}
      <Disclosure title={t("sell.returnsTitle")} description={t("sell.returnsDesc")} testID="sell-returns">
        <View style={{ padding: space.lg, gap: space.md }}>
          {retErr ? <Banner tone="danger" text={retErr} /> : null}
          {retProduct ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: 8, backgroundColor: c.surfaceMuted, borderWidth: 1, borderColor: c.line }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{retProduct.name}</Text>
                <Text style={{ color: c.muted, fontSize: 11 }}>{retProduct.code} · {formatQty(eff(retProduct))} {retProduct.unit} · {formatRwf(retProduct.selling_price)}</Text>
              </View>
              <Button size="sm" kind="quiet" label={t("common.remove")} onPress={() => setRetProduct(null)} />
            </View>
          ) : (
            <>
              <Field testID="sell-return-search" label={t("common.product")} placeholder={t("sell.searchPlaceholder")} value={retQuery} onChangeText={setRetQuery} autoCorrect={false} />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                {retMatches.length ? retMatches.map((p, idx) => (
                  <Pressable key={p.id} testID={`sell-return-product-${idx}`} accessibilityRole="button" accessibilityLabel={p.name}
                    onPress={() => { setRetSaved(false); setRetErr(null); setRetProduct(p); }}
                    style={({ hovered, pressed }: any) => ({ paddingVertical: 7, paddingHorizontal: space.md, borderRadius: 8, borderWidth: 1, borderColor: c.line, backgroundColor: hovered || pressed ? c.surfaceMuted : c.surface })}>
                    <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>{p.name}</Text>
                    <Text style={{ color: c.muted, fontSize: 11 }}>{formatRwf(p.selling_price)}</Text>
                  </Pressable>
                )) : <Text style={{ color: c.muted, fontSize: 12 }}>{t("sell.noProducts")}</Text>}
              </View>
            </>
          )}
          <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
            <Field testID="sell-return-qty" label={t("common.qty")} value={retQty} keyboardType="decimal-pad" onChangeText={setRetQty} />
            <Field testID="sell-return-amount" label={t("sell.returnAmount")} value={retAmount} keyboardType="number-pad" onChangeText={setRetAmount} hint={t("sell.returnAmountHelp")} />
            <Field testID="sell-return-receipt" label={t("sell.receipt")} value={retReceipt} onChangeText={setRetReceipt} placeholder="RC-XXXXXXXX" hint={t("common.optional")} />
          </View>
          <Field testID="sell-return-note" label={t("common.note")} value={retNote} onChangeText={setRetNote} placeholder={t("sell.returnNotePlaceholder")} />
          <Button testID="sell-return-save" label={t("sell.returnSubmit")} loading={retBusy} onPress={() => void saveReturn()} />
          <Text style={{ color: c.muted, fontSize: 11, lineHeight: 17 }}>{t("sell.returnApprovalNote")}</Text>
        </View>
      </Disclosure>
    </Screen>

      {!wide && lines.length && !quick && !cartOpen ? (
        <View pointerEvents="box-none" style={{ position: "absolute", left: space.lg, right: space.lg, bottom: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: c.ink, borderRadius: radius.lg, padding: space.md, ...elevation.raised }}>
            <View style={{ flex: 1, gap: 1 }}>
              <Text style={{ color: c.surface, fontSize: 12, fontWeight: "600" }}>{lines.length} {t("sell.cartItems")} · {formatQty(cartSellingQty(lines))}</Text>
              <Text testID="sell-cart-bar-total" style={{ color: c.surface, fontSize: 18, lineHeight: 23, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{formatRwf(total)}</Text>
            </View>
            <Button testID="sell-view-cart" size="sm" kind="secondary" label={t("sell.viewCart")} onPress={() => setCartOpen(true)} />
          </View>
        </View>
      ) : null}

      <Modal open={!!quick} onClose={closeQuick} title={quick?.name ?? t("sell.addProduct")} description={t("sell.quickLead")} width={460}
        headerAction={
          <Pressable testID="sell-quick-close" accessibilityRole="button" accessibilityLabel={t("common.close")} onPress={closeQuick}
            style={({ hovered, pressed }: any) => ({ width: 44, height: 44, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: hovered || pressed ? c.hover : "transparent" })}>
            <Icon name="close" size={18} color={c.inkSoft} />
          </Pressable>
        }
        footer={<>
          <Button kind="secondary" label={t("common.cancel")} onPress={closeQuick} />
          <Button testID="sell-quick-add" label={t("sell.addToCart")} onPress={addQuick} disabled={!quickCheck?.ok} />
        </>}>
        {quick ? (
          <View style={{ gap: space.md }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <View style={{ width: 64, height: 64, borderRadius: radius.md, borderWidth: 1, borderColor: c.line, backgroundColor: c.primarySoft, alignItems: "center", justifyContent: "center" }}>
                <Icon name="box" size={28} color={c.primaryStrong} />
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: c.muted, fontSize: 12 }}>{quick.code}</Text>
                <Text style={{ color: c.ink, fontWeight: "700", fontSize: 15 }}>{formatRwf(quick.selling_price)} / {sellingUnitOf(quick)}</Text>
                <Badge tone={quickStock <= 0 ? "danger" : quickStock <= quick.low_threshold ? "warn" : "neutral"}
                  label={`${t("sell.availableStock")}: ${formatQty(quickStock)} ${quick.unit}`} />
              </View>
            </View>
            {quickFactor !== 1 ? (
              <Text style={{ color: c.inkSoft, fontSize: 12 }}>
                {t("sell.packConversion").replace("{selling}", sellingUnitOf(quick)).replace("{n}", String(quickFactor)).replace("{base}", quick.unit)}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
              <QtyButton testID="sell-quick-minus" label="−" disabled={quickStock <= 0} onPress={() => { setQuickQty(stepSellingQty(quickQty, -1, quickStock, quickFactor)); setQuickErr(null); }} />
              <View style={{ flex: 1 }}>
                <Field testID="sell-quick-qty" label={`${t("common.qty")} (${sellingUnitOf(quick)})`} value={quickQty} keyboardType="decimal-pad"
                  onChangeText={(x) => { setQuickQty(x); setQuickErr(null); }} error={quickError} />
              </View>
              <QtyButton testID="sell-quick-plus" label="+" disabled={quickStock <= 0} onPress={() => { setQuickQty(stepSellingQty(quickQty, 1, quickStock, quickFactor)); setQuickErr(null); }} />
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderTopWidth: 1, borderTopColor: c.line, paddingTop: space.sm }}>
              <Text style={{ color: c.muted, fontSize: 13 }}>{t("sell.subtotal")}</Text>
              <Text testID="sell-quick-subtotal" style={{ color: c.ink, ...type.money }}>{formatRwf(quickSubtotal)}</Text>
            </View>
          </View>
        ) : null}
      </Modal>

      <Modal open={cartOpen} onClose={() => setCartOpen(false)} title={t("sell.cart")} description={t("sell.cartReviewDesc")} width={560} scroll
        headerAction={
          <Pressable testID="sell-cart-close" accessibilityRole="button" accessibilityLabel={t("common.close")} onPress={() => setCartOpen(false)}
            style={({ hovered, pressed }: any) => ({ width: 44, height: 44, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: hovered || pressed ? c.hover : "transparent" })}>
            <Icon name="close" size={18} color={c.inkSoft} />
          </Pressable>
        }
        footer={<Button kind="secondary" label={t("common.close")} onPress={() => setCartOpen(false)} />}>
        {lines.length ? lines.map((l, i) => (
          <View key={l.p.id} style={{ borderWidth: 1, borderColor: c.line, borderRadius: radius.md, padding: space.md, gap: space.sm }}>
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{l.p.name}</Text>
                <Text style={{ color: c.muted, fontSize: 11 }}>{t("sell.remaining")} {formatQty(eff(l.p))} {l.p.unit} · {formatRwf(l.p.selling_price)} / {sellingUnitOf(l.p)}</Text>
              </View>
              <Button size="sm" kind="quiet" label={t("common.remove")}
                onPress={() => { setLines((a) => a.filter((x) => x.p.id !== l.p.id)); setLeaving((v) => v.filter((id) => id !== l.p.id)); }} />
            </View>
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
              <QtyButton label="−" onPress={() => step(i, -1)} />
              <View style={{ flex: 1 }}>
                <Field testID={`sell-review-qty-${i}`} label={`${t("common.qty")} (${sellingUnitOf(l.p)})`} value={l.qty} keyboardType="decimal-pad" error={errs[`q${i}`]} onChangeText={(x) => update(i, { qty: x })} />
              </View>
              <QtyButton label="+" onPress={() => step(i, 1)} />
            </View>
            <View style={{ flexDirection: "row", gap: space.md, alignItems: "flex-end", flexWrap: "wrap" }}>
              <View style={{ flexGrow: 1, flexBasis: 150 }}>
                <Field testID={`sell-review-price-${i}`} label={`${t("common.price")} / ${sellingUnitOf(l.p)}`} value={l.price} keyboardType="number-pad" error={errs[`p${i}`]} onChangeText={(x) => update(i, { price: x })} />
              </View>
              <View style={{ alignItems: "flex-end", gap: 2, minWidth: 100 }}>
                <Text style={{ color: c.muted, fontSize: 11 }}>{t("sell.lineTotal")}</Text>
                <Text style={{ color: c.ink, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatRwf(amount(l))}</Text>
              </View>
            </View>
          </View>
        )) : <Empty icon="cart" title={t("sell.emptyCart")} description={t("sell.emptyCartDesc")} />}
        <View style={{ borderTopWidth: 1, borderTopColor: c.line, paddingTop: space.sm, gap: 4 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}><Text style={{ color: c.muted, fontSize: 13 }}>{t("sell.subtotal")}</Text><Text style={{ color: c.inkSoft, fontVariant: ["tabular-nums"] }}>{formatRwf(gross)}</Text></View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}><Text style={{ color: c.ink, fontWeight: "700" }}>{t("common.total")}</Text><Text style={{ color: c.ink, ...type.money }}>{formatRwf(total)}</Text></View>
        </View>
      </Modal>
    </View>
  );
}
