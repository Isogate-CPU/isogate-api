import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { providerJobsTable } from "./providers";

/**
 * Each challenge is an independent capability. Keeping it separate from the
 * job prevents a newer challenge from invalidating an older valid signature.
 */
export const genesisApprovalChallengesTable = pgTable("genesis_approval_challenges", {
  id: uuid("id").primaryKey(),
  providerJobId: uuid("provider_job_id").notNull().references(() => providerJobsTable.id, { onDelete: "cascade" }),
  creatorWalletAddress: text("creator_wallet_address").notNull(),
  nonceHash: text("nonce_hash").notNull(),
  messageDigest: text("message_digest").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("genesis_approval_challenges_nonce_uidx").on(table.nonceHash),
  index("genesis_approval_challenges_job_idx").on(table.providerJobId),
  index("genesis_approval_challenges_active_idx").on(table.providerJobId, table.expiresAt, table.consumedAt),
]);

export type GenesisApprovalChallenge = typeof genesisApprovalChallengesTable.$inferSelect;