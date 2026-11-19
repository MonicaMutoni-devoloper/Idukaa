import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Put, Query } from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AlertActions, ResolutionCategories } from "@sms/shared";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { audit } from "../audits/audit";
import { AlertsService, DEFAULT_THRESHOLDS, type AlertThresholds } from "./alerts.service";

const ActionBody = z.object({
  action: z.enum(AlertActions),
  note: z.string().trim().min(3).max(2000),
  assignedTo: z.string().uuid().nullable().optional(),
  category: z.enum(ResolutionCategories).nullable().optional(),
  correctiveAction: z.string().trim().max(1000).nullable().optional(),
  escalateTo: z.string().uuid().nullable().optional(),
  approvedBy: z.string().uuid().nullable().optional(),
  /** The version the reviewer saw; a newer server copy wins and the action is refused with 409. */
  expectedUpdatedAt: z.string().datetime().nullable().optional(),
});

/** A device running the previous build still posts a bare status; it is translated, never trusted. */
const LegacyStatus = z.object({
  status: z.enum(["investigating", "resolved", "legitimate"]),
  note: z.string().trim().min(3).max(1000),
});

const ThresholdsBody = z.record(z.string(), z.number().min(0).max(1_000_000)).refine((v) => {
  for (const k of Object.keys(v)) if (!(k in DEFAULT_THRESHOLDS)) return false;
  return true;
}, { message: "unknown_threshold" });

interface Finding {
  key: string; category: string; severity: "info" | "warning" | "critical"; level: "critical" | "high" | "medium" | "low";
  title: string; explanation: string; entityType?: string; entityId?: string; evidence: unknown;
}

/**
 * Explainable, rule-based monitoring. Every alert carries the numbers that caused it and is upserted
 * by a stable key, so reopening the screen does not create duplicates. These are review prompts,
 * never accusations: the wording says "review" and the resolution workflow decides what happened.
 */
@Controller("alerts") @Roles("owner", "manager")
export class AlertsController {
  constructor(private db: Db, private alerts: AlertsService) {}

  @Get()
  async list(@Me() u: AuthUser, @Query() q: any) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    const pick = (k: string) => (typeof q[k] === "string" && q[k] ? q[k] : null);
    return this.alerts.list(u.shopId, {
      status: pick("status"), severity: pick("severity"), category: pick("category"),
      employee: pick("employee"), from: pick("from"), to: pick("to"), search: pick("search"),
    });
  }

  /** People who can be assigned an investigation in this shop. */
  @Get("staff")
  async staff(@Me() u: AuthUser) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    return this.alerts.staff(u.shopId);
  }

  @Get("settings")
  async settings(@Me() u: AuthUser) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    return { thresholds: await this.alerts.thresholds(u.shopId), defaults: DEFAULT_THRESHOLDS };
  }

  @Put("settings") @Roles("owner")
  async saveSettings(@Me() u: AuthUser, @Body() body: unknown) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    const b = ThresholdsBody.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message ?? "invalid_thresholds");
    return { thresholds: await this.alerts.saveThresholds(u, b.data as Partial<AlertThresholds>) };
  }

  @Get(":id")
  async get(@Me() u: AuthUser, @Param("id") id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("alert_not_found");
    if (!u.shopId) throw new BadRequestException("shop_required");
    return this.alerts.get(u.shopId, id);
  }

  /** Start/assign/investigate/note/escalate/resolve/reopen — every path writes an event and an audit row. */
  @Post(":id/actions")
  async act(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("alert_not_found");
    const b = ActionBody.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message ?? "invalid_action");
    return this.alerts.act(u, id, b.data);
  }

  /** @deprecated kept for devices on the previous build; translated to the same audited workflow. */
  @Post(":id/status")
  async legacyStatus(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("alert_not_found");
    const b = LegacyStatus.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    if (b.data.status === "investigating") return this.alerts.act(u, id, { action: "investigate", note: b.data.note });
    // Both old closing statuses are recorded as a closure with the closest existing category; the
    // note the user typed is kept verbatim, so the decision remains explainable.
    return this.alerts.act(u, id, { action: "resolve", category: "other", note: b.data.note });
  }

  /**
   * Evaluate the configured rules now. There is no background scheduler by design: the owner sees
   * when detection ran, and an unchanged finding updates its last_seen_at instead of duplicating.
   */
  @Post("detect")
  async detect(@Me() u: AuthUser) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    const th = await this.alerts.thresholds(u.shopId);
    const findings = await this.detectAll(u.shopId, th);
    let created = 0, updated = 0, reopened = 0;
    // Detection is idempotent and recurrence-aware. A resolved legitimate promotion stays resolved
    // while the same transaction and evidence are unchanged; a genuinely changed finding reopens it
    // once, with the previous decision preserved in the event and notes.
    await this.db.tx(async (c) => {
      for (const f of findings) {
        const signature = createHash("sha256").update(JSON.stringify(f.evidence)).digest("hex");
        const { rows: [before] } = await c.query(
          "SELECT * FROM business_alerts WHERE shop_id=$1 AND dedupe_key=$2 FOR UPDATE",
          [u.shopId, f.key],
        );
        if (!before) {
          const { rows: [row] } = await c.query(
            `INSERT INTO business_alerts(shop_id,dedupe_key,category,severity,severity_level,title,explanation,
                                         entity_type,entity_id,evidence,evidence_signature,occurrences)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1) RETURNING id`,
            [u.shopId, f.key, f.category, f.severity, f.level, f.title, f.explanation,
              f.entityType ?? null, f.entityId ?? null, JSON.stringify(f.evidence), signature],
          );
          created += 1;
          await c.query(
            "INSERT INTO alert_events(alert_id,shop_id,actor_id,action,note,new_status) VALUES ($1,$2,$3,'detected',$4,'open')",
            [row.id, u.shopId, u.id, f.explanation],
          );
          continue;
        }

        updated += 1;
        const closed = ["resolved", "legitimate"].includes(before.status);
        const sameEvidence = before.evidence_signature === signature;
        if (closed && sameEvidence) {
          // Same transaction, same numbers, same evidence: count the detection but do not reopen.
          await c.query(
            "UPDATE business_alerts SET last_seen_at=now(), occurrences=occurrences+1 WHERE id=$1",
            [before.id],
          );
          continue;
        }

        if (closed && !sameEvidence) {
          reopened += 1;
          await c.query(
            `UPDATE business_alerts SET status='open', severity=$2, severity_level=$3, title=$4,
                    explanation=$5, evidence=$6, evidence_signature=$7, occurrences=occurrences+1,
                    last_seen_at=now(), updated_at=now(), resolution_category=NULL, resolution_note=NULL,
                    corrective_action=NULL, approved_by=NULL, resolved_at=NULL, resolved_by=NULL,
                    escalated_at=NULL, escalated_to=NULL
              WHERE id=$1`,
            [before.id, f.severity, f.level, f.title, f.explanation, JSON.stringify(f.evidence), signature],
          );
          await c.query(
            `INSERT INTO alert_events(alert_id,shop_id,actor_id,action,note,previous_status,new_status,details)
             VALUES ($1,$2,$3,'reopened',$4,$5,'open',$6)`,
            [before.id, u.shopId, u.id, f.explanation, before.status,
              JSON.stringify({ automatic: true, reason: "evidence_changed",
                previousSignature: before.evidence_signature ?? null, signature })],
          );
          continue;
        }

        await c.query(
          `UPDATE business_alerts SET severity=$2, severity_level=$3, title=$4, explanation=$5,
                  evidence=$6, evidence_signature=$7, occurrences=occurrences+1,
                  last_seen_at=now(), updated_at=now()
            WHERE id=$1`,
          [before.id, f.severity, f.level, f.title, f.explanation, JSON.stringify(f.evidence), signature],
        );
      }
    });
    await audit(this.db.pool, { shopId: u.shopId, actorId: u.id, action: "anomaly.detect", entity: "shop", entityId: u.shopId,
      newValue: { findings: findings.length, created, updated, reopened } });
    return { ok: true, evaluatedAt: new Date().toISOString(), findings: findings.length, created, updated, reopened,
      sufficientHistory: await this.hasHistory(u.shopId) };
  }

  private async hasHistory(shopId: string): Promise<boolean> {
    const [r] = await this.db.query("SELECT count(*)::int n FROM sales WHERE shop_id=$1 AND status='posted' AND sold_at >= now()-interval '21 days'", [shopId]);
    return Number(r.n) >= 5;
  }

  private async detectAll(shopId: string, th: AlertThresholds): Promise<Finding[]> {
    const out: Finding[] = [];
    const day = new Date().toISOString().slice(0, 10);
    const lookback = Math.max(1, Math.round(th.lookbackDays));

    // A. Daily sale quantity vs the previous 28-day average, per product.
    const stock = await this.db.query(
      `WITH daily AS (
         SELECT m.product_id, date_trunc('day', m.occurred_at AT TIME ZONE 'Africa/Kigali')::date AS d, SUM(-m.qty)::numeric AS q
           FROM stock_movements m
          WHERE m.shop_id=$1 AND m.type='sale' AND m.occurred_at >= now()-interval '36 days'
          GROUP BY 1,2
       ), recent AS (
         SELECT d.*, row_number() OVER (PARTITION BY product_id ORDER BY d DESC) rn FROM daily d
       )
       SELECT r.product_id, p.name, p.unit, r.d::text AS "day", r.q,
              COALESCE(AVG(b.q),0) AS baseline
         FROM recent r JOIN products p ON p.id=r.product_id
         LEFT JOIN daily b ON b.product_id=r.product_id AND b.d < r.d AND b.d >= r.d - 28
        WHERE r.rn=1 AND r.d >= current_date - 1
        GROUP BY r.product_id,p.name,p.unit,r.d,r.q
       HAVING r.q >= 10000 AND COALESCE(AVG(b.q),0) > 0 AND r.q >= COALESCE(AVG(b.q),0) * $2`,
      [shopId, th.stockMultiple]);
    for (const r of stock) {
      const ratio = Number(r.baseline) > 0 ? Number(r.q) / Number(r.baseline) : 0;
      out.push({ key: `stock:${r.product_id}:${r.day}`, category: "stock_reduction",
        severity: ratio >= 5 ? "critical" : "warning", level: ratio >= 5 ? "critical" : "high",
        title: `Unusual stock reduction: ${r.name}`,
        explanation: `${Number(r.q) / 1000} ${r.unit} left stock on ${r.day}; the 28-day daily average was ${(Number(r.baseline) / 1000).toFixed(1)}. Review the recorded sales and stock movements before drawing a conclusion.`,
        entityType: "product", entityId: r.product_id,
        evidence: { product: r.name, day: r.day, unitsReduced: Number(r.q) / 1000, baselineUnits: Number(r.baseline) / 1000 } });
    }

    // B. Large discounts relative to the shop's own recent average.
    const discounts = await this.db.query(
      `WITH s AS (
         SELECT id, sold_at, gross_amount, discount, user_id, customer_id,
                CASE WHEN gross_amount > 0 THEN discount::numeric / gross_amount ELSE 0 END AS pct
           FROM sales WHERE shop_id=$1 AND status='posted' AND sold_at >= now()-interval '7 days'
       ), base AS (
         SELECT AVG(CASE WHEN gross_amount > 0 THEN discount::numeric/gross_amount ELSE 0 END) avg_pct
           FROM sales WHERE shop_id=$1 AND status='posted' AND sold_at >= now()-interval '37 days' AND sold_at < now()-interval '7 days'
       )
       SELECT s.*, u.full_name AS cashier, base.avg_pct FROM s JOIN users u ON u.id=s.user_id CROSS JOIN base
        WHERE s.pct >= $2 AND base.avg_pct IS NOT NULL AND s.pct >= base.avg_pct * $3`,
      [shopId, th.discountPercentMin / 100, th.discountBaselineMultiple]);
    for (const r of discounts) {
      const pct = Number(r.pct) * 100;
      out.push({ key: `discount:${r.id}`, category: "discount",
        severity: pct >= th.discountCriticalPercent ? "critical" : "warning",
        level: pct >= th.discountCriticalPercent ? "critical" : pct >= 30 ? "high" : "medium",
        title: `Unusual discount on a sale`,
        explanation: `${pct.toFixed(1)}% discount (${Number(r.discount)} RWF) on a ${Number(r.gross_amount)} RWF sale. The recent average was ${(Number(r.avg_pct ?? 0) * 100).toFixed(1)}%. Confirm whether this was an approved promotion.`,
        entityType: "sale", entityId: r.id,
        evidence: { saleId: r.id, cashier: r.cashier, gross: Number(r.gross_amount), discount: Number(r.discount), percent: Number(pct.toFixed(1)), baselinePercent: Number(((r.avg_pct ?? 0) * 100).toFixed(1)) } });
    }

    // B2. The same cashier repeatedly discounting heavily: a pattern, not one sale.
    const repeat = await this.db.query(
      `SELECT s.user_id, u.full_name AS cashier, count(*)::int n, round(SUM(s.discount)::numeric) AS total_discount
         FROM sales s JOIN users u ON u.id=s.user_id
        WHERE s.shop_id=$1 AND s.status='posted' AND s.sold_at >= now()-interval '1 day' * $2
          AND s.gross_amount > 0 AND s.discount::numeric / s.gross_amount >= $3
        GROUP BY s.user_id, u.full_name HAVING count(*) >= $4`,
      [shopId, lookback, th.repeatedDiscountPercent / 100, th.repeatedDiscountCount]);
    for (const r of repeat) {
      out.push({ key: `discountrepeat:${r.user_id}:${day.slice(0, 7)}`, category: "discount",
        severity: Number(r.n) >= th.repeatedDiscountCount * 2 ? "critical" : "warning",
        level: Number(r.n) >= th.repeatedDiscountCount * 2 ? "high" : "medium",
        title: `Repeated large discounts by ${r.cashier}`,
        explanation: `${r.n} sales in the last ${lookback} days carried a discount of at least ${th.repeatedDiscountPercent}%, totalling ${Number(r.total_discount)} RWF. Check whether each one was approved; this is a pattern to review, not proof of misconduct.`,
        entityType: "user", entityId: r.user_id,
        evidence: { cashier: r.cashier, sales: Number(r.n), totalDiscount: Number(r.total_discount) } });
    }

    // C. Gross margin below the shop's floor for a product with meaningful recent sales.
    const margins = await this.db.query(
      `WITH revenue AS (
         SELECT sl.product_id, SUM(sl.line_amount)::numeric gross, SUM(sl.qty)::numeric units
           FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id
          WHERE s.shop_id=$1 AND s.status='posted' AND s.sold_at >= now()-interval '30 days'
          GROUP BY 1 HAVING SUM(sl.qty) >= 10000
       ), cost AS (
         SELECT product_id, CASE WHEN SUM(qty) > 0 THEN SUM(qty*COALESCE(unit_cost,0))/SUM(qty) ELSE NULL END avg_cost
           FROM stock_movements WHERE shop_id=$1 AND type='receipt' AND qty > 0 AND unit_cost IS NOT NULL GROUP BY 1
       )
       SELECT r.*, p.name, p.unit, c.avg_cost,
              CASE WHEN r.gross > 0 THEN (r.gross - (r.units*c.avg_cost/1000.0)) / r.gross ELSE NULL END margin
         FROM revenue r JOIN products p ON p.id=r.product_id JOIN cost c ON c.product_id=r.product_id
        WHERE c.avg_cost IS NOT NULL AND r.gross > 0
          AND (r.gross - (r.units*c.avg_cost/1000.0)) / r.gross < $2`,
      [shopId, th.marginMinPercent / 100]);
    for (const r of margins) {
      out.push({ key: `margin:${r.product_id}:${day.slice(0, 7)}`, category: "margin",
        severity: Number(r.margin) < 0 ? "critical" : "warning", level: Number(r.margin) < 0 ? "critical" : "medium",
        title: `Profit margin deterioration: ${r.name}`,
        explanation: `The 30-day gross margin is ${(Number(r.margin) * 100).toFixed(1)}%. Recent purchase cost averages ${Number(r.avg_cost)} RWF per ${r.unit}. Review prices, discounts and supply costs.`,
        entityType: "product", entityId: r.product_id,
        evidence: { product: r.name, gross: Number(r.gross), units: Number(r.units) / 1000, averageCost: Number(r.avg_cost), marginPercent: Number((r.margin * 100).toFixed(1)) } });
    }

    // D. Repeated manual stock corrections for one product in seven days.
    const adjustments = await this.db.query(
      `SELECT a.product_id, p.name, count(*)::int n, COALESCE(SUM(ABS(a.qty)),0)::bigint qty,
              string_agg(DISTINCT a.reason, ', ') reasons
         FROM adjustments a JOIN products p ON p.id=a.product_id
        WHERE a.shop_id=$1 AND a.status='approved' AND COALESCE(a.decided_at, now()) >= now()-interval '7 days'
        GROUP BY 1,2 HAVING count(*) >= $2`, [shopId, th.adjustmentCountMin]);
    for (const r of adjustments) {
      out.push({ key: `adjust:${r.product_id}:${day}`, category: "adjustments", severity: Number(r.n) >= 5 ? "critical" : "warning",
        level: Number(r.n) >= 5 ? "high" : "medium",
        title: `Repeated stock adjustments: ${r.name}`,
        explanation: `${r.n} approved manual corrections changed ${Number(r.qty) / 1000} units in seven days (${r.reasons}). Check whether the recorded reasons support the corrections.`,
        entityType: "product", entityId: r.product_id,
        evidence: { product: r.name, corrections: Number(r.n), unitsAdjusted: Number(r.qty) / 1000, reasons: r.reasons } });
    }

    // E. Daily expenses compared with the previous 30-day daily average.
    const expenses = await this.db.query(
      `WITH daily AS (
         SELECT date_trunc('day', incurred_at AT TIME ZONE 'Africa/Kigali')::date d, SUM(amount)::numeric amount
           FROM expenses WHERE shop_id=$1 AND incurred_at >= now()-interval '37 days'
          GROUP BY 1
       ), base AS (SELECT AVG(amount) avg_amount FROM daily WHERE d < current_date - 6)
       SELECT d.d::text AS "day", d.amount, base.avg_amount FROM daily d CROSS JOIN base
        WHERE d.d >= current_date - 6 AND d.amount >= $2 AND base.avg_amount > 0 AND d.amount >= base.avg_amount * $3
        ORDER BY d.d DESC`, [shopId, th.expenseMinAmount, th.expenseMultiple]);
    for (const r of expenses) {
      const ratio = Number(r.avg_amount) > 0 ? Number(r.amount) / Number(r.avg_amount) : 0;
      out.push({ key: `expense:${r.day}`, category: "expense", severity: ratio >= 6 ? "critical" : "warning",
        level: ratio >= 6 ? "high" : "medium",
        title: "Unusually high daily expenses",
        explanation: `Expenses on ${r.day} were ${Number(r.amount)} RWF against a 30-day daily average of ${Math.round(Number(r.avg_amount ?? 0))} RWF. Review the individual entries and receipts.`,
        evidence: { day: r.day, amount: Number(r.amount), baseline: Math.round(Number(r.avg_amount ?? 0)) } });
    }

    // F. Customer balances near limits or already overdue.
    const credit = await this.db.query(
      `SELECT c.id, c.name, c.credit_limit,
              COALESCE((SELECT SUM(gross_amount-discount-amount_paid) FROM sales WHERE shop_id=c.shop_id AND customer_id=c.id AND status='posted'),0)
              - COALESCE((SELECT SUM(amount) FROM credit_payments WHERE shop_id=c.shop_id AND customer_id=c.id),0)
              + COALESCE((SELECT SUM(amount) FROM credit_adjustments WHERE shop_id=c.shop_id AND customer_id=c.id),0) AS balance,
              GREATEST(0, LEAST(
                COALESCE((SELECT SUM(gross_amount-discount-amount_paid) FROM sales WHERE shop_id=c.shop_id AND customer_id=c.id AND status='posted'),0)
                - COALESCE((SELECT SUM(amount) FROM credit_payments WHERE shop_id=c.shop_id AND customer_id=c.id),0)
                + COALESCE((SELECT SUM(amount) FROM credit_adjustments WHERE shop_id=c.shop_id AND customer_id=c.id),0),
                (SELECT COALESCE(SUM(gross_amount-discount-amount_paid),0) FROM sales
                  WHERE shop_id=c.shop_id AND customer_id=c.id AND status='posted' AND due_at IS NOT NULL AND due_at < now()))) AS overdue
         FROM customers c WHERE c.shop_id=$1`, [shopId]);
    for (const r of credit) {
      const balance = Number(r.balance); if (balance <= 0) continue;
      const ratio = Number(r.credit_limit) > 0 ? balance / Number(r.credit_limit) : 0;
      if (ratio * 100 < th.creditUsedPercent && Number(r.overdue) <= 0) continue;
      out.push({ key: `credit:${r.id}:${day}`, category: "credit_risk",
        severity: ratio >= 1 || Number(r.overdue) >= balance * 0.5 ? "critical" : "warning",
        level: ratio >= 1 ? "critical" : ratio >= 0.9 ? "high" : "medium",
        title: `Customer credit risk: ${r.name}`,
        explanation: `Outstanding balance is ${balance} RWF${Number(r.credit_limit) > 0 ? ` against a ${Number(r.credit_limit)} RWF limit (${(ratio * 100).toFixed(0)}%)` : ""}${Number(r.overdue) > 0 ? `; ${Number(r.overdue)} RWF is overdue` : ""}. Review the account and arrange a repayment plan.`,
        entityType: "customer", entityId: r.id,
        evidence: { customer: r.name, balance, limit: Number(r.credit_limit), overdue: Number(r.overdue), usedPercent: Math.round(ratio * 100) } });
    }

    // G. Sales that were reversed (voided): each one needs a reason on record.
    const reversed = await this.db.query(
      `SELECT count(*)::int n, COALESCE(SUM(gross_amount),0)::bigint amount
         FROM sales WHERE shop_id=$1 AND status='reversed' AND sold_at >= now()-interval '1 day' * $2`,
      [shopId, lookback]);
    if (Number(reversed[0]?.n ?? 0) >= th.voidedSalesMin) {
      out.push({ key: `reversed:${day.slice(0, 7)}`, category: "reversed_sale",
        severity: "warning", level: "high",
        title: "Repeated reversed sales",
        explanation: `${Number(reversed[0].n)} sales worth ${Number(reversed[0].amount)} RWF were reversed in the last ${lookback} days. Confirm each reversal has a recorded reason and was authorised.`,
        evidence: { reversedSales: Number(reversed[0].n), amount: Number(reversed[0].amount), windowDays: lookback } });
    }

    return out;
  }
}
