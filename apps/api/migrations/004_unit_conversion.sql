-- Flexible purchase / base / selling units. Quantities in the ledger and on purchase/sale lines
-- stay in the product's BASE unit (products.unit), so historical stock, sales and valuations are
-- never reinterpreted. NULL unit labels mean "same as the base unit"; factor 1 keeps every
-- existing product behaving exactly as before the feature existed.
ALTER TABLE products
  ADD COLUMN purchase_unit text,
  ADD COLUMN selling_unit text,
  ADD COLUMN units_per_purchase integer NOT NULL DEFAULT 1 CHECK (units_per_purchase > 0),
  ADD COLUMN units_per_selling integer NOT NULL DEFAULT 1 CHECK (units_per_selling > 0);

-- The natural quantity the person actually entered (milli purchase units on purchases, milli
-- selling units on sales), kept alongside the base-unit ledger quantity so transaction history
-- preserves the original units and quantities entered. NULL on rows written before this migration.
ALTER TABLE purchase_lines ADD COLUMN qty_entered bigint;
ALTER TABLE sale_lines ADD COLUMN qty_entered bigint;