import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { audit } from "../audits/audit";
import { FinanceService } from "../reports/finance.service";
import { parseRange } from "../reports/finance.service";

const Switch = z.object({ shopId: z.string().uuid() });

/**
 * The owner's authorized shop list and the only route that changes the active shop. The JWT stays
 * valid: AuthGuard resolves the active shop from the user row on every request, and membership is
 * rechecked there, so a switched-away shop cannot be reached by keeping an old id in the client.
 */
@Controller("shop") @Roles("owner", "manager")
export class ShopMembershipsController {
  constructor(private db: Db, private finance: FinanceService) {}

  @Get("memberships")
  async list(@Me() u: AuthUser) {
    const rows = await this.db.query(
      `SELECT s.id, s.name, s.currency, s.location, s.category, s.status AS shop_status,
              s.subscription_required, m.role AS membership_role, m.created_at AS joined_at,
              (SELECT count(*)::int FROM shop_memberships sm WHERE sm.shop_id=s.id AND sm.status='active') AS employee_count,
              (SELECT count(*)::int FROM business_alerts a WHERE a.shop_id=s.id AND a.status IN ('open','investigating')) AS open_alerts,
              CASE WHEN ss.status='active' AND ss.ends_at IS NOT NULL AND ss.ends_at <= now()
                   THEN 'expired' ELSE ss.status END AS subscription_status,
              ss.ends_at, p.name AS plan_name, p.price_rwf
         FROM shop_memberships m JOIN shops s ON s.id=m.shop_id
         LEFT JOIN LATERAL (
           SELECT status, ends_at, plan_id FROM shop_subscriptions WHERE shop_id=s.id ORDER BY created_at DESC LIMIT 1
         ) ss ON true
         LEFT JOIN subscription_plans p ON p.id=ss.plan_id
        WHERE m.user_id=$1 AND m.status='active'
        ORDER BY (s.id = $2) DESC, s.name`, [u.id, u.shopId]);
    return rows.map((r: any) => ({
      id: r.id, name: r.name, currency: r.currency, location: r.location, category: r.category,
      active: r.id === u.shopId, role: r.membership_role, shopStatus: r.shop_status,
      employeeCount: Number(r.employee_count), openAlerts: Number(r.open_alerts),
      subscriptionRequired: !!r.subscription_required,
      subscriptionStatus: r.subscription_status ?? (r.subscription_required ? "missing" : "active"),
      planName: r.plan_name, priceRwf: r.price_rwf == null ? null : Number(r.price_rwf),
      endsAt: r.ends_at,
    }));
  }

  @Post("switch") @Roles("owner", "manager")
  async switch(@Me() u: AuthUser, @Body() body: unknown) {
    const b = Switch.safeParse(body);
    if (!b.success) throw new BadRequestException("invalid_shop");
    return this.db.tx(async (c) => {
      const { rows: [m] } = await c.query(
        `SELECT m.role, s.name FROM shop_memberships m JOIN shops s ON s.id=m.shop_id
          WHERE m.user_id=$1 AND m.shop_id=$2 AND m.status='active' FOR UPDATE OF m`, [u.id, b.data.shopId]);
      if (!m) throw new ForbiddenException("shop_access_denied");
      await c.query("UPDATE users SET shop_id=$2, role=$3 WHERE id=$1", [u.id, b.data.shopId, m.role]);
      await audit(c, { shopId: b.data.shopId, actorId: u.id, action: "shop.switch", entity: "shop", entityId: b.data.shopId,
        oldValue: { shopId: u.shopId, role: u.role }, newValue: { shopId: b.data.shopId, role: m.role } });
      return { ok: true, shopId: b.data.shopId, shopName: m.name, role: m.role };
    });
  }

  /** Owner-only combined view. Each shop is calculated independently, then summed once. */
  @Get("command-centre") @Roles("owner")
  async commandCentre(@Me() u: AuthUser, @Query() q: unknown) {
    const { from, to } = parseRange(q);
    const shops = await this.list(u);
    const perShop = [] as any[];
    for (const shop of shops) {
      if (shop.subscriptionStatus !== "active") {
        perShop.push({ ...shop, sales: null, expenses: null, profit: null, outstandingCredit: null, stockAlerts: null, unavailableReason: "subscription_inactive" });
        continue;
      }
      const p = await this.finance.period(shop.id, from, to);
      const [credit] = await this.db.query(
        `SELECT COALESCE(SUM(s.gross_amount-s.discount-s.amount_paid),0)::bigint owing
           FROM sales s WHERE s.shop_id=$1 AND s.status='posted' AND s.customer_id IS NOT NULL
             AND s.gross_amount-s.discount-s.amount_paid > 0`, [shop.id]);
      const [paid] = await this.db.query(
        "SELECT COALESCE(SUM(amount),0)::bigint paid FROM credit_payments WHERE shop_id=$1", [shop.id]);
      const [adj] = await this.db.query(
        "SELECT COALESCE(SUM(amount),0)::bigint amount FROM credit_adjustments WHERE shop_id=$1", [shop.id]);
      const [stock] = await this.db.query(
        `SELECT count(*)::int n FROM products p
          WHERE p.shop_id=$1 AND p.active=true AND p.low_stock_threshold > 0
            AND COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.product_id=p.id),0) <= p.low_stock_threshold`, [shop.id]);
      perShop.push({ ...shop,
        sales: p.grossSales, expenses: p.operatingExpenses, profit: p.operatingProfit,
        outstandingCredit: Math.max(0, Number(credit.owing) - Number(paid.paid) + Number(adj.amount)),
        stockAlerts: Number(stock.n),
      });
    }
    const available = perShop.filter((s) => s.sales !== null);
    const total = available.reduce((a, s) => ({
      sales: a.sales + s.sales, expenses: a.expenses + s.expenses, profit: a.profit + s.profit,
      outstandingCredit: a.outstandingCredit + s.outstandingCredit, stockAlerts: a.stockAlerts + s.stockAlerts,
      openAlerts: a.openAlerts + s.openAlerts,
    }), { sales: 0, expenses: 0, profit: 0, outstandingCredit: 0, stockAlerts: 0, openAlerts: 0 });
    return { from, to, shops: perShop, totals: total, shopsRequiringPayment: perShop.filter((s) => s.subscriptionStatus !== "active").length };
  }
}
