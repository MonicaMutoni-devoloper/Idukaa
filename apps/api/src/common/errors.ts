import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Request } from "express";
import { ZodError } from "zod";
import { requestIdOf } from "./auth-log";

/**
 * The one place raw ZodErrors become HTTP 400s (everything else throws HttpException directly).
 * Registered as a global APP_FILTER in AppModule so the exact same behaviour applies to the
 * running server AND to the integration tests, which build AppModule without main.ts's bootstrap.
 *
 * Unexpected failures are logged with the correlation id, the route and the PostgreSQL error code
 * (never SQL parameters, tokens or shop data) and answered with a fixed message plus that id, so a
 * user can quote one value and the exact Render log line can be found. Before this, a dashboard 500
 * was an Error object with no route, no id and no database code — impossible to diagnose remotely.
 */
@Catch()
export class Filter implements ExceptionFilter {
  private log = new Logger("Errors");
  catch(e: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    if (e instanceof ZodError) return res.status(400).json({ error: "validation_failed", issues: e.issues.map(i => ({ path: i.path.join("."), message: i.message })) });
    if (e instanceof HttpException) {
      // A 5xx thrown deliberately (e.g. a dependency is down) still deserves a diagnostic line.
      if (e.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR) this.diagnose(e, ctx.getRequest(), e.getStatus());
      return res.status(e.getStatus()).json(typeof e.getResponse() === "string" ? { error: e.getResponse() } : e.getResponse());
    }
    const requestId = this.diagnose(e, ctx.getRequest(), 500);
    // Never leak internals; the id is the only extra field and it contains no data.
    return res.status(500).json({ error: "internal_error", requestId });
  }

  private diagnose(e: unknown, req: Request | undefined, status: number): string | undefined {
    const err = e as { name?: string; message?: string; code?: string; detail?: string; stack?: string };
    const requestId = requestIdOf(req);
    console.error(JSON.stringify({
      t: new Date().toISOString(),
      evt: "http.error",
      status,
      requestId,
      method: req?.method,
      path: req?.path,
      error: err?.name ?? "Error",
      message: err?.message?.slice(0, 400),
      pgCode: err?.code,
      pgDetail: err?.detail?.slice(0, 400),
      // First frames only: enough to locate the code path without dumping the whole tree.
      stack: err?.stack?.split("\n").slice(0, 6).join(" | "),
    }));
    this.log.error(`${status} ${req?.method} ${req?.path} requestId=${requestId}`);
    return requestId;
  }
}
