import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { priceBelowCost, replayLedger, type Movement } from "@sms/shared";
import { Db } from "../db/db.service";
import { audit } from "../audits/audit";
import type { AuthUser } from "../common/auth";

/** Thrown when the price a device based its decision on is no longer the server's current price. */
export class PriceConflictError extends ConflictException {
  constructor(public readonly code = "price_changed_on_server") { super(code); }
}

export interface PricePreview {
  product: {
    id: string; name: string; code: string | null; unit: string; sellingUnit: string; unitsPerSelling: number;
    currentPrice: number; onHand: number; avgCost: number; costPerSellingUnit: number; inventoryValue: number;
    pendingPrice: number | null; pendingAt: string | null;
  };
  proposed: {
    price: number; grossProfitPerUnit: number; grossMarginBps: number | null;
    potentialRevenue: number; expectedGrossProfit: number;
  };
  /** These are projections at the proposed price, not realised revenue or profit. */
  projection: true;
  warnings: { code: "below_cost" | "cost_unknown" | "no_stock"; amount?: number }[];
}

/**
 * Selling-price changes are their own business operation. They never create a stock movement, never
 * change inventory carrying value or purchase cost, and never touch a completed sale (each sale
 * line keeps the price it was posted at). A price change only decides what a future sale charges.
 */
@Injectable()
export class PricingService {
  constructor(private db: Db) {}

  private async product(shopId: string, productId: string) {
    const [p] = await this.db.query(
      `SELECT id, name, code, unit, selling_unit, units_per_selling, selling_price,
              pending_selling_price, to_char(pending_price_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS pending_at
         FROM products WHERE id=$1 AND shop_id=$2`, [productId, shopId]);
    if (!p) throw new NotFoundException("product_not_found");
    const moves = await this.db.query(
      `SELECT type, qty, unit_cost, seq, to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
         FROM stock_movements WHERE shop_id=$1 AND product_id=$2 ORDER BY seq`, [shopId, productId]);
    const ledger = replayLedger(moves.map((m: any): Movement => ({ type: m.type, qty: Number(m.qty), unitCost: m.unit_cost === null ? undefined : Number(m.unit_cost), occurredAt: m.at, seq: Number(m.seq) })));
    return {
      id: p.id as string, name: p.name as string, code: (p.code ?? null) as string | null,
      unit: p.unit as string, sellingUnit: (p.selling_unit ?? p.unit) as string,
      unitsPerSelling: Number(p.units_per_selling ?? 1),
      currentPrice: Number(p.selling_price),
      pendingPrice: p.pending_selling_price === null ? null : Number(p.pending_selling_price),
      pendingAt: p.pending_at ?? null,
      onHand: ledger.onHand, avgCost: ledger.avgCost, inventoryValue: ledger.value,
    };
  }

  /** The financial preview the owner sees BEFORE confirming: current + proposed price and projections. */
  async preview(shopId: string, productId: string, newPrice: number): Promise<PricePreview> {
    if (!Number.isInteger(newPrice) || newPrice < 0) throw new BadRequestException("invalid_price");
    const p = await this.product(shopId, productId);
    // selling_price is quoted per SELLING unit; the ledger cost is per BASE unit.
    const costPerSellingUnit = Math.round((p.avgCost * p.unitsPerSelling) / 1);
    const grossProfitPerUnit = newPrice - costPerSellingUnit;
    // Available whole selling units, in milli-units to keep the arithmetic integer.
    const sellableMilli = p.unitsPerSelling > 0 ? Math.floor(p.onHand / p.unitsPerSelling) : 0;
    const potentialRevenue = Math.round((newPrice * sellableMilli) / 1000);
    const expectedGrossProfit = Math.round((grossProfitPerUnit * sellableMilli) / 1000);
    const warnings: PricePreview["warnings"] = [];
    if (p.onHand <= 0) warnings.push({ code: "no_stock" });
    if (p.avgCost <= 0) warnings.push({ code: "cost_unknown" });
    else if (priceBelowCost(newPrice, p.unitsPerSelling, p.avgCost)) warnings.push({ code: "below_cost", amount: costPerSellingUnit - newPrice });
    return {
      product: { ...p, costPerSellingUnit },
      proposed: {
        price: newPrice, grossProfitPerUnit,
        grossMarginBps: newPrice > 0 ? Math.round((grossProfitPerUnit * 10_000) / newPrice) : null,
        potentialRevenue, expectedGrossProfit,
      },
      projection: true, warnings,
    };
  }

  /**
   * Apply a price change inside the caller's transaction. Order of checks matters: the duplicate
   * check comes first (a replayed operation is not an error), then the optimistic version check, so
   * a stale device can never overwrite a newer server-side price.
   *
   * `effectiveAt` in the future schedules the change: products.selling_price keeps the current
   * value until the due date, and `applyDuePrices` promotes it. A sale always uses the price that
   * was current when it was committed, because its lines store the charged price forever.
   */
  async applyInTx(c: PoolClient, u: AuthUser, shopId: string, input: {
    productId: string; priceId: string; newPrice: number; reason: string;
    effectiveAt?: string; expectedPrice?: number; approvalRef?: string;
  }, opId?: string | null) {
    const { rows: [dupe] } = await c.query("SELECT id, new_price FROM product_price_changes WHERE id=$1 AND shop_id=$2", [input.priceId, shopId]);
    if (dupe) return { priceId: input.priceId, status: "duplicate" as const, price: Number(dupe.new_price), scheduled: false };

    const { rows: [p] } = await c.query(
      "SELECT id, selling_price FROM products WHERE id=$1 AND shop_id=$2 FOR UPDATE", [input.productId, shopId]);
    if (!p) throw new NotFoundException("product_not_found");
    const current = Number(p.selling_price);
    if (input.expectedPrice !== undefined && input.expectedPrice !== current) {
      throw new PriceConflictError("price_changed_on_server");
    }
    if (!Number.isInteger(input.newPrice) || input.newPrice < 0) throw new BadRequestException("invalid_price");
    if (input.newPrice === current) return { priceId: input.priceId, status: "duplicate" as const, price: current, scheduled: false, unchanged: true };

    // Below-cost repricing stays possible for the owner — never silently blocked — but a manager
    // needs an explicit owner authorisation reference, exactly like below-cost purchasing.
    const pv = await this.preview(shopId, input.productId, input.newPrice);
    if (u.role !== "owner" && pv.product.avgCost > 0 && pv.warnings.some((w) => w.code === "below_cost") && !input.approvalRef) {
      throw new ForbiddenException("below_cost_approval_required");
    }

    const effective = input.effectiveAt ? new Date(input.effectiveAt) : new Date();
    if (Number.isNaN(effective.getTime())) throw new BadRequestException("invalid_effective_at");
    const scheduled = effective.getTime() > Date.now() + 1000;
    if (scheduled) {
      await c.query(
        "UPDATE products SET pending_selling_price=$2, pending_price_at=$3, updated_at=now() WHERE id=$1",
        [input.productId, input.newPrice, effective.toISOString()]);
    } else {
      await c.query(
        "UPDATE products SET selling_price=$2, pending_selling_price=NULL, pending_price_at=NULL, updated_at=now() WHERE id=$1",
        [input.productId, input.newPrice]);
    }
    await c.query(
      `INSERT INTO product_price_changes(id,shop_id,product_id,op_id,old_price,new_price,effective_at,actor_id,reason,approval_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [input.priceId, shopId, input.productId, opId ?? null, current, input.newPrice,
       scheduled ? effective.toISOString() : new Date().toISOString(), u.id, input.reason, input.approvalRef ?? null]);
    await audit(c, {
      shopId, actorId: u.id, action: "product.price.change", entity: "product", entityId: input.productId,
      oldValue: { sellingPrice: current }, newValue: { sellingPrice: input.newPrice, effectiveAt: effective.toISOString(), scheduled },
      reason: input.reason, approvalRef: input.approvalRef,
    });
    return { priceId: input.priceId, status: "posted" as const, price: input.newPrice, scheduled };
  }

  /** Promote every scheduled change whose effective time has arrived. Never posts a stock movement. */
  async applyDuePrices(c: PoolClient, shopId: string): Promise<number> {
    const { rows } = await c.query(
      `UPDATE products SET selling_price = pending_selling_price, pending_selling_price = NULL,
                          pending_price_at = NULL, updated_at = now()
        WHERE shop_id=$1 AND pending_selling_price IS NOT NULL AND pending_price_at <= now()
        RETURNING id`, [shopId]);
    return rows.length;
  }

  /** Price-history ledger for one product, newest first. */
  async history(shopId: string, productId: string, limit = 100) {
    const rows = await this.db.query(
      `SELECT c.id, c.old_price, c.new_price, c.reason, c.approval_ref, c.op_id,
              to_char(c.effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS effective_at,
              to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
              us.full_name AS actor
         FROM product_price_changes c LEFT JOIN users us ON us.id = c.actor_id
        WHERE c.shop_id=$1 AND c.product_id=$2
        ORDER BY c.effective_at DESC, c.created_at DESC LIMIT $3`, [shopId, productId, Math.min(500, Math.max(1, limit))]);
    return rows.map((r: any) => ({
      id: r.id, oldPrice: Number(r.old_price), newPrice: Number(r.new_price), reason: r.reason,
      approvalRef: r.approval_ref ?? null, actor: r.actor ?? null,
      effectiveAt: r.effective_at, recordedAt: r.created_at, opId: r.op_id ?? null,
    }));
  }

  /** Every price change in the shop, for the owner's price-change history screen. */
  async historyAll(shopId: string, limit = 100) {
    const rows = await this.db.query(
      `SELECT c.id, c.product_id, p.name, p.code, c.old_price, c.new_price, c.reason, c.approval_ref,
              to_char(c.effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS effective_at,
              us.full_name AS actor
         FROM product_price_changes c JOIN products p ON p.id = c.product_id
         LEFT JOIN users us ON us.id = c.actor_id
        WHERE c.shop_id=$1 ORDER BY c.effective_at DESC, c.created_at DESC LIMIT $2`, [shopId, Math.min(500, Math.max(1, limit))]);
    return rows.map((r: any) => ({
      id: r.id, productId: r.product_id, product: r.name, code: r.code,
      oldPrice: Number(r.old_price), newPrice: Number(r.new_price), reason: r.reason,
      approvalRef: r.approval_ref ?? null, actor: r.actor ?? null, effectiveAt: r.effective_at,
    }));
  }

  /**
   * Called by non-price flows that change a product's price (a purchase line carrying a selling
   * price, or a product edit). They must appear in the same ledger, with their reason recorded.
   */
  async recordImpliedChange(c: PoolClient, shopId: string, userId: string, productId: string, oldPrice: number, newPrice: number, reason: string) {
    if (oldPrice === newPrice) return;
    await c.query(
      `INSERT INTO product_price_changes(id,shop_id,product_id,old_price,new_price,effective_at,actor_id,reason)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,now(),$5,$6)`, [shopId, productId, oldPrice, newPrice, userId, reason]);
  }
}
