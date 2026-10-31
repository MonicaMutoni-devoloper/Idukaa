-- Purchase metadata captured at stock entry. Quantities in the ledger stay in sellable milli-units;
-- purchase unit/conversion are descriptive so the same receipt can be read in boxes or pieces.
ALTER TABLE purchases ADD COLUMN reference text;
ALTER TABLE purchase_lines ADD COLUMN selling_price bigint;
ALTER TABLE purchase_lines ADD COLUMN purchase_unit text;
ALTER TABLE purchase_lines ADD COLUMN unit_factor bigint CHECK (unit_factor IS NULL OR unit_factor > 0);
