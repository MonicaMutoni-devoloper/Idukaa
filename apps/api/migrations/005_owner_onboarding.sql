-- 005: professional onboarding — owner application → administrator approval → owner activation →
-- shop creation → manager invitation → manager activation.
--
-- Safety: additive only. Existing users keep their password, sessions, role and shop; existing shops
-- are untouched (the two new shop columns are NULL). Existing accounts all become/remain
-- account_status='active' (the column default), so login, refresh and 2FA behave exactly as before.

-- ---------------------------------------------------------------- users: explicit account states
-- 'pending_activation': created by an approved application, cannot sign in yet.
-- 'active'            : normal account (the default, so every existing row is already correct).
-- 'suspended'         : revoked by the administrator; cannot sign in or refresh.
ALTER TABLE users ADD COLUMN account_status text NOT NULL DEFAULT 'active'
  CHECK (account_status IN ('pending_activation', 'active', 'suspended'));

-- The old pairing required every non-admin to already own a shop. Onboarding creates the OWNER
-- account at approval time, before the shop exists, so exactly one case becomes legal:
--   * system_admin -> still must have no shop;
--   * manager      -> still must belong to a shop (invitations always carry one);
--   * owner        -> may have no shop until shop creation completes (enforced in the service).
-- The unnamed pairing constraint is dropped by its DEFINITION so the statement works on any
-- database created by 001_init.sql regardless of the auto-generated constraint name. The filter
-- requires `shop_id` as well as `system_admin`, so the separate role whitelist
-- (role IN ('owner','manager','system_admin')) is never touched.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'users'::regclass
             AND pg_get_constraintdef(oid) LIKE '%system_admin%'
             AND pg_get_constraintdef(oid) LIKE '%shop_id%'
  LOOP EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c); END LOOP;
  -- Belt and braces: if a database somehow lost the role whitelist, put it back.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'users_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','manager','system_admin'));
  END IF;
END $$;
ALTER TABLE users ADD CONSTRAINT users_role_shop_check
  CHECK ((role = 'system_admin') = (shop_id IS NULL) OR (role = 'owner' AND shop_id IS NULL));

-- ---------------------------------------------------------------- shops: wizard details
ALTER TABLE shops ADD COLUMN location text;
ALTER TABLE shops ADD COLUMN category text;

-- ---------------------------------------------------------------- owner applications
CREATE TABLE owner_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  shop_name text NOT NULL,
  location text NOT NULL,
  category text NOT NULL,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'PENDING_REVIEW'
    CHECK (status IN ('PENDING_REVIEW', 'ADDITIONAL_INFORMATION_REQUIRED', 'APPROVED', 'REJECTED')),
  info_message text,               -- administrator's request for more information
  decision_reason text,            -- rejection reason, shown to the applicant
  history jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{at, actor, action, message}]
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  user_id uuid REFERENCES users(id),            -- owner account created at approval
  shop_id uuid REFERENCES shops(id),            -- set when the owner completes shop setup
  status_token_hash text NOT NULL UNIQUE,       -- SHA-256 only: lets the applicant check status
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One live application per applicant email: a rejected one frees the address for a new attempt.
CREATE UNIQUE INDEX owner_applications_active_email_idx
  ON owner_applications (lower(email)) WHERE status IN ('PENDING_REVIEW', 'ADDITIONAL_INFORMATION_REQUIRED', 'APPROVED');
CREATE INDEX owner_applications_status_idx ON owner_applications (status, submitted_at);

-- ---------------------------------------------------------------- activation tokens (single use)
CREATE TABLE onboarding_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL CHECK (purpose IN ('owner_activation')),
  application_id uuid NOT NULL REFERENCES owner_applications(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX onboarding_tokens_app_idx ON onboarding_tokens (application_id, created_at DESC);

-- ---------------------------------------------------------------- manager (staff) invitations
CREATE TABLE staff_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id),
  email text NOT NULL,
  full_name text NOT NULL,
  phone text,
  role text NOT NULL DEFAULT 'manager' CHECK (role = 'manager'),  -- an invitation can never grant more
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'active', 'revoked', 'expired')),
  invited_by uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_user_id uuid REFERENCES users(id),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One live invitation per email per shop; revoked/expired rows free the address again.
CREATE UNIQUE INDEX staff_invitations_open_idx
  ON staff_invitations (shop_id, lower(email)) WHERE status IN ('invited', 'active');
CREATE INDEX staff_invitations_shop_idx ON staff_invitations (shop_id, created_at DESC);

-- ---------------------------------------------------------------- rollback notes
-- Safe rollback (no business data lives only in the new structures):
--   DROP TABLE onboarding_tokens, staff_invitations, owner_applications;
--   ALTER TABLE shops DROP COLUMN location, DROP COLUMN category;
--   ALTER TABLE users DROP COLUMN account_status;
--   ALTER TABLE users DROP CONSTRAINT users_role_shop_check;
--   -- then optionally restore the original pairing check from 001_init.sql.
-- Dropping account_status requires a default first (ALTER TABLE users ALTER COLUMN account_status DROP DEFAULT).
