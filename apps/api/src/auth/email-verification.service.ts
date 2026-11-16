import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Db } from "../db/db.service";
import { audit } from "../audits/audit";
import { MailService } from "../mail/mail.service";
import { verificationEmail } from "../mail/templates";
import { hashToken, newOpaqueToken } from "./security";

/**
 * Proving that an address is real before it is allowed to sign in.
 *
 * The gate exists because "the e-mail exists" cannot be decided from the address itself: syntax
 * checks accept dead mailboxes and MX lookups accept catch-all domains. The only proof is that
 * whoever is signing in can read mail sent to that address, so an account is allowed once a random,
 * expiring, single-use link has been clicked.
 *
 * Two deliberate properties:
 *   * asking for a link never reveals whether an account exists or is already verified — the answer
 *     is the same `{ ok: true }` every time;
 *   * a mail outage is not an account outage. Sending is attempted, failures are logged, and the
 *     terms of the gate are controlled by EMAIL_VERIFICATION_REQUIRED so an operator can turn it off
 *     without a code change if the mailbox behind MAIL_SMTP_USER stops working.
 */

const ttlHours = () => {
  const n = Number(process.env.EMAIL_VERIFICATION_TTL_HOURS ?? 48);
  return Number.isFinite(n) && n >= 1 && n <= 168 ? n : 48;
};

/** The web app, where every link lands. Derived from PASSWORD_RESET_URL when APP_WEB_URL is unset. */
export const appWebBase = () => {
  if (process.env.APP_WEB_URL) return process.env.APP_WEB_URL.replace(/\/+$/, "");
  const reset = process.env.PASSWORD_RESET_URL;
  if (reset) return reset.split("?")[0]!.replace(/\/reset-password\/?$/, "");
  return "http://localhost:8081";
};

const verifyUrl = (token: string) => `${appWebBase()}/verify-email?token=${encodeURIComponent(token)}`;

@Injectable()
export class EmailVerificationService {
  private readonly log = new Logger("email-verification");

  constructor(private db: Db, private mail: MailService) {}

  /**
   * Off by default? No: on. A shop app that hands accounts to strangers needs the address proven,
   * and the escape hatch is explicit.
   */
  required() { return (process.env.EMAIL_VERIFICATION_REQUIRED ?? "true").toLowerCase() !== "false"; }

  /**
   * Issues a fresh link and tries to deliver it. Always resolves: a rejected message leaves the
   * account unverified but must not fail the approval or invitation that created it.
   */
  async issue(userId: string, email: string, fullName: string, ip: string | null = null) {
    const token = newOpaqueToken();
    const expiresAt = new Date(Date.now() + ttlHours() * 3600_000);
    // One live link per account: the previous one stops working the moment a new one is asked for.
    await this.db.tx(async (c) => {
      await c.query("UPDATE email_verification_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [userId]);
      await c.query(
        "INSERT INTO email_verification_tokens(user_id, email, token_hash, expires_at, requested_ip) VALUES ($1,$2,$3,$4,$5)",
        [userId, email, hashToken(token), expiresAt, ip],
      );
    });
    const url = verifyUrl(token);
    const delivered = await this.mail.send({ to: email, ...verificationEmail({ name: fullName, url, hours: ttlHours() }) });
    await audit(this.db.pool, {
      shopId: null, actorId: userId, action: "auth.email.verification.sent", entity: "user", entityId: userId,
      newValue: { email, delivered: delivered.sent, reason: delivered.error ?? null },
    });
    if (!delivered.sent) this.log.warn(`verification link for ${email} was stored but not delivered (${delivered.error})`);
    return { ok: true as const, delivered: delivered.sent };
  }

  /** Single use, and the address must still be the one the link was issued for. */
  async verify(token: string, ip: string | null = null) {
    if (!token) throw new BadRequestException("verification_token_invalid");
    const result = await this.db.tx(async (c) => {
      const claim = await c.query(
        `UPDATE email_verification_tokens SET used_at=now()
         WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()
         RETURNING user_id, email`, [hashToken(token)]);
      if (!claim.rowCount) throw new BadRequestException("verification_token_invalid");
      const { user_id: userId, email } = claim.rows[0];
      const upd = await c.query(
        `UPDATE users SET email_verified_at=coalesce(email_verified_at, now())
         WHERE id=$1 AND lower(email)=lower($2) RETURNING email, full_name, shop_id`,
        [userId, email]);
      if (!upd.rowCount) throw new BadRequestException("verification_token_invalid");
      await c.query("UPDATE email_verification_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [userId]);
      return { email: upd.rows[0].email as string, shopId: (upd.rows[0].shop_id ?? null) as string | null, userId };
    });
    await audit(this.db.pool, {
      shopId: result.shopId, actorId: result.userId, action: "auth.email.verified", entity: "user", entityId: result.userId,
      newValue: { email: result.email, ip },
    });
    return { ok: true as const, email: result.email };
  }

  /** Public entry point: same answer for an unknown address, a verified one and an unverified one. */
  async resend(email: string, ip: string | null = null) {
    const [u] = await this.db.query(
      "SELECT id, email, full_name, email_verified_at FROM users WHERE lower(email)=lower($1) AND active=true",
      [email.trim()],
    );
    if (!u || u.email_verified_at) return { ok: true as const };
    await this.issue(u.id, u.email, u.full_name, ip);
    return { ok: true as const };
  }
}
