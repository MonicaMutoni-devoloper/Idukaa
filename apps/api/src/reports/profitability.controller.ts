import { Controller, ForbiddenException, Get, Query, Req, ServiceUnavailableException } from "@nestjs/common";
import type { Request } from "express";
import { TARGET_GROSS_MARGIN_BPS, buildRecommendations } from "@sms/shared";
import { FinanceService, parseRange } from "./finance.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { reportLog } from "../common/report-log";
import { requestIdOf } from "../common/auth-log";
import { SCHEMA_ERROR_CODES } from "../db/schema-hint";

/**
 * Product profitability and pricing advice (spec §6–§7). One route: every number comes from the
 * same FinanceService the dashboard and summary use, so cards, charts, drill-downs and advice can
 * never disagree. Financial data is owner-only (or a manager the owner granted financial access).
 * Recommendations are advisory only — no price or quantity is ever changed automatically.
 */
@Controller("reports") @Roles("owner", "manager")
export class ProfitabilityController {
  constructor(private finance: FinanceService) {}

  @Get("profitability")
  async profitability(@Me() u: AuthUser, @Query() q: unknown, @Req() req?: Request) {
    if (!(await this.finance.canSeeFinancials(u))) throw new ForbiddenException("financials_not_permitted");
    const { from, to } = parseRange(q);
    const shopId = u.shopId!;

    try {
      const moves = await this.finance.movements(shopId);
      const items = await this.finance.productProfitability(shopId, from, to, moves);
      const totals = await this.finance.period(shopId, from, to, moves);

      const span = Date.parse(to) - Date.parse(from);
      const prevFrom = new Date(Date.parse(from) - span).toISOString();
      const expenseChanges = await this.finance.expenseChanges(shopId, from, to, prevFrom, from);

      const recommendations = buildRecommendations(
        items,
        { netSales: totals.netSales, grossMarginBps: totals.grossMarginBps },
        expenseChanges,
      );

      return {
        range: { from, to },
        previousRange: { from: prevFrom, to: from },
        valuationMethod: "moving_weighted_average",
        targetMarginBps: TARGET_GROSS_MARGIN_BPS,
        currency: "RWF",
        totals: {
          netSales: totals.netSales, cogs: totals.cogs, grossProfit: totals.grossProfit,
          grossMarginBps: totals.grossMarginBps, operatingExpenses: totals.operatingExpenses,
          operatingProfit: totals.operatingProfit, stockLosses: totals.stockLosses,
          operatingResultAfterStockLosses: totals.operatingResultAfterStockLosses,
          inventoryValue: totals.closingInventoryValue, costBasisIncomplete: totals.costBasisIncomplete,
        },
        expenseChanges,
        items,
        recommendations: recommendations.map(r => ({ ...r, period: { from, to } })),
      };
    } catch (e) {
      // Before this, this endpoint could only ever answer an opaque 500. The whole report depends on
      // this one calculation, so its failure is NOT swallowed and no figure is invented — but the
      // cause, the PostgreSQL code and the correlation id are now recorded and returned.
      reportLog(req, "reports.profitability_failed", "profitability", e);
      const code = (e as { code?: string })?.code;
      if (code && SCHEMA_ERROR_CODES.has(code)) {
        throw new ServiceUnavailableException({ error: "schema_out_of_date", requestId: requestIdOf(req) });
      }
      throw e;
    }
  }
}
