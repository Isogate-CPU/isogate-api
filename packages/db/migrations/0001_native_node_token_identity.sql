ALTER TABLE "provider_jobs"
  ADD COLUMN IF NOT EXISTS "workload" text NOT NULL DEFAULT 'cpu_replay',
  ADD COLUMN IF NOT EXISTS "creator_wallet_address" text,
  ADD COLUMN IF NOT EXISTS "verification_status" text NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS "creator_approved_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "provider_jobs_creator_wallet_idx"
  ON "provider_jobs" ("creator_wallet_address");

CREATE INDEX IF NOT EXISTS "provider_jobs_verification_status_idx"
  ON "provider_jobs" ("verification_status");

-- Use a new table so any pre-Native-Node recipe records remain preserved for
-- audit but are never read as deployment-eligible identities.
CREATE TABLE IF NOT EXISTS "approved_genesis_recipes_v2" (
  "id" uuid PRIMARY KEY,
  "provider_job_id" uuid NOT NULL REFERENCES "provider_jobs" ("id") ON DELETE RESTRICT,
  "provider_id" uuid NOT NULL REFERENCES "compute_providers" ("id") ON DELETE RESTRICT,
  "wallet_address" text NOT NULL,
  "token_name" text NOT NULL,
  "symbol" text NOT NULL,
  "description" text NOT NULL,
  "seed" jsonb NOT NULL,
  "pixels" jsonb NOT NULL,
  "engine_version" text NOT NULL,
  "cycles" integer NOT NULL,
  "cpu_digest" text NOT NULL,
  "image_digest" text NOT NULL,
  "logo_uri" text NOT NULL,
  "genesis_digest" text NOT NULL,
  "verifier_address" text NOT NULL,
  "verifier_signature" text NOT NULL,
  "approved_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "approved_genesis_recipes_v2_wallet_uidx"
  ON "approved_genesis_recipes_v2" ("wallet_address");
CREATE UNIQUE INDEX IF NOT EXISTS "approved_genesis_recipes_v2_provider_job_uidx"
  ON "approved_genesis_recipes_v2" ("provider_job_id");
CREATE UNIQUE INDEX IF NOT EXISTS "approved_genesis_recipes_v2_cpu_digest_uidx"
  ON "approved_genesis_recipes_v2" ("cpu_digest");
CREATE UNIQUE INDEX IF NOT EXISTS "approved_genesis_recipes_v2_image_digest_uidx"
  ON "approved_genesis_recipes_v2" ("image_digest");
CREATE UNIQUE INDEX IF NOT EXISTS "approved_genesis_recipes_v2_genesis_digest_uidx"
  ON "approved_genesis_recipes_v2" ("genesis_digest");