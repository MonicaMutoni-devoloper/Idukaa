/**
 * ADD PRODUCT — the entry point for the whole unit-conversion model.
 *
 * Three units per product (see packages/shared/src/units.ts):
 *   purchase unit  how the shop buys   (bag)   x unitsPerPurchase base units
 *   base unit      what the ledger stores (kg) = `unit` / `products.unit`
 *   selling unit   how the shop sells  (kg)    x unitsPerSelling base units
 *
 * Two shapes of the form:
 *   - SIMPLE (default): purchase unit = selling unit = base unit, 1:1. Exactly the original form.
 *   - CONVERTED (toggle): purchase and selling configuration appear, every derived figure
 *     (initial stock, cost per base unit, cost per purchase unit, profit) is recomputed live from
 *     toBaseQty/costPerBaseUnit, and the payload carries natural quantities plus the factor so the
 *     server can verify the conversion (unit_conversion_mismatch / unit_factor_* verdicts).
 *
 * Nothing else about the form changed: same validation-before-enqueue, same single
 * product.upsert operation that registers product + initial stock exactly once, same
 * durable-before-success rule (the SQLite/IndexedDB enqueue commits before the success banner).
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { costPerBaseUnit, formatQty, formatRwf, lineAmount, parseQty, priceBelowCost, profitPerBaseUnit, toBaseQty } from "@sms/shared";
import { Badge, Banner, Button, Card, DataTable, Empty, Field, KeyValue, Modal, Screen, Segmented, useWide } from "../../src/components/ui";
import { enqueue, listProducts, listSuppliers, upsertLocalProduct, type LocalProduct } from "../../src/database/local";
import { useT } from "../../src/localization";
import { request, useSession } from "../../src/services/api";
import { refreshCounts, syncNow, useSync } from "../../src/synchronization/engine";
import { dayToDate, parseRwf, qtyOrNull, todayDay, uuid } from "../../src/services/util";
import { space, radius, type, useTheme } from "../../src/theme/tokens";

type Filter = "all" | "low" | "pending";
/** The units a small shop buys and sells in — one tap instead of typing (the field still accepts any unit). */
const UNITS = ["pcs", "kg", "bag", "bottle", "litre", "box", "packet"];
const countedValue = (s: string): number | null => { try { const q = parseQty(s.replace(",", ".")); return q >= 0 ? q : null; } catch { return null; } };

/** Display helpers shared by the forms: base unit is the ledger truth, natural units are for people. */
const purchaseUnitOf = (p: LocalProduct) => p.purchase_unit ?? p.unit;
const sellingUnitOf = (p: LocalProduct) => p.selling_unit ?? p.unit;
const unitsPurchaseOf = (p: LocalProduct) => p.units_per_purchase ?? 1;
const unitsSellingOf = (p: LocalProduct) => p.units_per_selling ?? 1;

export default function Stock() {
  const t = useT(); const c = useTheme(); const user = useSession((s) => s.user)!; const wide = useWide(); const v = useSync((s) => s.dataVersion);
  const [q, setQ] = useState(""); const [filter, setFilter] = useState<Filter>("all"); const [rows, setRows] = useState<LocalProduct[]>([]);
  const [counting, setCounting] = useState(false); const [counts, setCounts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const fEmpty = { code: "", barcode: "", name: "", category: "", unit: "pcs", price: "", low: "0", qty: "", cost: "", convert: false, purchaseUnit: "", perPurchase: "1", sellingUnit: "", perSelling: "1" };
  const [f, setF] = useState(fEmpty);
  const [fErr, setFErr] = useState<Record<string, string | null>>({});

  // Add stock = a purchase received immediately against the SAME product. Edit = product details only.
  const emptyStock = () => ({ qty: "", cost: "", selling: "", paid: "", supplier: "", reference: "", date: todayDay(), notes: "", belowReason: "" });
  const [stocking, setStocking] = useState<LocalProduct | null>(null);
  const [s, setS] = useState(emptyStock());
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [policy, setPolicy] = useState<{ belowCostPolicy: "acknowledge" | "block" } | null>(null);
  const [sErr, setSErr] = useState<string | null>(null); const [sBusy, setSBusy] = useState(false);
  const [editing, setEditing] = useState<LocalProduct | null>(null);
  const [e, setE] = useState({ code: "", barcode: "", name: "", unit: "", price: "", low: "" });
  const [eErr, setEErr] = useState<string | null>(null); const [eBusy, setEBusy] = useState(false);
  const params = useLocalSearchParams<{ count?: string }>();

  useEffect(() => { void listProducts(q).then(setRows).catch(() => setRows([])); }, [q, v, msg]);
  useEffect(() => {
    let live = true;
    request<{ belowCostPolicy: "acknowledge" | "block" }>("/shop/settings")
      .then((p) => { if (live) setPolicy(p); }).catch(() => { if (live) setPolicy(null); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!stocking) return;
    let live = true;
    void listSuppliers().then((r) => { if (live) setSuppliers(r); }).catch(() => { if (live) setSuppliers([]); });
    return () => { live = false; };
  }, [stocking]);
  useEffect(() => { if (params.count === "1") { setCounting(true); setAdding(false); setErr(null); } }, [params.count]);

  const eff = (p: LocalProduct) => p.on_hand + p.pending_delta;
  const shown = rows.filter((p) => (filter === "low" ? eff(p) <= p.low_threshold : filter === "pending" ? p.pending_delta !== 0 : true));
  const lowCount = rows.filter((p) => eff(p) <= p.low_threshold).length;

  /**
   * Add product = product + its initial stock in ONE save (validated field by field).
   * The optimistic pending_delta is released when the server verdict arrives, and the operation
   * id is created once, so a retried sync can never register the stock twice.
   */
  async function addProduct() {
    const price = parseRwf(f.price);
    const qty = qtyOrNull(f.qty);        // milli PURCHASE units when converting, else milli base units
    const cost = parseRwf(f.cost);       // RWF per PURCHASE unit when converting, else per base unit
    const low = qtyOrNull(f.low);
    const perPurchase = f.convert ? Number(f.perPurchase.trim()) : 1;
    const perSelling = f.convert ? Number(f.perSelling.trim()) : 1;
    const e: Record<string, string | null> = {};
    if (!f.name.trim()) e.name = t("stock.errName");
    if (!f.unit.trim()) e.unit = t("stock.errUnit");
    if (qty === null || qty <= 0) e.qty = t("stock.errQty");
    if (cost === null || cost < 0) e.cost = t("stock.errCost");
    if (price === null || price <= 0) e.price = t("stock.errPrice");
    if (low === null) e.low = t("stock.errThreshold");
    if (f.convert) {
      if (!Number.isInteger(perPurchase) || perPurchase < 1) e.perPurchase = t("stock.errPerPurchase");
      if (!Number.isInteger(perSelling) || perSelling < 1) e.perSelling = t("stock.errPerSelling");
      if (!f.purchaseUnit.trim()) e.purchaseUnit = t("stock.errPurchaseUnit");
      if (!f.sellingUnit.trim()) e.sellingUnit = t("stock.errSellingUnit");
    }
    setFErr(e);
    if (Object.values(e).some(Boolean)) { setErr(t("stock.addInvalid")); return; }
    // Guaranteed present and valid by the field checks above. The ledger always receives BASE
    // quantities and a BASE unit cost; the natural entries are converted here (the same function
    // the server uses to verify them).
    const [qtyV, costV, priceV, lowV, up, us] = [qty, cost, price, low, perPurchase, perSelling] as [number, number, number, number, number, number];
    const baseInitial = toBaseQty(qtyV, up);
    const baseCost = costPerBaseUnit(costV, up);
    setErr(null); setBusy(true);
    const id = uuid(); const barcode = f.barcode.trim() || null;
    const code = f.code.trim() || `SKU-${id.slice(0, 8).toUpperCase()}`; // optional field: generated when left empty
    const purchaseUnit = f.convert ? f.purchaseUnit.trim() : undefined;
    const sellingUnit = f.convert ? f.sellingUnit.trim() : undefined;
    const payload = {
      productId: id, code, barcode, name: f.name.trim(), category: f.category.trim() || undefined,
      unit: f.unit.trim(), sellingPrice: priceV, lowStockThreshold: lowV,
      purchaseUnit, sellingUnit, unitsPerPurchase: up, unitsPerSelling: us,
      initialQty: baseInitial, initialUnitCost: baseCost,
    };
    const deltas = { [id]: baseInitial };
    try {
      await enqueue(user.id, uuid(), "product.upsert", payload, deltas, () => upsertLocalProduct({
        id, code, barcode, name: payload.name, category: payload.category ?? null, unit: payload.unit,
        sellingPrice: priceV, lowStockThreshold: lowV, initialQty: baseInitial,
        purchaseUnit, sellingUnit, unitsPerPurchase: up, unitsPerSelling: us,
      }));
      setF({ ...fEmpty }); setFErr({}); setAdding(false); setMsg(t("stock.added"));
      await refreshCounts(); void syncNow();
    } catch { setErr(t("common.error")); } finally { setBusy(false); }
  }

  async function submitCount() {
    const lines = Object.entries(counts).map(([productId, s]) => ({ productId, counted: countedValue(s) })).filter((l): l is { productId: string; counted: number } => l.counted !== null);
    if (!lines.length) { setErr(t("stock.countEmpty")); return; }
    setErr(null); setBusy(true);
    try {
      const countedAt = new Date().toISOString();
      await enqueue(user.id, uuid(), "count.submit", { countId: uuid(), countedAt, lines }, {}, undefined, countedAt);
      setCounts({}); setCounting(false); setMsg(t("stock.countSaved"));
      await refreshCounts(); void syncNow();
    } catch { setErr(t("common.error")); } finally { setBusy(false); }
  }

  function openStock(p: LocalProduct) {
    setEditing(null); setSErr(null); setStocking(p);
    setS({ ...emptyStock(), selling: String(p.selling_price) });
    // The confirmed shelf figure comes from the server when it is reachable, so "current stock"
    // cannot show a stale local copy; offline the cached quantity is all we have.
    request<{ items: { id: string; onHand: number }[] }>("/reports/inventory")
      .then((r) => {
        const item = r.items.find((i) => i.id === p.id);
        if (item) setStocking((prev) => (prev && prev.id === p.id ? { ...prev, on_hand: Number(item.onHand) } : prev));
      })
      .catch(() => { /* offline: keep the local figure */ });
  }

  function openEdit(p: LocalProduct) {
    setStocking(null); setEErr(null); setEditing(p);
    setE({ code: p.code, barcode: p.barcode ?? "", name: p.name, unit: p.unit, price: String(p.selling_price), low: formatQty(p.low_threshold) });
  }

  /** Receives more of an existing product: a purchase received immediately, never a second product. */
  async function saveStock() {
    if (!stocking || sBusy) return;
    const up = unitsPurchaseOf(stocking); const us = unitsSellingOf(stocking);
    const qty = qtyOrNull(s.qty); const cost = parseRwf(s.cost); const selling = parseRwf(s.selling); const at = dayToDate(s.date);
    if (qty === null) { setSErr(t("stock.invalidQty")); return; }
    if (cost === null) { setSErr(t("stock.invalidCost")); return; }
    if (selling === null) { setSErr(t("stock.invalidSelling")); return; }
    if (!at) { setSErr(t("expense.dateError")); return; }
    // Natural entries -> base ledger figures. When up === 1 this is the identity transform, so
    // simple products behave exactly as before.
    const baseQty = toBaseQty(qty, up);
    const baseCost = costPerBaseUnit(cost, up);
    const total = lineAmount(baseQty, baseCost);
    const paid = s.paid.trim() ? parseRwf(s.paid) : total;
    if (paid === null || paid > total) { setSErr(t("receive.paidTooHigh")); return; }
    const below = priceBelowCost(selling, us, baseCost);
    if (below && policy?.belowCostPolicy === "block" && user.role !== "owner") { setSErr(t("receive.belowCostBlocked")); return; }
    if (below && s.belowReason.trim().length < 3) { setSErr(t("receive.belowCostReasonRequired")); return; }
    setSErr(null); setSBusy(true);
    const when = new Date(at); when.setHours(12, 0, 0, 0);
    const payload = {
      purchaseId: uuid(), supplierId: s.supplier || null, orderedAt: when.toISOString(), amountPaid: paid, receiveNow: true,
      reference: s.reference.trim() ? s.reference.trim().slice(0, 80) : undefined,
      notes: s.notes.trim() ? s.notes.trim().slice(0, 500) : undefined,
      belowCostAcknowledged: below,
      belowCostReason: below ? s.belowReason.trim().slice(0, 500) : undefined,
      lines: [{
        productId: stocking.id, qty: baseQty, unitCost: baseCost, sellingPrice: selling,
        // Natural quantity + factor let the server verify the conversion (and are stored as the
        // original units and quantities entered).
        purchaseQty: qty, unitFactor: up, purchaseUnit: purchaseUnitOf(stocking),
      }],
    };
    try {
      // The operation id is created once per save; a retried sync reuses it and the server deduplicates.
      await enqueue(user.id, uuid(), "purchase.create", payload, { [stocking.id]: baseQty }, undefined, when.toISOString());
      setStocking(null); setS(emptyStock()); setMsg(t("stock.stockSaved"));
      await refreshCounts(); void syncNow();
    } catch { setSErr(t("common.error")); } finally { setSBusy(false); }
  }

  /** Edits product details only: no ledger movement, so stock and history are untouched. */
  async function saveEdit() {
    if (!editing || eBusy) return;
    const price = parseRwf(e.price);
    if (!e.code.trim() || !e.name.trim() || price === null) { setEErr(t("stock.addInvalid")); return; }
    setEErr(null); setEBusy(true);
    const payload = {
      productId: editing.id, code: e.code.trim(), barcode: e.barcode.trim() || null, name: e.name.trim(),
      category: editing.category ?? undefined, unit: e.unit.trim() || "pcs", sellingPrice: price,
      lowStockThreshold: qtyOrNull(e.low) ?? 0,
      // NOTE: no unit configuration here on purpose. The server locks conversion on an existing
      // product (unit_config_locked) — changing it would reinterpret historical quantities.
    };
    try {
      await enqueue(user.id, uuid(), "product.upsert", payload, {}, () => upsertLocalProduct({
        id: editing.id, code: payload.code, barcode: payload.barcode, name: payload.name,
        unit: payload.unit, sellingPrice: price, lowStockThreshold: payload.lowStockThreshold,
      }));
      setEditing(null); setMsg(t("stock.productSaved"));
      await refreshCounts(); void syncNow();
    } catch { setEErr(t("common.error")); } finally { setEBusy(false); }
  }

  const stockQty = qtyOrNull(s.qty);
  // Live figures for the Add Product form, recomputed on every keystroke (RWF, integer math).
  const convPerPurchase = f.convert ? Number(f.perPurchase.trim()) : 1;
  const convPerSelling = f.convert ? Number(f.perSelling.trim()) : 1;
  const convOkP = Number.isInteger(convPerPurchase) && convPerPurchase >= 1;
  const convOkS = Number.isInteger(convPerSelling) && convPerSelling >= 1;
  const newQty = qtyOrNull(f.qty);
  const newCost = parseRwf(f.cost);
  const newPrice = parseRwf(f.price);
  const newBaseQty = newQty !== null && convOkP ? toBaseQty(newQty, convPerPurchase) : null;
  const newBaseCost = newCost !== null && convOkP ? costPerBaseUnit(newCost, convPerPurchase) : null;
  const newTotal = newBaseQty !== null && newBaseCost !== null && newBaseQty > 0 ? lineAmount(newBaseQty, newBaseCost) : null;
  const newCostPerBase = newCost !== null && convOkP ? costPerBaseUnit(newCost, convPerPurchase) : null; // same rounding as the ledger
  const newPricePerBase = newPrice !== null && convOkS ? Math.floor(newPrice / convPerSelling) : null;
  const newProfit = newCostPerBase !== null && newPricePerBase !== null ? newPricePerBase - newCostPerBase : null;
  const newMargin = newProfit !== null && newPrice !== null && newPrice > 0 ? Math.round((newProfit / newPrice) * 1000) / 10 : null;
  const newBelow = newPrice !== null && newBaseCost !== null && priceBelowCost(newPrice, convOkS ? convPerSelling : 1, newBaseCost);
  const stockCost = parseRwf(s.cost);
  const stockSelling = parseRwf(s.selling);
  const stockBaseQty = stockQty !== null && stocking ? toBaseQty(stockQty, unitsPurchaseOf(stocking)) : null;
  const stockBaseCost = stockCost !== null && stocking ? costPerBaseUnit(stockCost, unitsPurchaseOf(stocking)) : null;
  const stockTotal = stockBaseQty !== null && stockBaseCost !== null ? lineAmount(stockBaseQty, stockBaseCost) : null;
  const stockBelow = stockBaseCost !== null && stockSelling !== null && priceBelowCost(stockSelling, stocking ? unitsSellingOf(stocking) : 1, stockBaseCost);
  const stockPaid = s.paid.trim() ? parseRwf(s.paid) : stockTotal;

  return (
    <Screen title={t("stock.title")} subtitle={t("stock.subtitle")} actions={
      <>
        <Button testID="stock-add-toggle" kind="secondary" label={adding ? t("common.cancel") : t("stock.addProduct")} onPress={() => { setAdding(!adding); setErr(null); }} />
        {user.role === "manager" ? <Button testID="stock-count-toggle" label={counting ? t("common.cancel") : t("stock.count")} onPress={() => { setCounting(!counting); setErr(null); }} /> : null}
      </>
    }>
      {msg ? <Banner tone="ok" text={msg} /> : null}
      {err ? <Banner tone="danger" text={err} /> : null}

      {adding ? (
        <Card style={{ gap: space.md }}>
          <Text style={{ color: c.ink, ...type.h2 }}>{t("stock.addProduct")}</Text>

          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("stock.sectionProduct")}</Text>
          <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
            <Field containerStyle={{ flexBasis: 220, flexGrow: 1 }} testID="stock-name" label={`${t("stock.productName")} *`} value={f.name}
              onChangeText={(x) => { setFErr({ ...fErr, name: null }); setErr(null); setF({ ...f, name: x }); }}
              error={fErr.name} placeholder={t("stock.productNamePlaceholder")} />
            <Field containerStyle={{ flexBasis: 160 }} testID="stock-code" label={t("stock.code")} value={f.code} autoCapitalize="characters"
              onChangeText={(x) => setF({ ...f, code: x })} hint={t("stock.codeAuto")} />
          </View>
          <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
            <Field containerStyle={{ flexBasis: 220, flexGrow: 1 }} testID="stock-barcode" label={t("stock.barcode")} value={f.barcode} maxLength={64} autoCorrect={false}
              onChangeText={(x) => setF({ ...f, barcode: x })} hint={t("stock.barcodeHelp")} />
            <Field containerStyle={{ flexBasis: 160 }} testID="stock-category" label={t("stock.category")} value={f.category}
              onChangeText={(x) => setF({ ...f, category: x })} hint={t("common.optional")} />
          </View>
          <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
            <Field containerStyle={{ flexBasis: 160 }} testID="stock-unit" label={`${t("stock.baseUnit")} *`} value={f.unit}
              onChangeText={(x) => { setFErr({ ...fErr, unit: null }); setF({ ...f, unit: x }); }} error={fErr.unit} hint={t("stock.baseUnitHelp")} />
          </View>
          <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
            {UNITS.map((u) => {
              const on = f.unit.trim().toLowerCase() === u;
              return (
                <Pressable key={u} testID={`stock-unit-pick-${u}`} accessibilityRole="button" accessibilityLabel={u}
                  onPress={() => { setFErr({ ...fErr, unit: null }); setF({ ...f, unit: u }); }}
                  style={({ hovered, pressed }: any) => ({ paddingVertical: 6, paddingHorizontal: 10, borderRadius: radius.sm, borderWidth: 1,
                    borderColor: on ? c.primary : c.lineStrong, backgroundColor: on ? c.surfaceMuted : c.surface, opacity: pressed ? 0.85 : hovered ? 0.95 : 1 })}>
                  <Text style={{ color: on ? c.primaryStrong : c.inkSoft, fontSize: 12, fontWeight: "600" }}>{u}</Text>
                </Pressable>
              );
            })}
          </View>

          {/* Conversion toggle: OFF keeps the original simple form, ON reveals purchase/selling configuration. */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
            <Button size="sm" kind={f.convert ? "secondary" : "quiet"} testID="stock-convert-toggle"
              label={`${t("stock.convertToggle")}: ${f.convert ? t("common.on") : t("common.off")}`}
              onPress={() => { setFErr({}); setF({ ...f, convert: !f.convert }); }} />
            <Text style={{ color: c.muted, fontSize: 11, flex: 1, minWidth: 180 }}>{t("stock.convertHelp")}</Text>
          </View>

          {f.convert ? (
            <>
              <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("stock.sectionPurchase")}</Text>
              <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
                <Field containerStyle={{ flexBasis: 150 }} testID="stock-purchase-unit" label={`${t("stock.purchaseUnit")} *`} value={f.purchaseUnit}
                  onChangeText={(x) => { setFErr({ ...fErr, purchaseUnit: null }); setF({ ...f, purchaseUnit: x }); }} error={fErr.purchaseUnit}
                  hint={t("stock.purchaseUnitHint")} />
                <Field containerStyle={{ flexBasis: 170 }} testID="stock-per-purchase" label={`${t("stock.unitsPerPurchase")} *`} value={f.perPurchase} keyboardType="number-pad"
                  onChangeText={(x) => { setFErr({ ...fErr, perPurchase: null }); setF({ ...f, perPurchase: x }); }} error={fErr.perPurchase}
                  hint={t("stock.unitsPerPurchaseHint")} />
              </View>
              <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
                {UNITS.filter((u) => u !== "pcs").map((u) => {
                  const on = f.purchaseUnit.trim().toLowerCase() === u;
                  return (
                    <Pressable key={u} testID={`stock-purchase-unit-pick-${u}`} accessibilityRole="button" accessibilityLabel={u}
                      onPress={() => { setFErr({ ...fErr, purchaseUnit: null }); setF({ ...f, purchaseUnit: u }); }}
                      style={({ hovered, pressed }: any) => ({ paddingVertical: 6, paddingHorizontal: 10, borderRadius: radius.sm, borderWidth: 1,
                        borderColor: on ? c.primary : c.lineStrong, backgroundColor: on ? c.surfaceMuted : c.surface, opacity: pressed ? 0.85 : hovered ? 0.95 : 1 })}>
                      <Text style={{ color: on ? c.primaryStrong : c.inkSoft, fontSize: 12, fontWeight: "600" }}>{u}</Text>
                    </Pressable>
                  );
                })}
              </View>

              <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("stock.sectionSelling")}</Text>
              <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
                <Field containerStyle={{ flexBasis: 150 }} testID="stock-selling-unit" label={`${t("stock.sellingUnit")} *`} value={f.sellingUnit}
                  onChangeText={(x) => { setFErr({ ...fErr, sellingUnit: null }); setF({ ...f, sellingUnit: x }); }} error={fErr.sellingUnit}
                  hint={t("stock.sellingUnitHint")} />
                <Field containerStyle={{ flexBasis: 170 }} testID="stock-per-selling" label={`${t("stock.unitsPerSelling")} *`} value={f.perSelling} keyboardType="number-pad"
                  onChangeText={(x) => { setFErr({ ...fErr, perSelling: null }); setF({ ...f, perSelling: x }); }} error={fErr.perSelling}
                  hint={t("stock.unitsPerSellingHint")} />
              </View>
            </>
          ) : null}

          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("stock.sectionInitial")}</Text>
          <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
            <Field containerStyle={{ flexBasis: 170 }} testID="stock-qty" label={`${f.convert ? t("stock.initialPurchaseQty") : t("stock.qtyReceived")} (${f.convert ? (f.purchaseUnit.trim() || t("stock.purchaseUnit")) : f.unit.trim()}) *`} value={f.qty} keyboardType="decimal-pad"
              onChangeText={(x) => { setFErr({ ...fErr, qty: null }); setErr(null); setF({ ...f, qty: x }); }} error={fErr.qty} hint={f.convert ? t("stock.initialQtyHelp") : t("stock.qtyHelp")} />
            <Field containerStyle={{ flexBasis: 170 }} testID="stock-cost" label={`${t("stock.costPerUnit")} (${f.convert ? (f.purchaseUnit.trim() || t("stock.purchaseUnit")) : f.unit.trim()}) *`} value={f.cost} keyboardType="number-pad"
              onChangeText={(x) => { setFErr({ ...fErr, cost: null }); setErr(null); setF({ ...f, cost: x }); }} error={fErr.cost} hint={f.convert ? t("stock.costPerPurchaseHelp") : t("stock.costHelp")} />
          </View>

          <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("stock.sectionSelling")}</Text>
          <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
            <Field containerStyle={{ flexBasis: 170 }} testID="stock-price" label={`${t("stock.sellingPrice")} (${f.convert ? (f.sellingUnit.trim() || t("stock.sellingUnit")) : f.unit.trim()}) *`} value={f.price} keyboardType="number-pad"
              onChangeText={(x) => { setFErr({ ...fErr, price: null }); setErr(null); setF({ ...f, price: x }); }} error={fErr.price} hint={f.convert ? t("stock.pricePerSellingHelp") : t("receive.priceHelp")} />
            <Field containerStyle={{ flexBasis: 170 }} testID="stock-low" label={`${t("stock.lowThreshold")} (${f.unit.trim()}) *`} value={f.low} keyboardType="decimal-pad"
              onChangeText={(x) => { setFErr({ ...fErr, low: null }); setErr(null); setF({ ...f, low: x }); }} error={fErr.low} hint={t("stock.thresholdHelp")} />
          </View>

          <Card tone="muted" style={{ gap: 2, padding: space.md }}>
            {f.convert && convOkP ? (
              <KeyValue label={t("stock.conversionLine")}
                value={<Text testID="stock-calc-conversion">{`1 ${f.purchaseUnit.trim() || "?"} = ${formatQty(toBaseQty(1000, convPerPurchase))} ${f.unit.trim()}`}</Text>} />
            ) : null}
            <KeyValue label={t("stock.initialStock")} value={<Text testID="stock-calc-initial">{newBaseQty === null ? "—" : `${formatQty(newBaseQty)} ${f.unit.trim()}`}</Text>} />
            <KeyValue label={t("stock.totalCost")} value={<Text testID="stock-calc-total">{newTotal === null ? formatRwf(0) : formatRwf(newTotal)}</Text>} />
            <KeyValue label={`${t("stock.costPerBase")} (${f.unit.trim()})`} value={<Text testID="stock-calc-cost-per-base">{newCostPerBase === null ? "—" : formatRwf(newCostPerBase)}</Text>} />
            <KeyValue label={t("stock.profitPerUnit")} value={<Text testID="stock-calc-profit">{newProfit === null ? "—" : formatRwf(newProfit)}</Text>} />
            <KeyValue strong label={t("stock.marginPct")} value={<Text testID="stock-calc-margin">{newMargin === null ? "—" : `${newMargin}%`}</Text>} />
            {newBelow ? <Banner tone="warn" title={t("receive.belowCostTitle")} text={t("receive.belowCostHelp")} /> : null}
            <Text style={{ color: c.muted, fontSize: 11, lineHeight: 16 }}>{t("stock.costNotExpense")}</Text>
          </Card>

          <Button testID="stock-save-product" label={t("common.save")} loading={busy} onPress={() => void addProduct()} />
          <Text style={{ color: c.muted, fontSize: 11 }}>{t("sync.savedLocally")}</Text>
        </Card>
      ) : null}

      <View style={{ flexDirection: wide ? "row" : "column", gap: space.md, alignItems: wide ? "center" : "stretch" }}>
        <View style={{ flex: 1 }}><Field testID="stock-search" label={t("common.search")} placeholder={t("stock.searchPlaceholder")} value={q} onChangeText={setQ} autoCorrect={false} /></View>
        <Segmented value={filter} onChange={setFilter} label={t("stock.filter")} options={[{ value: "all", label: `${t("common.all")} (${rows.length})` }, { value: "low", label: `${t("stock.low")} (${lowCount})` }, { value: "pending", label: t("sync.pending") }]} />
      </View>

      {counting ? (
        <View style={{ gap: space.md }}>
          <Banner tone="warn" title={t("stock.countTitle")} text={t("stock.countHelp")} />
          {shown.length ? shown.map((p) => {
            const raw = counts[p.id] ?? ""; const counted = raw === "" ? null : countedValue(raw);
            const diff = counted === null ? null : counted - eff(p);
            return (
              <Card key={p.id} style={{ padding: space.md, gap: space.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{p.name}</Text>
                    <Text style={{ color: c.muted, fontSize: 12 }}>{t("stock.expected")}: {formatQty(eff(p))} {p.unit}</Text>
                  </View>
                  {diff === null ? null : diff === 0 ? <Badge tone="ok" label={t("stock.matches")} /> : <Badge tone="danger" label={`${diff > 0 ? "+" : ""}${formatQty(diff)} ${p.unit}`} />}
                </View>
                <Field testID={`stock-count-input-${p.id}`} label={t("stock.counted")} value={raw} keyboardType="decimal-pad"
                  onChangeText={(x) => setCounts((s) => ({ ...s, [p.id]: x }))} placeholder={formatQty(eff(p))} />
              </Card>
            );
          }) : <Empty icon="layers" title={t("stock.noProducts")} description={t("stock.noProductsDesc")} />}
          <Button testID="stock-count-submit" label={t("stock.submitCount")} loading={busy} onPress={() => void submitCount()} disabled={!Object.keys(counts).length} />
        </View>
      ) : (
        <DataTable rows={shown} rowTitle={(p) => <View><Text style={{ color: c.ink, fontWeight: "700", fontSize: 14 }}>{p.name}</Text><Text style={{ color: c.muted, fontSize: 11 }}>{p.code}</Text></View>}
          empty={<Empty icon={rows.length ? "search" : "layers"} title={rows.length ? t("stock.noMatch") : t("stock.noProducts")} description={rows.length ? t("stock.noMatchDesc") : t("stock.noProductsDesc")}
            action={!rows.length ? <Button kind="secondary" label={t("stock.addProduct")} onPress={() => setAdding(true)} /> : null} />}
          cols={[
            { key: "name", title: t("common.product"), width: 2.2, render: (p) => <View><Text style={{ color: c.ink, fontWeight: "600", fontSize: 14 }}>{p.name}</Text><Text style={{ color: c.muted, fontSize: 11 }}>{p.code}</Text></View> },
            { key: "on_hand", title: t("stock.onHand"), align: "right", width: 1.3, render: (p) => (
              <View style={{ alignItems: "flex-end", gap: 2 }}>
                <Text style={{ color: c.ink, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatQty(eff(p))} {p.unit}</Text>
                {p.pending_delta ? <Badge tone="warn" label={t("sync.pending")} /> : null}
              </View>
            ) },
            { key: "selling_price", title: t("common.price"), align: "right", width: 1, render: (p) => (
              <View style={{ alignItems: "flex-end", gap: 2 }}>
                <Text style={{ color: c.inkSoft, fontVariant: ["tabular-nums"] }}>{formatRwf(p.selling_price)}</Text>
                {sellingUnitOf(p) !== p.unit ? <Text style={{ color: c.muted, fontSize: 10 }}>/ {sellingUnitOf(p)}</Text> : null}
              </View>
            ) },
            { key: "low", title: t("common.status"), align: "right", width: 1, render: (p) => (
              eff(p) <= 0 ? <Badge tone="danger" dot label={t("sell.outOfStock")} />
                : eff(p) <= p.low_threshold ? <Badge tone="warn" label={t("stock.low")} />
                : <Badge tone="ok" label={t("stock.ok")} />) },
            { key: "actions", title: t("stock.actions"), align: "right", width: 1.9, render: (p) => (
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <Button size="sm" kind="secondary" testID={`stock-add-stock-${p.code}`} label={t("stock.addStock")} onPress={() => openStock(p)} />
                <Button size="sm" kind="quiet" testID={`stock-edit-${p.code}`} label={t("common.edit")} onPress={() => openEdit(p)} />
              </View>
            ) },
          ]} />
      )}

      <Modal open={!!stocking} onClose={() => setStocking(null)} scroll
        title={t("stock.addStock")} description={stocking ? `${stocking.name} · ${stocking.code}` : undefined}
        footer={<>
          <Button kind="secondary" label={t("common.cancel")} onPress={() => setStocking(null)} disabled={sBusy} />
          <Button testID="stock-save-stock" label={t("stock.addStock")} loading={sBusy} onPress={() => void saveStock()} />
        </>}>
        {stocking ? (
          <>
            <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("stock.addStockHelp")}</Text>
            {sErr ? <Banner tone="danger" text={sErr} /> : null}
            <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
              <Field containerStyle={{ flexBasis: 130 }} testID="stock-qty-received" label={`${t("stock.qtyReceived")} (${purchaseUnitOf(stocking)})`} value={s.qty}
                keyboardType="decimal-pad" onChangeText={(x) => { setSErr(null); setS({ ...s, qty: x }); }} />
              <Field containerStyle={{ flexBasis: 130 }} testID="stock-unit-cost" label={`${t("common.cost")} / ${purchaseUnitOf(stocking)}`} value={s.cost}
                keyboardType="number-pad" onChangeText={(x) => { setSErr(null); setS({ ...s, cost: x }); }} />
              <Field containerStyle={{ flexBasis: 130 }} testID="stock-selling-price" label={`${t("common.price")} / ${sellingUnitOf(stocking)}`} value={s.selling}
                keyboardType="number-pad" onChangeText={(x) => setS({ ...s, selling: x })} hint={t("receive.priceHelp")} />
              <Field containerStyle={{ flexBasis: 130 }} testID="stock-paid" label={t("receive.payNow")} value={s.paid}
                keyboardType="number-pad" onChangeText={(x) => setS({ ...s, paid: x })}
                hint={stockTotal === null ? t("receive.payHelp") : `${t("receive.remainingToPay")}: ${formatRwf(Math.max(0, stockTotal - (stockPaid ?? 0)))}`} />
            </View>
            <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap", alignItems: "flex-end" }}>
              <Field containerStyle={{ flexBasis: 150 }} testID="stock-reference" label={t("receive.reference")} value={s.reference}
                onChangeText={(x) => setS({ ...s, reference: x })} placeholder={t("receive.referencePlaceholder")} />
              <Field containerStyle={{ flexBasis: 130 }} testID="stock-date" label={t("receive.purchaseDate")} value={s.date}
                onChangeText={(x) => setS({ ...s, date: x })} placeholder="YYYY-MM-DD" hint={t("expense.dateHelp")} error={s.date && !dayToDate(s.date) ? t("expense.dateError") : null} />
            </View>
            <Text style={{ color: c.muted, ...type.caption, textTransform: "uppercase" }}>{t("receive.supplierOptional")}</Text>
            <Segmented value={s.supplier} onChange={(x) => setS({ ...s, supplier: x })} label={t("common.supplier")}
              options={[{ value: "", label: t("common.none") }, ...suppliers.map((x) => ({ value: x.id, label: x.name }))]} />
            <Field testID="stock-notes" label={t("common.note")} value={s.notes} onChangeText={(x) => setS({ ...s, notes: x })}
              placeholder={t("receive.notesPlaceholder")} hint={t("common.optional")} />
            <Text style={{ color: c.muted, fontSize: 11 }}>{t("receive.responsible")}: <Text style={{ color: c.inkSoft, fontWeight: "600" }}>{user.name}</Text></Text>
            <Card tone="muted" style={{ gap: 2, padding: space.md }}>
              {unitsPurchaseOf(stocking) !== 1 ? (
                <KeyValue label={t("stock.conversionLine")}
                  value={`1 ${purchaseUnitOf(stocking)} = ${formatQty(toBaseQty(1000, unitsPurchaseOf(stocking)))} ${stocking.unit}`} />
              ) : null}
              <KeyValue label={t("stock.currentStock")} value={<Text testID="stock-preview-current">{`${formatQty(eff(stocking))} ${stocking.unit}`}</Text>} />
              <KeyValue label={`${t("stock.qtyReceived")} (${stocking.unit})`} value={`+${formatQty(stockBaseQty ?? 0)} ${stocking.unit}`} />
              {unitsPurchaseOf(stocking) !== 1 && stockQty !== null && stockBaseQty !== null ? (
                <KeyValue label={`${t("stock.qtyReceived")} (${purchaseUnitOf(stocking)})`} value={`${formatQty(stockQty)} ${purchaseUnitOf(stocking)} → ${formatQty(stockBaseQty)} ${stocking.unit}`} />
              ) : null}
              <KeyValue strong label={t("stock.newStock")} value={<Text testID="stock-preview-after">{`${formatQty(eff(stocking) + (stockBaseQty ?? 0))} ${stocking.unit}`}</Text>} />
              <KeyValue label={t("stock.totalCost")} value={<Text testID="stock-preview-total">{stockTotal === null ? "—" : formatRwf(stockTotal)}</Text>} />
            </Card>
            {stockBelow ? (
              <Banner tone="warn" title={t("receive.belowCostTitle")} text={t("receive.belowCostHelp")} />
            ) : null}
            {stockBelow ? (
              <Field testID="stock-below-reason" label={t("receive.belowCostReason")} value={s.belowReason}
                onChangeText={(x) => setS({ ...s, belowReason: x })} placeholder={t("receive.belowCostReasonPlaceholder")}
                hint={t("receive.belowCostReasonHelp")} />
            ) : null}
            <Text style={{ color: c.muted, fontSize: 11 }}>{t("sync.savedLocally")}</Text>
          </>
        ) : null}
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} scroll
        title={t("stock.editProduct")} description={editing ? `${editing.name} · ${formatQty(eff(editing))} ${editing.unit}` : undefined}
        footer={<>
          <Button kind="secondary" label={t("common.cancel")} onPress={() => setEditing(null)} disabled={eBusy} />
          <Button testID="stock-save-product-edit" label={t("common.save")} loading={eBusy} onPress={() => void saveEdit()} />
        </>}>
        {editing ? (
          <>
            <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{t("stock.editHelp")}</Text>
            {eErr ? <Banner tone="danger" text={eErr} /> : null}
            <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
              <Field containerStyle={{ flexBasis: 170 }} testID="stock-edit-name" label={t("common.product")} value={e.name} onChangeText={(x) => { setEErr(null); setE({ ...e, name: x }); }} />
              <Field containerStyle={{ flexBasis: 130 }} testID="stock-edit-code" label={t("stock.code")} value={e.code} onChangeText={(x) => setE({ ...e, code: x })}
                autoCapitalize="characters" hint={t("stock.codeHelp")} />
            </View>
            <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
              <Field containerStyle={{ flexBasis: 170 }} testID="stock-edit-barcode" label={t("stock.barcode")} value={e.barcode} maxLength={64} autoCorrect={false} onChangeText={(x) => setE({ ...e, barcode: x })} />
              <Field containerStyle={{ flexBasis: 110 }} label={t("stock.unit")} value={e.unit} onChangeText={(x) => setE({ ...e, unit: x })} hint={t("stock.unitHelp")} />
            </View>
            <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
              <Field containerStyle={{ flexBasis: 130 }} testID="stock-edit-price" label={`${t("common.price")} / ${sellingUnitOf(editing)}`} value={e.price} keyboardType="number-pad" onChangeText={(x) => setE({ ...e, price: x })} />
              <Field containerStyle={{ flexBasis: 130 }} label={`${t("stock.lowThreshold")} (${editing.unit})`} value={e.low} keyboardType="decimal-pad" onChangeText={(x) => setE({ ...e, low: x })} />
            </View>
            {editing.units_per_purchase !== 1 || editing.units_per_selling !== 1 ? (
              <Banner tone="warn" title={t("stock.unitConfigLockedTitle")}
                text={t("stock.unitConfigLocked").replace("{purchase}", `${formatQty(toBaseQty(1000, editing.units_per_purchase ?? 1))} ${editing.unit}`).replace("{selling}", String(editing.units_per_selling ?? 1))} />
            ) : null}
          </>
        ) : null}
      </Modal>
    </Screen>
  );
}