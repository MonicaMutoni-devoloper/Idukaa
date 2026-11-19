-- Owner-authorised transaction corrections.
--
-- A correction is NOT an edit of a posted sale. It is a separate document that links:
--   original posted sale -> immutable reversal -> separately posted corrected sale.
-- The original sale, its lines, its cost snapshots and its cashier remain untouched.
--
-- Stock policy:
--   * goods not handed over: the reversal restores the original quantities at their original cost,
--     then the corrected sale deducts the corrected quantities exactly once;
--   * goods already handed over: only a price/discount correction is allowed without a physical
--     return, so the reversal/re-post pair nets to zero physical stock. Quantity or product changes
--     are refused until the return/adjustment workflow has handled the goods.
--
-- Money policy: the corrected sale records what was actually collected. A remaining refund is a
-- liability, never an invented cash outflow; a remaining balance is a receivable for a named
-- customer. The correction stays `reconciliation_required` until the owner records a refund.

-- A composite key is the database-level guarantee that a correction can never point at another
-- shop's sale, even if a future writer forgets the application check.
CREATE UNIQUE INDEX IF NOT EXISTS sales_id_shop_uq ON sales (id, shop_id);
CREATE UNIQUE INDEX IF NOT EXISTS business_alerts_id_shop_uq ON business_alerts (id, shop_id);

-- Detection recurrence: the signature is what lets an unchanged finding keep its resolved decision
-- instead of reopening every time the detector runs. Existing rows have NULL until their next run.
ALTER TABLE business_alerts ADD COLUMN IF NOT EXISTS evidence_signature text;
ALTER TABLE business_alerts ADD COLUMN IF NOT EXISTS occurrences integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS sale_corrections (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  sale_id uuid NOT NULL,
  request_op_id uuid UNIQUE REFERENCES operations(op_id),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  evidence text CHECK (evidence IS NULL OR length(evidence) <= 4000),

  -- Frozen evidence of what was true when the request was made. Approval compares the live sale
  -- against this snapshot before any financial effect is posted.
  original_snapshot jsonb NOT NULL,
  original_fingerprint text NOT NULL,
  original_gross bigint NOT NULL CHECK (original_gross >= 0),
  original_discount bigint NOT NULL CHECK (original_discount >= 0),
  original_net bigint NOT NULL CHECK (original_net >= 0),
  original_collected bigint NOT NULL CHECK (original_collected >= 0),

  -- Frozen proposed values. The corrected sale is posted from these values, validated again under
  -- locks; nothing is copied blindly from the client after approval.
  proposed jsonb NOT NULL,
  proposed_gross bigint NOT NULL CHECK (proposed_gross >= 0),
  proposed_discount bigint NOT NULL CHECK (proposed_discount >= 0),
  proposed_net bigint NOT NULL CHECK (proposed_net >= 0),
  proposed_collected bigint NOT NULL CHECK (proposed_collected >= 0),

  fulfillment text NOT NULL CHECK (fulfillment IN ('not_handed_over', 'handed_over')),
  expected_refund bigint NOT NULL DEFAULT 0 CHECK (expected_refund >= 0),
  expected_additional bigint NOT NULL DEFAULT 0 CHECK (expected_additional >= 0),

  status text NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'rejected', 'completed', 'reconciliation_required')),
  owner_id uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,

  reversal_id uuid,
  corrected_sale_id uuid UNIQUE,
  stock_status text NOT NULL DEFAULT 'pending'
    CHECK (stock_status IN ('pending', 'reconciled')),
  money_status text NOT NULL DEFAULT 'pending'
    CHECK (money_status IN ('pending', 'reconciled', 'refund_due', 'balance_due')),

  amount_refunded bigint NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  amount_collected bigint NOT NULL DEFAULT 0 CHECK (amount_collected >= 0),
  settled_by uuid REFERENCES users(id),
  settled_at timestamptz,
  settlement_note text,

  alert_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (original_gross - original_discount = original_net),
  CHECK (proposed_gross - proposed_discount = proposed_net),
  CHECK (status <> 'rejected' OR (owner_id IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status NOT IN ('completed', 'reconciliation_required') OR (owner_id IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT sale_corrections_sale_shop_fk FOREIGN KEY (sale_id, shop_id)
    REFERENCES sales (id, shop_id) ON DELETE RESTRICT,
  CONSTRAINT sale_corrections_alert_shop_fk FOREIGN KEY (alert_id, shop_id)
    REFERENCES business_alerts (id, shop_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS sale_corrections_id_shop_uq ON sale_corrections (id, shop_id);

-- At most one open request and one closed correction per sale. A rejection is not closed: the
-- manager may correct the request and submit again.
CREATE UNIQUE INDEX IF NOT EXISTS sale_corrections_open_sale_uq
  ON sale_corrections (shop_id, sale_id) WHERE status = 'pending_approval';
CREATE UNIQUE INDEX IF NOT EXISTS sale_corrections_closed_sale_uq
  ON sale_corrections (shop_id, sale_id)
  WHERE status IN ('completed', 'reconciliation_required');
CREATE INDEX IF NOT EXISTS sale_corrections_shop_status_idx
  ON sale_corrections (shop_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS sale_corrections_sale_idx
  ON sale_corrections (shop_id, sale_id, requested_at DESC);

-- The financial links are exposed on the sale itself so ordinary sale detail/report queries can
-- show Original -> Reversal -> Corrected without a second join for every row.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS reversal_id uuid;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS correction_id uuid;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS corrects_sale_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS sales_corrects_sale_uq
  ON sales (corrects_sale_id) WHERE corrects_sale_id IS NOT NULL;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_corrects_sale_fk;
ALTER TABLE sales ADD CONSTRAINT sales_corrects_sale_fk
  FOREIGN KEY (corrects_sale_id, shop_id) REFERENCES sales (id, shop_id);
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_correction_fk;
ALTER TABLE sales ADD CONSTRAINT sales_correction_fk
  FOREIGN KEY (correction_id, shop_id) REFERENCES sale_corrections (id, shop_id);
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_correction_not_self;
ALTER TABLE sales ADD CONSTRAINT sales_correction_not_self
  CHECK (corrects_sale_id IS NULL OR corrects_sale_id <> id);

ALTER TABLE sale_corrections DROP CONSTRAINT IF EXISTS sale_corrections_corrected_sale_fk;
ALTER TABLE sale_corrections ADD CONSTRAINT sale_corrections_corrected_sale_fk
  FOREIGN KEY (corrected_sale_id, shop_id) REFERENCES sales (id, shop_id);

-- Timeline. Every approval, refusal, reversal, corrected posting and reconciliation is a row;
-- nothing is overwritten when a later step happens.
CREATE TABLE IF NOT EXISTS sale_correction_events (
  id bigserial PRIMARY KEY,
  correction_id uuid NOT NULL REFERENCES sale_corrections(id) ON DELETE RESTRICT,
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  note text,
  previous_status text,
  new_status text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sale_correction_events_idx
  ON sale_correction_events (correction_id, id);

-- Requests can only move through the implemented lifecycle. The approval transaction writes the
-- final outcome atomically; `reconciliation_required` can later become `completed` after a refund
-- or collection is explicitly recorded.
CREATE OR REPLACE FUNCTION sale_correction_status_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'pending_approval' AND NEW.status IN ('rejected', 'completed', 'reconciliation_required'))
    OR (OLD.status = 'reconciliation_required' AND NEW.status = 'completed')
  ) THEN
    RAISE EXCEPTION 'invalid correction status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  -- The evidence and proposal are the basis the owner reviewed. They may never be rewritten after
  -- the request is created; a different proposal is a new request.
  IF NEW.shop_id <> OLD.shop_id
     OR NEW.sale_id <> OLD.sale_id
     OR NEW.requested_by <> OLD.requested_by
     OR NEW.reason <> OLD.reason
     OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.original_snapshot IS DISTINCT FROM OLD.original_snapshot
     OR NEW.original_fingerprint <> OLD.original_fingerprint
     OR NEW.original_gross <> OLD.original_gross
     OR NEW.original_discount <> OLD.original_discount
     OR NEW.original_net <> OLD.original_net
     OR NEW.original_collected <> OLD.original_collected
     OR NEW.proposed IS DISTINCT FROM OLD.proposed
     OR NEW.proposed_gross <> OLD.proposed_gross
     OR NEW.proposed_discount <> OLD.proposed_discount
     OR NEW.proposed_net <> OLD.proposed_net
     OR NEW.proposed_collected <> OLD.proposed_collected
     OR NEW.fulfillment <> OLD.fulfillment
     OR NEW.alert_id IS DISTINCT FROM OLD.alert_id THEN
    RAISE EXCEPTION 'sale correction evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS sale_corrections_status_guard ON sale_corrections;
CREATE TRIGGER sale_corrections_status_guard BEFORE UPDATE ON sale_corrections
  FOR EACH ROW EXECUTE FUNCTION sale_correction_status_guard();

-- Financial documents are never deleted. sale_corrections is updated in place only for the
-- controlled status fields above; its timeline is append-only.
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'delete on % is not allowed (financial record)', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS sale_corrections_no_delete ON sale_corrections;
CREATE TRIGGER sale_corrections_no_delete BEFORE DELETE ON sale_corrections
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
DROP TRIGGER IF EXISTS sale_correction_events_immutable ON sale_correction_events;
CREATE TRIGGER sale_correction_events_immutable BEFORE UPDATE OR DELETE ON sale_correction_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE sale_corrections IS
  'Owner-authorised correction of a posted sale. Original sale is preserved; approval creates one linked reversal and one linked corrected sale.';
COMMENT ON COLUMN sale_corrections.original_fingerprint IS
  'Stable hash of the original header and lines used to refuse a stale approval.';
COMMENT ON COLUMN sale_corrections.fulfillment IS
  'not_handed_over = reversal restocks and corrected sale deducts; handed_over = price/discount-only correction whose stock effects net to zero.';
COMMENT ON COLUMN sale_corrections.money_status IS
  'reconciled = collected equals corrected net; refund_due = owner must record the actual refund; balance_due = corrected sale has a named customer receivable.';
