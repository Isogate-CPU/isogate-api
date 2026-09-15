import { bigint, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** Public, chain-derived Genesis launch metadata. Never add credentials or
 * creator approval material to this table. */
export const genesisLaunchesTable = pgTable("genesis_launches", {
  id: uuid("id").primaryKey(),
  version: text("version", { enum: ["v1", "v2"] }).notNull().default("v1"),
  chainId: integer("chain_id").notNull(),
  creatorWalletAddress: text("creator_wallet_address").notNull(),
  genesisDigest: text("genesis_digest").notNull(),
  tokenAddress: text("token_address").notNull(),
  feeVaultAddress: text("fee_vault_address").notNull(),
  hookAddress: text("hook_address").notNull(),
  positionLockAddress: text("position_lock_address").notNull(),
  poolId: text("pool_id").notNull(),
  positionTokenId: bigint("position_token_id", { mode: "bigint" }).notNull(),
  tokenName: text("token_name").notNull(),
  symbol: text("symbol").notNull(),
  logoUri: text("logo_uri").notNull(),
  logoCid: text("logo_cid").notNull(),
  deploymentTxHash: text("deployment_tx_hash").notNull(),
  deploymentBlockNumber: bigint("deployment_block_number", { mode: "bigint" }).notNull(),
  deploymentBlockHash: text("deployment_block_hash").notNull(),
  deploymentTimestamp: timestamp("deployment_timestamp", { withTimezone: true }).notNull(),
  launchTxHash: text("launch_tx_hash").notNull(),
  launchBlockNumber: bigint("launch_block_number", { mode: "bigint" }).notNull(),
  launchBlockHash: text("launch_block_hash").notNull(),
  launchTimestamp: timestamp("launch_timestamp", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("genesis_launches_token_uidx").on(table.tokenAddress),
  uniqueIndex("genesis_launches_launch_tx_uidx").on(table.launchTxHash),
  uniqueIndex("genesis_launches_genesis_digest_uidx").on(table.genesisDigest),
  index("genesis_launches_creator_idx").on(table.creatorWalletAddress),
  index("genesis_launches_newest_idx").on(table.launchTimestamp, table.launchTxHash),
]);

export const insertGenesisLaunchSchema = createInsertSchema(genesisLaunchesTable);
export type InsertGenesisLaunch = z.infer<typeof insertGenesisLaunchSchema>;
export type GenesisLaunch = typeof genesisLaunchesTable.$inferSelect;