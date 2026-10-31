import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import { ZodError } from "zod";

/**
 * The one place raw ZodErrors become HTTP 400s (everything else throws HttpException directly).
 * Registered as a global APP_FILTER in AppModule so the exact same behaviour applies to the
 * running server AND to the integration tests, which build AppModule without main.ts's bootstrap.
 * The 500 path never leaks internals — it logs and answers with a fixed message.
 */
@Catch()
export class Filter implements ExceptionFilter {
  private log = new Logger("Errors");
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof ZodError) return res.status(400).json({ error: "validation_failed", issues: e.issues.map(i => ({ path: i.path.join("."), message: i.message })) });
    if (e instanceof HttpException) return res.status(e.getStatus()).json(typeof e.getResponse() === "string" ? { error: e.getResponse() } : e.getResponse());
    this.log.error(e); return res.status(500).json({ error: "internal_error" }); // never leak internals
  }
}
