/**
 * Cookie-transport unit tests (no database).
 *
 * The production incident: the web app runs on *.vercel.app and the API on *.onrender.com, so the
 * refresh request is cross-site. With a hard-coded SameSite=Strict cookie the browser never sent the
 * credential and POST /auth/refresh answered 401 forever. These tests pin the policy that prevents it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cookieCsrfOk, originIsCrossSite, sameSitePolicy, siteOf } from "../src/common/http";

const req = (origin: string | undefined, host: string) => ({ headers: { origin, host } } as any);

test("site comparison ignores ports and separates different deployments", () => {
  assert.equal(siteOf("idukaa-api.vercel.app"), "vercel.app");
  assert.equal(siteOf("idukaa-qqk2.onrender.com"), "onrender.com");
  assert.equal(siteOf("api.example.rw:3000"), "example.rw");
  assert.equal(siteOf("localhost:8081"), "localhost");
  assert.equal(siteOf("127.0.0.1:3000"), "127.0.0.1");
  assert.equal(siteOf(""), "");
});

test("a *.vercel.app page calling *.onrender.com is cross-site, same-domain siblings are not", () => {
  assert.equal(originIsCrossSite(req("https://idukaa-api.vercel.app", "idukaa-qqk2.onrender.com")), true);
  assert.equal(originIsCrossSite(req("https://app.example.rw", "api.example.rw")), false);
  assert.equal(originIsCrossSite(req("http://localhost:8081", "localhost:3000")), false);
  // Native clients, curl and server-to-server calls send no Origin: keep the strict default.
  assert.equal(originIsCrossSite(req(undefined, "idukaa-qqk2.onrender.com")), false);
});

test("SameSite follows the caller: cross-site gets none+secure, same-site keeps strict", () => {
  delete process.env.COOKIE_SAMESITE;
  assert.equal(sameSitePolicy(req("https://idukaa-api.vercel.app", "idukaa-qqk2.onrender.com")), "none");
  assert.equal(sameSitePolicy(req("https://app.example.rw", "api.example.rw")), "strict");
  assert.equal(sameSitePolicy(req(undefined, "idukaa-qqk2.onrender.com")), "strict");
});

test("CSRF: double submit same-site, allow-listed Origin cross-site, nothing else", () => {
  const prevCors = process.env.CORS_ORIGINS;
  process.env.CORS_ORIGINS = "https://idukaa-api.vercel.app";
  const withCookie = (cookie: string | undefined, origin: string | undefined, csrf?: string) => ({
    headers: { origin, host: "idukaa-qqk2.onrender.com", cookie, "x-csrf-token": csrf },
  } as any);
  try {
    // Same-site: the classic double submit must match exactly.
    assert.equal(cookieCsrfOk(withCookie("sms_csrf=abc", "https://app.example.rw", "abc")), true);
    assert.equal(cookieCsrfOk(withCookie("sms_csrf=abc", "https://app.example.rw", "xyz")), false);
    assert.equal(cookieCsrfOk(withCookie(undefined, "https://app.example.rw", "abc")), false);

    // Cross-site: the browser cannot read the API's cookie, so an allow-listed Origin + header is
    // what makes the call legitimate (an unapproved origin never passes the CORS preflight).
    assert.equal(cookieCsrfOk(withCookie(undefined, "https://idukaa-api.vercel.app", "any-value")), true);
    assert.equal(cookieCsrfOk(withCookie(undefined, "https://evil.example", "any-value")), false);
    assert.equal(cookieCsrfOk(withCookie(undefined, undefined, "any-value")), false, "no Origin means no cross-site shortcut");
    assert.equal(cookieCsrfOk(withCookie(undefined, "https://idukaa-api.vercel.app", undefined)), false, "the header is still required");
  } finally {
    if (prevCors === undefined) delete process.env.CORS_ORIGINS; else process.env.CORS_ORIGINS = prevCors;
  }
});

test("an explicit COOKIE_SAMESITE always wins and is validated", () => {
  try {
    process.env.COOKIE_SAMESITE = "lax";
    assert.equal(sameSitePolicy(req("https://idukaa-api.vercel.app", "idukaa-qqk2.onrender.com")), "lax");
    process.env.COOKIE_SAMESITE = "nonsense";
    assert.equal(sameSitePolicy(req("https://idukaa-api.vercel.app", "idukaa-qqk2.onrender.com")), "none",
      "an unrecognised value falls back to the derived policy");
    process.env.COOKIE_SAMESITE = "strict";
    assert.equal(sameSitePolicy(req("https://idukaa-api.vercel.app", "idukaa-qqk2.onrender.com")), "strict");
  } finally {
    delete process.env.COOKIE_SAMESITE;
  }
});
