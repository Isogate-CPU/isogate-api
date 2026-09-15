import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const agentsTable = pgTable("agents", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  credentialHash: text("credential_hash"),
  ownerWalletAddress: text("owner_wallet_address"),
  ownerWalletBoundAt: timestamp("owner_wallet_bound_at", { withTimezone: true }),
  walletChallengeHash: text("wallet_challenge_hash"),
  walletChallengeExpiresAt: timestamp("wallet_challenge_expires_at", { withTimezone: true }),
  status: text("status").notNull().default("active"),
  policy: jsonb("policy").notNull(),
  policyVersion: integer("policy_version").notNull().default(1),
  policyHash: text("policy_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  index("agents_status_idx").on(table.status),
  index("agents_owner_wallet_idx").on(table.ownerWalletAddress),
  index("agents_last_seen_idx").on(table.lastSeenAt),
]);