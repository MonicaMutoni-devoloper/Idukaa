import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { emitShopChange } from "../realtime/hub";
import { audit } from "../audits/audit";
import { ReturnsService } from "./returns.service";

const ReturnRequest = z.object({
  returnId: z.string().uuid(),
  saleId: z.string().uuid(),
  returnedAt: z.string().datetime().optional(),
  reason: z.string().trim().min(3).max(500),
  note: z.string().trim().max(1000).optional(),
  approvalRef: z.string().trim().max(120).optional(),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    qty: z.number().int().positive(),
    condition: z.enum(["resalable", "damaged", "expired", "inspection"]),
  })).min(1).max(100),
});
const uuid = z.string().uuid();

/**
 * Product returns. A return is a separate posted document linked to the sale it reverses; the sale
 * itself and its earlier returns are never edited. The service validates the remaining returnable
 * quantity (also enforced by a database trigger), refunds the discounted amount the customer paid,
 * and restores only resalable goods at the original sale cost.
 */
@Controller("returns") @Roles("owner", "manager")
export class ReturnsController {
  constructor(private db: Db, private returns: ReturnsService) {}

  /** What can still be returned from this sale, with the refund and historical cost per unit. */
  @Get("preview/:saleId") async preview(@Me() u: AuthUser, @Param("saleId") saleId: string) {
    if (!uuid.safeParse(saleId).success) throw new NotFoundException("sale_not_found");
    return this.returns.saleView(this.db, u.shopId!, saleId);
  }

  /** Return history for one sale (used by the sale detail and the returns workflow). */
  @Get("sale/:saleId") async forSale(@Me() u: AuthUser, @Param("saleId") saleId: string) {
    if (!uuid.safeParse(saleId).success) throw new NotFoundException("sale_not_found");
    return { saleId, returns: await this.returns.listForSale(u.shopId!, saleId) };
  }

  /** All returns in a period, newest first — the returns half of the sales history. */
  @Get() async list(@Me() u: AuthUser, @Query() q: any) {
    const from = typeof q.from === "string" && !Number.isNaN(Date.parse(q.from)) ? q.from : undefined;
    const to = typeof q.to === "string" && !Number.isNaN(Date.parse(q.to)) ? q.to : undefined;
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    return { returns: await this.returns.list(u.shopId!, from, to, limit) };
  }

  /**
   * Post a return. Owner approval is required when the shop policy says so for a return of goods
   * that were damaged or expired (a concession beyond the sale terms): the reference is stored and
   * audited, and no "approval" can be invented silently by the API.
   */
  @Post() async create(@Me() u: AuthUser, @Body() body: unknown) {
    const parsed = ReturnRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const p = parsed.data;
    const needsApproval = p.lines.some((l) => l.condition === "damaged" || l.condition === "expired");
    if (needsApproval && u.role !== "owner" && !p.approvalRef) {
      throw new BadRequestException("return_approval_required");
    }
    const out = await this.db.tx(async (c) => {
      // `opId` is null for an online return: it is not an offline operation, so there is no outbox
      // row to reference. The document id itself is the idempotency key.
      const result = await this.returns.applyInTx(c, u, u.shopId!, {
        returnId: p.returnId, saleId: p.saleId, returnedAt: p.returnedAt ?? new Date().toISOString(),
        reason: p.reason, note: p.note, approvalRef: p.approvalRef, lines: p.lines,
      });
      if (result.status === "duplicate") return result;
      await audit(c, {
        shopId: u.shopId, actorId: u.id, action: needsApproval ? "sale.return.approved" : "sale.return.acknowledged",
        entity: "sale_return", entityId: p.returnId,
        newValue: { saleId: p.saleId, conditions: [...new Set(p.lines.map((l) => l.condition))] },
        approvalRef: p.approvalRef, reason: p.reason,
      });
      return result;
    });
    emitShopChange(u.shopId, ["sale", "product"]);
    return out;
  }
}
