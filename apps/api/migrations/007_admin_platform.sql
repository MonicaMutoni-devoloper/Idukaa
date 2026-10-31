-- 006: platform administration — shop lifecycle status for the admin console.
--
-- The administrator can suspend a shop (owner fraud review, non-payment, requested closure) without
-- touching a single sales, purchase, expense, inventory or audit row: `status` is metadata about
-- the shop, never a delete, and every change is recorded in audit_log with a reason.
--
-- Safety: additive only. Every existing row reads status='active' (the column default), so nothing
-- changes for live shops until an administrator explicitly suspends one.

ALTER TABLE shops ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'suspended'));
ALTER TABLE shops ADD COLUMN suspended_at timestamptz;
ALTER TABLE shops ADD COLUMN suspended_reason text;

-- The admin security/audit screen filters platform actions (auth.*, admin.*, shop.*) newest first.
CREATE INDEX audit_log_action_idx ON audit_log (action, id DESC);
