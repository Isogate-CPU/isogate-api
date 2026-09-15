CREATE TABLE IF NOT EXISTS "genesis_launches" (
  "id" uuid PRIMARY KEY NOT NULL,
  "chain_id" integer NOT NULL,
  "creator_wallet_address" text NOT NULL,
  "genesis_digest" text NOT NULL,
  "token_address" text NOT NULL,
  "fee_vault_address" text NOT NULL,
  "hook_address" text NOT NULL,
  "position_lock_address" text NOT NULL,
  "pool_id" text NOT NULL,
  "position_token_id" bigint NOT NULL,
  "token_name" text NOT NULL,
  "symbol" text NOT NULL,
  "logo_uri" text NOT NULL,
  "logo_cid" text NOT NULL,
  "deployment_tx_hash" text NOT NULL,
  "deployment_block_number" bigint NOT NULL,
  "deployment_block_hash" text NOT NULL,
  "deployment_timestamp" timestamptz NOT NULL,
  "launch_tx_hash" text NOT NULL,
  "launch_block_number" bigint NOT NULL,
  "launch_block_hash" text NOT NULL,
  "launch_timestamp" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "genesis_launches_token_uidx" ON "genesis_launches" ("token_address");
CREATE UNIQUE INDEX IF NOT EXISTS "genesis_launches_launch_tx_uidx" ON "genesis_launches" ("launch_tx_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "genesis_launches_genesis_digest_uidx" ON "genesis_launches" ("genesis_digest");
CREATE INDEX IF NOT EXISTS "genesis_launches_creator_idx" ON "genesis_launches" ("creator_wallet_address");
CREATE INDEX IF NOT EXISTS "genesis_launches_newest_idx" ON "genesis_launches" ("launch_timestamp", "launch_tx_hash");