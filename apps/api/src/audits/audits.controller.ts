import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post } from "@nestjs/common";
import { replayLedger } from "@sms/shared";
import { z } from "zod";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { audit } from "./audit";

const Decision = z.object({ approve: z.boolean(), note: z.string().min(3).max(500) });
const InvPatch = z.object({ notes: z.string().max(4000).optional(), correctiveAction: z.string().max(2000).optional(), status: z.enum(["open", "investigating", "resolved", "closed"]).optional(), assignedTo: z.string().uuid().nullable().optional() });
/** Adjustment reason → ledger movement type. Loss categories (theft/disposal/…) all become `adjustment`,
 *  which the valuation reports as stock-loss value; supplier returns reverse a purchase (not a loss). */
const MOVE = {
  damage: "damage", expiry: "expiry", correction: "adjustment", supplier_return: "supplier_return", sale_return: "sale_return",
  theft: "adjustment", disposal: "adjustment", supplier_shortage: "adjustment", other: "adjustment",
} as const;

@Controller("audit")
export class AuditsController {
  constructor(private db: Db) {}

  @Get("log") @Roles("owner")
  log(@Me() u: AuthUser) { return this.db.query("SELECT a.*, us.full_name AS actor FROM audit_log a LEFT JOIN users us ON us.id=a.actor_id WHERE a.shop_id=$1 ORDER BY a.id DESC LIMIT 300", [u.shopId]); }

  @Get("adjustments/pending") @Roles("owner")
  pending(@Me() u: AuthUser) { return this.db.query("SELECT a.*, p.name AS product_name FROM adjustments a JOIN products p ON p.id=a.product_id WHERE a.shop_id=$1 AND a.status='pending' ORDER BY a.id", [u.shopId]); }

  @Post("adjustments/:id/decide") @Roles("owner")
  async decide(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    const d = Decision.parse(body);
    return this.db.tx(async (c) => {
      const { rows: [a] } = await c.query("SELECT * FROM adjustments WHERE id=$1 AND shop_id=$2 FOR UPDATE", [id, u.shopId]);
      if (!a) throw new NotFoundException();
      if (a.status !== "pending") throw new BadRequestException("already_decided");
      if (d.approve) {
        await c.query("SELECT 1 FROM products WHERE id=$1 FOR UPDATE", [a.product_id]);
        const { rows: [h] } = await c.query("SELECT COALESCE(SUM(qty),0)::bigint q FROM stock_movements WHERE product_id=$1", [a.product_id]);
        if (Number(h.q) + Number(a.qty) < 0) throw new BadRequestException("would_make_stock_negative");
        // Freeze the moving-average cost at approval time on the movement (documentation for the
        // loss record; valuation still replays chronologically, so reports cannot disagree with it).
        const { rows: mvs } = await c.query(
          "SELECT type, qty, unit_cost, occurred_at FROM stock_movements WHERE product_id=$1 ORDER BY occurred_at, id", [a.product_id]);
        const r = replayLedger(mvs.map((m: any) => ({ type: m.type, qty: Number(m.qty), unitCost: m.unit_cost ?? undefined, occurredAt: new Date(m.occurred_at).toISOString() })));
        const unitCost = r.onHand > 0 ? Math.round((r.value * 1000) / r.onHand) : null;
        await c.query("INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,reason,occurred_at) VALUES ($1,$2,$3,$4,$5,'adjustment',$6,$7,$8,now())", [u.shopId, a.product_id, MOVE[a.reason as keyof typeof MOVE], a.qty, unitCost, a.id, a.requested_by, `${a.reason}: ${a.note}`]);
        await c.query("UPDATE products SET updated_at=now() WHERE id=$1", [a.product_id]);
      }
      await c.query("UPDATE adjustments SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1", [id, d.approve ? "approved" : "rejected", u.id, d.note]);
      await c.query("UPDATE operations SET status=$2, message=$3, resolved_by=$4, resolved_at=now(), resolution=$3 WHERE op_id=$1", [a.op_id, d.approve ? "applied" : "rejected", d.note, u.id]);
      await audit(c, { shopId: u.shopId, actorId: u.id, action: d.approve ? "adjustment.approved" : "adjustment.rejected", entity: "adjustment", entityId: id, oldValue: { status: "pending" }, newValue: { status: d.approve ? "approved" : "rejected", qty: a.qty, reason: a.reason }, reason: d.note, approvalRef: id });
      return { ok: true };
    });
  }

  @Get("conflicts") @Roles("owner")
  conflicts(@Me() u: AuthUser) { return this.db.query("SELECT op_id,type,payload,message,device_id,received_at FROM operations WHERE shop_id=$1 AND status IN ('conflict','rejected') AND resolved_at IS NULL ORDER BY received_at DESC LIMIT 200", [u.shopId]); }

  /** Conflicts are never auto-resolved. The owner records a decision; any re-entry is a NEW operation. */
  @Post("conflicts/:opId/resolve") @Roles("owner")
  async resolve(@Me() u: AuthUser, @Param("opId") opId: string, @Body() body: unknown) {
    const { note } = z.object({ note: z.string().min(3).max(500) }).parse(body);
    return this.db.tx(async (c) => {
      const r = await c.query("UPDATE operations SET resolved_by=$3, resolved_at=now(), resolution=$4 WHERE op_id=$1 AND shop_id=$2 AND status IN ('conflict','rejected') AND resolved_at IS NULL RETURNING type", [opId, u.shopId, u.id, note]);
      if (!r.rowCount) throw new NotFoundException();
      await audit(c, { shopId: u.shopId, actorId: u.id, action: "conflict.resolved", entity: "operation", entityId: opId, reason: note });
      return { ok: true };
    });
  }

  @Get("investigations") @Roles("owner", "manager")
  inv(@Me() u: AuthUser) { return this.db.query("SELECT i.*, p.name AS product_name FROM investigations i JOIN products p ON p.id=i.product_id WHERE i.shop_id=$1 ORDER BY i.created_at DESC LIMIT 200", [u.shopId]); }

  @Patch("investigations/:id") @Roles("owner", "manager")
  async patchInv(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    const b = InvPatch.parse(body);
    if (u.role === "manager" && (b.assignedTo !== undefined || b.status === "closed")) throw new BadRequestException("owner_only_fields");
    return this.db.tx(async (c) => {
      const { rows: [old] } = await c.query("SELECT * FROM investigations WHERE id=$1 AND shop_id=$2 FOR UPDATE", [id, u.shopId]);
      if (!old) throw new NotFoundException();
      await c.query("UPDATE investigations SET notes=COALESCE($2,notes), corrective_action=COALESCE($3,corrective_action), status=COALESCE($4,status), assigned_to=CASE WHEN $5::boolean THEN $6::uuid ELSE assigned_to END, updated_at=now() WHERE id=$1",
        [id, b.notes ?? null, b.correctiveAction ?? null, b.status ?? null, b.assignedTo !== undefined, b.assignedTo ?? null]);
      await audit(c, { shopId: u.shopId, actorId: u.id, action: "investigation.update", entity: "investigation", entityId: id, oldValue: { status: old.status, notes: old.notes }, newValue: b });
      return { ok: true };
    });
  }
}
