-- Additive production migration for creator approval challenges and the
-- independently retryable Genesis artifact upload stage.
ALTER TABLE "provider_jobs"
  ADD COLUMN IF NOT EXISTS "creator_approved_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "creator_approval_nonce_hash" text,
  ADD COLUMN IF NOT EXISTS "creator_approval_expires_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "provider_jobs_creator_approval_nonce_idx"
  ON "provider_jobs" ("creator_approval_nonce_hash");
CREATE INDEX IF NOT EXISTS "provider_jobs_creator_approval_expires_idx"
  ON "provider_jobs" ("creator_approval_expires_at");

ALTER TABLE "approved_genesis_recipes_v2"
  ADD COLUMN IF NOT EXISTS "logo_uri" text,
  ADD COLUMN IF NOT EXISTS "genesis_digest" text,
  ADD COLUMN IF NOT EXISTS "verifier_address" text,
  ADD COLUMN IF NOT EXISTS "verifier_signature" text,
  ADD COLUMN IF NOT EXISTS "ipfs_cid" text,
  ADD COLUMN IF NOT EXISTS "png_digest" text,
  ADD COLUMN IF NOT EXISTS "upload_status" text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "uploaded_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "upload_error" text;

ALTER TABLE "approved_genesis_recipes_v2"
  ALTER COLUMN "logo_uri" DROP NOT NULL,
  ALTER COLUMN "genesis_digest" DROP NOT NULL,
  ALTER COLUMN "verifier_address" DROP NOT NULL,
  ALTER COLUMN "verifier_signature" DROP NOT NULL,
  ALTER COLUMN "upload_status" SET DEFAULT 'pending',
  ALTER COLUMN "upload_status" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'approved_genesis_recipes_v2_upload_status_check'
  ) THEN
    ALTER TABLE "approved_genesis_recipes_v2"
      ADD CONSTRAINT "approved_genesis_recipes_v2_upload_status_check"
      CHECK ("upload_status" IN ('pending', 'uploading', 'uploaded', 'failed'));
  END IF;
END $$;

-- A pre-existing legacy recipe cannot be assigned an authentic PNG digest
-- from SQL. Fail closed instead of inventing a placeholder; operators must
-- re-derive and backfill those rows before publishing this constraint.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "approved_genesis_recipes_v2"
    WHERE "png_digest" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot enforce approved_genesis_recipes_v2.png_digest NOT NULL while legacy rows lack canonical digests';
  END IF;
  ALTER TABLE "approved_genesis_recipes_v2"
    ALTER COLUMN "png_digest" SET NOT NULL;
END $$;

DROP INDEX IF EXISTS "approved_genesis_recipes_v2_genesis_digest_uidx";
CREATE UNIQUE INDEX IF NOT EXISTS "approved_genesis_recipes_v2_ipfs_cid_uidx"
  ON "approved_genesis_recipes_v2" ("ipfs_cid")
  WHERE "ipfs_cid" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "approved_genesis_recipes_v2_upload_status_idx"
  ON "approved_genesis_recipes_v2" ("upload_status");