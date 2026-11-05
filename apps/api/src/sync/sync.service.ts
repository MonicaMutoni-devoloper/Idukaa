import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { Operation, lineAmount, priceBelowCost, toBaseQty, type OperationT, type OpResult } from "@sms/shared";
import { Db } from "../db/db.service";
import { audit } from "../audits/audit";
import { canRunOp } from "./op-permissions";
import type { AuthUser } from "../common/auth";

type Kind = "conflict" | "rejected" | "pending_approval";
class BizError extends Error { constructor(public kind: Kind, message: string) { super(message); } }

// Operation roles live in `op-permissions.ts`: OWNER = every manager operation + owner-only routes.
// (The owner used to be refused `sale.create`, `count.submit` and `adjustment.request` here, which
// let a manager do things the shop owner could not.)
/** Adjustment reason → ledger movement type. Loss categories all land in `adjustment`, which the
 *  valuation counts as stock-loss value (supplier returns are excluded: they reverse a purchase). */
const ADJ_TYPE = {
  damage: "damage", expiry: "expiry", correction: "adjustment", supplier_return: "supplier_return", sale_return: "sale_return",
  theft: "adjustment", disposal: "adjustment", supplier_shortage: "adjustment", other: "adjustment",
} as const;
/** Reasons that may only move stock DOWNWARD; `sale_return` only upward; `correction` either way. */
const NEG_ONLY = ["damage", "expiry", "supplier_return", "theft", "disposal", "supplier_shortage", "other"];

@Injectable()
export class SyncService {
  constructor(private db: Db) {}

  /**
   * Product operations queued by an older build used the separate `openingQty`/`openingUnitCost`
   * names. They are mapped onto the current single-contract (`initialQty`/`initialUnitCost`) before
   * validation, so work saved offline on a device that has not updated yet is never silently
   * dropped. New operations must only ever send the current names.
   */
  private static normalize(raw: unknown): unknown {
    const o = raw as { type?: string; payload?: Record<string, unknown> } | null;
    if (o?.type !== "product.upsert" || !o.payload) return raw;
    const p = o.payload;
    if (!("openingQty" in p) && !("openingUnitCost" in p)) return raw;
    return { ...o, payload: { ...p, initialQty: p.initialQty ?? p.openingQty, initialUnitCost: p.initialUnitCost ?? p.openingUnitCost } };
  }

  async push(user: AuthUser, device: string, raws: unknown[]): Promise<OpResult[]> {
    // A suspended shop cannot write anything: the whole batch is refused with the reason, and the
    // client keeps its queued work visible instead of it being silently applied or dropped.
    if (user.shopId) {
      const [sh] = await this.db.query("SELECT status FROM shops WHERE id=$1", [user.shopId]);
      if (sh?.status === "suspended") return raws.map((raw) => ({ opId: String((raw as any)?.opId ?? ""), status: "rejected" as const, message: "shop_suspended" }));
    }
    const out: OpResult[] = [];
    for (const raw of raws) out.push(await this.pushOne(user, raw)); // sequential: preserves client order
    return out;
  }

  private async pushOne(user: AuthUser, raw: unknown): Promise<OpResult> {
    const opId = String((raw as any)?.opId ?? "");
    const parsed = Operation.safeParse(SyncService.normalize(raw));
    if (!parsed.success) return { opId, status: "rejected", message: `invalid_operation: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}` };
    const op = parsed.data;
    if (!user.shopId || !canRunOp(user.role, op.type)) return { opId, status: "rejected", message: "role_not_allowed" };
    const shopId = user.shopId;

    return this.db.tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO operations(op_id,shop_id,user_id,device_id,type,payload,status,client_created_at) VALUES ($1,$2,$3,$4,$5,$6,'applied',$7) ON CONFLICT (op_id) DO NOTHING RETURNING op_id`,
        [op.opId, shopId, user.id, op.deviceId, op.type, JSON.stringify(op.payload), op.createdAt]);
      if (!ins.rowCount) { // idempotent replay: return the ORIGINAL outcome
        const { rows: [ex] } = await c.query("SELECT shop_id,status,message FROM operations WHERE op_id=$1", [op.opId]);
        if (ex.shop_id !== shopId) return { opId, status: "rejected", message: "op_id_in_use" } as OpResult;
        return { opId, status: ex.status === "applied" ? "duplicate" : ex.status, message: ex.message ?? undefined } as OpResult;
      }
      await c.query("SAVEPOINT op");
      let status: OpResult["status"] = "applied"; let message: string | undefined;
      try { const r = await this.apply(c, user, shopId, op); if (r) status = r; }
      catch (e: any) {
        await c.query("ROLLBACK TO SAVEPOINT op");
        if (e instanceof BizError) { status = e.kind; message = e.message; }
        else if (e?.code === "23505") { status = "conflict"; message = "duplicate_value"; }
        else if (e?.code === "23503" || e?.code === "23514") { status = "rejected"; message = "constraint_violation"; }
        else throw e;
      }
      if (status !== "applied") await c.query("UPDATE operations SET status=$2, message=$3 WHERE op_id=$1", [op.opId, status, message ?? null]);
      await audit(c, { shopId, actorId: user.id, action: `op.${op.type}`, entity: "operation", entityId: op.opId, newValue: { status, ...(op.payload as object) }, reason: message });
      return { opId, status, message };
    });
  }

  private async policy(c: PoolClient, shopId: string) {
    const { rows: [s] } = await c.query("SELECT below_cost_policy, max_discount_percent FROM shops WHERE id=$1", [shopId]);
    return s as { below_cost_policy: "acknowledge" | "block"; max_discount_percent: number };
  }
  private async lock(c: PoolClient, shopId: string, ids: string[]): Promise<Map<string, { unitsPerPurchase: number; unitsPerSelling: number }>> {
    const uniq = [...new Set(ids)].sort();
    const { rows } = await c.query("SELECT id, units_per_purchase, units_per_selling FROM products WHERE id = ANY($1::uuid[]) AND shop_id=$2 ORDER BY id FOR UPDATE", [uniq, shopId]);
    if (rows.length !== uniq.length) throw new BizError("rejected", "unknown_product");
    // The unit configuration rides along with the row lock: every quantity conversion below is
    // validated against this authoritative server-side config, never against a client claim.
    return new Map(rows.map((r: any) => [r.id, { unitsPerPurchase: Number(r.units_per_purchase), unitsPerSelling: Number(r.units_per_selling) }]));
  }
  private async onHand(c: PoolClient, productId: string): Promise<number> {
    const { rows: [r] } = await c.query("SELECT COALESCE(SUM(qty),0)::bigint AS q FROM stock_movements WHERE product_id=$1", [productId]); return Number(r.q);
  }
  private async mv(c: PoolClient, shopId: string, userId: string, productId: string, type: string, qty: number, unitCost: number | null, src: string, srcId: string, at: string, reason?: string) {
    await c.query("INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,reason,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [shopId, productId, type, qty, unitCost, src, srcId, userId, reason ?? null, at]);
    await c.query("UPDATE products SET updated_at=now() WHERE id=$1", [productId]); // drives incremental pull
  }

  /** The selling price entered on a received purchase line becomes the product's current price (audited). */
  private async applySellingPrice(c: PoolClient, shopId: string, userId: string, productId: string, sellingPrice: number | undefined | null, purchaseId: string) {
    if (sellingPrice === undefined || sellingPrice === null) return;
    const { rows: [p] } = await c.query("SELECT selling_price FROM products WHERE id=$1 AND shop_id=$2", [productId, shopId]);
    if (!p || Number(p.selling_price) === sellingPrice) return;
    await c.query("UPDATE products SET selling_price=$2, updated_at=now() WHERE id=$1", [productId, sellingPrice]);
    await audit(c, { shopId, actorId: userId, action: "product.price_from_purchase", entity: "product", entityId: productId, oldValue: { sellingPrice: Number(p.selling_price) }, newValue: { sellingPrice, purchaseId } });
  }

  private async apply(c: PoolClient, u: AuthUser, shopId: string, op: OperationT): Promise<OpResult["status"] | void> {
    switch (op.type) {
      case "sale.create": {
        const p = op.payload; const cfg = await this.lock(c, shopId, p.lines.map(l => l.productId));
        const need = new Map<string, number>(); p.lines.forEach(l => need.set(l.productId, (need.get(l.productId) ?? 0) + l.qty));
        for (const [pid, q] of need) { const have = await this.onHand(c, pid); if (have < q) throw new BizError("conflict", `insufficient_stock:${pid}:have=${have}:need=${q}`); }
        // Price each line from the quantity the cashier entered. When the product sells in a unit
        // other than its base unit the natural quantity is mandatory and must convert back to the
        // base quantity exactly, so stock can never be deducted on one basis and charged on another.
        const natural = p.lines.map((l) => {
          const units = cfg.get(l.productId)!.unitsPerSelling;
          if (l.sellingQty !== undefined) {
            if (toBaseQty(l.sellingQty, units) !== l.qty) throw new BizError("rejected", `unit_conversion_mismatch:${l.productId}`);
            return l.sellingQty;
          }
          if (units !== 1) throw new BizError("rejected", `selling_qty_required:${l.productId}`);
          return l.qty;
        });
        const amounts = p.lines.map((l, i) => lineAmount(natural[i]!, l.unitPrice)); const gross = amounts.reduce((a, b) => a + b, 0);
        if (p.discount > gross) throw new BizError("rejected", "discount_exceeds_total");
        // Owner-set discount ceiling. Owners may exceed it (recorded in the audit trail); managers may not.
        const { max_discount_percent } = await this.policy(c, shopId);
        const maxDiscount = Number((BigInt(gross) * BigInt(max_discount_percent)) / 100n);
        if (u.role !== "owner" && p.discount > maxDiscount) throw new BizError("rejected", `discount_above_limit:${max_discount_percent}%`);
        if (p.amountPaid > gross - p.discount) throw new BizError("rejected", "paid_exceeds_total");
        await c.query("INSERT INTO sales(id,shop_id,op_id,user_id,sold_at,gross_amount,discount,amount_paid,payment_method) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [p.saleId, shopId, op.opId, u.id, p.soldAt, gross, p.discount, p.amountPaid, p.paymentMethod]);
        if (u.role !== "owner" && p.discount > 0) await audit(c, { shopId, actorId: u.id, action: "sale.discount", entity: "sale", entityId: p.saleId, newValue: { discount: p.discount, gross, limitPercent: max_discount_percent } });
        for (const [i, l] of p.lines.entries()) {
          await c.query("INSERT INTO sale_lines(sale_id,product_id,qty,unit_price,line_amount,qty_entered) VALUES ($1,$2,$3,$4,$5,$6)", [p.saleId, l.productId, l.qty, l.unitPrice, amounts[i], natural[i]]);
          await this.mv(c, shopId, u.id, l.productId, "sale", -l.qty, null, "sale", p.saleId, p.soldAt);
        }
        return;
      }
      case "purchase.create": {
        const p = op.payload; const cfg = await this.lock(c, shopId, p.lines.map(l => l.productId));
        if (p.supplierId) { const { rowCount } = await c.query("SELECT 1 FROM suppliers WHERE id=$1 AND shop_id=$2", [p.supplierId, shopId]); if (!rowCount) throw new BizError("rejected", "unknown_supplier"); }
        // Conversion validation against the authoritative product config: the natural quantity the
        // buyer entered must convert back to the base quantity, and the advertised factor must be
        // the product's configured one (required, not optional, when the product uses conversion).
        for (const l of p.lines) {
          const units = cfg.get(l.productId)!.unitsPerPurchase;
          if (l.unitFactor !== undefined && l.unitFactor !== units) throw new BizError("rejected", `unit_factor_mismatch:${l.productId}`);
          if (units !== 1) {
            if (l.unitFactor === undefined) throw new BizError("rejected", `unit_factor_required:${l.productId}`);
            if (l.purchaseQty === undefined) throw new BizError("rejected", `purchase_qty_required:${l.productId}`);
          }
          if (l.purchaseQty !== undefined && toBaseQty(l.purchaseQty, units) !== l.qty) throw new BizError("rejected", `unit_conversion_mismatch:${l.productId}`);
        }
        const total = p.lines.reduce((s, l) => s + lineAmount(l.qty, l.unitCost), 0);
        if (p.amountPaid > total) throw new BizError("rejected", "paid_exceeds_total");
        // Below-cost selling prices are an explicit, auditable decision - never silently accepted.
        // unitCost is per BASE unit while sellingPrice is per SELLING unit, so the comparison is
        // cross-multiplied across unit bases (reduces to sellingPrice < unitCost when 1:1).
        const below = p.lines.filter(l => l.sellingPrice !== undefined && priceBelowCost(l.sellingPrice, cfg.get(l.productId)!.unitsPerSelling, l.unitCost));
        if (below.length) {
          const { below_cost_policy } = await this.policy(c, shopId);
          if (below_cost_policy === "block" && u.role !== "owner") throw new BizError("rejected", "below_cost_blocked_by_shop_policy");
          if (!p.belowCostAcknowledged || (p.belowCostReason?.trim().length ?? 0) < 3) throw new BizError("rejected", "below_cost_acknowledgement_required");
        }
        await c.query("INSERT INTO purchases(id,shop_id,op_id,user_id,supplier_id,ordered_at,total_amount,amount_paid,reference,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [p.purchaseId, shopId, op.opId, u.id, p.supplierId, p.orderedAt, total, p.amountPaid, p.reference ?? null, p.notes ?? null]);
        for (const l of p.lines) await c.query("INSERT INTO purchase_lines(purchase_id,product_id,qty_ordered,unit_cost,selling_price,purchase_unit,unit_factor,qty_entered) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [p.purchaseId, l.productId, l.qty, l.unitCost, l.sellingPrice ?? null, l.purchaseUnit ?? null, l.unitFactor ?? null, l.purchaseQty ?? null]);
        if (below.length) await audit(c, { shopId, actorId: u.id, action: "purchase.below_cost", entity: "purchase", entityId: p.purchaseId, oldValue: { accepted: false }, newValue: { lines: below.map(l => ({ productId: l.productId, unitCost: l.unitCost, sellingPrice: l.sellingPrice })), purchaseTotal: total }, reason: p.belowCostReason });
        if (p.receiveNow) { // full delivery at once; the receipt shares the purchase op id (unique per receipt row)
          await c.query("INSERT INTO goods_receipts(id,shop_id,purchase_id,op_id,user_id,received_at) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5)", [shopId, p.purchaseId, op.opId, u.id, p.orderedAt]);
          for (const l of p.lines) {
            await c.query("UPDATE purchase_lines SET qty_received=qty_ordered WHERE purchase_id=$1 AND product_id=$2", [p.purchaseId, l.productId]);
            await this.mv(c, shopId, u.id, l.productId, "receipt", l.qty, l.unitCost, "purchase", p.purchaseId, p.orderedAt);
            await this.applySellingPrice(c, shopId, u.id, l.productId, l.sellingPrice, p.purchaseId);
          }
        }
        return;
      }
      case "receipt.create": { // partial deliveries: cumulative received may never exceed ordered
        const p = op.payload;
        const { rows: [pur] } = await c.query("SELECT id FROM purchases WHERE id=$1 AND shop_id=$2", [p.purchaseId, shopId]);
        if (!pur) throw new BizError("conflict", "purchase_not_found_yet"); // may arrive in a later sync batch
        await this.lock(c, shopId, p.lines.map(l => l.productId));
        await c.query("INSERT INTO goods_receipts(id,shop_id,purchase_id,op_id,user_id,received_at) VALUES ($1,$2,$3,$4,$5,$6)", [p.receiptId, shopId, p.purchaseId, op.opId, u.id, p.receivedAt]);
        for (const l of p.lines) {
          const { rows: [pl] } = await c.query("SELECT id,qty_ordered,qty_received,unit_cost,selling_price FROM purchase_lines WHERE purchase_id=$1 AND product_id=$2 FOR UPDATE", [p.purchaseId, l.productId]);
          if (!pl) throw new BizError("rejected", "product_not_on_purchase");
          if (pl.qty_received + l.qty > pl.qty_ordered) throw new BizError("conflict", `over_receipt:${l.productId}:ordered=${pl.qty_ordered}:received=${pl.qty_received}:now=${l.qty}`);
          await c.query("UPDATE purchase_lines SET qty_received=qty_received+$1 WHERE id=$2", [l.qty, pl.id]);
          await this.mv(c, shopId, u.id, l.productId, "receipt", l.qty, pl.unit_cost, "receipt", p.receiptId, p.receivedAt);
          await this.applySellingPrice(c, shopId, u.id, l.productId, pl.selling_price ?? undefined, p.purchaseId);
        }
        return;
      }
      case "expense.create": {
        const p = op.payload;
        await c.query("INSERT INTO expenses(id,shop_id,op_id,user_id,category,amount,paid,incurred_at,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [p.expenseId, shopId, op.opId, u.id, p.category, p.amount, p.paid, p.incurredAt, p.note ?? null]);
        return;
      }
      /** Correcting an expense never rewrites history: the old and new values are audited, and a
       *  manager may only correct expenses they recorded themselves (owners may correct any). */
      case "expense.update": {
        const p = op.payload;
        const { rows: [old] } = await c.query("SELECT * FROM expenses WHERE id=$1 AND shop_id=$2 FOR UPDATE", [p.expenseId, shopId]);
        if (!old) throw new BizError("conflict", "expense_not_found");
        if (u.role !== "owner" && old.user_id !== u.id) throw new BizError("rejected", "not_your_expense");
        const next = {
          category: p.category ?? old.category,
          amount: p.amount ?? Number(old.amount),
          paid: p.paid ?? old.paid,
          incurredAt: p.incurredAt ?? new Date(old.incurred_at).toISOString(),
          note: p.note === undefined ? old.note : p.note,
        };
        await c.query("UPDATE expenses SET category=$2, amount=$3, paid=$4, incurred_at=$5, note=$6 WHERE id=$1",
          [p.expenseId, next.category, next.amount, next.paid, next.incurredAt, next.note ?? null]);
        await audit(c, {
          shopId, actorId: u.id, action: "expense.updated", entity: "expense", entityId: p.expenseId,
          oldValue: { category: old.category, amount: Number(old.amount), paid: old.paid, incurredAt: new Date(old.incurred_at).toISOString(), note: old.note },
          newValue: next,
        });
        return;
      }
      case "count.submit": { // records expected vs counted. NEVER silently corrects stock; discrepancies open investigations.
        const p = op.payload; await this.lock(c, shopId, p.lines.map(l => l.productId));
        await c.query("INSERT INTO stock_counts(id,shop_id,op_id,user_id,counted_at) VALUES ($1,$2,$3,$4,$5)", [p.countId, shopId, op.opId, u.id, p.countedAt]);
        for (const l of p.lines) {
          const expected = await this.onHand(c, l.productId); const diff = l.counted - expected;
          await c.query("INSERT INTO stock_count_lines(count_id,product_id,expected,counted,difference) VALUES ($1,$2,$3,$4,$5)", [p.countId, l.productId, expected, l.counted, diff]);
          if (diff !== 0) await c.query("INSERT INTO investigations(reference,shop_id,count_id,product_id,difference) VALUES ('INV-'||to_char(now(),'YYYY')||'-'||lpad(nextval('investigation_ref_seq')::text,5,'0'),$1,$2,$3,$4)", [shopId, p.countId, l.productId, diff]);
        }
        return;
      }
      case "adjustment.request": {
        const p = op.payload; await this.lock(c, shopId, [p.productId]);
        const neg = NEG_ONLY.includes(p.reason);
        if ((neg && p.qty > 0) || (p.reason === "sale_return" && p.qty < 0)) throw new BizError("rejected", "wrong_sign_for_reason");
        await c.query("INSERT INTO adjustments(id,shop_id,op_id,product_id,qty,reason,note,refund_amount,requested_by,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')", [p.adjustmentId, shopId, op.opId, p.productId, p.qty, p.reason, p.note, p.refundAmount ?? null, u.id]);
        return "pending_approval"; // owner must approve before any stock movement is posted
      }
      case "product.upsert": {
        const p = op.payload;
        // One product row = one initial-stock registration. The advisory lock serialises two create
        // operations carrying the same product id (double submit, retried sync), so the second one
        // sees the existing row and can never post a second `opening` movement: stock is
        // initialized exactly once, and only the first creation is audited as a creation.
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('product.upsert'))", [p.productId]);
        const { rows: [ex] } = await c.query("SELECT * FROM products WHERE id=$1", [p.productId]);
        if (ex && ex.shop_id !== shopId) throw new BizError("rejected", "unknown_product");
        // The unit configuration is set at creation and locked afterwards: changing conversion on
        // a product that already has stock would reinterpret every historical quantity.
        if (ex) {
          const stored = {
            purchaseUnit: ex.purchase_unit ?? ex.unit, sellingUnit: ex.selling_unit ?? ex.unit,
            unitsPerPurchase: Number(ex.units_per_purchase), unitsPerSelling: Number(ex.units_per_selling),
          };
          const given = {
            purchaseUnit: p.purchaseUnit, sellingUnit: p.sellingUnit,
            unitsPerPurchase: p.unitsPerPurchase, unitsPerSelling: p.unitsPerSelling,
          };
          if ((given.purchaseUnit !== undefined && given.purchaseUnit !== stored.purchaseUnit)
            || (given.sellingUnit !== undefined && given.sellingUnit !== stored.sellingUnit)
            || (given.unitsPerPurchase !== undefined && given.unitsPerPurchase !== stored.unitsPerPurchase)
            || (given.unitsPerSelling !== undefined && given.unitsPerSelling !== stored.unitsPerSelling)) {
            throw new BizError("rejected", "unit_config_locked");
          }
        }
        await c.query(`INSERT INTO products(id,shop_id,code,barcode,name,category,unit,selling_price,low_stock_threshold,purchase_unit,selling_unit,units_per_purchase,units_per_selling)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (id) DO UPDATE SET code=$3,barcode=$4,name=$5,category=$6,unit=$7,selling_price=$8,low_stock_threshold=$9,updated_at=now()`,
          [p.productId, shopId, p.code, p.barcode ?? null, p.name, p.category ?? null, p.unit, p.sellingPrice, p.lowStockThreshold,
           p.purchaseUnit ?? null, p.sellingUnit ?? null, p.unitsPerPurchase ?? 1, p.unitsPerSelling ?? 1]);
        const stock = { initialQty: p.initialQty ?? null, initialUnitCost: p.initialUnitCost ?? null, initialStockValue: p.initialQty ? lineAmount(p.initialQty, p.initialUnitCost ?? 0) : 0 };
        if (ex) {
          await audit(c, { shopId, actorId: u.id, action: "product.update", entity: "product", entityId: p.productId, oldValue: { name: ex.name, selling_price: ex.selling_price, code: ex.code }, newValue: { name: p.name, sellingPrice: p.sellingPrice, code: p.code } });
        } else {
          // Product creation is always audited; initial stock, when supplied, is audited with it
          // (the ledger movement it produced is visible through the stock history).
          if (p.initialQty) await this.mv(c, shopId, u.id, p.productId, "opening", p.initialQty, p.initialUnitCost ?? 0, "product", p.productId, op.createdAt, "initial stock");
          await audit(c, { shopId, actorId: u.id, action: "product.create", entity: "product", entityId: p.productId,
            newValue: { code: p.code, name: p.name, unit: p.unit, sellingPrice: p.sellingPrice, lowStockThreshold: p.lowStockThreshold, barcode: p.barcode ?? null,
              purchaseUnit: p.purchaseUnit ?? p.unit, sellingUnit: p.sellingUnit ?? p.unit,
              unitsPerPurchase: p.unitsPerPurchase ?? 1, unitsPerSelling: p.unitsPerSelling ?? 1, ...stock } });
        }
        return;
      }
      case "supplier.upsert": {
        const p = op.payload;
        const { rows: [ex] } = await c.query("SELECT shop_id FROM suppliers WHERE id=$1", [p.supplierId]);
        if (ex && ex.shop_id !== shopId) throw new BizError("rejected", "unknown_supplier");
        await c.query("INSERT INTO suppliers(id,shop_id,name,phone) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET name=$3, phone=$4, updated_at=now()", [p.supplierId, shopId, p.name, p.phone ?? null]);
        return;
      }
    }
  }

  /** Incremental pull. Checkpoint is an opaque JSON cursor: {p:[ts,id], s:[ts,id]} using (updated_at,id) row comparison. */
  async pull(user: AuthUser, checkpoint?: string, limit = 200) {
    const cur = checkpoint ? JSON.parse(checkpoint) : {}; const epoch = "1970-01-01T00:00:00.000000Z", nil = "00000000-0000-0000-0000-000000000000";
    const [pt, pid] = cur.p ?? [epoch, nil]; const [st, sid] = cur.s ?? [epoch, nil];
    const ts = `to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const products = await this.db.query(`SELECT p.*, ${ts} AS ts, COALESCE((SELECT SUM(qty) FROM stock_movements m WHERE m.product_id=p.id),0)::bigint AS on_hand
      FROM products p WHERE shop_id=$1 AND (updated_at,id) > ($2::timestamptz,$3::uuid) ORDER BY updated_at,id LIMIT $4`, [user.shopId, pt, pid, limit]);
    const suppliers = await this.db.query(`SELECT s.*, ${ts} AS ts FROM suppliers s WHERE shop_id=$1 AND (updated_at,id) > ($2::timestamptz,$3::uuid) ORDER BY updated_at,id LIMIT $4`, [user.shopId, st, sid, limit]);
    const lp = products.at(-1), ls = suppliers.at(-1);
    const next = { p: lp ? [lp.ts, lp.id] : [pt, pid], s: ls ? [ls.ts, ls.id] : [st, sid] };
    return {
      checkpoint: JSON.stringify(next), hasMore: products.length === limit || suppliers.length === limit,
      changes: [
        ...products.map(p => ({ entity: "product", id: p.id, data: { id: p.id, code: p.code, barcode: p.barcode, name: p.name, category: p.category, unit: p.unit, sellingPrice: p.selling_price, lowStockThreshold: p.low_stock_threshold, onHand: p.on_hand, active: p.active,
          purchaseUnit: p.purchase_unit, sellingUnit: p.selling_unit, unitsPerPurchase: p.units_per_purchase, unitsPerSelling: p.units_per_selling } })),
        ...suppliers.map(s => ({ entity: "supplier", id: s.id, data: { id: s.id, name: s.name, phone: s.phone } })),
      ],
    };
  }
}
