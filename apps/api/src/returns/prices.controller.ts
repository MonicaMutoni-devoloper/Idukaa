import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { emitShopChange } from "../realtime/hub";
import { PricingService } from "./pricing.service";

const uuid = z.string().uuid();
const ChangeRequest = z.object({
  priceId: z.string().uuid(),
  newPrice: z.number().int().min(0),
  reason: z.string().trim().min(3).max(500),
  effectiveAt: z.string().datetime().optional(),
  expectedPrice: z.number().int().min(0).optional(),
  approvalRef: z.string().trim().max(120).optional(),
});

/**
 * Selling-price endpoints. Read endpoints are open to managers (they sell at these prices); changing
 * one is an owner/authorised-manager operation recorded in the price ledger.
 */
@Controller("products") @Roles("owner", "manager")
export class PricesController {
  constructor(private db: Db, private pricing: PricingService) {}

  /** Preview a proposed price against the current average cost — no change is made. */
  @Get(":id/price-preview")
  async preview(@Me() u: AuthUser, @Param("id") id: string, @Query("newPrice") newPrice: string) {
    if (!uuid.safeParse(id).success) throw new NotFoundException("product_not_found");
    const price = Number(newPrice);
    if (newPrice === undefined || newPrice === "" || !Number.isInteger(price) || price < 0) {
      throw new BadRequestException("invalid_price");
    }
    return this.pricing.preview(u.shopId!, id, price);
  }

  /** Price history for one product (old, new, effective time, actor, reason, approval). */
  @Get(":id/prices")
  async history(@Me() u: AuthUser, @Param("id") id: string, @Query("limit") limit?: string) {
    if (!uuid.safeParse(id).success) throw new NotFoundException("product_not_found");
    return { productId: id, changes: await this.pricing.history(u.shopId!, id, Number(limit) || 100) };
  }

  /** Shop-wide price history, for the owner's "price changes" screen. */
  @Get("prices/history")
  async allHistory(@Me() u: AuthUser, @Query("limit") limit?: string) {
    return { changes: await this.pricing.historyAll(u.shopId!, Number(limit) || 100) };
  }

  /** Apply (or schedule) a selling-price change. Never touches stock, cost, or past sales. */
  @Post(":id/price")
  async change(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!uuid.safeParse(id).success) throw new NotFoundException("product_not_found");
    const parsed = ChangeRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const p = parsed.data;
    const out = await this.db.tx(async (c) => {
      // A scheduled change that is already due takes effect before this new one is compared with
      // the current price, so "current" always means what a sale would charge right now.
      await this.pricing.applyDuePrices(c, u.shopId!);
      return this.pricing.applyInTx(c, u, u.shopId!, { ...p, productId: id });
    });
    emitShopChange(u.shopId, ["product"]);
    return out;
  }
}
