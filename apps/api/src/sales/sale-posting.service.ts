import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { currentAverageCost, lineAmount, toBaseQty, type Movement } from "@sms/shared";
import { audit } from "../audits/audit";
import type { AuthUser } from "../common/auth";
import { PricingService } from "../returns/pricing.service";

export type SalePostingErrorKind = "conflict" | "rejected" | "pending_approval";

export class SalePostingError extends Error {
  constructor(public kind: SalePostingErrorKind, message: string) { super(message); this.name = "SalePostingError"; }
}

export interface SalePostingLine {
  productId: string;
  /** Base milli-units, exactly what stock moves in. */
  qty: number;
  unitPrice: number;
  /** Natural selling quantity, required when the product sells in a converted unit. */
  sellingQty?: number;
}

export interface SalePostingInput {
  saleId: string;
  soldAt: string;
  discount: number;
  amountPaid: number;
  paymentMethod: string;
  customerId?: string | null;
  dueAt?: string | null;
  creditOverrideReason?: string;
  lines: SalePostingLine[];
}

export interface SalePostingOptions {
  /** Normal sales promote a due scheduled price first; a correction uses the reviewed proposal. */
  applyDuePrices?: boolean;
  /** A correction is owner-authorised but still must not oversell. */
  allowOwnerOverCreditLimit?: boolean;
  /** A refund may leave the corrected sale with more collected than its corrected net. */
  allowOverpayment?: boolean;
  /** Correction links written on the corrected sale. */
  correction?: { correctionId: string; originalSaleId: string; reversalId: string };
  /**
   * Exact relief cost for a correction whose goods never physically moved. The reversal and the
   * corrected sale must use the original cost snapshot, otherwise restocking at an old cost and
   * re-deducting at today's average would silently revalue inventory that is still with the customer.
   */
  costOverrides?: Map<string, number>;
}

export interface SalePostingResult {
  saleId: string;
  status: "posted" | "pending_approval";
  gross: number;
  discount: number;
  net: number;
  amountPaid: number;
  customerId: string | null;
  lines: { productId: string; qty: number; unitPrice: number; lineAmount: number; unitCost: number }[];
}

/**
 * The single sale-posting implementation.
 *
 * It is used by the ordinary offline/online `sale.create` operation and by the owner-authorised
 * correction approval. Both paths therefore share the same stock locks, unit conversion checks,
 * discount arithmetic, credit policy, moving-average cost snapshot and ledger movement rules.
 * A correction only adds the explicit links to its original sale/reversal; it does not get a
 * weaker or parallel version of the sale rules.
 */
@Injectable()
export class SalePostingService {
  constructor(private pricing: PricingService) {}

  /**
   * Validate and price a proposed sale without posting it. Correction requests use this to freeze
   * the gross/net the owner will review; approval re-runs the same rules under the posting locks.
   */
  async quoteInTx(c: PoolClient, shopId: string, lines: SalePostingLine[]): Promise<{
    gross: number;
    lines: { productId: string; qty: number; sellingQty: number; unitPrice: number; lineAmount: number }[];
  }> {
    const cfg = await this.lock(c, shopId, lines.map((l) => l.productId));
    const quoted = lines.map((l) => {
      const units = cfg.get(l.productId)!.unitsPerSelling;
      const sellingQty = l.sellingQty ?? (units === 1 ? l.qty : undefined);
      if (sellingQty === undefined) throw new SalePostingError("rejected", `selling_qty_required:${l.productId}`);
      if (toBaseQty(sellingQty, units) !== l.qty) {
        throw new SalePostingError("rejected", `unit_conversion_mismatch:${l.productId}`);
      }
      return { productId: l.productId, qty: l.qty, sellingQty, unitPrice: l.unitPrice, lineAmount: lineAmount(sellingQty, l.unitPrice) };
    });
    return { gross: quoted.reduce((s, l) => s + l.lineAmount, 0), lines: quoted };
  }

  async postInTx(
    c: PoolClient,
    u: AuthUser,
    shopId: string,
    opId: string,
    p: SalePostingInput,
    options: SalePostingOptions = {},
  ): Promise<SalePostingResult> {
    if (options.applyDuePrices !== false) await this.pricing.applyDuePrices(c, shopId);

    const cfg = await this.lock(c, shopId, p.lines.map((l) => l.productId));
    const need = new Map<string, number>();
    p.lines.forEach((l) => need.set(l.productId, (need.get(l.productId) ?? 0) + l.qty));
    for (const [pid, q] of need) {
      const have = await this.onHand(c, pid, shopId);
      if (have < q) throw new SalePostingError("conflict", `insufficient_stock:${pid}:have=${have}:need=${q}`);
    }

    // Price each line from the quantity the cashier entered. When the product sells in a unit
    // other than its base unit the natural quantity is mandatory and must convert back exactly.
    const natural = p.lines.map((l) => {
      const units = cfg.get(l.productId)!.unitsPerSelling;
      if (l.sellingQty !== undefined) {
        if (toBaseQty(l.sellingQty, units) !== l.qty) {
          throw new SalePostingError("rejected", `unit_conversion_mismatch:${l.productId}`);
        }
        return l.sellingQty;
      }
      if (units !== 1) throw new SalePostingError("rejected", `selling_qty_required:${l.productId}`);
      return l.qty;
    });
    const amounts = p.lines.map((l, i) => lineAmount(natural[i]!, l.unitPrice));
    const gross = amounts.reduce((a, b) => a + b, 0);
    if (p.discount > gross) throw new SalePostingError("rejected", "discount_exceeds_total");

    const { max_discount_percent, credit_limit_policy } = await this.policy(c, shopId);
    const maxDiscount = Number((BigInt(gross) * BigInt(max_discount_percent)) / 100n);
    if (u.role !== "owner" && p.discount > maxDiscount) {
      throw new SalePostingError("rejected", `discount_above_limit:${max_discount_percent}%`);
    }

    const net = gross - p.discount;
    if (!options.allowOverpayment && p.amountPaid > net) {
      throw new SalePostingError("rejected", "paid_exceeds_total");
    }

    const credit = net - p.amountPaid;
    let customer: any = null;
    if (p.customerId) {
      const { rows: [cu] } = await c.query(
        "SELECT id, credit_limit, status FROM customers WHERE id=$1 AND shop_id=$2 FOR UPDATE",
        [p.customerId, shopId],
      );
      if (!cu) throw new SalePostingError("rejected", "unknown_customer");
      if (cu.status !== "active") throw new SalePostingError("rejected", "customer_blocked");
      customer = cu;
    }
    if (credit > 0 && !customer) throw new SalePostingError("rejected", "customer_required_for_credit");
    if (credit > 0) {
      const owing = await this.creditOutstanding(c, shopId, p.customerId!);
      const limit = Number(customer.credit_limit);
      // A zero limit means no credit line, not an unlimited one.
      if (limit <= 0) {
        throw new SalePostingError("rejected", `credit_limit_exceeded:${limit}:owing=${owing}:proposed=${credit}`);
      }
      if (owing + credit > limit) {
        // The shop policy is a hard block, for every role. The owner-approval policy is the only
        // path that may continue without owner approval, and then only for the owner.
        if (credit_limit_policy === "block") {
          throw new SalePostingError("rejected", `credit_limit_exceeded:${limit}:owing=${owing}:proposed=${credit}`);
        }
        const correctionOverride = !!options.allowOwnerOverCreditLimit;
        if (credit_limit_policy === "owner_approval" && u.role !== "owner" && !correctionOverride) {
          const { rows: [pending] } = await c.query(
            `INSERT INTO sales(id,shop_id,op_id,user_id,sold_at,gross_amount,discount,amount_paid,payment_method,customer_id,due_at,status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending_approval') RETURNING id`,
            [p.saleId, shopId, opId, u.id, p.soldAt, gross, p.discount, p.amountPaid, p.paymentMethod,
              p.customerId, p.dueAt ?? null],
          );
          for (const [i, l] of p.lines.entries()) {
            await c.query(
              "INSERT INTO sale_lines(sale_id,product_id,qty,unit_price,line_amount,qty_entered) VALUES ($1,$2,$3,$4,$5,$6)",
              [pending.id, l.productId, l.qty, l.unitPrice, amounts[i], natural[i]],
            );
          }
          await audit(c, {
            shopId, actorId: u.id, action: "sale.credit.approval_requested", entity: "sale", entityId: p.saleId,
            newValue: { credit, limit, owing, customerId: p.customerId, reason: p.creditOverrideReason ?? null },
          });
          return { saleId: p.saleId, status: "pending_approval", gross, discount: p.discount, net, amountPaid: p.amountPaid, customerId: p.customerId ?? null, lines: [] };
        }
        if (!correctionOverride && !p.creditOverrideReason) {
          throw new SalePostingError("rejected", "credit_override_reason_required");
        }
        await audit(c, {
          shopId, actorId: u.id, action: "sale.credit.override", entity: "sale", entityId: p.saleId,
          newValue: { credit, limit, owing, customerId: p.customerId, correction: options.correction ?? null },
          reason: p.creditOverrideReason ?? (correctionOverride ? "owner-authorised correction" : undefined),
        });
      }
    }

    // The cost is fixed once, under the product locks, at the current weighted average. A corrected
    // sale gets its own snapshot; it never charges the old sale's cost to a different product mix.
    const costs = await this.costsNow(c, shopId, p.lines.map((l) => l.productId));
    const link = options.correction;
    await c.query(
      `INSERT INTO sales(id,shop_id,op_id,user_id,sold_at,gross_amount,discount,amount_paid,payment_method,customer_id,due_at,
                          correction_id,corrects_sale_id,reversal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [p.saleId, shopId, opId, u.id, p.soldAt, gross, p.discount, p.amountPaid, p.paymentMethod,
        p.customerId ?? null, p.dueAt ?? null, link?.correctionId ?? null, link?.originalSaleId ?? null, link?.reversalId ?? null],
    );
    if (u.role !== "owner" && p.discount > 0) {
      await audit(c, {
        shopId, actorId: u.id, action: "sale.discount", entity: "sale", entityId: p.saleId,
        newValue: { discount: p.discount, gross, limitPercent: max_discount_percent },
      });
    }

    const postedLines: SalePostingResult["lines"] = [];
    for (const [i, l] of p.lines.entries()) {
      const cost = options.costOverrides?.get(l.productId) ?? costs.get(l.productId) ?? 0;
      await c.query(
        "INSERT INTO sale_lines(sale_id,product_id,qty,unit_price,line_amount,qty_entered,unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [p.saleId, l.productId, l.qty, l.unitPrice, amounts[i], natural[i], cost],
      );
      await this.mv(c, shopId, u.id, l.productId, "sale", -l.qty, cost, "sale", p.saleId, p.soldAt,
        link ? "corrected sale" : undefined, p.soldAt);
      postedLines.push({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, lineAmount: amounts[i]!, unitCost: cost });
    }

    return {
      saleId: p.saleId, status: "posted", gross, discount: p.discount, net, amountPaid: p.amountPaid,
      customerId: p.customerId ?? null, lines: postedLines,
    };
  }

  private async policy(c: PoolClient, shopId: string) {
    const { rows: [s] } = await c.query(
      "SELECT below_cost_policy, max_discount_percent, credit_limit_policy FROM shops WHERE id=$1",
      [shopId],
    );
    return s as { below_cost_policy: string; max_discount_percent: number; credit_limit_policy: string };
  }

  private async creditOutstanding(c: PoolClient, shopId: string, customerId: string): Promise<number> {
    const { rows: [r] } = await c.query(
      `SELECT
         COALESCE((SELECT SUM(gross_amount-discount-amount_paid) FROM sales
                    WHERE shop_id=$1 AND customer_id=$2 AND status='posted'),0)
         - COALESCE((SELECT SUM(amount) FROM credit_payments WHERE shop_id=$1 AND customer_id=$2),0)
         + COALESCE((SELECT SUM(amount) FROM credit_adjustments WHERE shop_id=$1 AND customer_id=$2),0) AS owing`,
      [shopId, customerId],
    );
    return Number(r?.owing ?? 0);
  }

  private async lock(c: PoolClient, shopId: string, ids: string[]) {
    const uniq = [...new Set(ids)].sort();
    const { rows } = await c.query(
      "SELECT id, units_per_purchase, units_per_selling FROM products WHERE id = ANY($1::uuid[]) AND shop_id=$2 ORDER BY id FOR UPDATE",
      [uniq, shopId],
    );
    if (rows.length !== uniq.length) throw new SalePostingError("rejected", "unknown_product");
    return new Map(rows.map((r: any) => [
      r.id, { unitsPerPurchase: Number(r.units_per_purchase), unitsPerSelling: Number(r.units_per_selling) },
    ]));
  }

  private async onHand(c: PoolClient, productId: string, shopId: string): Promise<number> {
    const { rows: [r] } = await c.query(
      "SELECT COALESCE(SUM(qty),0)::bigint AS q FROM stock_movements WHERE product_id=$1 AND shop_id=$2",
      [productId, shopId],
    );
    return Number(r.q);
  }

  private async costsNow(c: PoolClient, shopId: string, productIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set(productIds)].sort();
    const { rows } = await c.query(
      `SELECT product_id, type, qty, unit_cost,
              to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, seq
         FROM stock_movements WHERE shop_id=$1 AND product_id = ANY($2::uuid[])
        ORDER BY seq`,
      [shopId, ids],
    );
    const by = new Map<string, Movement[]>();
    for (const r of rows) {
      const list = by.get(r.product_id) ?? [];
      list.push({
        type: r.type, qty: Number(r.qty),
        unitCost: r.unit_cost === null ? undefined : Number(r.unit_cost),
        occurredAt: r.at, seq: Number(r.seq),
      });
      by.set(r.product_id, list);
    }
    return new Map(ids.map((id) => [id, currentAverageCost(by.get(id) ?? [])]));
  }

  private async mv(
    c: PoolClient, shopId: string, userId: string, productId: string, type: string, qty: number,
    unitCost: number | null, src: string, srcId: string, at: string, reason?: string, actedAt?: string,
  ) {
    await c.query(
      "INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,reason,occurred_at,acted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [shopId, productId, type, qty, unitCost, src, srcId, userId, reason ?? null, at, actedAt ?? new Date().toISOString()],
    );
    await c.query("UPDATE products SET updated_at=now() WHERE id=$1", [productId]);
  }
}
