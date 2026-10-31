-- Owner-configurable shop policy (enforced by the API, never only by the UI).
ALTER TABLE shops ADD COLUMN manager_financial_access boolean NOT NULL DEFAULT false;
ALTER TABLE shops ADD COLUMN below_cost_policy text NOT NULL DEFAULT 'acknowledge'
  CHECK (below_cost_policy IN ('acknowledge', 'block'));
ALTER TABLE shops ADD COLUMN max_discount_percent integer NOT NULL DEFAULT 100
  CHECK (max_discount_percent BETWEEN 0 AND 100);

-- Payment method is part of the sale record. RWF amounts stay integer minor units.
ALTER TABLE sales ADD COLUMN payment_method text NOT NULL DEFAULT 'cash'
  CHECK (payment_method IN ('cash', 'momo', 'bank', 'credit'));

-- A void is a recorded reversal, never a delete. The status and the reversal stamp move together.
ALTER TABLE sales ADD COLUMN reversed_at timestamptz;
ALTER TABLE sales ADD COLUMN reversed_by uuid REFERENCES users(id);
ALTER TABLE sales ADD COLUMN reversal_reason text;
ALTER TABLE sales ADD CONSTRAINT sales_reversal_stamp
  CHECK ((status = 'reversed') = (reversed_at IS NOT NULL));

ALTER TABLE purchases ADD COLUMN notes text;

CREATE INDEX IF NOT EXISTS sales_period_idx ON sales (shop_id, sold_at);
