import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Me, Roles, type AuthUser } from "../common/auth";
import { Db } from "../db/db.service";
import { emitShopChange } from "../realtime/hub";
import { CorrectionsService } from "./corrections.service";

const uuid = z.string().uuid();
const CreateBody = z.object({
  correctionId: uuid,
  saleId: uuid,
  reason: z.string().trim().min(3).max(1000),
  evidence: z.string().trim().max(4000).optional(),
  fulfillment: z.enum(["not_handed_over", "handed_over"]),
  discount: z.number().int().nonnegative(),
  amountPaid: z.number().int().nonnegative(),
  lines: z.array(z.object({
    productId: uuid,
    qty: z.number().int().positive(),
    unitPrice: z.number().int().nonnegative(),
    sellingQty: z.number().int().positive().optional(),
  })).min(1).max(100),
  alertId: uuid.nullable().optional(),
});
const DecisionBody = z.object({ note: z.string().trim().min(3).max(1000) });
const NoteBody = z.object({ note: z.string().trim().min(3).max(1000).optional() });
const SettleBody = z.object({
  amount: z.number().int().positive(),
  note: z.string().trim().min(3).max(1000),
});

/**
 * Transaction corrections.
 *
 * A request never changes a sale. Only the owner's approval route executes the linked reversal and
 * corrected posting; the approval is an online-only action so a queued device can never authorise
 * its own financial effect. Every read and write is scoped to the authenticated user's shop.
 */
@Controller("corrections") @Roles("owner", "manager")
export class CorrectionsController {
  constructor(private db: Db, private corrections: CorrectionsService) {}

  @Get()
  async list(@Me() u: AuthUser) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    return this.corrections.list(u.shopId);
  }

  /** The sale, its immutable snapshot and whether this user may start a correction. */
  @Get("sale/:saleId")
  async saleContext(@Me() u: AuthUser, @Param("saleId") saleId: string) {
    if (!uuid.safeParse(saleId).success) throw new NotFoundException("sale_not_found");
    if (!u.shopId) throw new BadRequestException("shop_required");
    return this.corrections.saleContext(u.shopId, saleId);
  }

  @Get(":id")
  async get(@Me() u: AuthUser, @Param("id") id: string) {
    if (!uuid.safeParse(id).success) throw new NotFoundException("correction_not_found");
    if (!u.shopId) throw new BadRequestException("shop_required");
    return this.corrections.get(u.shopId, id);
  }

  /**
   * Optional online create route. The mobile outbox uses `/sync/push` with `correction.request`, but
   * this route is useful for tests and non-device clients. The request id is the idempotency key.
   */
  @Post()
  async create(@Me() u: AuthUser, @Body() body: unknown) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    const b = CreateBody.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message ?? "invalid_correction");
    const result = await this.db.tx((c) => this.corrections.createInTx(c, u, u.shopId!, b.data));
    emitShopChange(u.shopId, ["sale_correction"]);
    return result;
  }

  @Post(":id/approve") @Roles("owner")
  async approve(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    if (!uuid.safeParse(id).success) throw new NotFoundException("correction_not_found");
    const b = NoteBody.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    const result = await this.corrections.approve(u, id, b.data.note);
    emitShopChange(u.shopId, ["sale", "product", "sale_correction", "business_alert"]);
    return result;
  }

  @Post(":id/reject") @Roles("owner")
  async reject(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    if (!uuid.safeParse(id).success) throw new NotFoundException("correction_not_found");
    const b = DecisionBody.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message ?? "reason_required");
    const result = await this.corrections.reject(u, id, b.data.note);
    emitShopChange(u.shopId, ["sale_correction", "business_alert"]);
    return result;
  }

  /** Ask for more evidence without changing the proposal or the sale. */
  @Post(":id/request-info") @Roles("owner")
  async requestInfo(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    if (!uuid.safeParse(id).success) throw new NotFoundException("correction_not_found");
    const b = DecisionBody.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message ?? "reason_required");
    const result = await this.corrections.requestInfo(u, id, b.data.note);
    emitShopChange(u.shopId, ["sale_correction"]);
    return result;
  }

  @Post(":id/settle-refund") @Roles("owner")
  async settleRefund(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    if (!uuid.safeParse(id).success) throw new NotFoundException("correction_not_found");
    const b = SettleBody.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message ?? "invalid_settlement");
    const result = await this.corrections.settleRefund(u, id, b.data.amount, b.data.note);
    emitShopChange(u.shopId, ["sale_correction"]);
    return result;
  }
}
