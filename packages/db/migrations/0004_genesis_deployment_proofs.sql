-- Server-only, short-lived deployment attestations.  The structured JSON
-- columns preserve the exact typed-data payload and checked configuration for
-- later receipt reconciliation; the scalar columns make expiry/status queries
-- indexable without trusting client input.
ALTER TABLE "approved_genesis_recipes_v2"
  ADD COLUMN IF NOT EXISTS "deployment_proof_json" jsonb,
  ADD COLUMN IF NOT EXISTS "deployment_config_json" jsonb,
  ADD COLUMN IF NOT EXISTS "deployment_digest" text,
  ADD COLUMN IF NOT EXISTS "deployment_signature" text,
  ADD COLUMN IF NOT EXISTS "deployment_status" text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "deployment_issued_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "deployment_expiry" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "approved_genesis_recipes_v2_deployment_status_idx"
  ON "approved_genesis_recipes_v2" ("deployment_status");
CREATE INDEX IF NOT EXISTS "approved_genesis_recipes_v2_deployment_expiry_idx"
  ON "approved_genesis_recipes_v2" ("deployment_expiry");