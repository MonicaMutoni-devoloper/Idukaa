-- Shop Management System: initial schema. Money = BIGINT RWF. Quantities = BIGINT milli-units.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE shops (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, currency char(3) NOT NULL DEFAULT 'RWF', created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid REFERENCES shops(id),            -- NULL only for system_admin
  email text NOT NULL UNIQUE, full_name text NOT NULL, password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','manager','system_admin')),
  active boolean NOT NULL DEFAULT true, token_version int NOT NULL DEFAULT 0, -- bump to revoke sessions / lost devices
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'system_admin') = (shop_id IS NULL))
);

CREATE TABLE products (
  id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES shops(id), code text NOT NULL, barcode text, name text NOT NULL,
  category text, unit text NOT NULL, selling_price bigint NOT NULL CHECK (selling_price >= 0),
  low_stock_threshold bigint NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(), seq bigserial,
  UNIQUE (shop_id, code)
);
CREATE TABLE suppliers (id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES shops(id), name text NOT NULL, phone text, updated_at timestamptz NOT NULL DEFAULT now(), seq bigserial);

-- Idempotency + sync status: one row per client operation. PK makes duplicates impossible.
CREATE TABLE operations (
  op_id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES shops(id), user_id uuid NOT NULL REFERENCES users(id),
  device_id text NOT NULL, type text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('applied','conflict','rejected','pending_approval')),
  message text, client_created_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES users(id), resolved_at timestamptz, resolution text
);

CREATE TABLE sales (id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES shops(id), op_id uuid NOT NULL UNIQUE REFERENCES operations(op_id), user_id uuid NOT NULL REFERENCES users(id),
  sold_at timestamptz NOT NULL, gross_amount bigint NOT NULL, discount bigint NOT NULL DEFAULT 0, amount_paid bigint NOT NULL, status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')), seq bigserial);
CREATE TABLE sale_lines (id bigserial PRIMARY KEY, sale_id uuid NOT NULL REFERENCES sales(id), product_id uuid NOT NULL REFERENCES products(id), qty bigint NOT NULL CHECK (qty > 0), unit_price bigint NOT NULL, line_amount bigint NOT NULL);

CREATE TABLE purchases (id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES shops(id), op_id uuid NOT NULL UNIQUE REFERENCES operations(op_id), user_id uuid NOT NULL REFERENCES users(id),
  supplier_id uuid REFERENCES suppliers(id), ordered_at timestamptz NOT NULL, total_amount bigint NOT NULL, amount_paid bigint NOT NULL, seq bigserial);
CREATE TABLE purchase_lines (id bigserial PRIMARY KEY, purchase_id uuid NOT NULL REFERENCES purchases(id), product_id uuid NOT NULL REFERENCES products(id), qty_ordered bigint NOT NULL CHECK (qty_ordered > 0), qty_received bigint NOT NULL DEFAULT 0, unit_cost bigint NOT NULL, CHECK (qty_received <= qty_ordered));
CREATE TABLE goods_receipts (id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES shops(id), purchase_id uuid NOT NULL REFERENCES purchases(id), op_id uuid NOT NULL UNIQUE REFERENCES operations(op_id), user_id uuid NOT NULL REFERENCES users(id), received_at timestamptz NOT NULL, seq bigserial);

CREATE TABLE expenses (id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES shops(id), op_id uuid NOT NULL UNIQUE REFERENCES operations(op_id), user_id uuid NOT NULL REFERENCES users(id),
  category text NOT NULL, amount bigint NOT NULL CHECK (amount > 0), paid boolean NOT NULL, incurred_at timestamptz NOT NULL, note text, seq bigserial);

-- Stock movement ledger: append-only source of truth. Quantity on hand is DERIVED.
CREATE TABLE stock_movements (
  id bigserial PRIMARY KEY, shop_id uuid NOT NULL REFERENCES shops(id), product_id uuid NOT NULL REFERENCES products(id),
  type text NOT NULL CHECK (type IN ('opening','receipt','sale','sale_return','supplier_return','damage','expiry','adjustment','count_correction','transfer_in','transfer_out')),
  qty bigint NOT NULL CHECK (qty <> 0), unit_cost bigint, source_type text NOT NULL, source_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id), reason text, occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), seq bigserial
);
CREATE INDEX stock_movements_product_idx ON stock_movements (shop_id, product_id, occurred_at);
CREATE INDEX stock_movements_source_idx ON stock_movements (source_type, source_id);

CREATE TABLE stock_counts (id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES shops(id), op_id uuid NOT NULL UNIQUE REFERENCES operations(op_id), user_id uuid NOT NULL REFERENCES users(id), counted_at timestamptz NOT NULL);
CREATE TABLE stock_count_lines (id bigserial PRIMARY KEY, count_id uuid NOT NULL REFERENCES stock_counts(id), product_id uuid NOT NULL REFERENCES products(id), expected bigint NOT NULL, counted bigint NOT NULL, difference bigint NOT NULL);

CREATE TABLE adjustments (id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES shops(id), op_id uuid NOT NULL UNIQUE REFERENCES operations(op_id), product_id uuid NOT NULL REFERENCES products(id), qty bigint NOT NULL,
  reason text NOT NULL, note text NOT NULL, refund_amount bigint, requested_by uuid NOT NULL REFERENCES users(id), status text NOT NULL CHECK (status IN ('pending','approved','rejected')), decided_by uuid REFERENCES users(id), decided_at timestamptz, decision_note text);

CREATE TABLE investigations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text NOT NULL UNIQUE, shop_id uuid NOT NULL REFERENCES shops(id),
  count_id uuid REFERENCES stock_counts(id), product_id uuid NOT NULL REFERENCES products(id), difference bigint NOT NULL,
  assigned_to uuid REFERENCES users(id), notes text NOT NULL DEFAULT '', corrective_action text, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','closed')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE investigation_ref_seq;

-- Append-only audit trail. Triggers block UPDATE/DELETE for everyone (incl. app role).
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY, shop_id uuid REFERENCES shops(id), actor_id uuid REFERENCES users(id), action text NOT NULL,
  entity text NOT NULL, entity_id text, old_value jsonb, new_value jsonb, reason text, approval_ref text, at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE VIEW stock_on_hand AS SELECT shop_id, product_id, SUM(qty)::bigint AS qty FROM stock_movements GROUP BY shop_id, product_id;
