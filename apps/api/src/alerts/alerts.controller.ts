import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { audit } from "../audits/audit";

const StatusChange = z.object({
  status: z.enum(["investigating", "resolved", "legitimate"]),
  note: z.string().trim().min(3).max(1000),
});

interface Finding {
  key: string; category: string; severity: "info" | "warning" | "critical";
  title: string; explanation: string; entityType?: string; entityId?: string; evidence: unknown;
}

/**
 * Explainable, rule-based monitoring. Every alert carries the numbers that caused it and is
 * upserted by a stable key, so reopening the screen does not create duplicates. These are review
 * prompts, never accusations: the wording and suggested action say "investigate".
 */
@Controller("alerts") @Roles("owner")
export class AlertsController {
  constructor(private db: Db) {}

  @Get()
  async list(@Me() u: AuthUser, @Query() q: any) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    const status = typeof q.status === "string" && q.status ? q.status : null;
    const severity = typeof q.severity === "string" && q.severity ? q.severity : null;
    const rows = await this.db.query(
      `SELECT a.*, us.full_name AS resolved_by_name
         FROM business_alerts a LEFT JOIN users us ON us.id=a.resolved_by
        WHERE a.shop_id=$1 AND ($2::text IS NULL OR a.status=$2) AND ($3::text IS NULL OR a.severity=$3)
        ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                 a.last_seen_at DESC LIMIT 200`, [u.shopId, status, severity]);
    return rows.map(this.shape);
  }

  @Get(":id")
  async get(@Me() u: AuthUser, @Param("id") id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("alert_not_found");
    const [row] = await this.db.query("SELECT * FROM business_alerts WHERE id=$1 AND shop_id=$2", [id, u.shopId]);
    if (!row) throw new NotFoundException("alert_not_found");
    const events = await this.db.query(
      `SELECT e.id, e.action, e.note, e.at, us.full_name AS actor
         FROM alert_events e LEFT JOIN users us ON us.id=e.actor_id
        WHERE e.alert_id=$1 ORDER BY e.id`, [id]);
    return { ...this.shape(row), events };
  }

  /** Evaluate the configured rules now. There is no background scheduler by design: the owner sees
   *  when detection ran, and an unchanged finding updates its last_seen_at instead of duplicating. */
  @Post("detect")
  async detect(@Me() u: AuthUser) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    const findings = await this.detectAll(u.shopId);
    let created = 0, updated = 0;
    for (const f of findings) {
      const [before] = await this.db.query(
        "SELECT id, status FROM business_alerts WHERE shop_id=$1 AND dedupe_key=$2", [u.shopId, f.key]);
      const [row] = await this.db.query(
        `INSERT INTO business_alerts(shop_id,dedupe_key,category,severity,title,explanation,entity_type,entity_id,evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (shop_id,dedupe_key) DO UPDATE SET
           severity=EXCLUDED.severity, title=EXCLUDED.title, explanation=EXCLUDED.explanation,
           evidence=EXCLUDED.evidence, last_seen_at=now(), updated_at=now(),
           status=CASE WHEN business_alerts.status IN ('resolved','legitimate') THEN 'open' ELSE business_alerts.status END,
           resolved_at=CASE WHEN business_alerts.status IN ('resolved','legitimate') THEN NULL ELSE business_alerts.resolved_at END,
           resolved_by=CASE WHEN business_alerts.status IN ('resolved','legitimate') THEN NULL ELSE business_alerts.resolved_by END
         RETURNING id, (xmax=0) AS inserted`,
        [u.shopId, f.key, f.category, f.severity, f.title, f.explanation, f.entityType ?? null, f.entityId ?? null, JSON.stringify(f.evidence)]);
      if (row?.inserted) {
        created += 1;
        await this.db.query("INSERT INTO alert_events(alert_id,shop_id,actor_id,action,note) VALUES ($1,$2,$3,'detected',$4)",
          [row.id, u.shopId, u.id, f.explanation]);
      } else {
        updated += 1;
        // A recurrence after a closed investigation is a new event, but stays on the same alert so
        // the earlier decision and notes are not lost.
        if (before && ["resolved", "legitimate"].includes(before.status)) {
          await this.db.query("INSERT INTO alert_events(alert_id,shop_id,actor_id,action,note) VALUES ($1,$2,$3,'reopened',$4)",
            [row.id, u.shopId, u.id, f.explanation]);
        }
      }
    }
    await audit(this.db.pool, { shopId: u.shopId, actorId: u.id, action: "anomaly.detect", entity: "shop", entityId: u.shopId,
      newValue: { findings: findings.length, created, updated } });
    return { ok: true, evaluatedAt: new Date().toISOString(), findings: findings.length, created, updated,
      sufficientHistory: await this.hasHistory(u.shopId) };
  }

  @Post(":id/status")
  async change(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("alert_not_found");
    const b = StatusChange.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    return this.db.tx(async (c) => {
      const { rows: [old] } = await c.query("SELECT * FROM business_alerts WHERE id=$1 AND shop_id=$2 FOR UPDATE", [id, u.shopId]);
      if (!old) throw new NotFoundException("alert_not_found");
      const resolved = b.data.status === "resolved" || b.data.status === "legitimate";
      const { rows: [row] } = await c.query(
        `UPDATE business_alerts SET status=$2, notes=trim(notes || E'\n' || $3), assigned_to=$4::uuid,
                resolved_at=CASE WHEN $5::boolean THEN now() ELSE NULL END,
                resolved_by=CASE WHEN $5::boolean THEN $4::uuid ELSE NULL END, updated_at=now()
          WHERE id=$1 RETURNING *`, [id, b.data.status, b.data.note, u.id, resolved]);
      await c.query("INSERT INTO alert_events(alert_id,shop_id,actor_id,action,note) VALUES ($1,$2,$3,$4,$5)",
        [id, u.shopId, u.id, b.data.status, b.data.note]);
      await audit(c, { shopId: u.shopId, actorId: u.id, action: `anomaly.${b.data.status}`, entity: "business_alert", entityId: id,
        oldValue: { status: old.status }, newValue: { status: b.data.status }, reason: b.data.note });
      return this.shape(row);
    });
  }

  private shape(r: any) {
    return { id: r.id, dedupeKey: r.dedupe_key, category: r.category, severity: r.severity, title: r.title,
      explanation: r.explanation, entityType: r.entity_type, entityId: r.entity_id, evidence: r.evidence,
      status: r.status, notes: r.notes, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
      resolvedAt: r.resolved_at, resolvedByName: r.resolved_by_name ?? null };
  }

  private async hasHistory(shopId: string): Promise<boolean> {
    const [r] = await this.db.query("SELECT count(*)::int n FROM sales WHERE shop_id=$1 AND status='posted' AND sold_at >= now()-interval '21 days'", [shopId]);
    return Number(r.n) >= 5;
  }

  private async detectAll(shopId: string): Promise<Finding[]> {
    const out: Finding[] = [];
    const day = new Date().toISOString().slice(0, 10);

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
       HAVING r.q >= 10000 AND COALESCE(AVG(b.q),0) > 0 AND r.q >= COALESCE(AVG(b.q),0) * 3`,
      [shopId]);
    for (const r of stock) {
      out.push({ key: `stock:${r.product_id}:${r.day}`, category: "stock_reduction",
        severity: Number(r.q) >= Number(r.baseline) * 5 ? "critical" : "warning",
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
        WHERE s.pct >= 0.20 AND base.avg_pct IS NOT NULL AND s.pct >= base.avg_pct * 2`,
      [shopId]);
    for (const r of discounts) {
      out.push({ key: `discount:${r.id}`, category: "discount", severity: Number(r.pct) >= 0.35 ? "critical" : "warning",
        title: `Unusual discount on a sale`,
        explanation: `${(Number(r.pct) * 100).toFixed(1)}% discount (${Number(r.discount)} RWF) on a ${Number(r.gross_amount)} RWF sale. The recent average was ${(Number(r.avg_pct ?? 0) * 100).toFixed(1)}%. Confirm whether this was an approved promotion.`,
        entityType: "sale", entityId: r.id,
        evidence: { saleId: r.id, cashier: r.cashier, gross: Number(r.gross_amount), discount: Number(r.discount), percent: Number((r.pct * 100).toFixed(1)), baselinePercent: Number(((r.avg_pct ?? 0) * 100).toFixed(1)) } });
    }

    // C. Gross margin below 5% for a product with meaningful recent sales.
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
          AND (r.gross - (r.units*c.avg_cost/1000.0)) / r.gross < 0.05`,
      [shopId]);
    for (const r of margins) {
      out.push({ key: `margin:${r.product_id}:${day.slice(0, 7)}`, category: "margin", severity: Number(r.margin) < 0 ? "critical" : "warning",
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
        GROUP BY 1,2 HAVING count(*) >= 3`, [shopId]);
    for (const r of adjustments) {
      out.push({ key: `adjust:${r.product_id}:${day}`, category: "adjustments", severity: Number(r.n) >= 5 ? "critical" : "warning",
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
        WHERE d.d >= current_date - 6 AND d.amount >= 10000 AND base.avg_amount > 0 AND d.amount >= base.avg_amount * 3
        ORDER BY d.d DESC`, [shopId]);
    for (const r of expenses) {
      out.push({ key: `expense:${r.day}`, category: "expense", severity: Number(r.amount) >= Number(r.avg_amount ?? 0) * 6 ? "critical" : "warning",
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
      if (ratio < 0.8 && Number(r.overdue) <= 0) continue;
      out.push({ key: `credit:${r.id}:${day}`, category: "credit_risk",
        severity: ratio >= 1 || Number(r.overdue) >= balance * 0.5 ? "critical" : "warning",
        title: `Customer credit risk: ${r.name}`,
        explanation: `Outstanding balance is ${balance} RWF${Number(r.credit_limit) > 0 ? ` against a ${Number(r.credit_limit)} RWF limit (${(ratio * 100).toFixed(0)}%)` : ""}${Number(r.overdue) > 0 ? `; ${Number(r.overdue)} RWF is overdue` : ""}. Review the account and arrange a repayment plan.`,
        entityType: "customer", entityId: r.id,
        evidence: { customer: r.name, balance, limit: Number(r.credit_limit), overdue: Number(r.overdue), usedPercent: Math.round(ratio * 100) } });
    }

    return out;
  }
}
