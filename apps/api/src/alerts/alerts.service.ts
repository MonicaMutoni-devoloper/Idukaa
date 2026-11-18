import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import {
  canTransition, categoriesForRole, displayStatus, mayPerform, severityLevel,
  type AlertAction, type ResolutionCategory,
} from "@sms/shared";
import { Db } from "../db/db.service";
import { audit } from "../audits/audit";
import type { AuthUser } from "../common/auth";

/** What counts as unusual, unless the owner says otherwise for this shop. */
export interface AlertThresholds {
  /** A single sale discounted by at least this share of its gross value is worth a look. */
  discountPercentMin: number;
  /** ...and at least this multiple of the shop's own 30-day average discount. */
  discountBaselineMultiple: number;
  discountCriticalPercent: number;
  /** Repeated discounting by one cashier within the lookback window. */
  repeatedDiscountCount: number;
  repeatedDiscountPercent: number;
  /** Gross margin below this percentage over 30 days. */
  marginMinPercent: number;
  /** Approved manual stock corrections for one product in seven days. */
  adjustmentCountMin: number;
  /** A day's expenses against the 30-day daily average. */
  expenseMultiple: number;
  expenseMinAmount: number;
  /** One product's daily stock reduction against its 28-day daily average. */
  stockMultiple: number;
  /** Share of a customer's credit limit in use before the account is flagged. */
  creditUsedPercent: number;
  /** Voided sales within the lookback window. */
  voidedSalesMin: number;
  lookbackDays: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  discountPercentMin: 20, discountBaselineMultiple: 2, discountCriticalPercent: 35,
  repeatedDiscountCount: 3, repeatedDiscountPercent: 10,
  marginMinPercent: 5, adjustmentCountMin: 3,
  expenseMultiple: 3, expenseMinAmount: 10_000,
  stockMultiple: 3, creditUsedPercent: 80,
  voidedSalesMin: 2, lookbackDays: 7,
};

export interface AlertFilters {
  status?: string | null; severity?: string | null; category?: string | null;
  employee?: string | null; from?: string | null; to?: string | null; search?: string | null;
}

const CLOSED = "'resolved','legitimate'";

/**
 * The alert a reviewer was looking at is no longer the alert on the server. Raised inside the
 * transaction so nothing is written; the sync layer turns it into a `conflict` verdict for the
 * outbox, and the HTTP route into 409. Never silently overwrite a decision made on another device.
 */
export class AlertConflictError extends Error {
  constructor(public code: string) { super(code); this.name = "AlertConflictError"; }
}

const iso = (value: unknown): string | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

@Injectable()
export class AlertsService {
  constructor(private db: Db) {}

  /** The shop's thresholds, with every missing key filled from the documented defaults. */
  async thresholds(shopId: string): Promise<AlertThresholds> {
    const [row] = await this.db.query("SELECT thresholds FROM alert_settings WHERE shop_id=$1", [shopId]);
    const stored = (row?.thresholds ?? {}) as Partial<AlertThresholds>;
    const out = { ...DEFAULT_THRESHOLDS };
    for (const k of Object.keys(DEFAULT_THRESHOLDS) as (keyof AlertThresholds)[]) {
      const v = stored[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
    }
    return out;
  }

  async saveThresholds(user: AuthUser, patch: Partial<AlertThresholds>) {
    const current = await this.thresholds(user.shopId!);
    const next = { ...current, ...patch };
    await this.db.query(
      `INSERT INTO alert_settings(shop_id,thresholds,updated_by,updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (shop_id) DO UPDATE SET thresholds=$2, updated_by=$3, updated_at=now()`,
      [user.shopId, JSON.stringify(next), user.id]);
    await audit(this.db.pool, { shopId: user.shopId!, actorId: user.id, action: "alerts.settings.update",
      entity: "shop", entityId: user.shopId!, oldValue: current, newValue: next });
    return next;
  }

  /** Alerts matching the filters, plus stable counts for the summary tiles. */
  async list(shopId: string, f: AlertFilters) {
    const rows = await this.db.query(
      `SELECT a.*, asg.full_name AS assigned_name, res.full_name AS resolved_name, esc.full_name AS escalated_name
         FROM business_alerts a
         LEFT JOIN users asg ON asg.id=a.assigned_to
         LEFT JOIN users res ON res.id=a.resolved_by
         LEFT JOIN users esc ON esc.id=a.escalated_to
        WHERE a.shop_id=$1
          AND ($2::text IS NULL OR (CASE WHEN a.status='legitimate' THEN 'resolved' ELSE a.status END)=$2)
          AND ($3::text IS NULL OR COALESCE(a.severity_level,
                CASE a.severity WHEN 'critical' THEN 'critical' WHEN 'warning' THEN 'high' ELSE 'medium' END)=$3)
          AND ($4::text IS NULL OR a.category=$4)
          AND ($5::timestamptz IS NULL OR a.last_seen_at >= $5::timestamptz)
          AND ($6::timestamptz IS NULL OR a.last_seen_at < ($6::timestamptz + interval '1 day'))
          AND ($7::text IS NULL OR $7='' OR a.title ILIKE '%'||$7||'%' OR a.explanation ILIKE '%'||$7||'%'
               OR COALESCE(a.entity_id,'') ILIKE '%'||$7||'%' OR COALESCE(a.dedupe_key,'') ILIKE '%'||$7||'%')
          AND ($8::uuid IS NULL OR a.assigned_to=$8 OR a.resolved_by=$8
               OR a.evidence->>'cashier' = (SELECT full_name FROM users WHERE id=$8 AND shop_id=$1))
        ORDER BY CASE COALESCE(a.severity_level,
                   CASE a.severity WHEN 'critical' THEN 'critical' WHEN 'warning' THEN 'high' ELSE 'medium' END)
                   WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                 CASE WHEN a.status IN (${CLOSED}) THEN 1 ELSE 0 END,
                 a.last_seen_at DESC, a.id
        LIMIT 200`,
      [shopId, f.status || null, f.severity || null, f.category || null, f.from || null, f.to || null,
        f.search || null, f.employee || null]);

    const [counts] = await this.db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status='open')::int AS open,
              count(*) FILTER (WHERE status='investigating')::int AS investigating,
              count(*) FILTER (WHERE status='action_required')::int AS action_required,
              count(*) FILTER (WHERE status='escalated')::int AS escalated,
              count(*) FILTER (WHERE status IN (${CLOSED}))::int AS resolved,
              count(*) FILTER (WHERE status NOT IN (${CLOSED}) AND COALESCE(severity_level,
                CASE severity WHEN 'critical' THEN 'critical' WHEN 'warning' THEN 'high' ELSE 'medium' END)='critical')::int AS critical_open
         FROM business_alerts WHERE shop_id=$1`, [shopId]);

    return {
      alerts: rows.map((r) => this.shape(r)),
      summary: {
        total: Number(counts.total), open: Number(counts.open), investigating: Number(counts.investigating),
        actionRequired: Number(counts.action_required), escalated: Number(counts.escalated),
        resolved: Number(counts.resolved), criticalOpen: Number(counts.critical_open),
      },
    };
  }

  async get(shopId: string, id: string) {
    const [row] = await this.db.query(
      `SELECT a.*, asg.full_name AS assigned_name, res.full_name AS resolved_name,
              esc.full_name AS escalated_name, apr.full_name AS approved_name,
              au.email AS assigned_email, ru.email AS resolved_email
         FROM business_alerts a
         LEFT JOIN users asg ON asg.id=a.assigned_to
         LEFT JOIN users res ON res.id=a.resolved_by
         LEFT JOIN users esc ON esc.id=a.escalated_to
         LEFT JOIN users apr ON apr.id=a.approved_by
         LEFT JOIN users au ON au.id=a.assigned_to
         LEFT JOIN users ru ON ru.id=a.resolved_by
        WHERE a.id=$1 AND a.shop_id=$2`, [id, shopId]);
    if (!row) throw new NotFoundException("alert_not_found");
    const events = await this.db.query(
      `SELECT e.id, e.action, e.note, e.at, e.previous_status, e.new_status, e.details, us.full_name AS actor
         FROM alert_events e LEFT JOIN users us ON us.id=e.actor_id
        WHERE e.alert_id=$1 ORDER BY e.id`, [id]);
    return {
      ...this.shape(row),
      resolution: {
        category: row.resolution_category ?? null, note: row.resolution_note ?? null,
        correctiveAction: row.corrective_action ?? null, approvedByName: row.approved_name ?? null,
        escalatedToName: row.escalated_name ?? null, escalatedAt: row.escalated_at ?? null,
      },
      supporting: await this.supporting(row),
      events,
      actions: this.availableActions(row),
    };
  }

  /** Who may be assigned an investigation in this shop. */
  async staff(shopId: string) {
    return this.db.query(
      `SELECT id, full_name AS name, role FROM users
        WHERE shop_id=$1 AND active AND role IN ('owner','manager') ORDER BY role DESC, full_name`, [shopId]);
  }

  /**
   * One careless click cannot rewrite history: every action is validated against the workflow and
   * the caller's role, recorded as an event with what changed, and audited. The sale, stock movement
   * or expense the alert points at is never touched here — correcting a transaction is a separate,
   * auditable decision.
   */
  async act(user: AuthUser, id: string, input: {
    action: AlertAction; note: string; assignedTo?: string | null; category?: ResolutionCategory | null;
    correctiveAction?: string | null; escalateTo?: string | null; approvedBy?: string | null;
    expectedUpdatedAt?: string | null;
  }) {
    try {
      return await this.db.tx((c) => this.actInTx(c, user, id, input));
    } catch (e) {
      // A stale version is the only failure that means "read it again", not "your request was bad".
      if (e instanceof AlertConflictError) throw new ConflictException(e.code);
      throw e;
    }
  }

  /**
   * The workflow, inside a caller-owned transaction. The sync queue uses this so an offline action
   * commits (or rolls back) together with its operation row and audit entry.
   *
   * `expectedUpdatedAt` is the version the reviewer saw. If the alert has changed since — another
   * device resolved it, detection saw it again, a manager reassigned it — the action is refused as
   * a conflict instead of overwriting that newer decision.
   */
  async actInTx(c: PoolClient, user: AuthUser, id: string, input: {
    action: AlertAction; note: string; assignedTo?: string | null; category?: ResolutionCategory | null;
    correctiveAction?: string | null; escalateTo?: string | null; approvedBy?: string | null;
    expectedUpdatedAt?: string | null;
  }) {
    const shopId = user.shopId!;
    {
      const { rows: [a] } = await c.query("SELECT * FROM business_alerts WHERE id=$1 AND shop_id=$2 FOR UPDATE", [id, shopId]);
      if (!a) throw new NotFoundException("alert_not_found");
      if (input.expectedUpdatedAt && iso(a.updated_at) !== iso(input.expectedUpdatedAt)) {
        throw new AlertConflictError("alert_changed_on_server");
      }
      if (!mayPerform(user.role, input.action)) throw new ForbiddenException(`alert_action_forbidden:${input.action}`);

      const now = new Date().toISOString();
      const details: Record<string, unknown> = {};
      let next = a.status as string;
      let eventAction: string = input.action;
      let sql = ""; let params: unknown[] = [];

      switch (input.action) {
        case "investigate": {
          this.assertTransition(a.status, "investigating");
          next = "investigating";
          sql = "UPDATE business_alerts SET status='investigating', updated_at=now() WHERE id=$1";
          params = [id];
          break;
        }
        case "assign": {
          if (!input.assignedTo) throw new BadRequestException("assignee_required");
          const { rows: [who] } = await c.query("SELECT id, full_name FROM users WHERE id=$1 AND shop_id=$2 AND active", [input.assignedTo, shopId]);
          if (!who) throw new BadRequestException("unknown_assignee");
          // Naming an investigator starts the investigation if it had not started yet.
          if (displayStatus(a.status) === "open") { this.assertTransition(a.status, "investigating"); next = "investigating"; }
          sql = `UPDATE business_alerts SET assigned_to=$2, assigned_at=now(),
                   status=CASE WHEN status='open' THEN 'investigating' ELSE status END, updated_at=now() WHERE id=$1`;
          params = [id, input.assignedTo];
          details.assignee = who.full_name;
          break;
        }
        case "note": {
          next = a.status;
          eventAction = "note";
          sql = "UPDATE business_alerts SET notes=trim(notes || E'\\n' || $2), updated_at=now() WHERE id=$1";
          params = [id, input.note];
          break;
        }
        case "escalate": {
          this.assertTransition(a.status, "escalated");
          if (input.escalateTo) {
            const { rows: [who] } = await c.query("SELECT id, full_name FROM users WHERE id=$1 AND shop_id=$2 AND active AND role='owner'", [input.escalateTo, shopId]);
            if (!who) throw new BadRequestException("unknown_escalation_target");
            details.escalatedTo = who.full_name;
          }
          next = "escalated";
          sql = `UPDATE business_alerts SET status='escalated', escalated_to=$2, escalated_at=now(), updated_at=now() WHERE id=$1`;
          params = [id, input.escalateTo ?? null];
          break;
        }
        case "resolve": {
          if (!input.category) throw new BadRequestException("resolution_category_required");
          if (!categoriesForRole(user.role).includes(input.category)) {
            throw new ForbiddenException(`resolution_category_forbidden:${input.category}`);
          }
          details.category = input.category;
          if (input.correctiveAction) details.correctiveAction = input.correctiveAction;
          if (input.category === "suspicious_activity") {
            // Suspicion is not a closure: it hands the alert to the owner for a decision.
            this.assertTransition(a.status, "escalated");
            next = "escalated";
            eventAction = "escalated";
            sql = `UPDATE business_alerts SET status='escalated', resolution_category=$2, resolution_note=$3,
                     corrective_action=$4, escalated_to=$5, escalated_at=now(), updated_at=now() WHERE id=$1`;
            params = [id, input.category, input.note, input.correctiveAction ?? null, input.escalateTo ?? null];
          } else {
            this.assertTransition(a.status, "resolved");
            if (input.category === "approved_activity" && input.approvedBy) {
              const { rows: [who] } = await c.query("SELECT id, full_name FROM users WHERE id=$1 AND shop_id=$2 AND active", [input.approvedBy, shopId]);
              if (!who) throw new BadRequestException("unknown_approver");
              details.approvedBy = who.full_name;
            }
            next = "resolved";
            sql = `UPDATE business_alerts SET status='resolved', resolution_category=$2, resolution_note=$3,
                     corrective_action=$4, approved_by=$5, resolved_at=now(), resolved_by=$6,
                     assigned_to=COALESCE(assigned_to,$6), updated_at=now() WHERE id=$1`;
            params = [id, input.category, input.note, input.correctiveAction ?? null, input.approvedBy ?? null, user.id];
          }
          break;
        }
        case "reopen": {
          if (displayStatus(a.status) !== "resolved") throw new BadRequestException("alert_not_resolved");
          this.assertTransition(a.status, "open");
          // The previous decision is preserved in this event; the row is ready for a new review.
          details.previousResolution = {
            category: a.resolution_category, note: a.resolution_note,
            correctiveAction: a.corrective_action, resolvedAt: a.resolved_at, resolvedBy: a.resolved_by,
            escalatedAt: a.escalated_at,
          };
          next = "open";
          sql = `UPDATE business_alerts SET status='open', resolution_category=NULL, resolution_note=NULL,
                   corrective_action=NULL, approved_by=NULL, resolved_at=NULL, resolved_by=NULL,
                   escalated_at=NULL, escalated_to=NULL, updated_at=now() WHERE id=$1`;
          params = [id];
          break;
        }
      }

      const { rows: [row] } = await c.query(`${sql} RETURNING *`, params);
      await c.query(
        `INSERT INTO alert_events(alert_id,shop_id,actor_id,action,note,previous_status,new_status,details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, shopId, user.id, eventAction, input.note, a.status, next, JSON.stringify(details)]);
      await audit(c, {
        shopId, actorId: user.id, action: `anomaly.${eventAction}`, entity: "business_alert", entityId: id,
        oldValue: { status: a.status, category: a.resolution_category ?? null },
        newValue: { status: next, ...details }, reason: input.note,
      });
      return this.shape(row);
    }
  }

  private assertTransition(from: string, to: string) {
    if (!canTransition(from, to)) throw new BadRequestException(`invalid_status_transition:${displayStatus(from)}->${to}`);
  }

  /** Records that explain THIS kind of alert — never a generic dump of everything we know. */
  private async supporting(a: any): Promise<{ kind: string; fields: { label: string; value: string | number | null }[]; related: { label: string; id: string; at?: string | null }[] }> {
    const ev = (a.evidence ?? {}) as Record<string, any>;
    const fields: { label: string; value: string | number | null }[] = [];
    const related: { label: string; id: string; at?: string | null }[] = [];

    if (a.category === "discount" && ev.saleId) {
      const [s] = await this.db.query(
        `SELECT s.id, s.sold_at, s.gross_amount, s.discount, s.amount_paid, s.status,
                GREATEST(0, s.gross_amount - s.discount) AS net, u.full_name AS cashier,
                (SELECT round(AVG(CASE WHEN gross_amount>0 THEN discount::numeric/gross_amount ELSE 0 END)*1000)/10
                   FROM sales WHERE shop_id=$2 AND status='posted' AND sold_at >= now()-interval '30 days' AND sold_at < s.sold_at) AS avg_pct
           FROM sales s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.shop_id=$2`, [ev.saleId, a.shop_id]);
      if (s) {
        fields.push(
          { label: "Gross sale", value: Number(s.gross_amount) },
          { label: "Discount", value: Number(s.discount) },
          { label: "Discount %", value: Number(s.gross_amount) > 0 ? Number(((Number(s.discount) / Number(s.gross_amount)) * 100).toFixed(1)) : 0 },
          { label: "Net sale", value: Number(s.net) },
          { label: "Cashier", value: s.cashier },
          { label: "Average discount (30 days)", value: s.avg_pct === null ? null : Number(s.avg_pct) },
          { label: "Sale status", value: s.status },
        );
        related.push({ label: "Sale", id: s.id, at: s.sold_at });
        const [approval] = await this.db.query(
          `SELECT id, action, new_value FROM audit_log
            WHERE shop_id=$1 AND entity_id=$2 AND action IN ('sale.credit.override','sale.discount','sale.credit.approval_requested')
            ORDER BY id DESC LIMIT 1`, [a.shop_id, s.id]);
        if (approval) related.push({ label: `Approval record (${approval.action})`, id: String(approval.id) });
      }
    }

    if (["stock_reduction", "adjustments", "margin"].includes(a.category) && a.entity_id) {
      const [p] = await this.db.query(
        `SELECT p.name, p.unit, COALESCE((SELECT SUM(qty) FROM stock_movements m WHERE m.product_id=p.id),0)::bigint AS on_hand
           FROM products p WHERE p.id=$1 AND p.shop_id=$2`, [a.entity_id, a.shop_id]);
      if (p) {
        fields.push({ label: "Product", value: p.name }, { label: "Stock on hand", value: `${Number(p.on_hand) / 1000} ${p.unit}` });
        const moves = await this.db.query(
          `SELECT m.id, m.type, m.qty, m.reason, m.occurred_at, u.full_name AS by
             FROM stock_movements m LEFT JOIN users u ON u.id=m.user_id
            WHERE m.product_id=$1 AND m.shop_id=$2 ORDER BY m.occurred_at DESC LIMIT 10`, [a.entity_id, a.shop_id]);
        for (const m of moves) related.push({ label: `${m.type} ${Number(m.qty) / 1000} (${m.by ?? "system"}${m.reason ? `: ${m.reason}` : ""})`, id: String(m.id), at: m.occurred_at });
      }
    }

    if (a.category === "expense" && ev.day) {
      const rows = await this.db.query(
        `SELECT e.id, e.amount, e.category, e.paid, e.note, e.incurred_at, u.full_name AS by
           FROM expenses e LEFT JOIN users u ON u.id=e.user_id
          WHERE e.shop_id=$1 AND (e.incurred_at AT TIME ZONE 'Africa/Kigali')::date = $2::date
          ORDER BY e.amount DESC LIMIT 20`, [a.shop_id, ev.day]);
      for (const e of rows) {
        related.push({ label: `${e.category} · ${Number(e.amount)} RWF${e.note ? ` · ${e.note}` : ""}`, id: e.id, at: e.incurred_at });
      }
      fields.push({ label: "Entries that day", value: rows.length });
    }

    if (a.category === "credit_risk" && a.entity_id) {
      const [cu] = await this.db.query(
        `SELECT c.name, c.credit_limit,
                COALESCE((SELECT SUM(gross_amount-discount-amount_paid) FROM sales WHERE shop_id=c.shop_id AND customer_id=c.id AND status='posted'),0)
                - COALESCE((SELECT SUM(amount) FROM credit_payments WHERE shop_id=c.shop_id AND customer_id=c.id),0)
                + COALESCE((SELECT SUM(amount) FROM credit_adjustments WHERE shop_id=c.shop_id AND customer_id=c.id),0) AS balance
           FROM customers c WHERE c.id=$1 AND c.shop_id=$2`, [a.entity_id, a.shop_id]);
      if (cu) {
        fields.push({ label: "Customer", value: cu.name }, { label: "Credit limit", value: Number(cu.credit_limit) }, { label: "Balance", value: Number(cu.balance) });
        related.push({ label: "Customer account", id: a.entity_id });
      }
    }

    if (a.category === "reversed_sale" && a.entity_id) {
      const [s] = await this.db.query(
        `SELECT s.id, s.sold_at, s.gross_amount, s.status, u.full_name AS cashier FROM sales s JOIN users u ON u.id=s.user_id
          WHERE s.id=$1 AND s.shop_id=$2`, [a.entity_id, a.shop_id]);
      if (s) {
        fields.push({ label: "Sale", value: Number(s.gross_amount) }, { label: "Cashier", value: s.cashier }, { label: "Status", value: s.status });
        related.push({ label: "Sale", id: s.id, at: s.sold_at });
      }
    }

    // Whatever the detector recorded is always shown; the fields above simply add the live records.
    for (const [k, v] of Object.entries(ev)) {
      if (fields.some((f) => f.label.toLowerCase().replace(/[^a-z]/g, "") === k.toLowerCase().replace(/[^a-z]/g, ""))) continue;
      if (v === null || typeof v === "object") continue;
      fields.push({ label: k.replace(/([A-Z])/g, " $1").replace(/^./, (m) => m.toUpperCase()), value: v as any });
    }

    const kind = a.category === "discount" ? "sale"
      : ["stock_reduction", "adjustments", "margin"].includes(a.category) ? "stock"
      : a.category === "expense" ? "expense"
      : a.category === "credit_risk" ? "credit"
      : a.category === "reversed_sale" ? "sale" : "other";
    return { kind, fields, related };
  }

  private availableActions(row: any) {
    const status = displayStatus(row.status);
    return {
      investigate: status === "open" || status === "action_required" || status === "escalated",
      assign: status !== "resolved",
      note: true,
      escalate: status !== "resolved" && status !== "escalated",
      resolve: status !== "resolved",
      reopen: status === "resolved",
    };
  }

  shape(r: any) {
    return {
      id: r.id, dedupeKey: r.dedupe_key, category: r.category, severity: r.severity,
      severityLevel: severityLevel(r.severity, r.severity_level),
      title: r.title, explanation: r.explanation, entityType: r.entity_type, entityId: r.entity_id,
      evidence: r.evidence, status: r.status, statusGroup: displayStatus(r.status),
      notes: r.notes, assignedTo: r.assigned_to ?? null, assignedToName: r.assigned_name ?? null,
      assignedAt: r.assigned_at ?? null, resolutionCategory: r.resolution_category ?? null,
      resolutionNote: r.resolution_note ?? null, correctiveAction: r.corrective_action ?? null,
      escalatedTo: r.escalated_to ?? null, escalatedToName: r.escalated_name ?? null, escalatedAt: r.escalated_at ?? null,
      approvedByName: r.approved_name ?? null,
      firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, resolvedAt: r.resolved_at,
      resolvedByName: r.resolved_name ?? null,
      /** Version used by the app to detect that another device changed this alert first. */
      updatedAt: iso(r.updated_at),
    };
  }
}
