-- Business alerts become an investigation workflow rather than a two-state flag. Everything here is
-- additive: existing alerts keep their row, their status and their events, and `legitimate` is read
-- as `resolved` (the API and the app both normalise it).
ALTER TABLE business_alerts DROP CONSTRAINT IF EXISTS business_alerts_status_check;
ALTER TABLE business_alerts ADD CONSTRAINT business_alerts_status_check
  CHECK (status IN ('open','investigating','action_required','escalated','resolved','legitimate'));

-- Fresh detections also carry the four review levels the interface filters by. The old severity
-- column stays authoritative for older rows and older clients.
ALTER TABLE business_alerts ADD COLUMN IF NOT EXISTS severity_level text;
ALTER TABLE business_alerts ADD COLUMN IF NOT EXISTS resolution_category text;
ALTER TABLE business_alerts ADD COLUMN IF NOT EXISTS resolution_note text;
ALTER TABLE business_alerts ADD COLUMN IF NOT EXISTS corrective_action text;
ALTER TABLE business_alerts ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id);
ALTER TABLE business_alerts ADD COLUMN IF NOT EXISTS escalated_to uuid REFERENCES users(id);
ALTER TABLE business_alerts ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
ALTER TABLE business_alerts ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

UPDATE business_alerts SET severity_level = CASE severity
  WHEN 'critical' THEN 'critical' WHEN 'warning' THEN 'high' ELSE 'medium' END
 WHERE severity_level IS NULL;

-- Safe to re-run: some production databases already carry these objects from an out-of-band
-- application that was never recorded in schema_migrations. A deploy must not stop on them.
ALTER TABLE business_alerts DROP CONSTRAINT IF EXISTS business_alerts_severity_level_check;
ALTER TABLE business_alerts ADD CONSTRAINT business_alerts_severity_level_check
  CHECK (severity_level IS NULL OR severity_level IN ('critical','high','medium','low'));
ALTER TABLE business_alerts DROP CONSTRAINT IF EXISTS business_alerts_resolution_category_check;
ALTER TABLE business_alerts ADD CONSTRAINT business_alerts_resolution_category_check
  CHECK (resolution_category IS NULL OR resolution_category IN ('approved_activity','human_error','suspicious_activity','false_positive','other'));

-- Reversed sales are their own kind of review prompt (a sale was undone); they are not a discount
-- and not a stock adjustment.
ALTER TABLE business_alerts DROP CONSTRAINT IF EXISTS business_alerts_category_check;
ALTER TABLE business_alerts ADD CONSTRAINT business_alerts_category_check
  CHECK (category IN ('stock_reduction','discount','margin','adjustments','expense','credit_risk','reversed_sale','cash'));

CREATE INDEX IF NOT EXISTS business_alerts_shop_level_idx ON business_alerts (shop_id, severity_level, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS business_alerts_shop_category_idx ON business_alerts (shop_id, category, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS business_alerts_assigned_idx ON business_alerts (assigned_to) WHERE assigned_to IS NOT NULL;

-- Every action records the move it made and the decision behind it. `note` is kept for existing
-- readers; `details` carries the resolution category, corrective action, escalation target and the
-- previous values, so reopening an alert can never erase what a previous investigator decided.
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS previous_status text;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS new_status text;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Thresholds are the shop's own, not the developer's: the owner can tune what counts as unusual
-- without a deployment. Missing keys fall back to the documented defaults in the API.
CREATE TABLE IF NOT EXISTS alert_settings (
  shop_id uuid PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  thresholds jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
