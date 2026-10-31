-- 007: refresh-session hygiene.
--
-- Expired refresh rows are kept 30 days for audit and reuse detection, then deleted
-- opportunistically by AuthService.createSession (each new sign-in). This index keeps that
-- DELETE an index range scan as the table grows, instead of a sequential scan per sign-in.
--
-- Safety: additive only. No data is touched here; the purge itself only removes rows that
-- expired more than 30 days ago.
CREATE INDEX IF NOT EXISTS refresh_sessions_expiry_idx ON refresh_sessions (expires_at);
