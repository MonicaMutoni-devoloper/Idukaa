-- 017: administrative impersonation sessions
-- A system administrator may impersonate any active user or enter any active shop.
-- Sessions are short-lived, server-authorized, and fully auditable.
--
-- Architecture:
--   - admin_user_id: the system administrator performing the impersonation
--   - target_user_id: the user being impersonated (null when entering a shop directly)
--   - target_shop_id: the shop being accessed (null when impersonating a user directly)
--   - reason: explicit, mandatory reason for access
--   - started_at / expires_at: short-lived window
--   - ended_at / revoked_at: session termination tracking
--   - status: active, expired, revoked
--
-- Security:
--   - admin_user_id is validated from the JWT, never client-supplied
--   - target_user_id / target_shop_id are server-validated against active accounts
--   - Every protected request re-validates the impersonation session
--   - Revocation affects only this administrative session; the target's own sessions are untouched
--   - The administrator's own identity is preserved in audit logs
--
-- Audit integration:
--   - Every operation during impersonation records admin_user_id (the administrator)
--   - The audit category distinguishes "impersonated" actions from "own-account" actions
--

-- ============================================================
-- Impersonation sessions table
-- ============================================================
CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_shop_id uuid REFERENCES shops(id) ON DELETE SET NULL,
  reason text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  revoked_at timestamptz,
  status text NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'expired', 'revoked')),

  -- Explicit constraints to prevent contradictory states
  CONSTRAINT chk_one_target CHECK (
    (target_user_id IS NOT NULL AND target_shop_id IS NULL) OR
    (target_user_id IS NULL AND target_shop_id IS NOT NULL)
  ),
  CONSTRAINT chk_status_started CHECK (
    status = 'active' OR ended_at IS NOT NULL OR revoked_at IS NOT NULL
  ),
  CONSTRAINT chk_expires_before_ended CHECK (
    expires_at <= now() + interval '365 days' -- safety limit; actual TTL set by caller
  )
);

-- Indexes for session lookup by admin or by target
CREATE INDEX IF NOT EXISTS impersonation_sessions_admin_idx ON impersonation_sessions(admin_user_id);
CREATE INDEX IF NOT EXISTS impersonation_sessions_target_user_idx ON impersonation_sessions(target_user_id) WHERE target_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS impersonation_sessions_target_shop_idx ON impersonation_sessions(target_shop_id) WHERE target_shop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS impersonation_sessions_status_idx ON impersonation_sessions(status);
CREATE INDEX IF NOT EXISTS impersonation_sessions_expires_idx ON impersonation_sessions(expires_at);

-- ==========================================================--
-- Update admin overview to include impersonation stats
-- ============================================================
-- No structural change needed; the admin overview already shows real counts.
-- Application-level: add impersonation-active count when needed.

-- ============================================================
-- Update audit_log if needed (the existing table already captures actor_id,
-- action, entity, entity_id. Impersonation actions will use the admin's
-- ID as actor_id and record the target in new_value/reason.
-- ============================================================
