-- 019: mark security-sensitive operations in the immutable audit trail.
-- Sensitive actions (credential/security changes, shop policy changes, suspension, data export,
-- and every impersonation session lifecycle event) can then be filtered separately from routine
-- trading activity without reading free-form JSON.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS audit_log_sensitive_idx ON audit_log (sensitive, id DESC) WHERE sensitive = true;
