import "./env";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { requestIdMiddleware } from "./common/auth-log";
import { allowedOrigins } from "./common/http";

async function bootstrap() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET (>=32 chars) is required");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
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
