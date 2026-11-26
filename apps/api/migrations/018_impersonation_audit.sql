-- 018: attributability for impersonated actions.
-- audit_log already records actor_id. These columns make it explicit and queryable when the actor
-- was a system administrator operating inside another user's account or shop.
--
--   impersonated            true when the action happened during an administrative access session
--   impersonation_session_id the impersonation session that authorized it
--   on_behalf_of_user_id    the target user whose account was being managed (NULL for shop access)
--
-- Additive only. Existing rows read as ordinary actions (impersonated=false).

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS impersonated boolean NOT NULL DEFAULT false;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS impersonation_session_id uuid REFERENCES impersonation_sessions(id) ON DELETE SET NULL;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS on_behalf_of_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS audit_log_impersonation_session_idx ON audit_log (impersonation_session_id, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_on_behalf_idx ON audit_log (on_behalf_of_user_id, id DESC);
