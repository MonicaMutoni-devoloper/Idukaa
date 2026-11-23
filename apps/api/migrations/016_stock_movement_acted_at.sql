-- Keep the business/stock date separate from the moment the person actually did the work.
--
-- `occurred_at` is the document date: a receive form only asks for a day, so it is stored at noon
-- and reports include the movement in that business day. Printing that noon value as the action
-- time made every delivery look as if it happened at 12:00.
--
-- `acted_at` is the precise time the operation was saved on the device (the sync operation's
-- client timestamp) or the server action time. It is nullable because rows posted before this
-- migration have no exact value; the movement report falls back to `recorded_at` for those.
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS acted_at timestamptz;
COMMENT ON COLUMN stock_movements.acted_at IS
  'When the person actually performed the movement; occurred_at remains the business/document date.';
