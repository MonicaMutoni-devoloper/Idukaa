import { Controller, Get } from "@nestjs/common";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";

export interface OpenPurchaseLine { productId: string; name: string; code: string; unit: string; qtyOrdered: number; qtyReceived: number; outstanding: number; unitCost: number; sellingPrice: number | null; purchaseUnit: string | null; unitFactor: number | null }
export interface OpenPurchase { id: string; orderedAt: string; supplier: string | null; totalAmount: number; amountPaid: number; reference: string | null; notes: string | null; lines: OpenPurchaseLine[] }

/** Purchases that still have undelivered lines. Read-only: stock only changes through a receipt operation. */
@Controller("purchases") @Roles("owner", "manager")
export class PurchasesController {
  constructor(private db: Db) {}

  @Get("open") async open(@Me() u: AuthUser): Promise<{ purchases: OpenPurchase[] }> {
    const rows = await this.db.query(`
      SELECT pu.id,
             to_char(pu.ordered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ordered_at,
             pu.total_amount, pu.amount_paid, pu.reference, pu.notes, su.name AS supplier,
             pl.product_id, p.name AS product_name, p.code, p.unit,
             pl.qty_ordered, pl.qty_received, (pl.qty_ordered - pl.qty_received)::bigint AS outstanding, pl.unit_cost,
             pl.selling_price, pl.purchase_unit, pl.unit_factor
      FROM purchases pu
      JOIN purchase_lines pl ON pl.purchase_id = pu.id
      JOIN products p ON p.id = pl.product_id
      LEFT JOIN suppliers su ON su.id = pu.supplier_id
      WHERE pu.shop_id = $1 AND pl.qty_received < pl.qty_ordered
      ORDER BY pu.ordered_at DESC, p.name`, [u.shopId]);

    const byId = new Map<string, OpenPurchase>();
    for (const r of rows) {
      let p = byId.get(r.id);
      if (!p) {
        p = { id: r.id, orderedAt: r.ordered_at, supplier: r.supplier ?? null, totalAmount: r.total_amount, amountPaid: r.amount_paid, reference: r.reference ?? null, notes: r.notes ?? null, lines: [] };
        byId.set(r.id, p);
      }
      p.lines.push({ productId: r.product_id, name: r.product_name, code: r.code, unit: r.unit, qtyOrdered: r.qty_ordered, qtyReceived: r.qty_received, outstanding: r.outstanding, unitCost: r.unit_cost, sellingPrice: r.selling_price, purchaseUnit: r.purchase_unit, unitFactor: r.unit_factor });
    }
    return { purchases: [...byId.values()] };
  }
}
