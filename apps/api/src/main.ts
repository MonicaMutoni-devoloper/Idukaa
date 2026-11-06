import "./env";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
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
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}
bootstrap();
