import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { originIsCrossSite } from "./http";

/**
 * Correlation id for one HTTP request. Honours an inbound `x-request-id` (so a browser console
 * entry or a Render log line can be matched end to end) and always echoes it back in the response.
 * The value is validated, so a client cannot inject arbitrary text into the logs.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const supplied = req.headers["x-request-id"];
  const id = typeof supplied === "string" && /^[A-Za-z0-9._:-]{8,64}$/.test(supplied) ? supplied : randomUUID();
  (req as { requestId?: string }).requestId = id;
  res.setHeader("x-request-id", id);
  next();
}

export const requestIdOf = (req: Request | undefined) => (req as { requestId?: string } | undefined)?.requestId;

type Field = string | number | boolean | null | undefined;
export type AuthCategory =
  | "missing_refresh_credential" // no cookie and no body token reached the API
  | "csrf_rejected" // cookie arrived but the double-submit header did not match
  | "unknown_token" // token hash is not in the database (wrong/old deployment, wiped session)
  | "token_expired"
  | "token_reused" // presented after rotation, outside the grace window
  | "session_revoked" // user deactivated, account not active, or signed out everywhere
  | "invalid_access_token" // missing, malformed, bad signature or expired bearer
  | "session_state_mismatch" // token_version moved on (logout-all / revocation)
  | "shop_suspended"
  | "role_not_allowed"
  | "database_error"
  | "ok";

/**
 * One structured line per authentication decision. Fields are curated by the caller: no token,
 * cookie, password, authorization header or request body is ever serialized here — only the
 * category, the endpoint, the correlation id and non-secret metadata (counts, booleans, timings).
 */
export function authLog(
  req: Request | undefined,
  event: string,
  category: AuthCategory,
  fields: Record<string, Field> = {},
) {
  const line = {
    t: new Date().toISOString(),
    evt: `auth.${event}`,
    category,
    requestId: requestIdOf(req),
    method: req?.method,
    path: req?.path,
    crossSite: req ? originIsCrossSite(req) : undefined,
    ...fields,
  };
  // A single-line JSON record keeps production logs greppable by requestId or category.
  console.log(JSON.stringify(line));
}

/** Maps an exception message produced by AuthService.refresh onto a log category. */
export function refreshFailureCategory(message: string): AuthCategory {
  switch (message) {
    case "refresh_invalid": return "unknown_token";
    case "refresh_missing_credential": return "missing_refresh_credential";
    case "refresh_expired": return "token_expired";
    case "refresh_reused": return "token_reused";
    case "session_revoked": return "session_revoked";
    case "csrf_failed": return "csrf_rejected";
    default: return "database_error";
  }
}
