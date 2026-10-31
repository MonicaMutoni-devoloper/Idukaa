import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { authenticator } from "otplib";
import { z } from "zod";

/**
 * Small, dependency-light helpers shared by the auth flows.
 * Rules enforced here:
 *  - tokens are always random, never derived from user data;
 *  - only SHA-256 hashes of tokens/codes reach PostgreSQL;
 *  - TOTP secrets are encrypted with AES-256-GCM before they are stored;
 *  - password policy is applied by the server, never only by the UI.
 */

/** Password policy: at least 10 characters (the project minimum) plus a letter and a digit. */
export const passwordSchema = z
  .string()
  .min(10, "at least 10 characters")
  .max(200, "at most 200 characters")
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "must contain a letter and a number");

export const passwordProblem = (value: string): string | null => {
  const r = passwordSchema.safeParse(value);
  return r.success ? null : (r.error.issues[0]?.message ?? "invalid password");
};

/** A cryptographically random, URL-safe opaque token (48 bytes ⇒ 64 chars). */
export const newOpaqueToken = () => randomBytes(48).toString("base64url");
/** A shorter token for 2FA challenges (32 bytes). */
export const newChallengeToken = () => randomBytes(32).toString("base64url");

export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** Constant-time comparison of two hex digests. */
export const sameHash = (a: string, b: string) => {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};

/* ------------------------------------------------------------------ TOTP secret encryption */

let cachedKey: Buffer | null = null;
const encryptionKey = (): Buffer => {
  if (cachedKey) return cachedKey;
  const raw = process.env.TOTP_ENCRYPTION_KEY ?? "";
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else if (raw) {
    try { const b = Buffer.from(raw, "base64"); if (b.length === 32) key = b; } catch { /* handled below */ }
  }
  if (!key) throw new Error("totp_not_configured"); // fail closed, never store a plaintext secret
  cachedKey = key;
  return key;
};

export const isEncryptionConfigured = () => {
  try { encryptionKey(); return true; } catch { return false; }
};

/** AES-256-GCM: `iv.tag.ciphertext`, all base64url. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptSecret(stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("totp_secret_corrupt");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

/* ------------------------------------------------------------------ TOTP verification */

const STEP_SECONDS = 30;
export const totpStep = (at = Date.now()) => Math.floor(at / 1000 / STEP_SECONDS);

// `clone` exists on the otplib authenticator but is missing from its typings.
const totpWithWindow = (window = 1) =>
  (authenticator as unknown as { clone(o: { window: number; step: number }): typeof authenticator })
    .clone({ window, step: STEP_SECONDS });

/**
 * Verifies a 6-digit code with ±1 step of clock drift. Returns the accepted time-step, or null.
 * The caller stores the returned step so the same code cannot be replayed.
 */
export function verifyTotp(code: string, secret: string, at = Date.now()): number | null {
  const cleaned = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return null;
  try {
    const delta = totpWithWindow(1).checkDelta(cleaned, secret);
    return delta === null ? null : totpStep(at) + delta;
  } catch {
    return null;
  }
}

export const otpauthUri = (email: string, secret: string) => authenticator.keyuri(email, "Shop Management", secret);
export const newTotpSecret = () => authenticator.generateSecret();

/* ------------------------------------------------------------------ recovery codes */

// Unambiguous base32 alphabet: no 0/O, 1/I/L.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 2;
const GROUP_LENGTH = 5;

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () =>
    Array.from({ length: CODE_GROUPS }, () =>
      Array.from({ length: GROUP_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(""),
    ).join("-"),
  );
}

/** Canonical form for hashing: uppercase, no separators, no spaces. */
export const normalizeRecoveryCode = (code: string) => code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
export const hashRecoveryCode = (code: string) => hashToken(normalizeRecoveryCode(code));
export const looksLikeRecoveryCode = (code: string) => normalizeRecoveryCode(code).length === CODE_GROUPS * GROUP_LENGTH;
