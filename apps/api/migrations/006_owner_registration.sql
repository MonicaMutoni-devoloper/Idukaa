-- 006: the "Create a Shop" registration form collects the applicant's password up front, so
-- administrator approval can activate the account (and the proposed shop) immediately instead of
-- waiting for a separate activation step.
--
-- Safety: additive only. NULL means the legacy flow where the password is chosen at activation
-- time from the status page — every existing row keeps its current behaviour.
ALTER TABLE owner_applications ADD COLUMN password_hash text;
