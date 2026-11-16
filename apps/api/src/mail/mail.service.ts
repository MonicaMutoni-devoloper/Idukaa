import { Injectable, Logger } from "@nestjs/common";
import nodemailer, { type Transporter } from "nodemailer";

/**
 * The one place in the API that talks to the outside world for e-mail.
 *
 * Sending is deliberately configured through environment variables and is optional at the process
 * level: with no credentials the server still starts, still approves shops and still accepts reset
 * requests, and every attempt is logged as skipped instead of throwing. A mail provider outage must
 * never turn into a 500 that hides whether an account exists.
 *
 * The default target is a real Gmail mailbox over SMTP (an app password, never the account
 * password): Gmail delivers to Gmail, and the message is sent by Google's own servers, so SPF and
 * DKIM pass without owning a domain. Point MAIL_SMTP_HOST elsewhere to use any other SMTP relay.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger("mail");
  private transport: Transporter | null = null;

  private host() { return process.env.MAIL_SMTP_HOST ?? "smtp.gmail.com"; }
  private port() {
    const n = Number(process.env.MAIL_SMTP_PORT ?? 465);
    return Number.isFinite(n) && n > 0 && n < 65_536 ? n : 465;
  }
  private user() { return process.env.MAIL_SMTP_USER ?? ""; }
  private pass() { return process.env.MAIL_SMTP_PASS ?? ""; }
  private fromName() { return process.env.MAIL_FROM_NAME ?? "Idukaa"; }

  /** The From address must be the authenticated mailbox on Gmail; any other value is rejected. */
  private from() { return process.env.MAIL_FROM ?? this.user(); }

  configured() { return !!this.user() && !!this.pass(); }

  private client(): Transporter {
    if (this.transport) return this.transport;
    const port = this.port();
    this.transport = nodemailer.createTransport({
      host: this.host(),
      port,
      // 465 is implicit TLS; anything else (587) upgrades with STARTTLS.
      secure: port === 465,
      auth: { user: this.user(), pass: this.pass() },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return this.transport;
  }

  /**
   * Never throws. The caller learns whether the message left the building, and the reason is both
   * logged and kept for the operator to read back on the health endpoint.
   */
  async send(msg: { to: string; subject: string; text: string; html: string }): Promise<{ sent: boolean; error?: string }> {
    if (!this.configured()) {
      this.log.warn(`mail not configured (MAIL_SMTP_USER / MAIL_SMTP_PASS unset) — "${msg.subject}" to ${msg.to} not sent`);
      return { sent: false, error: "mail_not_configured" };
    }
    try {
      await this.client().sendMail({
        from: `"${this.fromName()}" <${this.from()}>`,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        // Transactional only: a reply goes to the operator's mailbox, never to a no-reply void.
        replyTo: this.from(),
        headers: { "X-Entity-Ref-ID": `idukaa-${Date.now()}` },
      });
      this.log.log(`sent "${msg.subject}" to ${msg.to}`);
      return { sent: true };
    } catch (e: any) {
      const message = String(e?.response ?? e?.message ?? e);
      // A revoked app password or a quota stop would otherwise be invisible until a user complains.
      this.log.error(`could not send "${msg.subject}" to ${msg.to}: ${message}`);
      return { sent: false, error: "mail_send_failed" };
    }
  }
}
