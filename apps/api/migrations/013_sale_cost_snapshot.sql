-- Perpetual weighted average cost: record the cost each sale actually moved at.
--
-- Until now COGS was re-derived from the whole ledger every time a report ran. That is stable only
-- while the ledger never gains a movement that is dated before an existing sale — a backdated
-- delivery, or a return restored at today's average, silently rewrote past profit. The cost is now
-- fixed once, inside the same transaction and product row lock that posts the sale, and every
-- report uses the recorded figure.
--
-- Both columns are nullable on purpose: rows posted before this migration have no recorded cost, and
-- the valuation replay falls back to the running average for them, so historical reports do not jump.
ALTER TABLE sale_lines ADD COLUMN IF NOT EXISTS unit_cost bigint;
COMMENT ON COLUMN sale_lines.unit_cost IS
  'Moving weighted average cost per base unit at the moment this line was posted; never recalculated.';
