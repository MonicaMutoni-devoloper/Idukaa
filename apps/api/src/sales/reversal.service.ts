import { BadRequestException, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { audit } from "../audits/audit";
import type { AuthUser } from "../common/auth";

export interface ReversalLine {
  product_id: string; qty: number; unit_price: number; line_amount: number;
  unit_cost: number | null; name: string; code: string | null;
}

export interface ReversalInput {
  saleId: string;
  reason: string;
  /** Owner route idempotency key; correction has its own locked correction id. */
  cancellationId?: string | null;
  approvalRef?: string | null;
  /** Undispatched goods default to restock; dispatched goods only restock when explicitly true. */
  restock?: boolean;
  /** The existing owner-only void policy. Corrections are authorised by the correction record. */
  requireApprovalAfterDispatch: boolean;
  /** `sale_void` for a normal cancellation, `sale_correction` for a correction reversal. */
  source: "sale_void" | "sale_correction";
  /** Stable id of the reversal document. Required for a correction. */
  reversalId?: string | null;
}

export interface ReversalResult {
  saleId: string;
  status: "reversed";
  restocked: boolean;
  dispatched: boolean;
  duplicate: boolean;
  lines: ReversalLine[];
  grossAmount: number;
  discount: number;
  amountPaid: number;
  paymentMethod: string;
  soldAt: string;
  customerId: string | null;
}

/**
 * The one reversal path for posted sales.
 *
 * A completed sale is never edited or deleted. This service locks the sale, refuses a second
 * reversal and any sale that already has a return document, writes reversing `sale_return`
 * movements at the cost the goods originally left at, and stamps the sale `reversed` with the actor,
 * time, reason and approval reference. The caller supplies the transaction and owns the outer
 * audit; the ledger and sale stamp commit or roll back together.
 *
 * Both the owner's void route and the correction approval use this exact implementation. A
 * correction must not grow a second, subtly different reversal rule.
 */
@Injectable()
export class SalesReversalService {
  async reverseInTx(c: PoolClient, u: AuthUser, shopId: string, input: ReversalInput): Promise<ReversalResult> {
    const { rows: [sale] } = await c.query(
      `SELECT id, status, gross_amount, discount, amount_paid, payment_method, sold_at, customer_id,
              dispatched_at, cancellation_id, reversal_id
         FROM sales WHERE id=$1 AND shop_id=$2 FOR UPDATE`,
      [input.saleId, shopId],
    );
    if (!sale) throw new BadRequestException("sale_not_found");

    if (input.cancellationId && sale.cancellation_id === input.cancellationId) {
      const lines = await this.lines(c, input.saleId);
      return {
        saleId: input.saleId, status: "reversed", restocked: true, dispatched: !!sale.dispatched_at,
        duplicate: true, lines, grossAmount: Number(sale.gross_amount), discount: Number(sale.discount),
        amountPaid: Number(sale.amount_paid), paymentMethod: sale.payment_method,
        soldAt: new Date(sale.sold_at).toISOString(), customerId: sale.customer_id ?? null,
      };
    }
    if (sale.status !== "posted") throw new BadRequestException("sale_already_reversed");
    if (sale.reversal_id) throw new BadRequestException("sale_already_reversed");

    const { rows: [ret] } = await c.query(
      "SELECT COUNT(*)::int AS n FROM sale_returns WHERE sale_id=$1 AND shop_id=$2",
      [input.saleId, shopId],
    );
    if (Number(ret?.n ?? 0) > 0) throw new BadRequestException("sale_has_returns");

    const dispatched = sale.dispatched_at !== null && sale.dispatched_at !== undefined;
    if (dispatched && input.requireApprovalAfterDispatch && !input.approvalRef) {
      throw new BadRequestException("approval_ref_required_after_dispatch");
    }
    // Dispatched goods are never silently restocked by a void. A correction handles the physical
    // question explicitly at request time and passes its decision in `restock`; a delivered
    // price-only correction pairs the reversal with a corrected sale, so the net physical position
    // remains unchanged.
    const restock = input.restock ?? !dispatched;

    // Reversing a credit sale removes the debt. If repayments already cover that debt, the customer
    // would be left with a negative balance; require an explicit credit adjustment first.
    if (sale.customer_id) {
      await c.query("SELECT id FROM customers WHERE id=$1 AND shop_id=$2 FOR UPDATE", [sale.customer_id, shopId]);
      const credit = Number(sale.gross_amount) - Number(sale.discount) - Number(sale.amount_paid);
      if (credit > 0) {
        const { rows: [b] } = await c.query(
          `SELECT COALESCE((SELECT SUM(gross_amount-discount-amount_paid) FROM sales WHERE shop_id=$1 AND customer_id=$2 AND status='posted'),0)
                  - COALESCE((SELECT SUM(amount) FROM credit_payments WHERE shop_id=$1 AND customer_id=$2),0)
                  + COALESCE((SELECT SUM(amount) FROM credit_adjustments WHERE shop_id=$1 AND customer_id=$2),0) AS owing`,
          [shopId, sale.customer_id],
        );
        if (Number(b.owing) - credit < 0) throw new BadRequestException("credit_payment_exists");
      }
    }

    const lines = await this.lines(c, input.saleId);
    if (!lines.length) throw new BadRequestException("sale_has_no_lines");

    const sourceId = input.source === "sale_correction" ? input.reversalId : input.saleId;
    if (!sourceId) throw new BadRequestException("reversal_id_required");

    if (restock) {
      for (const l of lines) {
        await c.query(
          `INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,reason,occurred_at)
           VALUES ($1,$2,'sale_return',$3,$4,$5,$6,$7,$8,now())`,
          [shopId, l.product_id, l.qty, l.unit_cost, input.source, sourceId, u.id,
            input.source === "sale_correction" ? `correction reversal: ${input.reason}` : `sale cancelled: ${input.reason}`],
        );
        await c.query("UPDATE products SET updated_at=now() WHERE id=$1", [l.product_id]);
      }
    }

    const { rows: [updated] } = await c.query(
      `UPDATE sales SET status='reversed', reversed_at=now(), reversed_by=$3, reversal_reason=$4,
                        cancellation_id=COALESCE(cancellation_id,$5), cancellation_approval_ref=COALESCE(cancellation_approval_ref,$6),
                        reversal_id=COALESCE(reversal_id,$7)
        WHERE id=$1 AND shop_id=$2
        RETURNING id`,
      [input.saleId, shopId, u.id, input.reason, input.cancellationId ?? null, input.approvalRef ?? null,
        input.reversalId ?? null],
    );
    if (!updated) throw new BadRequestException("sale_not_found");

    await audit(c, {
      shopId, actorId: u.id,
      action: input.source === "sale_correction" ? "sale.correction.reversal" : "sale.void",
      entity: "sale", entityId: input.saleId,
      oldValue: {
        status: "posted", grossAmount: Number(sale.gross_amount), discount: Number(sale.discount),
        paid: Number(sale.amount_paid), soldAt: sale.sold_at, paymentMethod: sale.payment_method,
      },
      newValue: {
        status: "reversed", restocked: restock, dispatched,
        cancellationId: input.cancellationId ?? null, reversalId: input.reversalId ?? null,
        lines: lines.map((l) => ({ productId: l.product_id, name: l.name, code: l.code, qty: l.qty, unitPrice: l.unit_price })),
      },
      reason: input.reason,
      approvalRef: input.approvalRef ?? undefined,
    });

    return {
      saleId: input.saleId, status: "reversed", restocked: restock, dispatched, duplicate: false, lines,
      grossAmount: Number(sale.gross_amount), discount: Number(sale.discount), amountPaid: Number(sale.amount_paid),
      paymentMethod: sale.payment_method, soldAt: new Date(sale.sold_at).toISOString(),
      customerId: sale.customer_id ?? null,
    };
  }

  private async lines(c: PoolClient, saleId: string): Promise<ReversalLine[]> {
    const { rows } = await c.query(
      `SELECT sl.product_id, sl.qty, sl.unit_price, sl.line_amount, sl.unit_cost, p.name, p.code
         FROM sale_lines sl JOIN products p ON p.id = sl.product_id
        WHERE sl.sale_id = $1 ORDER BY sl.id`,
      [saleId],
    );
    return rows.map((l) => ({
      product_id: l.product_id, qty: Number(l.qty), unit_price: Number(l.unit_price),
      line_amount: Number(l.line_amount), unit_cost: l.unit_cost === null ? null : Number(l.unit_cost),
      name: l.name, code: l.code,
    }));
  }
}
