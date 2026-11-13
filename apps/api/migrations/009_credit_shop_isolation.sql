-- 009: make cross-shop customer references impossible at the database boundary.
-- The API already scopes every query by shop, but a single missed predicate must not be able to
-- attach Shop A's customer to Shop B's sale, repayment, reminder or adjustment. Customers already
-- have UNIQUE (shop_id, id), so these composite foreign keys are enforceable without new data.
ALTER TABLE sales
  ADD CONSTRAINT sales_customer_shop_fk FOREIGN KEY (shop_id, customer_id)
  REFERENCES customers(shop_id, id);

ALTER TABLE credit_payments
  ADD CONSTRAINT credit_payments_customer_shop_fk FOREIGN KEY (shop_id, customer_id)
  REFERENCES customers(shop_id, id);

ALTER TABLE credit_reminders
  ADD CONSTRAINT credit_reminders_customer_shop_fk FOREIGN KEY (shop_id, customer_id)
  REFERENCES customers(shop_id, id);

ALTER TABLE credit_adjustments
  ADD CONSTRAINT credit_adjustments_customer_shop_fk FOREIGN KEY (shop_id, customer_id)
  REFERENCES customers(shop_id, id);

CREATE INDEX IF NOT EXISTS credit_adjustments_customer_idx
  ON credit_adjustments (shop_id, customer_id, created_at DESC);
