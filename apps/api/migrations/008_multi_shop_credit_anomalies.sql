-- 008: multi-shop memberships, per-shop subscriptions, customer credit and explainable alerts.
-- Additive only. Existing shops keep their data and are grandfathered as active; existing users are
-- mirrored into memberships so every current session continues to resolve to the same shop.

-- ---------------------------------------------------------------- multi-shop memberships
CREATE TABLE IF NOT EXISTS shop_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','manager')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, shop_id)
);
CREATE INDEX IF NOT EXISTS shop_memberships_shop_idx ON shop_memberships (shop_id, status);
CREATE INDEX IF NOT EXISTS shop_memberships_user_idx ON shop_memberships (user_id, status);

INSERT INTO shop_memberships(user_id, shop_id, role, status)
SELECT id, shop_id, role, 'active' FROM users
WHERE shop_id IS NOT NULL AND role IN ('owner','manager')
ON CONFLICT (user_id, shop_id) DO NOTHING;

-- Every newly created or moved account gets its membership automatically. Existing code paths keep
-- writing users.shop_id; this trigger makes that row and the membership table impossible to drift.
CREATE OR REPLACE FUNCTION sync_user_shop_membership() RETURNS trigger AS $$
BEGIN
  IF NEW.shop_id IS NOT NULL AND NEW.role IN ('owner','manager') THEN
    INSERT INTO shop_memberships(user_id, shop_id, role, status)
    VALUES (NEW.id, NEW.shop_id, NEW.role, 'active')
    ON CONFLICT (user_id, shop_id) DO UPDATE SET role=EXCLUDED.role, status='active', updated_at=now();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS users_shop_membership ON users;
CREATE TRIGGER users_shop_membership AFTER INSERT OR UPDATE OF shop_id, role ON users
FOR EACH ROW EXECUTE FUNCTION sync_user_shop_membership();

-- ---------------------------------------------------------------- subscriptions
CREATE TABLE IF NOT EXISTS subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  price_rwf bigint NOT NULL CHECK (price_rwf >= 0),
  duration_days integer NOT NULL CHECK (duration_days BETWEEN 1 AND 3660),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO subscription_plans(code, name, price_rwf, duration_days) VALUES
  ('starter', 'Shop Starter', 10000, 30),
  ('standard', 'Shop Standard', 25000, 90),
  ('annual', 'Shop Annual', 90000, 365)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS shop_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  status text NOT NULL CHECK (status IN ('active','pending_payment','verification_required','expired','suspended','cancelled')),
  starts_at timestamptz,
  ends_at timestamptz,
  payment_reference text,
  activated_by uuid REFERENCES users(id),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_subscriptions_shop_idx ON shop_subscriptions (shop_id, created_at DESC);
-- One current subscription per shop. History rows stay intact after expiry/cancellation.
CREATE UNIQUE INDEX IF NOT EXISTS shop_subscriptions_current_idx
  ON shop_subscriptions (shop_id)
  WHERE status IN ('active','pending_payment','verification_required');

-- New shops must have a valid subscription. Existing shops are grandfathered (false).
ALTER TABLE shops ADD COLUMN IF NOT EXISTS subscription_required boolean NOT NULL DEFAULT false;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS credit_limit_policy text NOT NULL DEFAULT 'block'
  CHECK (credit_limit_policy IN ('block','owner_approval','reason_override'));

INSERT INTO shop_subscriptions(shop_id, plan_id, status, starts_at, ends_at)
SELECT s.id, p.id, 'active', s.created_at, NULL
FROM shops s CROSS JOIN subscription_plans p
WHERE p.code='starter'
  AND NOT EXISTS (SELECT 1 FROM shop_subscriptions ss WHERE ss.shop_id=s.id);

-- ---------------------------------------------------------------- customers and credit
CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,
  address text,
  notes text,
  credit_limit bigint NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_shop_phone_idx
  ON customers (shop_id, lower(phone)) WHERE phone IS NOT NULL AND phone <> '';
CREATE INDEX IF NOT EXISTS customers_shop_name_idx ON customers (shop_id, name);

ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS due_at timestamptz;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS credit_amount bigint
  GENERATED ALWAYS AS (gross_amount - discount - amount_paid) STORED;
CREATE INDEX IF NOT EXISTS sales_customer_idx ON sales (shop_id, customer_id, sold_at DESC);

-- Sales can wait for the owner when a credit limit needs an explicit approval. They are excluded
-- from reports until posted, and stock is deducted only on approval.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'sales'::regclass
             AND pg_get_constraintdef(oid) LIKE '%posted%'
             AND pg_get_constraintdef(oid) LIKE '%reversed%'
  LOOP EXECUTE format('ALTER TABLE sales DROP CONSTRAINT %I', c); END LOOP;
  ALTER TABLE sales ADD CONSTRAINT sales_status_check
    CHECK (status IN ('posted','reversed','pending_approval','rejected'));
END $$;

CREATE TABLE IF NOT EXISTS credit_payments (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  op_id uuid NOT NULL UNIQUE REFERENCES operations(op_id),
  user_id uuid NOT NULL REFERENCES users(id),
  amount bigint NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('cash','momo','bank','credit')),
  paid_at timestamptz NOT NULL,
  reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_payments_reference_idx ON credit_payments (shop_id, lower(reference));
CREATE INDEX IF NOT EXISTS credit_payments_customer_idx ON credit_payments (shop_id, customer_id, paid_at DESC);

CREATE TABLE IF NOT EXISTS credit_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  user_id uuid NOT NULL REFERENCES users(id),
  channel text NOT NULL DEFAULT 'manual' CHECK (channel IN ('manual','sms','whatsapp')),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','sent','failed')),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_reminders_customer_idx ON credit_reminders (shop_id, customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS credit_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  user_id uuid NOT NULL REFERENCES users(id),
  amount bigint NOT NULL CHECK (amount <> 0),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- anomalies and investigations
CREATE TABLE IF NOT EXISTS business_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  category text NOT NULL CHECK (category IN ('stock_reduction','discount','margin','adjustments','expense','credit_risk')),
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  title text NOT NULL,
  explanation text NOT NULL,
  entity_type text,
  entity_id text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','legitimate')),
  assigned_to uuid REFERENCES users(id),
  notes text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS business_alerts_shop_idx ON business_alerts (shop_id, status, severity, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS alert_events (
  id bigserial PRIMARY KEY,
  alert_id uuid NOT NULL REFERENCES business_alerts(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  note text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_events_alert_idx ON alert_events (alert_id, id);

-- Rollback is intentionally data-preserving: keep the additive tables and columns. Removing them
-- would delete credit and alert history, so a rollback should only disable the new routes.
