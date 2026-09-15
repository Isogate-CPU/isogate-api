import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentsTable } from "./agent-definitions";

export const computeProvidersTable = pgTable("compute_providers", {
  id: uuid("id").primaryKey(),
  // Only the SHA-256 digest of the one-time provider credential is persisted.
  // Null is retained for legacy registrations, which are intentionally unable
  // to perform provider control operations until they re-register.
  credentialHash: text("credential_hash"),
  walletAddress: text("wallet_address"),
  walletBoundAt: timestamp("wallet_bound_at", { withTimezone: true }),
  walletChallengeHash: text("wallet_challenge_hash"),
  walletChallengeExpiresAt: timestamp("wallet_challenge_expires_at", { withTimezone: true }),
  status: text("status").notNull().default("online"),
  reportDigest: text("report_digest").notNull(),
  cpuVendor: text("cpu_vendor").notNull(),
  cpuModel: text("cpu_model").notNull(),
  architecture: text("architecture").notNull(),
  logicalProcessors: integer("logical_processors").notNull(),
  report: jsonb("report").notNull(),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("compute_providers_last_seen_idx").on(table.lastSeenAt),
]);

export const providerJobsTable = pgTable("provider_jobs", {
  id: uuid("id").primaryKey(),
  providerId: uuid("provider_id").notNull().references(() => computeProvidersTable.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
  agentPolicyHash: text("agent_policy_hash"),
  agentPolicyVersion: integer("agent_policy_version"),
  agentOwnerWalletAddress: text("agent_owner_wallet_address"),
  // Versioned built-in workload identifier. Native Nodes must dispatch only
  // workloads they know by this identifier; no executable job payloads are
  // accepted.
  workload: text("workload").notNull().default("cpu_replay"),
  creatorWalletAddress: text("creator_wallet_address"),
  verificationStatus: text("verification_status").notNull().default("queued"),
  creatorApprovedAt: timestamp("creator_approved_at", { withTimezone: true }),
  creatorApprovalNonceHash: text("creator_approval_nonce_hash"),
  creatorApprovalExpiresAt: timestamp("creator_approval_expires_at", { withTimezone: true }),
  status: text("status").notNull().default("queued"),
  inputs: jsonb("inputs").notNull(),
  cycles: integer("cycles").notNull(),
  result: jsonb("result"),
  digest: text("digest"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseTokenHash: text("lease_token_hash"),
  attemptCount: integer("attempt_count").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("provider_jobs_provider_idx").on(table.providerId),
  index("provider_jobs_agent_idx").on(table.agentId),
  index("provider_jobs_creator_wallet_idx").on(table.creatorWalletAddress),
  index("provider_jobs_verification_status_idx").on(table.verificationStatus),
  index("provider_jobs_creator_approval_nonce_idx").on(table.creatorApprovalNonceHash),
  index("provider_jobs_creator_approval_expires_idx").on(table.creatorApprovalExpiresAt),
  index("provider_jobs_lease_idx").on(table.status, table.leaseExpiresAt),
]);
