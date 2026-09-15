ALTER TABLE "genesis_launches"
  ADD COLUMN IF NOT EXISTS "version" text NOT NULL DEFAULT 'v1';

ALTER TABLE "genesis_launches"
  DROP CONSTRAINT IF EXISTS "genesis_launches_version_check";

ALTER TABLE "genesis_launches"
  ADD CONSTRAINT "genesis_launches_version_check"
  CHECK ("version" IN ('v1', 'v2'));