import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { allocateLineDiscounts, type ReturnPayload } from "@sms/shared";
import { Db } from "../db/db.service";
import { audit } from "../audits/audit";
import type { AuthUser } from "../common/auth";

type Cond = "resalable" | "damaged" | "expired" | "inspection";
const CONDITIONS: Cond[] = ["resalable", "damaged", "expired", "inspection"];
/** Only these conditions may re-enter sellable stock. Everything else stays quarantined. */
const RESTOCK_CONDITIONS = new Set<Cond>(["resalable"]);

export interface SaleLineView {
  productId: string; name: string; code: string | null; unit: string;
  soldQty: number; returnedQty: number; remainingQty: number;
  unitPrice: number; /** per-unit revenue after the line's share of the sale discount */ netUnitPrice: number;
  /** Historical cost per base unit the sale line moved at (null for legacy lines). */
  unitCost: number | null;
  /** Net revenue this product contributed to the sale (after its discount share). */
  net: number;
  /** Net revenue already refunded by earlier returns of this product. */
  refunded: number;
}
export interface SaleReturnView {
  id: string; saleId: string; at: string; reason: string; note: string | null; approvalRef: string | null;
  by: string | null; refund: number; costReversed: number; status: "posted";
  lines: { productId: string; name: string; unit: string; qty: number; unitPrice: number; refund: number; unitCost: number | null; condition: Cond; restocked: boolean }[];
}

@Injectable()
export class ReturnsService {
  constructor(private db: Db) {}

  /**
   * The sale with its remaining returnable quantity per product. The discounted unit price is the
   * line amount minus the exact share of the sale-level discount, so a partial return refunds the
   * same proportion the customer actually paid — not the pre-discount list price.
   */
  async saleView(c: PoolClient | Db, shopId: string, saleId: string): Promise<{
    sale: { id: string; at: string; status: string; gross: number; discount: number; net: number; customer: string | null };
    lines: SaleLineView[]; fullyReturned: boolean;
  }> {
    const run = (sql: string, params: unknown[]) => ("tx" in c ? (c as Db).query(sql, params) : (c as PoolClient).query(sql, params).then((r) => r.rows));
    const [sale] = await run(
      `SELECT s.id, to_char(s.sold_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
              s.status, s.gross_amount, s.discount, c.name AS customer
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.id=$1 AND s.shop_id=$2`, [saleId, shopId]);
    if (!sale) throw new NotFoundException("sale_not_found");
    const rows = await run(
      `SELECT sl.product_id, p.name, p.code, p.unit, sl.qty, sl.unit_price, sl.line_amount, sl.unit_cost
         FROM sale_lines sl JOIN products p ON p.id = sl.product_id
        WHERE sl.sale_id=$1 ORDER BY sl.id`, [saleId]);
    const shares = allocateLineDiscounts(rows.map((r: any) => Number(r.line_amount)), Number(sale.discount));
    const returned = await run(
      `SELECT l.product_id, COALESCE(SUM(l.qty),0)::bigint AS qty, COALESCE(SUM(l.refund_amount),0)::bigint AS refunded
         FROM sale_return_lines l JOIN sale_returns r ON r.id = l.return_id
        WHERE r.sale_id=$1 GROUP BY l.product_id`, [saleId]);
    const returnedBy = new Map<string, number>(returned.map((r: any) => [r.product_id, Number(r.qty)]));
    const refundedBy = new Map<string, number>(returned.map((r: any) => [r.product_id, Number(r.refunded)]));
    // A product may appear on several sale lines (different prices): aggregate its sold quantity and
    // net revenue so the refund is computed against everything the customer actually bought.
    const agg = new Map<string, { productId: string; name: string; code: string | null; unit: string; soldQty: number; net: number; costValue: number; costedQty: number }>();
    rows.forEach((r: any, i: number) => {
      const x = agg.get(r.product_id) ?? { productId: r.product_id, name: r.name, code: r.code, unit: r.unit, soldQty: 0, net: 0, costValue: 0, costedQty: 0 };
      x.soldQty += Number(r.qty);
      x.net += Number(r.line_amount) - (shares[i] ?? 0);
      if (r.unit_cost !== null && r.unit_cost !== undefined) {
        x.costValue += Number(r.unit_cost) * Number(r.qty);
        x.costedQty += Number(r.qty);
      }
      agg.set(r.product_id, x);
    });
    const lines: SaleLineView[] = [...agg.values()].map((x) => {
      const returnedQty = returnedBy.get(x.productId) ?? 0;
      const remainingQty = Math.max(0, x.soldQty - returnedQty);
      return {
        productId: x.productId, name: x.name, code: x.code, unit: x.unit,
        soldQty: x.soldQty, returnedQty, remainingQty,
        unitPrice: x.soldQty > 0 ? Math.round(x.net / (x.soldQty / 1000)) : 0,
        netUnitPrice: x.soldQty > 0 ? Math.round(x.net / (x.soldQty / 1000)) : 0,
        unitCost: x.costedQty > 0 ? Math.round(x.costValue / x.costedQty) : null,
        net: x.net, refunded: refundedBy.get(x.productId) ?? 0,
      };
    });
    return {
      sale: {
        id: sale.id, at: sale.at, status: sale.status, gross: Number(sale.gross_amount),
        discount: Number(sale.discount), net: Number(sale.gross_amount) - Number(sale.discount),
        customer: sale.customer ?? null,
      },
      lines,
      fullyReturned: lines.every((l) => l.remainingQty === 0),
    };
  }

  /**
   * Post a return. The whole document (header, lines, stock movements, audit) is one transaction:
   * a failure at any point leaves no partial return and no partial stock restore. A repeated
   * `returnId` is answered with the existing document instead of posting twice.
   */
  async applyInTx(c: PoolClient, u: AuthUser, shopId: string, p: ReturnPayload, opId?: string | null): Promise<{
    returnId: string; status: "posted" | "duplicate"; refund: number; costReversed: number; lines: number;
  }> {
    const { rows: [existing] } = await c.query(
      `SELECT id FROM sale_returns WHERE id=$1 AND shop_id=$2`, [p.returnId, shopId]);
    if (existing) return this.summary(c, shopId, existing.id, "duplicate");

    const { rows: [sale] } = await c.query(
      `SELECT id, status, sold_at, COALESCE(dispatched_at, sold_at) AS dispatched_at
         FROM sales WHERE id=$1 AND shop_id=$2 FOR UPDATE`, [p.saleId, shopId]);
    if (!sale) throw new NotFoundException("sale_not_found");
    if (sale.status !== "posted") throw new BadRequestException("sale_not_returnable");

    const view = await this.saleView(c, shopId, p.saleId);
    if (view.sale.status !== "posted") throw new BadRequestException("sale_not_returnable");
    const byProduct = new Map(view.lines.map((l) => [l.productId, l]));
    // Aggregate the request per product before validating: two lines for the same product must not
    // each pass the remaining-quantity check independently.
    const wanted = new Map<string, { qty: number; condition: Cond }>();
    for (const l of p.lines) {
      const prev = wanted.get(l.productId);
      // Mixed conditions on one product are stored as separate lines, so keep the first condition
      // for the aggregate check and post each requested line exactly as given.
      wanted.set(l.productId, { qty: (prev?.qty ?? 0) + l.qty, condition: prev?.condition ?? l.condition });
    }
    for (const [pid, w] of wanted) {
      const line = byProduct.get(pid);
      if (!line) throw new BadRequestException(`product_not_on_sale:${pid}`);
      if (w.qty > line.remainingQty) {
        throw new BadRequestException(
          `return_exceeds_sold:${pid}:sold=${line.soldQty}:returned=${line.returnedQty}:remaining=${line.remainingQty}:requested=${w.qty}`);
      }
    }
    // Lock the products in a stable order before any movement is written (same lock discipline as
    // sales, so a return and a concurrent sale cannot both observe stale stock).
    const productIds = [...new Set(p.lines.map((l) => l.productId))].sort();
    for (const pid of productIds) {
      const { rowCount } = await c.query("SELECT 1 FROM products WHERE id=$1 AND shop_id=$2 FOR UPDATE", [pid, shopId]);
      if (!rowCount) throw new BadRequestException(`unknown_product:${pid}`);
    }

    await c.query(
      `INSERT INTO sale_returns(id,shop_id,sale_id,op_id,user_id,returned_at,reason,note,approval_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [p.returnId, shopId, p.saleId, opId ?? null, u.id, p.returnedAt, p.reason, p.note ?? null, p.approvalRef ?? null]);

    let refund = 0, costReversed = 0, count = 0;
    // Track refunds already allocated in THIS return: two lines for one product must add up to the
    // product's refund, not each compute against the untouched original net.
    const refundedNow = new Map<string, number>();
    for (const l of p.lines) {
      const line = byProduct.get(l.productId)!;
      const doneNow = refundedNow.get(l.productId) ?? 0;
      const remainingNet = Math.max(0, line.net - line.refunded);
      const nextCumulative = doneNow + l.qty;
      // Proportional net revenue for exactly this quantity (whole RWF). The last remainder is
      // refunded to the franc, so full returns reconcile exactly with the sale's net.
      const lineRefund = Math.max(0, Math.min(
        remainingNet - doneNow,
        nextCumulative >= line.remainingQty
          ? remainingNet
          : Math.round((line.net * nextCumulative) / line.soldQty),
      ));
      refundedNow.set(l.productId, doneNow + Math.max(0, lineRefund));
      const restock = RESTOCK_CONDITIONS.has(l.condition);
      await c.query(
        `INSERT INTO sale_return_lines(return_id,product_id,qty,unit_price,refund_amount,unit_cost,condition,restocked)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [p.returnId, l.productId, l.qty, line.netUnitPrice, lineRefund, line.unitCost, l.condition, restock]);
      if (restock) {
        // Restored at the cost the goods originally left at, never today's purchase cost. A legacy
        // line without a recorded cost keeps the running-average fallback in the valuation replay.
        await c.query(
          `INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,reason,occurred_at,acted_at)
           VALUES ($1,$2,'sale_return',$3,$4,'sale_return',$5,$6,$7,$8,$9)`,
          [shopId, l.productId, l.qty, line.unitCost, p.returnId, u.id, `return (${l.condition}): ${p.reason}`, p.returnedAt, p.returnedAt]);
        await c.query("UPDATE products SET updated_at=now() WHERE id=$1", [l.productId]);
        if (line.unitCost !== null) costReversed += Math.round((line.unitCost * l.qty) / 1000);
      }
      refund += Math.max(0, lineRefund); count++;
    }

    await audit(c, {
      shopId, actorId: u.id, action: "sale.return", entity: "sale_return", entityId: p.returnId,
      newValue: {
        saleId: p.saleId, refund, costReversed, lines: p.lines.map((l) => ({ productId: l.productId, qty: l.qty, condition: l.condition })),
      },
      reason: p.reason, approvalRef: p.approvalRef,
    });
    return { returnId: p.returnId, status: "posted", refund, costReversed, lines: count };
  }

  private async summary(c: PoolClient, shopId: string, returnId: string, status: "posted" | "duplicate") {
    const { rows: [r] } = await c.query(
      `SELECT COALESCE(SUM(refund_amount),0)::bigint AS refund, COUNT(*)::int AS n,
              COALESCE(SUM(CASE WHEN restocked THEN (COALESCE(unit_cost,0) * qty + 500) / 1000 ELSE 0 END),0)::bigint AS cost
         FROM sale_return_lines WHERE return_id=$1`, [returnId]);
    return { returnId, status, refund: Number(r?.refund ?? 0), costReversed: Number(r?.cost ?? 0), lines: Number(r?.n ?? 0) };
  }

  /** Return documents for one sale (newest first), with their lines and the actor's name. */
  async listForSale(shopId: string, saleId: string) {
    const rows = await this.db.query(
      `SELECT r.id, r.sale_id, to_char(r.returned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
              r.reason, r.note, r.approval_ref, us.full_name AS by
         FROM sale_returns r LEFT JOIN users us ON us.id = r.user_id
        WHERE r.shop_id=$1 AND r.sale_id=$2 ORDER BY r.returned_at DESC, r.id DESC`, [shopId, saleId]);
    return this.withLines(rows);
  }

  /** Returns in a period (or the most recent ones) for the shop's sales/returns history. */
  async list(shopId: string, from?: string, to?: string, limit = 100) {
    const rows = await this.db.query(
      `SELECT r.id, r.sale_id, to_char(r.returned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
              r.reason, r.note, r.approval_ref, us.full_name AS by,
              s.gross_amount, s.discount
         FROM sale_returns r
         JOIN sales s ON s.id = r.sale_id
         LEFT JOIN users us ON us.id = r.user_id
        WHERE r.shop_id=$1 AND ($2::timestamptz IS NULL OR r.returned_at >= $2)
          AND ($3::timestamptz IS NULL OR r.returned_at < $3)
        ORDER BY r.returned_at DESC, r.id DESC LIMIT $4`, [shopId, from ?? null, to ?? null, Math.min(500, Math.max(1, limit))]);
    return this.withLines(rows);
  }

  private async withLines(rows: any[]): Promise<SaleReturnView[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const lines = await this.db.query(
      `SELECT l.return_id, l.product_id, p.name, p.unit, l.qty, l.unit_price, l.refund_amount, l.unit_cost, l.condition, l.restocked
         FROM sale_return_lines l JOIN products p ON p.id = l.product_id
        WHERE l.return_id = ANY($1::uuid[]) ORDER BY l.id`, [ids]);
    const by = new Map<string, any[]>();
    for (const l of lines) {
      const list = by.get(l.return_id) ?? [];
      list.push({
        productId: l.product_id, name: l.name, unit: l.unit, qty: Number(l.qty), unitPrice: Number(l.unit_price),
        refund: Number(l.refund_amount), unitCost: l.unit_cost === null ? null : Number(l.unit_cost),
        condition: l.condition as Cond, restocked: !!l.restocked,
      });
      by.set(l.return_id, list);
    }
    return rows.map((r) => {
      const ls = by.get(r.id) ?? [];
      return {
        id: r.id, saleId: r.sale_id, at: r.at, reason: r.reason, note: r.note ?? null,
        approvalRef: r.approval_ref ?? null, by: r.by ?? null,
        refund: ls.reduce((s: number, l: any) => s + l.refund, 0),
        costReversed: ls.reduce((s: number, l: any) => s + (l.restocked ? Math.round(((l.unitCost ?? 0) * l.qty) / 1000) : 0), 0),
        status: "posted" as const, lines: ls,
      };
    });
  }
}

/** Kept next to the service so both controllers can validate the same condition vocabulary. */
export function validCondition(v: string): v is Cond {
  return (CONDITIONS as string[]).includes(v);
}
export { CONDITIONS, RESTOCK_CONDITIONS };
