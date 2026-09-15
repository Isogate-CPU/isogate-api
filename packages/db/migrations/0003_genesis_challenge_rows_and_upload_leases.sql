-- Independent creator approval capabilities and crash-recoverable artifact
-- upload leases. This migration is additive; legacy provider nonce columns
-- remain for compatibility but are no longer used by the API.
CREATE TABLE IF NOT EXISTS "genesis_approval_challenges" (
  "id" uuid PRIMARY KEY,
  "provider_job_id" uuid NOT NULL REFERENCES "provider_jobs" ("id") ON DELETE CASCADE,
  "creator_wallet_address" text NOT NULL,
  "nonce_hash" text NOT NULL,
  "message_digest" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "genesis_approval_challenges_nonce_uidx"
  ON "genesis_approval_challenges" ("nonce_hash");
CREATE INDEX IF NOT EXISTS "genesis_approval_challenges_job_idx"
  ON "genesis_approval_challenges" ("provider_job_id");
CREATE INDEX IF NOT EXISTS "genesis_approval_challenges_active_idx"
  ON "genesis_approval_challenges" ("provider_job_id", "expires_at", "consumed_at");

ALTER TABLE "approved_genesis_recipes_v2"
  ADD COLUMN IF NOT EXISTS "upload_started_at" timestamp with time zone;