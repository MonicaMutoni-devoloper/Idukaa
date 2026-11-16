import "./env";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import helmet from "helmet";
import { Db } from "./db/db.service";
import { attachRealtime } from "./realtime/hub";
import { AppModule } from "./app.module";
import { requestIdMiddleware } from "./common/auth-log";
import { allowedOrigins } from "./common/http";
import { runMigrations } from "./db/migrate";

async function bootstrap() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET (>=32 chars) is required");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  // Migrate before the port opens. New code therefore never serves requests against an older
  // schema, and a failed migration stops this instance from starting at all (Render then keeps the
  // previous healthy deploy) instead of accepting writes it cannot store. Serialized across
  // instances by an advisory lock. AUTO_MIGRATE=false hands the job to an external step instead.
  if (process.env.AUTO_MIGRATE !== "false") {
    const { applied, failure } = await runMigrations(process.env.DIRECT_URL ?? process.env.DATABASE_URL);
    if (applied.length) console.log(JSON.stringify({ t: new Date().toISOString(), evt: "db.migrate", applied }));
    if (failure) {
      const e = failure.error as { message?: string; code?: string };
      console.error(JSON.stringify({ t: new Date().toISOString(), evt: "db.migrate.failed", file: failure.file, pgCode: e?.code, message: e?.message?.slice(0, 400) }));
      process.exit(1);
    }
  }
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  // Every request gets a correlation id that is echoed back and attached to auth diagnostics.
  app.use(requestIdMiddleware);
  // credentials:true is required for the web HttpOnly refresh cookie. The allow-list stays explicit,
  // so no other origin can send or read authenticated requests.
  app.enableCors({ origin: allowedOrigins(), credentials: true });
  app.getHttpAdapter().getInstance().set("trust proxy", 1);
  // Real-time presence channel. It carries only "this shop changed" nudges: clients answer by
  // running their own authorized incremental pull, so authorization stays in AuthGuard/pull and a
  // dropped message costs one poll interval, never data.
  attachRealtime(app.getHttpServer() as Parameters<typeof attachRealtime>[0], {
    verify: async (token) => {
      let claims: { sub?: string; tv?: number; exp?: number };
      try { claims = await app.get(JwtService).verifyAsync(token); } catch { return null; }
      const [u] = await app.get(Db).query(
        `SELECT u.id, u.role, u.shop_id, u.active, u.account_status, u.token_version, s.status AS shop_status
           FROM users u LEFT JOIN shops s ON s.id = u.shop_id WHERE u.id=$1`, [claims.sub]);
      if (!u || !u.active || u.account_status !== "active" || u.token_version !== claims.tv) return null;
      if (u.shop_id && u.shop_status === "suspended") return null;
      return {
        id: u.id, role: u.role, shopId: u.shop_id,
        expiresAt: typeof claims.exp === "number" ? claims.exp * 1000 : undefined,
      };
    },
    log: (evt, data) => console.log(JSON.stringify({ t: new Date().toISOString(), evt, ...data })),
  });
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
  // Two misconfigurations that are invisible until a real user is stuck: links that point at a
  // developer's laptop, and a confirmation e-mail that was never sent. Both are warnings, not
  // refusals — the API is still able to serve every other route.
  if (!process.env.APP_WEB_URL && !process.env.PASSWORD_RESET_URL) {
    console.warn(JSON.stringify({ t: new Date().toISOString(), evt: "mail.link_base_missing",
      message: "APP_WEB_URL is unset: confirmation and reset links point at http://localhost:8081" }));
  }
  const mailChannel = process.env.MAIL_GMAIL_REFRESH_TOKEN ? "gmail-api"
    : process.env.MAIL_SMTP_USER && process.env.MAIL_SMTP_PASS ? "smtp" : "none";
  if (mailChannel === "none") {
    console.warn(JSON.stringify({ t: new Date().toISOString(), evt: "mail.not_configured",
      message: "no mail channel (MAIL_GMAIL_* or MAIL_SMTP_USER/PASS): no confirmation or reset e-mail will be sent" }));
  } else {
    console.log(JSON.stringify({ t: new Date().toISOString(), evt: "mail.channel", channel: mailChannel }));
  }
  // A free Render instance cannot reach Gmail's SMTP ports; say so at boot instead of at the first
  // reset request, which would otherwise sit for 20 s and fail with ETIMEDOUT in the logs.
  if (mailChannel === "smtp" && !process.env.MAIL_GMAIL_REFRESH_TOKEN) {
    console.warn(JSON.stringify({ t: new Date().toISOString(), evt: "mail.smtp_may_be_blocked",
      message: "SMTP is selected: free Render instances block ports 25/465/587. Use MAIL_GMAIL_* or a paid instance." }));
  }
}
bootstrap();
