/**
 * What a failed `/auth/refresh` actually tells us about the session.
 *
 * Pure and dependency-free on purpose: this is the decision that used to sign people out during a
 * Render cold start, so it is unit-tested directly instead of only being exercised through the UI.
 *
 * `rejected` — the server received a refresh credential and refused it. Only then is the session
 *              over and a sign-in required.
 * `deferred` — anything else: a throttle (429), a cold-start 5xx, a dropped connection, or a 401
 *              whose body says no credential reached the API at all. The session may be perfectly
 *              valid; retry later, keep the access token and the queued work.
 */
export type RefreshVerdict = "rejected" | "deferred";

/**
 * Bodies that mean "the credential was never presented", not "it was refused".
 * Nest renders a thrown string as `{ statusCode, message, error: "Unauthorized" }`, so the code can
 * sit in `message`; a custom object response puts it in `error`. Both are checked.
 */
const NO_CREDENTIAL_RECEIVED = new Set(["refresh_missing_credential"]);

export function refreshVerdict(status: number, body: unknown): RefreshVerdict {
  if (status !== 401 && status !== 403) return "deferred";
  const b = body as { error?: unknown; message?: unknown; code?: unknown } | null | undefined;
  const codes = [b?.code, b?.error, b?.message].filter((v): v is string => typeof v === "string");
  if (codes.some((c) => NO_CREDENTIAL_RECEIVED.has(c))) return "deferred";
  // Any other 401/403 came from a credential the server actually examined and refused:
  // refresh_invalid / refresh_expired / refresh_reused / session_revoked / csrf_failed.
  return "rejected";
}
