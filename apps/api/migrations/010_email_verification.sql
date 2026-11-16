-- Proving an address exists before it is allowed to sign in, and delivering the reset links that
-- until now were only ever written to the log.
--
-- The only reliable proof that an address is real and belongs to the person using it is that they
-- can read mail sent to it: a click on a random, expiring, single-use link. Syntax checks and MX
-- lookups accept dead mailboxes, so they are not used here.

ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

-- Accounts that already exist were created under administrator review and are in daily use. They
-- are recorded as verified at their creation time so this deploy cannot lock a single shop out;
-- every account created from here on starts unverified and must click its link.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

CREATE TABLE email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The address as it stood when the link was issued: changing the address must invalidate the link.
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  requested_ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_verification_user_idx ON email_verification_tokens (user_id, created_at DESC);
CREATE INDEX email_verification_expiry_idx ON email_verification_tokens (expires_at);
