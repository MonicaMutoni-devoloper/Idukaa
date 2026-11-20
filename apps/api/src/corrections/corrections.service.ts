import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { audit } from "../audits/audit";
import type { AuthUser } from "../common/auth";
import { Db } from "../db/db.service";
import { SalePostingError, SalePostingService, type SalePostingLine } from "../sales/sale-posting.service";
import { SalesReversalService } from "../sales/reversal.service";

export interface CorrectionProposal {
  discount: number;
  amountPaid: number;
  lineCosts: number;
  lines: { productId: string; qty: number; unitPrice: number; sellingQty?: number }[];
  gross: number;
  net: number;
  refund: number;
  additional: number;
}

export interface CorrectionRequestInput {
  correctionId: string;
  saleId: string;
  reason: string;
  evidence?: string;
  fulfillment: "not_handed_over" | "handed_over";
  discount: number;
  amountPaid: number;
  lines: SalePostingLine[];
  alertId?: string | null;
  /** Named debtor when the corrected sale creates a balance and the original sale was walk-in. */
  customerId?: string | null;
}

const round = (n: number) => Math.max(0, Math.round(n));
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/** Stable ordered representation: the stored snapshot and the live sale must produce the same hash. */
function fingerprint(s: any, lines: any[]): string {
  const canonical = JSON.stringify({
    id: s.id,
    soldAt: iso(s.sold_at),
    gross: Number(s.gross_amount),
    discount: Number(s.discount),
    paid: Number(s.amount_paid),
    method: s.payment_method,
    customerId: s.customer_id ?? null,
    status: s.status,
    lines: lines.map((l) => ({
      productId: l.product_id, qty: Number(l.qty), unitPrice: Number(l.unit_price),
      lineAmount: Number(l.line_amount),
      unitCost: l.unit_cost === null || l.unit_cost === undefined ? null : Number(l.unit_cost),
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

@Injectable()
export class CorrectionsService {
  constructor(
    private db: Db,
    private posting: SalePostingService,
    private reversal: SalesReversalService,
  ) {}

  /**
   * Record a correction request. This is the only phase available offline: it validates and freezes
   * the evidence and proposal, writes no stock or money movement, and never changes the sale.
   */
  async createInTx(
    c: PoolClient, u: AuthUser, shopId: string, input: CorrectionRequestInput, opId?: string | null,
  ) {
    if (u.role !== "owner" && u.role !== "manager") throw new ForbiddenException("role_not_allowed");
    const existing = await c.query(
      "SELECT id, requested_by, sale_id, status FROM sale_corrections WHERE id=$1 AND shop_id=$2",
      [input.correctionId, shopId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].requested_by !== u.id || existing.rows[0].sale_id !== input.saleId) {
        throw new BadRequestException("correction_id_conflict");
      }
      return { correctionId: input.correctionId, duplicate: true, status: existing.rows[0].status };
    }

    const { rows: [sale] } = await c.query(
      `SELECT s.id, s.shop_id, s.sold_at, s.gross_amount, s.discount, s.amount_paid, s.payment_method,
              s.customer_id, s.due_at, s.status, s.dispatched_at, s.reversal_id, s.corrects_sale_id,
              s.correction_id, u.full_name AS cashier
         FROM sales s JOIN users u ON u.id=s.user_id
        WHERE s.id=$1 AND s.shop_id=$2 FOR UPDATE`,
      [input.saleId, shopId],
    );
    if (!sale) throw new NotFoundException("sale_not_found");
    this.assertCorrectable(sale);
    // A dispatched sale has left the shop. A client cannot relabel it as still in stock to get an
    // unsafe quantity change through the reversal; the physical return workflow must handle that.
    if (sale.dispatched_at && input.fulfillment !== "handed_over") {
      throw new BadRequestException("dispatched_sale_must_be_handed_over");
    }

    const { rows: originalLines } = await c.query(
      `SELECT sl.product_id, sl.qty, sl.unit_price, sl.line_amount, sl.unit_cost, sl.qty_entered,
              p.name, p.code, p.unit, p.selling_unit
         FROM sale_lines sl JOIN products p ON p.id=sl.product_id
        WHERE sl.sale_id=$1 ORDER BY sl.id`,
      [sale.id],
    );
    if (!originalLines.length) throw new BadRequestException("sale_has_no_lines");

    const { rows: [ret] } = await c.query(
      "SELECT COUNT(*)::int AS n FROM sale_returns WHERE sale_id=$1 AND shop_id=$2",
      [sale.id, shopId],
    );
    if (Number(ret?.n ?? 0) > 0) throw new BadRequestException("sale_has_returns");

    let quoted: Awaited<ReturnType<SalePostingService["quoteInTx"]>>;
    try {
      quoted = await this.posting.quoteInTx(c, shopId, input.lines);
    } catch (e: any) {
      if (e instanceof SalePostingError) throw new BadRequestException(e.message);
      throw e;
    }
    if (input.discount > quoted.gross) throw new BadRequestException("discount_exceeds_total");
    const net = quoted.gross - input.discount;
    if (input.fulfillment === "handed_over") {
      this.assertNoPhysicalChange(originalLines, quoted.lines);
    }

    // The amount already collected is a historical fact from the posted sale, not a client claim.
    // Accepting it from the request would let a caller manufacture a refund or a new receivable.
    const originalCollected = Number(sale.amount_paid);
    const additional = round(net - originalCollected);
    if (sale.customer_id && input.customerId && input.customerId !== sale.customer_id) {
      throw new BadRequestException("customer_change_not_allowed");
    }
    // A corrected credit balance must have a named debtor. A refund can be recorded without one.
    // A walk-in sale can name the debtor at correction time; the owner reviews and approves that
    // choice before the corrected sale is posted.
    const correctionCustomerId = additional > 0 ? (sale.customer_id ?? input.customerId ?? null) : sale.customer_id;
    if (additional > 0 && !correctionCustomerId) {
      throw new BadRequestException("customer_required_for_additional_payment");
    }
    if (correctionCustomerId) {
      const { rowCount } = await c.query(
        "SELECT 1 FROM customers WHERE id=$1 AND shop_id=$2 AND status='active'",
        [correctionCustomerId, shopId],
      );
      if (!rowCount) throw new BadRequestException("customer_blocked");
    }

    if (input.alertId) {
      const { rows: [alert] } = await c.query(
        "SELECT id, status, category, entity_type, entity_id FROM business_alerts WHERE id=$1 AND shop_id=$2",
        [input.alertId, shopId],
      );
      if (!alert) throw new BadRequestException("alert_not_found");
      if (alert.entity_type !== "sale" || alert.entity_id !== sale.id) {
        throw new BadRequestException("alert_sale_mismatch");
      }
    }

    const snapshot = {
      id: sale.id,
      at: iso(sale.sold_at),
      cashier: sale.cashier,
      status: sale.status,
      paymentMethod: sale.payment_method,
      dispatchedAt: iso(sale.dispatched_at),
      customerId: sale.customer_id ?? null,
      gross: Number(sale.gross_amount),
      discount: Number(sale.discount),
      net: Number(sale.gross_amount) - Number(sale.discount),
      amountPaid: Number(sale.amount_paid),
      lines: originalLines.map((l) => ({
        productId: l.product_id, name: l.name, code: l.code, unit: l.unit, sellingUnit: l.selling_unit,
        qty: Number(l.qty), qtyEntered: l.qty_entered === null ? Number(l.qty) : Number(l.qty_entered),
        unitPrice: Number(l.unit_price), lineAmount: Number(l.line_amount),
        unitCost: l.unit_cost === null || l.unit_cost === undefined ? null : Number(l.unit_cost),
      })),
    };
    const proposedIds = [...new Set(quoted.lines.map((l) => l.productId))];
    const proposedProducts = await c.query(
      "SELECT id, name, code, unit, selling_unit FROM products WHERE shop_id=$1 AND id = ANY($2::uuid[])",
      [shopId, proposedIds],
    );
    const productById = new Map(proposedProducts.rows.map((p: any) => [p.id, p]));
    const proposal = {
      discount: input.discount,
      amountPaid: originalCollected,
      customerId: correctionCustomerId,
      lines: quoted.lines.map((l) => {
        const product: any = productById.get(l.productId);
        return {
          productId: l.productId, name: product?.name ?? null, code: product?.code ?? null,
          unit: product?.unit ?? null, sellingUnit: product?.selling_unit ?? null,
          qty: l.qty, sellingQty: l.sellingQty, unitPrice: l.unitPrice, lineAmount: l.lineAmount,
        };
      }),
    };
    const refund = round(originalCollected - net);
    const fp = fingerprint(sale, originalLines);

    await c.query(
      `INSERT INTO sale_corrections(
         id,shop_id,sale_id,request_op_id,requested_by,reason,evidence,
         original_snapshot,original_fingerprint,original_gross,original_discount,original_net,original_collected,
         proposed,proposed_gross,proposed_discount,proposed_net,proposed_collected,fulfillment,
         expected_refund,expected_additional,alert_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        input.correctionId, shopId, sale.id, opId ?? null, u.id, input.reason, input.evidence ?? null,
        JSON.stringify(snapshot), fp, Number(sale.gross_amount), Number(sale.discount),
        Number(sale.gross_amount) - Number(sale.discount), originalCollected,
        JSON.stringify(proposal), quoted.gross, input.discount, net, originalCollected, input.fulfillment,
        refund, additional, input.alertId ?? null,
      ],
    );
    await this.event(c, shopId, u.id, input.correctionId, "requested", null, "pending_approval", input.reason, {
      fulfillment: input.fulfillment, originalNet: Number(sale.gross_amount) - Number(sale.discount),
      proposedNet: net, expectedRefund: refund, expectedAdditional: additional,
      alertId: input.alertId ?? null, customerId: correctionCustomerId,
    });
    await audit(c, {
      shopId, actorId: u.id, action: "sale.correction.requested", entity: "sale_correction", entityId: input.correctionId,
      oldValue: { saleId: sale.id, status: sale.status, gross: Number(sale.gross_amount), discount: Number(sale.discount), net: Number(sale.gross_amount) - Number(sale.discount), collected: originalCollected },
      newValue: { status: "pending_approval", fulfillment: input.fulfillment, gross: quoted.gross, discount: input.discount, net, collected: originalCollected, customerId: correctionCustomerId, lines: proposal.lines },
      reason: input.reason,
    });
    return { correctionId: input.correctionId, duplicate: false, status: "pending_approval", originalFingerprint: fp };
  }

  async list(shopId: string, canDecide = false) {
    const rows = await this.db.query(
      `SELECT sc.*, ru.full_name AS requested_name, ou.full_name AS owner_name,
              s.sold_at, s.user_id AS cashier_id, cu.full_name AS cashier_name,
              cc.id AS correction_customer_id, cc.name AS correction_customer_name,
              cc.phone AS correction_customer_phone
         FROM sale_corrections sc
         JOIN sales s ON s.id=sc.sale_id
         JOIN users ru ON ru.id=sc.requested_by
         JOIN users cu ON cu.id=s.user_id
         LEFT JOIN users ou ON ou.id=sc.owner_id
         LEFT JOIN customers cc
           ON cc.id = COALESCE(NULLIF(sc.proposed->>'customerId','')::uuid, s.customer_id)
        WHERE sc.shop_id=$1
        ORDER BY CASE WHEN sc.status='pending_approval' THEN 0 ELSE 1 END,
                 sc.requested_at DESC, sc.id DESC LIMIT 200`,
      [shopId],
    );
    return { corrections: rows.map((r) => this.shape(r, canDecide)), canDecide };
  }

  async get(shopId: string, id: string, canDecide = false) {
    const [row] = await this.db.query(
      `SELECT sc.*, ru.full_name AS requested_name, ou.full_name AS owner_name,
              s.sold_at, s.user_id AS cashier_id, cu.full_name AS cashier_name,
              cc.id AS correction_customer_id, cc.name AS correction_customer_name,
              cc.phone AS correction_customer_phone
         FROM sale_corrections sc
         JOIN sales s ON s.id=sc.sale_id
         JOIN users ru ON ru.id=sc.requested_by
         JOIN users cu ON cu.id=s.user_id
         LEFT JOIN users ou ON ou.id=sc.owner_id
         LEFT JOIN customers cc
           ON cc.id = COALESCE(NULLIF(sc.proposed->>'customerId','')::uuid, s.customer_id)
        WHERE sc.id=$1 AND sc.shop_id=$2`,
      [id, shopId],
    );
    if (!row) throw new NotFoundException("correction_not_found");
    const events = await this.db.query(
      `SELECT e.id, e.action, e.note, e.previous_status, e.new_status, e.details, e.at,
              u.full_name AS actor
         FROM sale_correction_events e LEFT JOIN users u ON u.id=e.actor_id
        WHERE e.correction_id=$1 AND e.shop_id=$2 ORDER BY e.id`,
      [id, shopId],
    );
    const corrected = row.corrected_sale_id
      ? (await this.db.query(
        `SELECT id, status, sold_at, gross_amount, discount, amount_paid, payment_method, reversal_id
           FROM sales WHERE id=$1 AND shop_id=$2`,
        [row.corrected_sale_id, shopId],
      ))[0]
      : null;
    return {
      ...this.shape(row, canDecide),
      events,
      correctedSale: corrected ? {
        id: corrected.id, status: corrected.status, at: iso(corrected.sold_at),
        gross: Number(corrected.gross_amount), discount: Number(corrected.discount),
        net: Number(corrected.gross_amount) - Number(corrected.discount),
        amountPaid: Number(corrected.amount_paid), paymentMethod: corrected.payment_method,
        reversalId: corrected.reversal_id ?? null,
      } : null,
    };
  }

  /**
   * Everything needed by the correction form. The sale is read from the server, but the immutable
   * request snapshot is always what the owner reviews after submission.
   */
  async saleContext(shopId: string, saleId: string) {
    const [sale] = await this.db.query(
      `SELECT s.id, s.sold_at, s.gross_amount, s.discount, s.amount_paid, s.payment_method, s.status,
              s.dispatched_at, s.reversal_reason, s.reversal_id, s.corrects_sale_id, s.correction_id,
              s.customer_id, c.name AS customer_name, c.phone AS customer_phone,
              us.full_name AS cashier
         FROM sales s JOIN users us ON us.id=s.user_id
         LEFT JOIN customers c ON c.id=s.customer_id
        WHERE s.id=$1 AND s.shop_id=$2`,
      [saleId, shopId],
    );
    if (!sale) throw new NotFoundException("sale_not_found");
    const lines = await this.db.query(
      `SELECT sl.product_id, p.name, p.code, p.unit, p.selling_unit, sl.qty, sl.unit_price,
              sl.line_amount, sl.qty_entered
         FROM sale_lines sl JOIN products p ON p.id=sl.product_id
        WHERE sl.sale_id=$1 ORDER BY sl.id`,
      [saleId],
    );
    const [ret] = await this.db.query(
      "SELECT COUNT(*)::int AS n FROM sale_returns WHERE sale_id=$1 AND shop_id=$2",
      [saleId, shopId],
    );
    const [pending] = await this.db.query(
      "SELECT id FROM sale_corrections WHERE shop_id=$1 AND sale_id=$2 AND status='pending_approval'",
      [shopId, saleId],
    );
    const [closed] = await this.db.query(
      "SELECT id FROM sale_corrections WHERE shop_id=$1 AND sale_id=$2 AND status IN ('completed','reconciliation_required')",
      [shopId, saleId],
    );
    let reason: string | null = null;
    if (sale.status !== "posted") reason = "sale_not_posted";
    else if (Number(ret?.n ?? 0) > 0) reason = "sale_has_returns";
    else if (sale.corrects_sale_id) reason = "sale_is_corrected_sale";
    else if (closed) reason = "sale_already_corrected";
    else if (pending) reason = "correction_pending";
    return {
      sale: {
        id: sale.id, at: iso(sale.sold_at), cashier: sale.cashier, paymentMethod: sale.payment_method,
        status: sale.status, dispatchedAt: iso(sale.dispatched_at), reversalReason: sale.reversal_reason ?? null,
        gross: Number(sale.gross_amount), discount: Number(sale.discount),
        net: Number(sale.gross_amount) - Number(sale.discount),
        amountPaid: Number(sale.amount_paid),
        balance: Number(sale.gross_amount) - Number(sale.discount) - Number(sale.amount_paid),
        customer: sale.customer_id ? {
          id: sale.customer_id, name: sale.customer_name, phone: sale.customer_phone ?? null,
        } : null,
        correctsSaleId: sale.corrects_sale_id ?? null, correctionId: sale.correction_id ?? null,
      },
      lines: lines.map((l) => ({
        productId: l.product_id, name: l.name, code: l.code, unit: l.unit,
        sellingUnit: l.selling_unit, qty: Number(l.qty),
        qtyEntered: l.qty_entered === null ? Number(l.qty) : Number(l.qty_entered),
        unitPrice: Number(l.unit_price), lineAmount: Number(l.line_amount),
      })),
      eligibility: {
        canRequest: reason === null, reason,
        hasReturns: Number(ret?.n ?? 0) > 0,
        pendingCorrectionId: pending?.id ?? null,
        closedCorrectionId: closed?.id ?? null,
        fulfillmentDefault: sale.dispatched_at ? "handed_over" : "not_handed_over",
      },
    };
  }

  /** Owner approval: validate, reverse and re-post in one transaction. Nothing is partially written. */
  async approve(u: AuthUser, id: string, note?: string) {
    if (u.role !== "owner") throw new ForbiddenException("role_not_allowed");
    if (!u.shopId) throw new BadRequestException("shop_required");
    const shopId = u.shopId;
    await this.db.tx(async (c) => {
      const { rows: [corr] } = await c.query(
        "SELECT * FROM sale_corrections WHERE id=$1 AND shop_id=$2 FOR UPDATE",
        [id, shopId],
      );
      if (!corr) throw new NotFoundException("correction_not_found");
      if (corr.status === "completed" || corr.status === "reconciliation_required") {
        // A retried approval is idempotent: the correction already has its one reversal and one
        // corrected sale. It must never post a second pair.
        return;
      }
      if (corr.status !== "pending_approval") throw new BadRequestException("correction_not_pending");

      const { rows: [sale] } = await c.query(
        `SELECT id, shop_id, sold_at, gross_amount, discount, amount_paid, payment_method, customer_id,
                due_at, status, dispatched_at, reversal_id, corrects_sale_id, correction_id
           FROM sales WHERE id=$1 AND shop_id=$2 FOR UPDATE`,
        [corr.sale_id, shopId],
      );
      if (!sale) throw new NotFoundException("sale_not_found");
      if (sale.status !== "posted") throw new ConflictException("sale_not_posted");
      if (sale.reversal_id) throw new ConflictException("sale_already_reversed");
      if (sale.dispatched_at && corr.fulfillment !== "handed_over") {
        throw new ConflictException("dispatched_sale_fulfillment_changed");
      }
      const { rows: originalLines } = await c.query(
        `SELECT sl.product_id, sl.qty, sl.unit_price, sl.line_amount, sl.unit_cost, sl.qty_entered
           FROM sale_lines sl WHERE sl.sale_id=$1 ORDER BY sl.id`,
        [sale.id],
      );
      if (fingerprint(sale, originalLines) !== corr.original_fingerprint) {
        throw new ConflictException("original_sale_changed");
      }
      const { rows: [ret] } = await c.query(
        "SELECT COUNT(*)::int AS n FROM sale_returns WHERE sale_id=$1 AND shop_id=$2",
        [sale.id, shopId],
      );
      if (Number(ret?.n ?? 0) > 0) throw new ConflictException("sale_has_returns");

      const proposed = corr.proposed as {
        discount: number; amountPaid: number; lines: SalePostingLine[]; customerId?: string | null;
      };
      let quoted: Awaited<ReturnType<SalePostingService["quoteInTx"]>>;
      try {
        quoted = await this.posting.quoteInTx(c, shopId, proposed.lines);
      } catch (e: any) {
        if (e instanceof SalePostingError) throw new BadRequestException(e.message);
        throw e;
      }
      const correctedNet = quoted.gross - proposed.discount;
      if (correctedNet !== Number(corr.proposed_net)) {
        throw new ConflictException("proposal_changed");
      }
      if (corr.fulfillment === "handed_over") this.assertNoPhysicalChange(originalLines, quoted.lines);

      // The debtor was frozen in the reviewed proposal. Validate it again under the approval lock:
      // a customer blocked after the request must not receive the corrected receivable.
      if (sale.customer_id && proposed.customerId && proposed.customerId !== sale.customer_id) {
        throw new BadRequestException("customer_change_not_allowed");
      }
      const correctionCustomerId = sale.customer_id ?? proposed.customerId ?? null;
      const additional = round(correctedNet - Number(corr.original_collected));
      if (additional > 0 && !correctionCustomerId) {
        throw new BadRequestException("customer_required_for_additional_payment");
      }
      if (correctionCustomerId) {
        const { rowCount } = await c.query(
          "SELECT 1 FROM customers WHERE id=$1 AND shop_id=$2 AND status='active'",
          [correctionCustomerId, shopId],
        );
        if (!rowCount) throw new BadRequestException("customer_blocked");
      }

      // Handed-over goods never come back. The reversal restocks and the corrected sale relieves the
      // SAME quantities at the SAME historical cost, so stock quantity and inventory value both net
      // to zero instead of being silently revalued at today's moving average.
      let costOverrides: Map<string, number> | undefined;
      if (corr.fulfillment === "handed_over") {
        costOverrides = new Map();
        for (const l of originalLines) {
          if (l.unit_cost === null || l.unit_cost === undefined) throw new ConflictException("original_cost_missing");
          costOverrides.set(l.product_id, Number(l.unit_cost));
        }
      }

      const reversalId = randomUUID();
      const reversal = await this.reversal.reverseInTx(c, u, shopId, {
        saleId: sale.id, reason: corr.reason, reversalId, restock: true,
        requireApprovalAfterDispatch: false, source: "sale_correction",
      });

      const correctedSaleId = randomUUID();
      const internalOpId = randomUUID();
      await c.query(
        `INSERT INTO operations(op_id,shop_id,user_id,device_id,type,payload,status,client_created_at)
         VALUES ($1,$2,$3,'transaction-correction','sale.correction.post',$4,'applied',now())`,
        [internalOpId, shopId, u.id, JSON.stringify({ correctionId: id, originalSaleId: sale.id, correctedSaleId })],
      );
      let posted: Awaited<ReturnType<SalePostingService["postInTx"]>>;
      try {
        // The corrected sale is consideration for the corrected goods/services, so it can consume at
        // most its own net amount. Any excess originally collected stays a refund liability tracked
        // on the correction instead of becoming a negative receivable on the customer.
        const appliedPaid = Math.min(Number(corr.original_collected), correctedNet);
        posted = await this.posting.postInTx(c, u, shopId, internalOpId, {
          saleId: correctedSaleId,
          soldAt: new Date().toISOString(),
          discount: proposed.discount,
          amountPaid: appliedPaid,
          paymentMethod: sale.payment_method,
          customerId: correctionCustomerId,
          dueAt: sale.due_at,
          lines: proposed.lines,
        }, {
          applyDuePrices: false, allowOwnerOverCreditLimit: true, allowOverpayment: true,
          correction: { correctionId: id, originalSaleId: sale.id, reversalId }, costOverrides,
        });
      } catch (e: any) {
        if (e instanceof SalePostingError) throw new BadRequestException(e.message);
        throw e;
      }
      if (posted.status !== "posted") throw new ConflictException("corrected_sale_not_posted");

      const refund = round(Number(corr.original_collected) - posted.net);
      const status = refund > 0 ? "reconciliation_required" : "completed";
      const moneyStatus = refund > 0 ? "refund_due" : additional > 0 ? "balance_due" : "reconciled";
      await c.query(
        `UPDATE sale_corrections
            SET status=$2, owner_id=$3, decided_at=now(), decision_note=$4,
                reversal_id=$5, corrected_sale_id=$6, stock_status='reconciled', money_status=$7,
                updated_at=now()
          WHERE id=$1 AND shop_id=$8`,
        [id, status, u.id, note ?? null, reversalId, correctedSaleId, moneyStatus, shopId],
      );

      await this.event(c, shopId, u.id, id, "approved", "pending_approval", "processing", note ?? null, {
        ownerId: u.id, reversalId, correctedSaleId,
      });
      await this.event(c, shopId, u.id, id, "reversed", "processing", "reversed", corr.reason, {
        reversalId, restocked: true, dispatched: !!sale.dispatched_at,
        stockMovements: reversal.lines.map((l) => ({ productId: l.product_id, qty: l.qty, unitCost: l.unit_cost })),
      });
      await this.event(c, shopId, u.id, id, "corrected", "reversed", "corrected", null, {
        correctedSaleId, gross: posted.gross, discount: posted.discount, net: posted.net,
        collected: posted.amountPaid, customerId: correctionCustomerId,
      });
      await this.event(c, shopId, u.id, id, "stock_reconciled", "corrected", "stock_reconciled", null, {
        fulfillment: corr.fulfillment, netPhysicalChange: this.physicalDelta(originalLines, quoted.lines),
      });
      await this.event(c, shopId, u.id, id, moneyStatus === "reconciled" ? "money_reconciled" : "money_reconciliation_required",
        "stock_reconciled", status, null, { refund, additional, moneyStatus });
      if (status === "completed") {
        await this.event(c, shopId, u.id, id, "completed", status, status, null, {});
      }

      await audit(c, {
        shopId: shopId, actorId: u.id, action: "sale.correction.approved", entity: "sale_correction", entityId: id,
        oldValue: { status: "pending_approval", saleId: sale.id },
        newValue: {
          status, reversalId, correctedSaleId, gross: posted.gross, discount: posted.discount,
          net: posted.net, collected: posted.amountPaid, refund, additional, moneyStatus,
          customerId: correctionCustomerId,
        },
        reason: note ?? corr.reason,
      });

      if (corr.alert_id) await this.linkAlert(c, u, corr.alert_id, id, correctedSaleId, status, note ?? corr.reason);
    });
    return this.get(shopId, id, true);
  }

  async reject(u: AuthUser, id: string, note: string) {
    if (u.role !== "owner") throw new ForbiddenException("role_not_allowed");
    if (!u.shopId) throw new BadRequestException("shop_required");
    const shopId = u.shopId;
    if (note.trim().length < 3) throw new BadRequestException("reason_required");
    await this.db.tx(async (c) => {
      const { rows: [corr] } = await c.query(
        "SELECT * FROM sale_corrections WHERE id=$1 AND shop_id=$2 FOR UPDATE",
        [id, shopId],
      );
      if (!corr) throw new NotFoundException("correction_not_found");
      if (corr.status === "rejected") return;
      if (corr.status !== "pending_approval") throw new BadRequestException("correction_not_pending");
      await c.query(
        `UPDATE sale_corrections SET status='rejected', owner_id=$2, decided_at=now(),
                decision_note=$3, updated_at=now() WHERE id=$1 AND shop_id=$4`,
        [id, u.id, note.trim(), shopId],
      );
      await this.event(c, shopId, u.id, id, "rejected", "pending_approval", "rejected", note.trim(), {});
      await audit(c, {
        shopId: shopId, actorId: u.id, action: "sale.correction.rejected", entity: "sale_correction", entityId: id,
        oldValue: { status: "pending_approval", saleId: corr.sale_id },
        newValue: { status: "rejected" }, reason: note.trim(),
      });
      if (corr.alert_id) {
        await c.query(
          "INSERT INTO alert_events(alert_id,shop_id,actor_id,action,note,details) VALUES ($1,$2,$3,'correction_rejected',$4,$5)",
          [corr.alert_id, shopId, u.id, note.trim(), JSON.stringify({ correctionId: id })],
        );
      }
    });
    return this.get(shopId, id, true);
  }

  /** A request for more evidence does not change the proposal or the sale. */
  async requestInfo(u: AuthUser, id: string, note: string) {
    if (u.role !== "owner") throw new ForbiddenException("role_not_allowed");
    if (!u.shopId) throw new BadRequestException("shop_required");
    const shopId = u.shopId;
    if (note.trim().length < 3) throw new BadRequestException("reason_required");
    await this.db.tx(async (c) => {
      const { rows: [corr] } = await c.query(
        "SELECT id, status FROM sale_corrections WHERE id=$1 AND shop_id=$2 FOR UPDATE",
        [id, shopId],
      );
      if (!corr) throw new NotFoundException("correction_not_found");
      if (corr.status !== "pending_approval") throw new BadRequestException("correction_not_pending");
      await this.event(c, shopId, u.id, id, "information_requested", "pending_approval", "pending_approval", note.trim(), {});
      await audit(c, {
        shopId: shopId, actorId: u.id, action: "sale.correction.information_requested",
        entity: "sale_correction", entityId: id, reason: note.trim(),
      });
    });
    return this.get(shopId, id, true);
  }

  /**
   * Record an actual refund. The app has no cash-drawer ledger, so this is a correction settlement
   * event (with the owner's note/reference), never a fabricated cash movement. Partial refunds are
   * allowed; the correction completes only when the full expected refund is recorded.
   */
  async settleRefund(u: AuthUser, id: string, amount: number, note: string) {
    if (u.role !== "owner") throw new ForbiddenException("role_not_allowed");
    if (!u.shopId) throw new BadRequestException("shop_required");
    const shopId = u.shopId;
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException("invalid_amount");
    if (note.trim().length < 3) throw new BadRequestException("reason_required");
    await this.db.tx(async (c) => {
      const { rows: [corr] } = await c.query(
        "SELECT * FROM sale_corrections WHERE id=$1 AND shop_id=$2 FOR UPDATE",
        [id, shopId],
      );
      if (!corr) throw new NotFoundException("correction_not_found");
      if (corr.status !== "reconciliation_required" || corr.money_status !== "refund_due") {
        throw new BadRequestException("correction_not_refund_due");
      }
      const remaining = Number(corr.expected_refund) - Number(corr.amount_refunded);
      if (amount > remaining) throw new BadRequestException(`refund_exceeds_due:${remaining}`);
      const next = Number(corr.amount_refunded) + amount;
      const done = next >= Number(corr.expected_refund);
      await c.query(
        `UPDATE sale_corrections SET amount_refunded=$2, money_status=$3, status=$4,
                settled_by=$5, settled_at=now(), settlement_note=$6, updated_at=now()
          WHERE id=$1 AND shop_id=$7`,
        [id, next, done ? "reconciled" : "refund_due", done ? "completed" : "reconciliation_required",
          u.id, note.trim(), shopId],
      );
      await this.event(c, shopId, u.id, id, done ? "refund_reconciled" : "refund_partial",
        corr.status, done ? "completed" : "reconciliation_required", note.trim(), {
          amount, totalRefunded: next, expectedRefund: Number(corr.expected_refund),
        });
      await audit(c, {
        shopId: shopId, actorId: u.id, action: "sale.correction.refund_recorded",
        entity: "sale_correction", entityId: id,
        newValue: { amount, totalRefunded: next, expectedRefund: Number(corr.expected_refund) },
        reason: note.trim(),
      });
    });
    return this.get(shopId, id, true);
  }

  private assertCorrectable(sale: any) {
    if (sale.status !== "posted") throw new BadRequestException("sale_not_posted");
    if (sale.reversal_id) throw new BadRequestException("sale_already_reversed");
    if (sale.corrects_sale_id) throw new BadRequestException("sale_is_corrected_sale");
  }

  /** A delivered price/discount-only correction must not change which goods physically left. */
  private assertNoPhysicalChange(original: any[], proposed: { productId: string; qty: number }[]) {
    const a = new Map<string, number>();
    const b = new Map<string, number>();
    for (const l of original) a.set(l.product_id, (a.get(l.product_id) ?? 0) + Number(l.qty));
    for (const l of proposed) b.set(l.productId, (b.get(l.productId) ?? 0) + Number(l.qty));
    if (a.size !== b.size) throw new BadRequestException("physical_stock_change_requires_return");
    for (const [pid, qty] of a) if (b.get(pid) !== qty) {
      throw new BadRequestException("physical_stock_change_requires_return");
    }
  }

  private physicalDelta(original: any[], proposed: { productId: string; qty: number }[]) {
    const a = new Map<string, number>();
    const b = new Map<string, number>();
    for (const l of original) a.set(l.product_id, (a.get(l.product_id) ?? 0) + Number(l.qty));
    for (const l of proposed) b.set(l.productId, (b.get(l.productId) ?? 0) + Number(l.qty));
    const ids = new Set([...a.keys(), ...b.keys()]);
    return [...ids].map((productId) => ({ productId, delta: (b.get(productId) ?? 0) - (a.get(productId) ?? 0) }))
      .filter((x) => x.delta !== 0);
  }

  private async event(
    c: PoolClient, shopId: string, actorId: string, correctionId: string, action: string,
    previous: string | null, next: string | null, note: string | null, details: unknown,
  ) {
    await c.query(
      `INSERT INTO sale_correction_events(correction_id,shop_id,actor_id,action,note,previous_status,new_status,details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [correctionId, shopId, actorId, action, note, previous, next, JSON.stringify(details ?? {})],
    );
  }

  private async linkAlert(
    c: PoolClient, u: AuthUser, alertId: string, correctionId: string, correctedSaleId: string,
    status: string, note: string,
  ) {
    const shopId = u.shopId!;
    const { rows: [alert] } = await c.query(
      "SELECT * FROM business_alerts WHERE id=$1 AND shop_id=$2 FOR UPDATE",
      [alertId, shopId],
    );
    if (!alert) return;
    const closed = ["resolved", "legitimate"].includes(alert.status);
    // The correction is stronger evidence than the earlier decision. Resolve (or keep resolved) as
    // human error, preserve the original resolution in the append-only event, and never reopen it.
    await c.query(
      `UPDATE business_alerts SET status='resolved', resolution_category='human_error',
              resolution_note=$2, corrective_action=$3, resolved_at=COALESCE(resolved_at,now()),
              resolved_by=COALESCE(resolved_by,$4), assigned_to=COALESCE(assigned_to,$4), updated_at=now()
        WHERE id=$1`,
      [alertId, note, `Transaction corrected: ${correctionId}`, u.id],
    );
    await c.query(
      `INSERT INTO alert_events(alert_id,shop_id,actor_id,action,note,previous_status,new_status,details)
       VALUES ($1,$2,$3,'correction_completed',$4,$5,$6,$7)`,
      [alertId, shopId, u.id, note, alert.status, "resolved",
        JSON.stringify({
          correctionId, correctedSaleId, correctionStatus: status, wasAlreadyResolved: closed,
          previousResolutionCategory: alert.resolution_category ?? null,
          previousResolutionNote: alert.resolution_note ?? null,
        })],
    );
    await audit(c, {
      shopId: shopId, actorId: u.id, action: "anomaly.correction_completed",
      entity: "business_alert", entityId: alertId,
      oldValue: { status: alert.status, resolutionCategory: alert.resolution_category ?? null },
      newValue: { status: "resolved", resolutionCategory: "human_error", correctionId, correctedSaleId },
      reason: note,
    });
  }

  private shape(r: any, canDecide = false) {
    const snapshot = r.original_snapshot as any;
    const proposed = r.proposed as any;
    const originalCollected = Number(r.original_collected);
    const collected = Number(r.proposed_collected);
    return {
      id: r.id,
      saleId: r.sale_id,
      status: r.status,
      requestedBy: r.requested_by,
      requestedByName: r.requested_name,
      requestedAt: iso(r.requested_at),
      reason: r.reason,
      evidence: r.evidence ?? null,
      fulfillment: r.fulfillment,
      original: {
        at: snapshot?.at ?? iso(r.sold_at),
        cashier: snapshot?.cashier ?? r.cashier_name,
        gross: Number(r.original_gross),
        discount: Number(r.original_discount),
        net: Number(r.original_net),
        collected: originalCollected,
        paymentMethod: snapshot?.paymentMethod ?? null,
        lines: (snapshot?.lines ?? []).map((l: any) => ({
          productId: l.productId, name: l.name, code: l.code, unit: l.unit,
          sellingUnit: l.sellingUnit ?? null, qty: l.qty, qtyEntered: l.qtyEntered ?? l.qty,
          unitPrice: l.unitPrice, lineAmount: l.lineAmount,
        })),
      },
      proposed: {
        gross: Number(r.proposed_gross),
        discount: Number(r.proposed_discount),
        net: Number(r.proposed_net),
        collected,
        lines: (proposed?.lines ?? []).map((l: any) => ({
          productId: l.productId, name: l.name ?? null, code: l.code ?? null,
          unit: l.unit ?? null, sellingUnit: l.sellingUnit ?? null,
          qty: l.qty, sellingQty: l.sellingQty ?? l.qty,
          unitPrice: l.unitPrice, lineAmount: l.lineAmount,
        })),
      },
      customer: r.correction_customer_id ? {
        id: r.correction_customer_id,
        name: r.correction_customer_name,
        phone: r.correction_customer_phone ?? null,
      } : null,
      expectedRefund: Number(r.expected_refund),
      expectedAdditional: Number(r.expected_additional),
      amountRefunded: Number(r.amount_refunded),
      amountCollected: Number(r.amount_collected),
      decisionNote: r.decision_note ?? null,
      decidedAt: iso(r.decided_at),
      ownerId: r.owner_id ?? null,
      ownerName: r.owner_name ?? null,
      reversalId: r.reversal_id ?? null,
      correctedSaleId: r.corrected_sale_id ?? null,
      stockStatus: r.stock_status,
      moneyStatus: r.money_status,
      alertId: r.alert_id ?? null,
      settlementNote: r.settlement_note ?? null,
      settledAt: iso(r.settled_at),
      updatedAt: iso(r.updated_at),
      /** Authority, not workflow state: only the shop owner may authorise or settle. */
      canDecide,
      actions: {
        approve: r.status === "pending_approval",
        reject: r.status === "pending_approval",
        requestInfo: r.status === "pending_approval",
        settleRefund: r.status === "reconciliation_required" && r.money_status === "refund_due",
      },
    };
  }
}
