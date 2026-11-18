-- Multiple selling units per product (bottle / crate / carton), each with its own conversion and
-- price. Quantities on sales stay in the product's BASE unit (as every other ledger quantity does),
-- so this table changes pricing and the cashier's entry unit only — never historical stock.
--
-- The single unit a product already had (products.selling_unit / units_per_selling / selling_price)
-- becomes its first row here, with the same factor and price, so every existing product keeps
-- behaving exactly as before the feature existed. Those legacy columns stay authoritative for the
-- DEFAULT unit and are kept in step with it, because reports, below-cost checks and older clients
-- still read them.
CREATE TABLE product_selling_units (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Base units in one of this package (integer, like units_per_selling). 1 means "the base unit".
  qty_base integer NOT NULL CHECK (qty_base > 0),
  -- Price of ONE package, in whole RWF.
  price bigint NOT NULL CHECK (price >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  seq bigserial,
  UNIQUE (product_id, name)
);

CREATE INDEX product_selling_units_product_idx ON product_selling_units(product_id);
CREATE INDEX product_selling_units_shop_idx ON product_selling_units(shop_id);

INSERT INTO product_selling_units (id, shop_id, product_id, name, qty_base, price, sort_order)
SELECT gen_random_uuid(), p.shop_id, p.id, COALESCE(p.selling_unit, p.unit), p.units_per_selling, p.selling_price, 0
  FROM products p;

-- Snapshot of the unit the cashier actually used, written when the sale is posted. sale_lines.qty
-- stays in base units and unit_price stays the price of one entered unit, exactly as before; these
-- two columns keep the receipt readable even if the product's packages are renamed or removed.
ALTER TABLE sale_lines ADD COLUMN unit_name text;
ALTER TABLE sale_lines ADD COLUMN units_per_unit integer CHECK (units_per_unit > 0);
