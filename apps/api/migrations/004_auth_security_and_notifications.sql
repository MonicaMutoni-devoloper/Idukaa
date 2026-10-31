-- 004: account security (refresh sessions, password reset, 2FA) and notification preferences.
--
-- Safety: every statement is additive. Existing users keep their password and sessions; no column is
-- dropped or rewritten. `users.token_version` is unchanged. New tables are created empty, so the
-- migration is safe to run on a live database and safe to roll back by dropping the new tables and
-- columns (see the bottom of this file). Nothing here stores a plaintext secret or token:
--   * password reset tokens and refresh tokens are stored as SHA-256 hashes only;
--   * TOTP secrets are stored AES-256-GCM encrypted with TOTP_ENCRYPTION_KEY;
--   * recovery codes are stored as SHA-256 hashes only.

-- ---------------------------------------------------------------- notification preferences (per user)
CREATE TABLE notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  low_stock boolean NOT NULL DEFAULT true,
  out_of_stock boolean NOT NULL DEFAULT true,
  sales_activity boolean NOT NULL DEFAULT true,
  inventory_updates boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Security notifications are deliberately NOT configurable: there is no column to disable them.

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id uuid REFERENCES shops(id),
  category text NOT NULL CHECK (category IN ('security', 'low_stock', 'out_of_stock', 'sales_activity', 'inventory_updates')),
  kind text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- ---------------------------------------------------------------- password reset (single use, hashed)
CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  requested_ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_user_idx ON password_reset_tokens (user_id, created_at DESC);
CREATE INDEX password_reset_expiry_idx ON password_reset_tokens (expires_at);

-- ---------------------------------------------------------------- refresh sessions (rotating, hashed)
CREATE TABLE refresh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,                    -- one login chain; reuse detection revokes the whole family
  token_hash text NOT NULL UNIQUE,
  device_id text,
  user_agent text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  replaced_by uuid REFERENCES refresh_sessions(id)
);
CREATE INDEX refresh_sessions_user_idx ON refresh_sessions (user_id, created_at DESC);
CREATE INDEX refresh_sessions_family_idx ON refresh_sessions (family_id);

-- ---------------------------------------------------------------- TOTP two-factor authentication
ALTER TABLE users ADD COLUMN totp_secret text;          -- encrypted; NULL until 2FA is confirmed
ALTER TABLE users ADD COLUMN totp_pending_secret text;  -- encrypted; only while enrolling
ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN totp_last_step bigint;     -- rejects replay of an accepted time-step

CREATE TABLE totp_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

-- A short-lived challenge issued after a correct password; it does not grant an access token.
CREATE TABLE two_factor_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX two_factor_challenges_user_idx ON two_factor_challenges (user_id, created_at DESC);

-- ---------------------------------------------------------------- rollback notes
-- Safe rollback (no business data is stored in the new tables):
--   DROP TABLE two_factor_challenges, totp_recovery_codes, refresh_sessions, password_reset_tokens,
--              notifications, notification_preferences;
--   ALTER TABLE users DROP COLUMN totp_secret, DROP COLUMN totp_pending_secret,
--                     DROP COLUMN totp_enabled_at, DROP COLUMN totp_last_step;
-- Rolling back signs every device out (no refresh sessions remain) and disables 2FA; users keep
-- their passwords. Take a backup before running the down statements in production.
