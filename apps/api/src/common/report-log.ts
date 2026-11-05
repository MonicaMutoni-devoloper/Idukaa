import type { Request } from "express";
import { requestIdOf } from "./auth-log";

/**
 * One structured line per failed report section.
 *
 * A dashboard 500 used to be logged only as an Error object by the global filter, with no way to tie
 * it to the request that produced it or to tell which sub-query failed. This records the correlation
 * id, the route and the PostgreSQL error code (never SQL text, parameters, tokens or shop data), so
 * a production failure can be identified from the Render log instead of guessed at.
 */
export function reportLog(req: Request | undefined, evt: string, section: string, e: unknown) {
  const err = e as { name?: string; message?: string; code?: string; detail?: string; table?: string; column?: string };
  console.log(JSON.stringify({
    t: new Date().toISOString(),
    evt,
    section,
    requestId: requestIdOf(req),
    method: req?.method,
    path: req?.path,
    error: err?.name ?? "Error",
    message: err?.message?.slice(0, 400),
    pgCode: err?.code,
    pgTable: err?.table,
    pgColumn: err?.column,
  }));
}
