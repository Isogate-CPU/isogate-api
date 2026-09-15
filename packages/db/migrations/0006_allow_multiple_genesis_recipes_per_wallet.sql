DROP INDEX IF EXISTS "approved_genesis_recipes_v2_wallet_uidx";

CREATE INDEX IF NOT EXISTS "approved_genesis_recipes_v2_wallet_idx"
  ON "approved_genesis_recipes_v2" ("wallet_address");