import { BadRequestException, Body, Controller, NotFoundException, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { audit } from "../audits/audit";
import { emitShopChange } from "../realtime/hub";

const VoidRequest = z.object({ reason: z.string().trim().min(3).max(500) });

/**
 * A completed sale is never edited or deleted. An owner can void it once: every line goes back to
 * the ledger as a sale_return, the sale is stamped reversed, and the reason is audited. The row lock
 * and the status filter inside one transaction make a second reversal impossible.
 */
@Controller("sales") @Roles("owner")
export class SalesController {
  constructor(private db: Db) {}

  @Post(":id/void")
  async voidSale(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("sale_not_found");
    const { reason } = VoidRequest.parse(body);
    const out = await this.db.tx(async (c) => {
      const { rows: [sale] } = await c.query(
        "SELECT id, status, gross_amount, discount, amount_paid, payment_method, sold_at FROM sales WHERE id=$1 AND shop_id=$2 FOR UPDATE",
        [id, u.shopId]);
      if (!sale) throw new NotFoundException("sale_not_found");
      if (sale.status !== "posted") throw new BadRequestException("sale_already_reversed");

      const { rows: lines } = await c.query(
        `SELECT sl.product_id, sl.qty, sl.unit_price, sl.line_amount, p.name, p.code
         FROM sale_lines sl JOIN products p ON p.id = sl.product_id
         WHERE sl.sale_id = $1 ORDER BY sl.id`, [id]);
      if (!lines.length) throw new BadRequestException("sale_has_no_lines");

      for (const l of lines) {
        await c.query(
          `INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,reason,occurred_at)
           VALUES ($1,$2,'sale_return',$3,NULL,'sale_void',$4,$5,$6,now())`,
          [u.shopId, l.product_id, l.qty, id, u.id, `sale void: ${reason}`]);
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
