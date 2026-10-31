-- 005: reporting indexes for the financial/period queries. ADDITIVE ONLY: every statement is
-- CREATE INDEX IF NOT EXISTS; no column, constraint or row is touched, so it is safe on a live
-- database and safe to roll back by dropping the named indexes.
--
-- Period reports filter by (shop_id, range) over sales, expenses, purchases, adjustments and
-- movements; drill-downs join sale_lines by sale and product. 001 only indexed stock_movements
-- by (shop_id, product_id, occurred_at).

CREATE INDEX IF NOT EXISTS sales_shop_sold_idx          ON sales (shop_id, sold_at);
CREATE INDEX IF NOT EXISTS sales_shop_status_sold_idx   ON sales (shop_id, status, sold_at);
CREATE INDEX IF NOT EXISTS sale_lines_sale_idx          ON sale_lines (sale_id);
CREATE INDEX IF NOT EXISTS sale_lines_product_idx       ON sale_lines (product_id);
CREATE INDEX IF NOT EXISTS expenses_shop_incurred_idx   ON expenses (shop_id, incurred_at);
CREATE INDEX IF NOT EXISTS purchases_shop_ordered_idx   ON purchases (shop_id, ordered_at);
CREATE INDEX IF NOT EXISTS adjustments_shop_decided_idx ON adjustments (shop_id, decided_at);
CREATE INDEX IF NOT EXISTS adjustments_shop_status_idx  ON adjustments (shop_id, status);
CREATE INDEX IF NOT EXISTS stock_movements_shop_occurred_idx ON stock_movements (shop_id, occurred_at);
