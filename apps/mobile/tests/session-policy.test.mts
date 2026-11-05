/**
 * The rule that decides whether a failed refresh ends the session.
 *
 * Every case here is one that used to sign the user out (or, worse, keep retrying a dead token):
 *   npm run test:policy -w @sms/mobile
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshVerdict } from "../src/services/session-policy.ts";

test("a refused refresh credential ends the session", () => {
  assert.equal(refreshVerdict(401, { error: "refresh_invalid" }), "rejected");
  assert.equal(refreshVerdict(401, { error: "refresh_expired" }), "rejected");
  assert.equal(refreshVerdict(401, { error: "refresh_reused" }), "rejected");
  assert.equal(refreshVerdict(401, { error: "session_revoked" }), "rejected");
  assert.equal(refreshVerdict(403, { error: "csrf_failed" }), "rejected");
});

test("a 401 that never carried a credential keeps the session", () => {
  // The cookie was blocked by the browser or not attached yet: the server examined nothing.
  assert.equal(refreshVerdict(401, { error: "refresh_missing_credential" }), "deferred");
  // The shape Nest actually sends for UnauthorizedException("refresh_missing_credential"):
  // the code is in `message`, while `error` is the generic word.
  assert.equal(refreshVerdict(401, {
    statusCode: 401, message: "refresh_missing_credential", error: "Unauthorized",
  }), "deferred");
});

test("a refused credential is recognised in Nest's real response shape too", () => {
  assert.equal(refreshVerdict(401, { statusCode: 401, message: "refresh_expired", error: "Unauthorized" }), "rejected");
  assert.equal(refreshVerdict(401, { statusCode: 401, message: "refresh_reused", error: "Unauthorized" }), "rejected");
});

test("temporary server and network failures keep the session", () => {
  for (const status of [0, 429, 500, 502, 503, 504]) {
    assert.equal(refreshVerdict(status, null), "deferred", `${status} must not end the session`);
  }
  assert.equal(refreshVerdict(429, { error: "ThrottlerException: Too Many Requests" }), "deferred");
  assert.equal(refreshVerdict(502, { error: "Bad Gateway" }), "deferred");
});

test("a 400 or 404 is a client bug, not proof the session died", () => {
  assert.equal(refreshVerdict(400, { error: "Bad Request" }), "deferred");
  assert.equal(refreshVerdict(404, null), "deferred");
});

test("an unknown body shape on a 401 is treated as a refusal", () => {
  // A 401 with no recognisable code still came from a credential the server looked at.
  assert.equal(refreshVerdict(401, null), "rejected");
  assert.equal(refreshVerdict(401, { error: 42 }), "rejected");
});
