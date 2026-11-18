-- Perpetual weighted average cost: record the cost each sale actually moved at.
--
-- Until now COGS was re-derived from the whole ledger every time a report ran. That is stable only
-- while the ledger never gains a movement that is dated before an existing sale — a backdated
-- delivery, or a return restored at today's average, silently rewrote past profit. The cost is now
-- fixed once, inside the same transaction and product row lock that posts the sale, and every
-- report uses the recorded figure.
--
-- Both columns are nullable on purpose: rows posted before this migration have no recorded cost, and
-- no invented backfill is written for them. The valuation replay derives their cost from posting
-- order; a later purchase cannot change it, because posting order always puts that purchase after
-- the sale it followed. Historical lines stay NULL and are clearly distinguishable from snapshots.
ALTER TABLE sale_lines ADD COLUMN IF NOT EXISTS unit_cost bigint;
COMMENT ON COLUMN sale_lines.unit_cost IS
  'Moving weighted average cost per base unit at the moment this line was posted; never recalculated.';
