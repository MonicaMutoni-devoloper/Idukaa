import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { averageCostAt, type Movement } from "@sms/shared";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { audit } from "../audits/audit";
import { emitShopChange } from "../realtime/hub";

const VoidRequest = z.object({ reason: z.string().trim().min(3).max(500) });
const CreditDecision = z.object({ reason: z.string().trim().min(3).max(500).optional() });

/**
 * A completed sale is never edited or deleted. An owner can void it once: every line goes back to
 * the ledger as a sale_return, the sale is stamped reversed, and the reason is audited. The row lock
 * and the status filter inside one transaction make a second reversal impossible.
 */
@Controller("sales") @Roles("owner")
export class SalesController {
  constructor(private db: Db) {}

  /**
   * The moving weighted average cost per product as of `at`, read inside the caller's transaction.
   * Called while the product rows are locked, so a concurrent sale of the same product cannot post
   * at a stale average.
   */
  private async costsAt(c: any, shopId: string, productIds: string[], at: string): Promise<Map<string, number>> {
    const ids = [...new Set(productIds)].sort();
    const { rows } = await c.query(
      `SELECT product_id, type, qty, unit_cost,
              to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
         FROM stock_movements WHERE shop_id=$1 AND product_id = ANY($2::uuid[]) ORDER BY occurred_at, id`,
      [shopId, ids]);
    const by = new Map<string, Movement[]>();
    for (const r of rows) {
      const list = by.get(r.product_id) ?? [];
      list.push({ type: r.type, qty: Number(r.qty), unitCost: r.unit_cost === null ? undefined : Number(r.unit_cost), occurredAt: r.at });
      by.set(r.product_id, list);
    }
    return new Map(ids.map((id) => [id, averageCostAt(by.get(id) ?? [], at)]));
  }

  /** The owner's approvals desk: credit sales that are waiting and have moved no stock yet. */
  @Get("pending-credit")
  async pendingCredit(@Me() u: AuthUser) {
    const rows = await this.db.query(
      `SELECT s.id, s.sold_at AS at, s.gross_amount, s.discount, s.amount_paid,
              s.customer_id, c.name AS customer, us.full_name AS by, s.due_at,
              (SELECT COALESCE(json_agg(json_build_object(
                 'productId', sl.product_id, 'name', p.name, 'qty', sl.qty, 'lineAmount', sl.line_amount
               ) ORDER BY sl.id), '[]'::json)
                 FROM sale_lines sl JOIN products p ON p.id=sl.product_id WHERE sl.sale_id=s.id) AS lines
         FROM sales s JOIN users us ON us.id=s.user_id JOIN customers c ON c.id=s.customer_id
        WHERE s.shop_id=$1 AND s.status='pending_approval'
        ORDER BY s.sold_at, s.id LIMIT 200`, [u.shopId]);
    return rows.map((r: any) => ({ ...r,
      gross: Number(r.gross_amount), discount: Number(r.discount), amountPaid: Number(r.amount_paid),
      credit: Number(r.gross_amount) - Number(r.discount) - Number(r.amount_paid),
      lines: (r.lines ?? []).map((l: any) => ({ ...l, qty: Number(l.qty), lineAmount: Number(l.lineAmount) })) }));
  }

  /** Owner approval of a credit sale that exceeded the customer's limit. Stock moves only now. */
  @Post(":id/approve-credit")
  async approveCredit(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("sale_not_found");
    const b = CreditDecision.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    const out = await this.db.tx(async (c) => {
      const { rows: [sale] } = await c.query(
        "SELECT id, status, customer_id, sold_at FROM sales WHERE id=$1 AND shop_id=$2 FOR UPDATE", [id, u.shopId]);
      if (!sale) throw new NotFoundException("sale_not_found");
      if (sale.status !== "pending_approval") throw new BadRequestException("sale_not_pending_approval");
      const { rows: lines } = await c.query(
        "SELECT product_id, qty FROM sale_lines WHERE sale_id=$1 ORDER BY id", [id]);
      // Lock in a stable order so two approvals cannot both observe the same stock and oversell.
      const productIds = [...new Set(lines.map((l: any) => l.product_id))].sort();
      for (const pid of productIds) {
        const { rowCount } = await c.query("SELECT 1 FROM products WHERE id=$1 AND shop_id=$2 FOR UPDATE", [pid, u.shopId]);
        if (!rowCount) throw new BadRequestException(`unknown_product:${pid}`);
      }
      for (const l of lines) {
        const { rows: [h] } = await c.query("SELECT COALESCE(SUM(qty),0)::bigint q FROM stock_movements WHERE product_id=$1", [l.product_id]);
        if (Number(h.q) < Number(l.qty)) throw new BadRequestException(`insufficient_stock:${l.product_id}`);
      }
      // Stock only moves now, so this is when the sale's cost is fixed — once, under the same locks.
      const costs = await this.costsAt(c, u.shopId!, lines.map((l: any) => l.product_id), new Date(sale.sold_at).toISOString());
      for (const l of lines) {
        const cost = costs.get(l.product_id) ?? 0;
        await c.query(
          `INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,reason,occurred_at)
           VALUES ($1,$2,'sale',$3,$4,'sale',$5,$6,$7,$8)`,
          [u.shopId, l.product_id, -Number(l.qty), cost, id, u.id, "credit approval", sale.sold_at]);
        await c.query("UPDATE sale_lines SET unit_cost=$2 WHERE sale_id=$1 AND product_id=$3", [id, cost, l.product_id]);
        await c.query("UPDATE products SET updated_at=now() WHERE id=$1", [l.product_id]);
      }
      await c.query("UPDATE sales SET status='posted' WHERE id=$1", [id]);
      await audit(c, { shopId: u.shopId, actorId: u.id, action: "sale.credit.approved", entity: "sale", entityId: id,
        oldValue: { status: "pending_approval" }, newValue: { status: "posted", customerId: sale.customer_id }, reason: b.data.reason });
      return { ok: true, saleId: id, status: "posted" };
    });
    emitShopChange(u.shopId, ["sale", "product"]);
    return out;
  }

  @Post(":id/reject-credit")
  async rejectCredit(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("sale_not_found");
    const b = VoidRequest.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    const out = await this.db.tx(async (c) => {
      const { rows: [sale] } = await c.query(
        "SELECT id, status FROM sales WHERE id=$1 AND shop_id=$2 FOR UPDATE", [id, u.shopId]);
      if (!sale) throw new NotFoundException("sale_not_found");
      if (sale.status !== "pending_approval") throw new BadRequestException("sale_not_pending_approval");
      await c.query("UPDATE sales SET status='rejected' WHERE id=$1", [id]);
      await audit(c, { shopId: u.shopId, actorId: u.id, action: "sale.credit.rejected", entity: "sale", entityId: id,
        oldValue: { status: "pending_approval" }, newValue: { status: "rejected" }, reason: b.data.reason });
      return { ok: true, saleId: id, status: "rejected" };
    });
    emitShopChange(u.shopId, ["sale"]);
    return out;
  }

  @Post(":id/void")
  async voidSale(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("sale_not_found");
    const { reason } = VoidRequest.parse(body);
    const out = await this.db.tx(async (c) => {
      const { rows: [sale] } = await c.query(
        "SELECT id, status, gross_amount, discount, amount_paid, payment_method, sold_at, customer_id FROM sales WHERE id=$1 AND shop_id=$2 FOR UPDATE",
        [id, u.shopId]);
      if (!sale) throw new NotFoundException("sale_not_found");
      if (sale.status !== "posted") throw new BadRequestException("sale_already_reversed");
      // Reversing a credit sale removes the debt. If repayments already cover that debt, the
      // customer would be left with a negative balance; require an explicit credit adjustment first.
      if (sale.customer_id) {
        // Serialize with repayments and adjustments. Without this lock a repayment can commit
        // between the balance check below and the reversal, leaving the customer negative.
        await c.query("SELECT id FROM customers WHERE id=$1 AND shop_id=$2 FOR UPDATE", [sale.customer_id, u.shopId]);
        const credit = Number(sale.gross_amount) - Number(sale.discount) - Number(sale.amount_paid);
        if (credit > 0) {
          const { rows: [b] } = await c.query(
            `SELECT COALESCE((SELECT SUM(gross_amount-discount-amount_paid) FROM sales WHERE shop_id=$1 AND customer_id=$2 AND status='posted'),0)
                    - COALESCE((SELECT SUM(amount) FROM credit_payments WHERE shop_id=$1 AND customer_id=$2),0)
                    + COALESCE((SELECT SUM(amount) FROM credit_adjustments WHERE shop_id=$1 AND customer_id=$2),0) AS owing`,
            [u.shopId, sale.customer_id]);
          if (Number(b.owing) - credit < 0) throw new BadRequestException("credit_payment_exists");
        }
      }

      const { rows: lines } = await c.query(
        `SELECT sl.product_id, sl.qty, sl.unit_price, sl.line_amount, sl.unit_cost, p.name, p.code
         FROM sale_lines sl JOIN products p ON p.id = sl.product_id
         WHERE sl.sale_id = $1 ORDER BY sl.id`, [id]);
      if (!lines.length) throw new BadRequestException("sale_has_no_lines");

      for (const l of lines) {
        // The goods go back at the cost they left at, not at today's average: voiding a sale cannot
        // move profit into (or out of) the period the cost changed in. Legacy lines carry no recorded
        // cost and keep the running-average fallback.
        const cost = l.unit_cost === null || l.unit_cost === undefined ? null : Number(l.unit_cost);
        await c.query(
          `INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,reason,occurred_at)
           VALUES ($1,$2,'sale_return',$3,$4,'sale_void',$5,$6,$7,now())`,
          [u.shopId, l.product_id, l.qty, cost, id, u.id, `sale void: ${reason}`]);
        await c.query("UPDATE products SET updated_at=now() WHERE id=$1", [l.product_id]);
      }

      await c.query(
        "UPDATE sales SET status='reversed', reversed_at=now(), reversed_by=$3, reversal_reason=$4 WHERE id=$1 AND shop_id=$2",
        [id, u.shopId, u.id, reason]);

      await audit(c, {
        shopId: u.shopId, actorId: u.id, action: "sale.void", entity: "sale", entityId: id,
        oldValue: { status: "posted", grossAmount: Number(sale.gross_amount), discount: Number(sale.discount), paid: Number(sale.amount_paid), soldAt: sale.sold_at, paymentMethod: sale.payment_method },
        newValue: { status: "reversed", lines: lines.map(l => ({ productId: l.product_id, name: l.name, code: l.code, qty: l.qty, unitPrice: l.unit_price })) },
        reason,
      });
      return { ok: true, saleId: id, status: "reversed" };
    });
    // The returned stock and the reversed sale are visible to every connected device at once.
    emitShopChange(u.shopId, ["sale", "product"]);
    return out;
  }
}
