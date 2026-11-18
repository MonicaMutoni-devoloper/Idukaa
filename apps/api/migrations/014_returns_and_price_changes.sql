-- Sales reversals, product returns and selling-price changes as first-class operations.
--
-- Nothing here deletes or edits a completed sale. A return is its own posted document linked to the
-- sale it reverses, and a selling-price change is its own append-only row. Inventory keeps using the
-- perpetual moving weighted average policy: a return restores stock at the ORIGINAL sale line cost,
-- never at today's average, and a price change never moves inventory or its carrying value.

-- ── Cancellation ────────────────────────────────────────────────────────────────────────────────
-- Goods that have physically left the shop cannot be restocked just because the sale was cancelled.
-- The timestamp records whether that happened; the API lets the owner decide to restock only when
-- the goods are back on the shelf, and always records who approved it.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
-- Idempotency: one cancellation request can be retried (double tap, network retry) without a second
-- reversal. A NULL id (legacy /void calls) is not constrained.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancellation_id uuid;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancellation_approval_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS sales_cancellation_id_uq
  ON sales (cancellation_id) WHERE cancellation_id IS NOT NULL;

-- ── Product returns ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sale_returns (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES shops(id),
  sale_id uuid NOT NULL REFERENCES sales(id),
  -- NULL for an online return (not an offline operation); the return id is its idempotency key.
  op_id uuid UNIQUE REFERENCES operations(op_id),
  user_id uuid NOT NULL REFERENCES users(id),
  returned_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  -- Owner attribution when an exception needed approval (dispatched goods, damaged concession).
  approval_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sale_returns ALTER COLUMN op_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS sale_returns_sale_idx ON sale_returns (shop_id, sale_id, returned_at DESC);
CREATE INDEX IF NOT EXISTS sale_returns_period_idx ON sale_returns (shop_id, returned_at);

CREATE TABLE IF NOT EXISTS sale_return_lines (
  id bigserial PRIMARY KEY,
  return_id uuid NOT NULL REFERENCES sale_returns(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty bigint NOT NULL CHECK (qty > 0),
  -- Exact customer-facing refund for this line, after its proportional share of the sale discount.
  unit_price bigint NOT NULL CHECK (unit_price >= 0),
  refund_amount bigint NOT NULL CHECK (refund_amount >= 0),
  -- The cost the goods originally left at (sale_lines.unit_cost). Never today's purchase cost.
  unit_cost bigint,
  condition text NOT NULL CHECK (condition IN ('resalable', 'damaged', 'expired', 'inspection')),
  -- Only resalable goods re-enter the sellable ledger. Damaged/expired/inspection stay quarantined
  -- in the return document, so the loss is visible without pretending the goods are saleable.
  restocked boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS sale_return_lines_return_idx ON sale_return_lines (return_id, product_id);

-- Hard database guarantee that cumulative returned quantity can never exceed the quantity sold.
-- The API checks this under a row lock too; this trigger is the last line of defence for any writer
-- (including a future migration or manual correction) and for concurrent devices.
CREATE OR REPLACE FUNCTION check_return_qty() RETURNS trigger AS $$
DECLARE
  sold bigint;
  already bigint;
BEGIN
  SELECT COALESCE(SUM(sl.qty), 0) INTO sold
    FROM sale_lines sl
    JOIN sale_returns sr ON sr.sale_id = sl.sale_id
   WHERE sr.id = NEW.return_id AND sl.product_id = NEW.product_id;
  SELECT COALESCE(SUM(l.qty), 0) INTO already
    FROM sale_return_lines l
    JOIN sale_returns sr ON sr.id = l.return_id
   WHERE sr.sale_id = (SELECT sale_id FROM sale_returns WHERE id = NEW.return_id)
     AND l.product_id = NEW.product_id
     AND l.id <> COALESCE(NEW.id, 0);
  IF sold = 0 THEN
    RAISE EXCEPTION 'return_line_not_on_sale' USING ERRCODE = '23514';
  END IF;
  IF already + NEW.qty > sold THEN
    RAISE EXCEPTION 'return_exceeds_sold' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS sale_return_lines_qty_guard ON sale_return_lines;
CREATE TRIGGER sale_return_lines_qty_guard BEFORE INSERT OR UPDATE ON sale_return_lines
  FOR EACH ROW EXECUTE FUNCTION check_return_qty();

-- Returns are financial documents: never edited or deleted, like sales and the stock ledger.
DROP TRIGGER IF EXISTS sale_returns_immutable ON sale_returns;
CREATE TRIGGER sale_returns_immutable BEFORE UPDATE OR DELETE ON sale_returns
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DROP TRIGGER IF EXISTS sale_return_lines_immutable ON sale_return_lines;
CREATE TRIGGER sale_return_lines_immutable BEFORE UPDATE OR DELETE ON sale_return_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Selling-price changes ──────────────────────────────────────────────────────────────────────
-- A price change is neither a purchase nor a stock movement. It has its own ledger so the owner can
-- see every previous price, who changed it, why, and when it became effective.
CREATE TABLE IF NOT EXISTS product_price_changes (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES shops(id),
  product_id uuid NOT NULL REFERENCES products(id),
  op_id uuid UNIQUE REFERENCES operations(op_id),
  old_price bigint NOT NULL CHECK (old_price >= 0),
  new_price bigint NOT NULL CHECK (new_price >= 0),
  effective_at timestamptz NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  approval_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_price_changes_product_idx
  ON product_price_changes (shop_id, product_id, effective_at DESC, created_at DESC);
DROP TRIGGER IF EXISTS product_price_changes_immutable ON product_price_changes;
CREATE TRIGGER product_price_changes_immutable BEFORE UPDATE OR DELETE ON product_price_changes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A scheduled change is held here until it is due. Products.selling_price therefore always means
-- "the price a sale committed now would use"; the future price is visible but not yet effective.
ALTER TABLE products ADD COLUMN IF NOT EXISTS pending_selling_price bigint
  CHECK (pending_selling_price IS NULL OR pending_selling_price >= 0);
ALTER TABLE products ADD COLUMN IF NOT EXISTS pending_price_at timestamptz;

-- Every application path that updates products.selling_price (price workflow, purchase receipt,
-- product edit) writes product_price_changes explicitly, so the actor, reason and approval are not
-- guessed by a trigger. `tests/returns-pricing.integration.test.ts` asserts the ledger is complete.
