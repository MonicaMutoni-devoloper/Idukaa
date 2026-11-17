import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { Public } from "./auth";
import { Db } from "../db/db.service";
import { MailService } from "../mail/mail.service";

/**
 * Unauthenticated liveness/readiness probe for the hosting platform (Render health checks,
 * uptime monitors, load balancers). Deliberately returns nothing sensitive: a status word,
 * whether the database answered a trivial query, and process uptime — never configuration,
 * connection strings or tenant data.
 *
 * 200 when the database answers, 503 when it does not, so a failed check means the instance
 * genuinely cannot serve requests (for example a wrong DATABASE_URL) instead of pretending to be healthy.
 *
 * `mail` is the sending channel ("gmail-api", "smtp" or "none") — a name, never a credential. It is
 * here because "sign-in says check your e-mail and nothing arrives" has one cause worth reading off a
 * probe: whether this instance can send at all, and whether links point somewhere other than localhost.
 */
@Public()
@Controller("health")
export class HealthController {
  constructor(private db: Db, private mail: MailService) {}

  @Get()
  async health() {
    const body = {
      status: "ok",
      db: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      mail: this.mail.channel(),
      links: process.env.APP_WEB_URL || process.env.PASSWORD_RESET_URL ? "configured" : "localhost",
    };
    try {
      await this.db.query("SELECT 1");
      return body;
    } catch {
      throw new ServiceUnavailableException({ ...body, status: "unavailable", db: "down" });
    }
  }
}
