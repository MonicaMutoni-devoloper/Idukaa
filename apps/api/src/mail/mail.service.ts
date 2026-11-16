import { Injectable, Logger } from "@nestjs/common";
import nodemailer, { type Transporter } from "nodemailer";
import { gmailApiConfigured, sendViaGmailApi } from "./gmail-api";

/**
 * The one place in the API that talks to the outside world for e-mail.
 *
 * Two channels, one sender:
 *   * Gmail's HTTPS send API (`MAIL_GMAIL_*`) — the default recommendation. Same real mailbox,
 *     Google's servers sign it (SPF/DKIM pass to Gmail without owning a domain), and it runs on
 *     443, which every host allows. Render's free tier blocks outbound SMTP since Sept 2025.
 *   * SMTP (`MAIL_SMTP_*`) — for a paid host or any other relay, including a Gmail app password
 *     where port 465/587 is reachable.
 *
 * Sending is optional at the process level: with no credentials the server still starts, still
 * approves shops and still accepts reset requests, and every attempt is logged as skipped instead of
 * throwing. A mail provider outage must never become a 500 that hides whether an account exists.
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

  /** On Gmail the From address must be the authenticated mailbox; any other value is rejected. */
  private from() { return process.env.MAIL_FROM ?? this.user(); }

  smtpConfigured() { return !!this.user() && !!this.pass(); }
  configured() { return gmailApiConfigured() || this.smtpConfigured(); }

  /** Named so a log line says which one was used, instead of the operator having to guess. */
  channel(): "gmail-api" | "smtp" | "none" {
    if (gmailApiConfigured()) return "gmail-api";
    if (this.smtpConfigured()) return "smtp";
    return "none";
  }

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
   * Never throws. The caller learns whether the message left the building, and the reason is logged
   * for the operator — a revoked refresh token or a quota stop must be visible before a user says
   * "I never got the link".
   */
  async send(msg: { to: string; subject: string; text: string; html: string }): Promise<{ sent: boolean; error?: string }> {
    const channel = this.channel();
    if (channel === "none") {
      this.log.warn(`no mail channel configured (MAIL_GMAIL_* or MAIL_SMTP_USER/PASS) — "${msg.subject}" to ${msg.to} not sent`);
      return { sent: false, error: "mail_not_configured" };
    }
    try {
      if (channel === "gmail-api") {
        await sendViaGmailApi(msg);
      } else {
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
      }
      this.log.log(`sent "${msg.subject}" to ${msg.to} via ${channel}`);
      return { sent: true };
    } catch (e: any) {
      const message = String(e?.response ?? e?.message ?? e);
      this.log.error(`could not send "${msg.subject}" to ${msg.to} via ${channel}: ${message}`);
      return { sent: false, error: channel === "gmail-api" ? `gmail_api_failed: ${message.slice(0, 200)}` : "mail_send_failed" };
    }
  }
}
