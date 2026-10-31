import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { Db } from "../db/db.service";
import { audit } from "../audits/audit";
import type { AuthUser } from "../common/auth";
import { hashToken, newOpaqueToken, passwordSchema } from "../auth/security";

/**
 * The complete onboarding state machine. Every transition is validated by the server, inside a
 * transaction, against the CURRENT row (FOR UPDATE) — the frontend never decides a state.
 *
 *   owner application : PENDING_REVIEW -> APPROVED | REJECTED
 *                       PENDING_REVIEW -> ADDITIONAL_INFORMATION_REQUIRED -> PENDING_REVIEW
 *   owner account     : pending_activation -> active (activation token, single use, 7 days)
 *   owner shop        : active owner without a shop -> shop created (one per owner, ever)
 *   staff invitation  : invited -> active (accepted) | revoked ; invited -> expired (time)
 *
 * Nothing here emails or texts anyone: no delivery provider is configured, so the only channels
 * are the applicant's status page and the invitation link the owner shares. Tokens are random,
 * expiring, single use and stored as SHA-256 hashes only.
 */

const ACTIVATION_TTL_MS = 7 * 24 * 3600_000;
const INVITATION_TTL_MS = 7 * 24 * 3600_000;
const invitationUrl = (token: string) => {
  const base = (process.env.STAFF_INVITE_URL ?? "http://localhost:8081/invite").split("?")[0]!;
  return `${base}?token=${encodeURIComponent(token)}`;
};

const norm = (s: string) => s.trim();
const normEmail = (s: string) => s.trim().toLowerCase();

export interface ApplicationInput {
  contactName: string; email: string; phone: string;
  shopName: string; location?: string; category?: string; note?: string;
  /** Chosen on the registration form; present only for the five-field flow. */
  password?: string;
}
export interface ApplicationStatusView {
  id: string; status: string; contactName: string; shopName: string;
  submittedAt: string; reviewedAt: string | null;
  infoMessage: string | null; decisionReason: string | null;
  accountActive: boolean;
  activation: { available: boolean } | null;
}
export interface InvitationPreview {
  status: "invited" | "active" | "expired" | "revoked";
  shopName?: string; email?: string; fullName?: string; expiresAt?: string;
  existingAccount?: boolean;
}

@Injectable()
export class OnboardingService {
  constructor(private db: Db) {}

  /* ================================================================ Stage 1 — owner applies */

  async submitApplication(input: ApplicationInput): Promise<{ id: string; status: string; statusToken: string; submittedAt: string }> {
    const email = normEmail(input.email);
    // An existing account never gets a second identity through the public form.
    const [taken] = await this.db.query("SELECT 1 FROM users WHERE lower(email)=lower($1)", [email]);
    if (taken) throw new ConflictException("application_email_in_use");
    const [open] = await this.db.query(
      "SELECT 1 FROM owner_applications WHERE lower(email)=lower($1) AND status IN ('PENDING_REVIEW','ADDITIONAL_INFORMATION_REQUIRED','APPROVED')",
      [email]);
    if (open) throw new ConflictException("application_duplicate");

    const statusToken = newOpaqueToken();
    // The password policy is the same one activation uses; hashing happens here, never in a client.
    const pwHash = input.password ? await bcrypt.hash(input.password, 12) : null;
    let row: any;
    try {
      [row] = await this.db.query(
        `INSERT INTO owner_applications(contact_name,email,phone,shop_name,location,category,note,status_token_hash,password_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, status, to_char(submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at`,
        [norm(input.contactName), email, norm(input.phone), norm(input.shopName), norm(input.location ?? ""), norm(input.category ?? ""), norm(input.note ?? ""), hashToken(statusToken), pwHash]);
    } catch (e: any) {
      if (e?.code === "23505") throw new ConflictException("application_duplicate"); // lost the race: index decides
      throw e;
    }
    await audit(this.db.pool, {
      shopId: null, actorId: null, action: "application.submit", entity: "owner_application", entityId: row.id,
      newValue: { email, shopName: norm(input.shopName), status: "PENDING_REVIEW" },
    });
    return { id: row.id, status: row.status, statusToken, submittedAt: row.submitted_at };
  }

  /** Status is protected by the status token handed to the applicant at submission — never by an id or an email. */
  async applicationStatus(token: string): Promise<ApplicationStatusView> {
    const [app] = await this.db.query(
      `SELECT id, status, contact_name, shop_name, status_token_hash,
              to_char(submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at,
              to_char(reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reviewed_at,
              info_message, decision_reason, user_id
       FROM owner_applications WHERE status_token_hash=$1`, [hashToken(token)]);
    if (!app) throw new BadRequestException("status_token_invalid");

    let accountActive = false;
    if (app.user_id) {
      const [u] = await this.db.query("SELECT account_status FROM users WHERE id=$1", [app.user_id]);
      accountActive = u?.account_status === "active" && !!u;
    }

    // Activation itself is available on the status page (no e-mail provider is configured, so the
    // status token IS the delivery channel). Whether a link token is still fresh is reported so the
    // screen can say "ask the administrator to re-issue" instead of failing silently.
    let activation: ApplicationStatusView["activation"] = null;
    if (app.status === "APPROVED" && !accountActive) {
      const [t] = await this.db.query(
        `SELECT 1 FROM onboarding_tokens
         WHERE application_id=$1 AND purpose='owner_activation' AND used_at IS NULL AND expires_at > now() LIMIT 1`, [app.id]);
      activation = { available: !!t };
    }
    return {
      id: app.id, status: app.status, contactName: app.contact_name, shopName: app.shop_name,
      submittedAt: app.submitted_at, reviewedAt: app.reviewed_at,
      infoMessage: app.status === "ADDITIONAL_INFORMATION_REQUIRED" ? app.info_message : null,
      decisionReason: app.status === "REJECTED" ? app.decision_reason : null,
      accountActive, activation,
    };
  }

  async respondToInformation(token: string, message: string): Promise<{ status: string }> {
    const txt = norm(message);
    return this.db.tx(async (c) => {
      const { rows: [app] } = await c.query(
        "SELECT id, status FROM owner_applications WHERE status_token_hash=$1 FOR UPDATE", [hashToken(token)]);
      if (!app) throw new BadRequestException("status_token_invalid");
      if (app.status !== "ADDITIONAL_INFORMATION_REQUIRED") throw new ConflictException("invalid_transition");
      await c.query(
        `UPDATE owner_applications SET status='PENDING_REVIEW', info_message=NULL, updated_at=now(),
           history = history || jsonb_build_array(jsonb_build_object('at', now(), 'actor', 'applicant', 'action', 'responded', 'message', $2::text))
         WHERE id=$1`, [app.id, txt]);
      await audit(c, { shopId: null, actorId: null, action: "application.respond", entity: "owner_application", entityId: app.id, newValue: { message: txt } });
      return { status: "PENDING_REVIEW" };
    });
  }

  /* ================================================================ Stage 3 — activation */

  /**
   * Single use: activation always passes through one claim UPDATE (`used_at IS NULL`), so a replay
   * or a parallel submission can only win once. Two credentials reach the same state machine:
   *   * `statusToken` — the applicant's own credential from submission (the primary channel today);
   *   * `token`       — a link token issued at approval (reserved for a future e-mail provider).
   * Exactly one is required.
   */
  async activateOwner(creds: { token?: string; statusToken?: string }, password: string): Promise<{ ok: true; email: string }> {
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    if (!creds.token && !creds.statusToken) throw new BadRequestException("activation_token_invalid");
    const hash = await bcrypt.hash(password, 12);

    return this.db.tx(async (c) => {
      let applicationId: string;
      if (creds.token) {
        const { rows: [claim] } = await c.query(
          `UPDATE onboarding_tokens SET used_at=now()
           WHERE token_hash=$1 AND purpose='owner_activation' AND used_at IS NULL AND expires_at > now()
           RETURNING application_id`, [hashToken(creds.token)]);
        if (!claim) throw new BadRequestException("activation_token_invalid");
        applicationId = claim.application_id;
      } else {
        const { rows: [app0] } = await c.query(
          "SELECT id, status FROM owner_applications WHERE status_token_hash=$1 FOR UPDATE", [hashToken(creds.statusToken!)]);
        if (!app0) throw new BadRequestException("status_token_invalid");
        if (app0.status !== "APPROVED") throw new BadRequestException("activation_not_available");
        const { rows: [claim] } = await c.query(
          `UPDATE onboarding_tokens SET used_at=now()
           WHERE id = (SELECT id FROM onboarding_tokens
                       WHERE application_id=$1 AND purpose='owner_activation' AND used_at IS NULL AND expires_at > now()
                       ORDER BY created_at DESC LIMIT 1)
           RETURNING application_id`, [app0.id]);
        if (!claim) throw new BadRequestException("activation_token_invalid"); // approved but the link window lapsed
        applicationId = claim.application_id;
      }

      const { rows: [app] } = await c.query("SELECT id, status, user_id, email FROM owner_applications WHERE id=$1 FOR UPDATE", [applicationId]);
      if (!app || app.status !== "APPROVED") throw new BadRequestException("activation_not_available");
      if (!app.user_id) throw new BadRequestException("activation_not_available");

      const { rows: [u] } = await c.query("SELECT id, account_status, active FROM users WHERE id=$1 FOR UPDATE", [app.user_id]);
      if (!u) throw new BadRequestException("activation_not_available");
      if (u.account_status === "active" && u.active) throw new BadRequestException("activation_already_completed");

      await c.query(
        "UPDATE users SET password_hash=$2, active=true, account_status='active', token_version=token_version+1 WHERE id=$1",
        [u.id, hash]);
      await audit(c, { shopId: null, actorId: u.id, action: "application.activate", entity: "owner_application", entityId: app.id, newValue: { email: app.email } });
      await audit(c, { shopId: null, actorId: u.id, action: "auth.account.activated", entity: "user", entityId: u.id });
      return { ok: true as const, email: app.email };
    });
  }

  /* ================================================================ Stage 2 — administrator review */

  async listApplications() {
    return this.db.query(
      `SELECT a.id, a.contact_name, a.email, a.phone, a.shop_name, a.location, a.category, a.note,
              a.status, a.info_message, a.decision_reason, a.user_id, a.shop_id,
              to_char(a.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at,
              to_char(a.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reviewed_at,
              u.full_name AS reviewed_by_name,
              (a.history ->- 1) AS last_event
       FROM owner_applications a LEFT JOIN users u ON u.id = a.reviewed_by
       ORDER BY CASE a.status WHEN 'PENDING_REVIEW' THEN 0 WHEN 'ADDITIONAL_INFORMATION_REQUIRED' THEN 1 ELSE 2 END,
                a.submitted_at DESC LIMIT 500`);
  }

  async getApplication(id: string) {
    const [app] = await this.db.query(
      `SELECT a.*, u.full_name AS reviewed_by_name,
              to_char(a.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at,
              to_char(a.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
              to_char(a.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reviewed_at
       FROM owner_applications a LEFT JOIN users u ON u.id=a.reviewed_by WHERE a.id=$1`, [id]);
    if (!app) throw new NotFoundException("application_not_found");
    return app;
  }  async approve(adminId: string, id: string, note?: string) {
    return this.db.tx(async (c) => {
      const { rows: [app] } = await c.query("SELECT * FROM owner_applications WHERE id=$1 FOR UPDATE", [id]);
      if (!app) throw new NotFoundException("application_not_found");
      if (app.status !== "PENDING_REVIEW" && app.status !== "ADDITIONAL_INFORMATION_REQUIRED")
        throw new ConflictException("invalid_transition"); // double approval / decision after a decision

      const history = `history = history || jsonb_build_array(jsonb_build_object('at', now(), 'actor', 'admin', 'action', 'approved', 'message', $4::text))`;
      let userId: string;
      if (app.password_hash) {
        // Five-field registration flow: the applicant already chose their password, so approval
        // activates the account AND the proposed shop in the same transaction. The role is assigned
        // here on the server — nothing a client sent can influence it — and the shop is created
        // exactly once because the application row is locked FOR UPDATE for the whole decision.
        const { rows: shopRows } = await c.query(
          "INSERT INTO shops(name, location, category) VALUES ($1,$2,$3) RETURNING id",
          [norm(app.shop_name), norm(app.location) || null, norm(app.category) || null]);
        const newShopId = shopRows[0].id;
        const { rows: userRows } = await c.query(
          `INSERT INTO users(shop_id, email, full_name, password_hash, role, active, account_status)
           VALUES ($1,$2,$3,$4,'owner', true, 'active') RETURNING id`,
          [newShopId, app.email, app.contact_name, app.password_hash]);
        userId = userRows[0].id;

        await c.query(
          `UPDATE owner_applications SET status='APPROVED', user_id=$2, shop_id=$3, reviewed_by=$4, reviewed_at=now(), updated_at=now(),
             history = history || jsonb_build_array(jsonb_build_object('at', now(), 'actor', 'admin', 'action', 'approved', 'message', $5::text))
           WHERE id=$1`,
          [id, userId, newShopId, adminId, norm(note ?? "") || null]);
        await audit(c, { shopId: newShopId, actorId: adminId, action: "application.approve", entity: "owner_application", entityId: id,
          newValue: { email: app.email, status: "APPROVED", userId, shopId: newShopId } });
        await audit(c, { shopId: newShopId, actorId: adminId, action: "user.create", entity: "user", entityId: userId,
          newValue: { email: app.email, role: "owner" } });
        await audit(c, { shopId: newShopId, actorId: adminId, action: "shop.create", entity: "shop", entityId: newShopId,
          newValue: { name: app.shop_name, location: norm(app.location) || null, category: norm(app.category) || null } });
        return { id, status: "APPROVED" as const };
      }

      // Legacy flow: the password is chosen at activation, so the account is created unusable and
      // an activation token (single use, 7 days) is issued for the applicant's status page.
      // An unusable placeholder hash — never a real password.
      const placeholder = await bcrypt.hash(randomBytes(32).toString("hex"), 12);
      const activationToken = newOpaqueToken();
      const { rows: userRows } = await c.query(
        `INSERT INTO users(shop_id, email, full_name, password_hash, role, active, account_status)
         VALUES (NULL, $1, $2, $3, 'owner', false, 'pending_activation') RETURNING id`,
        [app.email, app.contact_name, placeholder]);
      userId = userRows[0].id;

      await c.query(
        "INSERT INTO onboarding_tokens(purpose, application_id, token_hash, expires_at) VALUES ('owner_activation', $1, $2, $3)",
        [app.id, hashToken(activationToken), new Date(Date.now() + ACTIVATION_TTL_MS)]);

      await c.query(
        `UPDATE owner_applications SET status='APPROVED', user_id=$2, reviewed_by=$3, reviewed_at=now(), updated_at=now(), ${history}
         WHERE id=$1`,
        [id, userId, adminId, norm(note ?? "") || null]);
      await audit(c, { shopId: null, actorId: adminId, action: "application.approve", entity: "owner_application", entityId: id,
        newValue: { email: app.email, status: "APPROVED", userId } });
      return { id, status: "APPROVED" as const };
    });
  }

  async reject(adminId: string, id: string, reason: string) {
    const why = norm(reason);
    return this.db.tx(async (c) => {
      const { rows: [app] } = await c.query("SELECT * FROM owner_applications WHERE id=$1 FOR UPDATE", [id]);
      if (!app) throw new NotFoundException("application_not_found");
      if (app.status !== "PENDING_REVIEW" && app.status !== "ADDITIONAL_INFORMATION_REQUIRED")
        throw new ConflictException("invalid_transition");
      await c.query(
        `UPDATE owner_applications SET status='REJECTED', decision_reason=$2, reviewed_by=$3, reviewed_at=now(), updated_at=now(),
           history = history || jsonb_build_array(jsonb_build_object('at', now(), 'actor', 'admin', 'action', 'rejected', 'message', $2::text))
         WHERE id=$1`, [id, why, adminId]);
      await audit(c, { shopId: null, actorId: adminId, action: "application.reject", entity: "owner_application", entityId: id,
        newValue: { email: app.email, status: "REJECTED" }, reason: why });
      return { id, status: "REJECTED" as const };
    });
  }

  async requestInformation(adminId: string, id: string, message: string) {
    const msg = norm(message);
    return this.db.tx(async (c) => {
      const { rows: [app] } = await c.query("SELECT * FROM owner_applications WHERE id=$1 FOR UPDATE", [id]);
      if (!app) throw new NotFoundException("application_not_found");
      if (app.status !== "PENDING_REVIEW" && app.status !== "ADDITIONAL_INFORMATION_REQUIRED")
        throw new ConflictException("invalid_transition");
      await c.query(
        `UPDATE owner_applications SET status='ADDITIONAL_INFORMATION_REQUIRED', info_message=$2, reviewed_by=$3, updated_at=now(),
           history = history || jsonb_build_array(jsonb_build_object('at', now(), 'actor', 'admin', 'action', 'requested_information', 'message', $2::text))
         WHERE id=$1`, [id, msg, adminId]);
      await audit(c, { shopId: null, actorId: adminId, action: "application.request_info", entity: "owner_application", entityId: id, newValue: { message: msg } });
      return { id, status: "ADDITIONAL_INFORMATION_REQUIRED" as const };
    });
  }

  /**
   * Re-opens the activation window when the 7-day link lifetime lapsed (the applicant activates
   * from their status page, so no raw token is shown to anybody — least of all to the reviewer).
   */
  async extendActivationWindow(adminId: string, id: string) {
    return this.db.tx(async (c) => {
      const { rows: [app] } = await c.query("SELECT * FROM owner_applications WHERE id=$1 FOR UPDATE", [id]);
      if (!app) throw new NotFoundException("application_not_found");
      if (app.status !== "APPROVED") throw new ConflictException("invalid_transition");
      await c.query("UPDATE onboarding_tokens SET used_at=coalesce(used_at, now()) WHERE application_id=$1 AND purpose='owner_activation'", [id]);
      await c.query(
        "INSERT INTO onboarding_tokens(purpose, application_id, token_hash, expires_at) VALUES ('owner_activation', $1, $2, $3)",
        [id, hashToken(newOpaqueToken()), new Date(Date.now() + ACTIVATION_TTL_MS)]);
      await audit(c, { shopId: null, actorId: adminId, action: "application.activation_extended", entity: "owner_application", entityId: id });
      return { id, ok: true };
    });
  }

  /* ================================================================ Stage 4 — shop creation */

  async createShop(user: AuthUser, input: { name: string; location?: string; category?: string }) {
    const name = norm(input.name);
    return this.db.tx(async (c) => {
      // The user row is the lock: two concurrent "create" calls serialise here, so only one wins.
      const { rows: [u] } = await c.query("SELECT id, role, shop_id, account_status FROM users WHERE id=$1 FOR UPDATE", [user.id]);
      if (!u || u.role !== "owner") throw new ForbiddenException("role_not_allowed");
      if (u.account_status !== "active") throw new ForbiddenException("account_not_active");
      if (u.shop_id) throw new ConflictException("shop_already_created");

      const { rows: [s] } = await c.query(
        "INSERT INTO shops(name, location, category) VALUES ($1,$2,$3) RETURNING id, name, currency, location, category, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at",
        [name, norm(input.location ?? "") || null, norm(input.category ?? "") || null]);
      const upd = await c.query("UPDATE users SET shop_id=$2 WHERE id=$1 AND shop_id IS NULL", [u.id, s.id]);
      if (!upd.rowCount) throw new ConflictException("shop_already_created"); // lost the race; the extra shop never commits
      // Tie the shop back to the approved application for the audit trail.
      await c.query("UPDATE owner_applications SET shop_id=$2, updated_at=now() WHERE user_id=$1 AND status='APPROVED'", [u.id, s.id]);
      await audit(c, { shopId: s.id, actorId: u.id, action: "shop.create", entity: "shop", entityId: s.id,
        newValue: { name, location: s.location, category: s.category } });
      return s;
    });
  }

  /* ================================================================ Stage 5 — manager invitations */

  async listStaff(user: AuthUser) {
    const shopId = user.shopId;
    if (!shopId) throw new BadRequestException("shop_required");
    const [staff, invitations] = await Promise.all([
      this.db.query(
        `SELECT id, email, full_name, role, active, account_status,
                to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
         FROM users WHERE shop_id=$1 AND role IN ('owner','manager')
         ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, full_name`, [shopId]),
      this.db.query(
        `SELECT i.id, i.email, i.full_name, i.phone, i.status,
                to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                to_char(i.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
                to_char(i.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS accepted_at,
                u.full_name AS invited_by_name
         FROM staff_invitations i JOIN users u ON u.id=i.invited_by
         WHERE i.shop_id=$1 ORDER BY i.created_at DESC LIMIT 200`, [shopId]),
    ]);
    return { staff, invitations };
  }

  async invite(user: AuthUser, input: { fullName: string; email: string; phone?: string }) {
    const shopId = user.shopId;
    if (!shopId) throw new BadRequestException("shop_required");
    const email = normEmail(input.email);

    // An invitation can never be aimed at somebody who already runs a shop or the platform.
    const [existing] = await this.db.query("SELECT id, role, shop_id, active, account_status FROM users WHERE lower(email)=lower($1)", [email]);
    if (existing) {
      if (existing.shop_id === shopId) throw new ConflictException("staff_already_in_shop");
      if (existing.role === "system_admin" || existing.role === "owner" || existing.account_status === "suspended")
        throw new ConflictException("invitation_target_ineligible");
    }

    const token = newOpaqueToken();
    let row: any;
    try {
      [row] = await this.db.query(
        `INSERT INTO staff_invitations(shop_id, email, full_name, phone, invited_by, token_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, status, to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at, email, full_name`,
        [shopId, email, norm(input.fullName), norm(input.phone ?? "") || null, user.id, hashToken(token), new Date(Date.now() + INVITATION_TTL_MS)]);
    } catch (e: any) {
      if (e?.code === "23505") throw new ConflictException("invitation_exists");
      throw e;
    }
    await audit(this.db.pool, { shopId, actorId: user.id, action: "staff.invitation.create", entity: "staff_invitation",
      entityId: row.id, newValue: { email, fullName: norm(input.fullName), role: "manager", expiresAt: row.expires_at } });
    return { ...row, inviteUrl: invitationUrl(token) };
  }

  async resendInvitation(user: AuthUser, id: string) {
    const shopId = user.shopId;
    if (!shopId) throw new BadRequestException("shop_required");
    const token = newOpaqueToken();
    return this.db.tx(async (c) => {
      const { rows: [inv] } = await c.query("SELECT * FROM staff_invitations WHERE id=$1 AND shop_id=$2 FOR UPDATE", [id, shopId]);
      if (!inv) throw new NotFoundException("invitation_not_found"); // never confirm another shop's row
      if (inv.status === "active") throw new ConflictException("invitation_already_active");
      if (inv.status === "revoked") throw new ConflictException("invitation_revoked"); // a revoked invite is terminal: create a new one
      const { rows: [row] } = await c.query(
        `UPDATE staff_invitations SET token_hash=$2, expires_at=$3, status='invited', updated_at=now()
         WHERE id=$1 RETURNING id, email, to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`,
        [id, hashToken(token), new Date(Date.now() + INVITATION_TTL_MS)]);
      await audit(c, { shopId, actorId: user.id, action: "staff.invitation.resend", entity: "staff_invitation", entityId: id,
        newValue: { email: inv.email, expiresAt: row.expires_at } });
      return { ...row, inviteUrl: invitationUrl(token) };
    });
  }

  async revokeInvitation(user: AuthUser, id: string) {
    const shopId = user.shopId;
    if (!shopId) throw new BadRequestException("shop_required");
    return this.db.tx(async (c) => {
      const { rows: [inv] } = await c.query("SELECT * FROM staff_invitations WHERE id=$1 AND shop_id=$2 FOR UPDATE", [id, shopId]);
      if (!inv) throw new NotFoundException("invitation_not_found");
      if (inv.status === "active") throw new ConflictException("invitation_already_active");
      if (inv.status === "revoked") return { id, status: "revoked" as const };
      await c.query(
        "UPDATE staff_invitations SET status='revoked', revoked_at=now(), revoked_by=$2, updated_at=now() WHERE id=$1", [id, user.id]);
      await audit(c, { shopId, actorId: user.id, action: "staff.invitation.revoke", entity: "staff_invitation", entityId: id, newValue: { email: inv.email } });
      return { id, status: "revoked" as const };
    });
  }

  /* ---------------------------------- invitation acceptance (public, token-gated) */

  async previewInvitation(token: string): Promise<InvitationPreview> {
    const [inv] = await this.db.query(
      `SELECT i.status, i.email, i.full_name, i.expires_at, s.name AS shop_name
       FROM staff_invitations i JOIN shops s ON s.id=i.shop_id WHERE i.token_hash=$1`, [hashToken(token)]);
    if (!inv) throw new BadRequestException("invitation_invalid");
    const expired = new Date(inv.expires_at).getTime() <= Date.now();
    const status = inv.status === "active" ? "active" : inv.status === "revoked" ? "revoked" : expired || inv.status === "expired" ? "expired" : "invited";
    if (status === "expired" && inv.status === "invited") {
      // Flip the row so the owner's list stops showing a lapsed invite as pending.
      await this.db.query("UPDATE staff_invitations SET status='expired', updated_at=now() WHERE token_hash=$1", [hashToken(token)]);
    }
    if (status !== "invited") return { status };
    const [existing] = await this.db.query("SELECT 1 FROM users WHERE lower(email)=lower($1)", [inv.email]);
    return {
      status, shopName: inv.shop_name, email: inv.email, fullName: inv.full_name,
      expiresAt: inv.expires_at, existingAccount: !!existing,
    };
  }

  /** First visit from an expired link flips the row so the owner sees EXPIRED too. */
  private async expireIfNeeded(c: any, inv: any) {
    if (inv.status === "invited" && new Date(inv.expires_at).getTime() <= Date.now()) {
      await c.query("UPDATE staff_invitations SET status='expired', updated_at=now() WHERE id=$1", [inv.id]);
      throw new BadRequestException("invitation_expired");
    }
  }

  /** New account: creates the manager with a password the invitee chose themselves. */
  async acceptInvitation(token: string, password: string): Promise<{ ok: true; email: string; shopName: string }> {
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const [check] = await this.db.query("SELECT id FROM staff_invitations WHERE token_hash=$1 AND status='invited'", [hashToken(token)]);
    if (!check) throw new BadRequestException("invitation_invalid");
    const hash = await bcrypt.hash(password, 12);

    return this.db.tx(async (c) => {
      const { rows: [inv] } = await c.query("SELECT * FROM staff_invitations WHERE token_hash=$1 FOR UPDATE", [hashToken(token)]);
      if (!inv) throw new BadRequestException("invitation_invalid");
      if (inv.status !== "invited") throw new BadRequestException(inv.status === "expired" ? "invitation_expired" : `invitation_${inv.status}`);
      await this.expireIfNeeded(c, inv);

      const { rows: [taken] } = await c.query("SELECT id FROM users WHERE lower(email)=lower($1)", [inv.email]);
      if (taken) throw new ConflictException("invitation_email_in_use"); // identity collision: accept while signed in instead

      const { rows: [u] } = await c.query(
        `INSERT INTO users(shop_id, email, full_name, password_hash, role, active, account_status)
         VALUES ($1,$2,$3,$4,'manager', true, 'active') RETURNING id`,
        [inv.shop_id, inv.email, inv.full_name, hash]);
      const upd = await c.query(
        "UPDATE staff_invitations SET status='active', accepted_at=now(), accepted_user_id=$2, updated_at=now() WHERE id=$1 AND status='invited'",
        [inv.id, u.id]);
      if (!upd.rowCount) throw new BadRequestException("invitation_invalid"); // lost a parallel race: nothing was created
      const shopRes = await c.query("SELECT name FROM shops WHERE id=$1", [inv.shop_id]);
      const shop = shopRes.rows[0];
      await audit(c, { shopId: inv.shop_id, actorId: u.id, action: "staff.invitation.accepted", entity: "staff_invitation",
        entityId: inv.id, newValue: { email: inv.email, role: "manager" } });
      await audit(c, { shopId: inv.shop_id, actorId: u.id, action: "user.create", entity: "user", entityId: u.id, newValue: { email: inv.email, role: "manager" } });
      return { ok: true as const, email: inv.email, shopName: shop?.name ?? "" };
    });
  }

  /**
   * Existing account: the holder must be signed in and matches the invited address, so an
   * invitation can never silently move somebody else's account to another shop.
   */
  async acceptInvitationAuthenticated(user: AuthUser, token: string): Promise<{ ok: true }> {
    return this.db.tx(async (c) => {
      const { rows: [inv] } = await c.query("SELECT * FROM staff_invitations WHERE token_hash=$1 FOR UPDATE", [hashToken(token)]);
      if (!inv) throw new BadRequestException("invitation_invalid");
      if (inv.status !== "invited") throw new BadRequestException(inv.status === "expired" ? "invitation_expired" : `invitation_${inv.status}`);
      await this.expireIfNeeded(c, inv);

      const { rows: [u] } = await c.query("SELECT id, email, role, shop_id, active, account_status FROM users WHERE id=$1 FOR UPDATE", [user.id]);
      if (u.email.toLowerCase() !== inv.email.toLowerCase()) throw new ForbiddenException("invitation_email_mismatch");
      if (u.role !== "manager") throw new ForbiddenException("invitation_target_ineligible"); // never an owner or an admin
      if (u.account_status !== "active" || !u.active) throw new ForbiddenException("invitation_target_ineligible"); // suspended stays suspended
      if (u.shop_id === inv.shop_id) throw new ConflictException("staff_already_in_shop");

      const oldShop = u.shop_id;
      await c.query("UPDATE users SET shop_id=$2, active=true, account_status='active' WHERE id=$1", [u.id, inv.shop_id]);
      const upd = await c.query(
        "UPDATE staff_invitations SET status='active', accepted_at=now(), accepted_user_id=$2, updated_at=now() WHERE id=$1 AND status='invited'",
        [inv.id, u.id]);
      if (!upd.rowCount) throw new BadRequestException("invitation_invalid");
      await audit(c, { shopId: inv.shop_id, actorId: u.id, action: "staff.invitation.accepted", entity: "staff_invitation",
        entityId: inv.id, newValue: { email: inv.email, role: "manager", previousShopId: oldShop } });
      await audit(c, { shopId: oldShop, actorId: u.id, action: "staff.transfer_out", entity: "user", entityId: u.id,
        newValue: { newShopId: inv.shop_id } });
      return { ok: true as const };
    });
  }
}

