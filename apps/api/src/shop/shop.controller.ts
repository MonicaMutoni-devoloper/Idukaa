import { BadRequestException, Body, Controller, Get, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { audit } from "../audits/audit";
import { OnboardingService } from "../onboarding/onboarding.service";
import { emitShopChange } from "../realtime/hub";

export interface ShopPolicy {
  managerFinancialAccess: boolean;
  belowCostPolicy: "acknowledge" | "block";
  maxDiscountPercent: number;
  creditLimitPolicy: "block" | "owner_approval" | "reason_override";
}

const PolicyPatch = z.object({
  managerFinancialAccess: z.boolean().optional(),
  belowCostPolicy: z.enum(["acknowledge", "block"]).optional(),
  maxDiscountPercent: z.number().int().min(0).max(100).optional(),
  creditLimitPolicy: z.enum(["block", "owner_approval", "reason_override"]).optional(),
}).refine(v => Object.keys(v).length > 0, { message: "no_changes" });

const shape = (r: any): ShopPolicy => ({
  managerFinancialAccess: r.manager_financial_access,
  belowCostPolicy: r.below_cost_policy,
  maxDiscountPercent: r.max_discount_percent,
  creditLimitPolicy: r.credit_limit_policy,
});

export interface ShopProfile { id: string; name: string; currency: string; createdAt: string }
const ProfilePatch = z.object({ name: z.string().trim().min(2).max(120) });
const profileShape = (r: any): ShopProfile => ({ id: r.id, name: r.name, currency: r.currency, createdAt: r.created_at });
const PROFILE_COLS = `id, name, currency, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;

/**
 * Business rules the owner controls. They are enforced by the API (pricing, discounts, profit
 * visibility), so hiding a control in the UI can never bypass them.
 */
@Controller("shop") @Roles("owner", "manager")
export class ShopController {
  constructor(private db: Db, private onboarding: OnboardingService) {}

  /**
   * Create the caller's OWN shop — once, after the application was approved and the account
   * activated. The shop id and the owner always come from the signed-in row: a body field like
   * `ownerId` or `shopId` is ignored, so nobody can create a shop for somebody else.
   */
  @Post() @Roles("owner")
  async create(@Me() u: AuthUser, @Body() body: unknown) {
    const b = z.object({
      name: z.string().trim().min(2).max(120),
      location: z.string().trim().max(120).optional(),
      category: z.string().trim().max(60).optional(),
    }).safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    return this.onboarding.createShop(u, b.data);
  }

  @Get("settings") async get(@Me() u: AuthUser): Promise<ShopPolicy> {
    const [row] = await this.db.query("SELECT manager_financial_access, below_cost_policy, max_discount_percent, credit_limit_policy FROM shops WHERE id=$1", [u.shopId]);
    return shape(row);
  }

  /** Both roles may read the shop they work in; only the owner may rename it. */
  @Get("profile") async profile(@Me() u: AuthUser): Promise<ShopProfile> {
    const [row] = await this.db.query(`SELECT ${PROFILE_COLS} FROM shops WHERE id=$1`, [u.shopId]);
    if (!row) throw new BadRequestException("unknown_shop");
    return profileShape(row);
  }

  @Patch("profile") @Roles("owner") async updateProfile(@Me() u: AuthUser, @Body() body: unknown): Promise<ShopProfile> {
    const b = ProfilePatch.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    const name = b.data.name;
    const out = await this.db.tx(async (c) => {
      const { rows: [old] } = await c.query("SELECT id, name FROM shops WHERE id=$1 FOR UPDATE", [u.shopId]);
      if (!old) throw new BadRequestException("unknown_shop");
      const { rows: [row] } = await c.query(`UPDATE shops SET name=$2 WHERE id=$1 RETURNING ${PROFILE_COLS}`, [u.shopId, name]);
      if (old.name !== name) {
        await audit(c, { shopId: u.shopId, actorId: u.id, action: "shop.profile.update", entity: "shop", entityId: u.shopId ?? undefined, oldValue: { name: old.name }, newValue: { name } });
      }
      return profileShape(row);
    });
    if (out.name !== undefined) emitShopChange(u.shopId, ["shop"]);
    return out;
  }

  @Patch("settings") @Roles("owner") async patch(@Me() u: AuthUser, @Body() body: unknown): Promise<ShopPolicy> {
    const b = PolicyPatch.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    const v = b.data;
    const out = await this.db.tx(async (c) => {
      const { rows: [old] } = await c.query("SELECT manager_financial_access, below_cost_policy, max_discount_percent, credit_limit_policy FROM shops WHERE id=$1 FOR UPDATE", [u.shopId]);
      const { rows: [row] } = await c.query(
        `UPDATE shops SET manager_financial_access=COALESCE($2,manager_financial_access),
                          below_cost_policy=COALESCE($3,below_cost_policy),
                          max_discount_percent=COALESCE($4,max_discount_percent),
                          credit_limit_policy=COALESCE($5,credit_limit_policy)
         WHERE id=$1 RETURNING manager_financial_access, below_cost_policy, max_discount_percent, credit_limit_policy`,
        [u.shopId, v.managerFinancialAccess ?? null, v.belowCostPolicy ?? null, v.maxDiscountPercent ?? null, v.creditLimitPolicy ?? null]);
      await audit(c, { shopId: u.shopId, actorId: u.id, action: "shop.policy.update", entity: "shop", entityId: u.shopId ?? undefined, oldValue: shape(old), newValue: shape(row) });
      return shape(row);
    });
    emitShopChange(u.shopId, ["shop"]);
    return out;
  }
}
