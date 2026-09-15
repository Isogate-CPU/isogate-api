import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { computeProvidersTable, providerJobsTable } from "./providers";

export const approvedGenesisRecipesTable = pgTable("approved_genesis_recipes_v2", {
  id: uuid("id").primaryKey(),
  providerJobId: uuid("provider_job_id").notNull().references(() => providerJobsTable.id, { onDelete: "restrict" }),
  providerId: uuid("provider_id").notNull().references(() => computeProvidersTable.id, { onDelete: "restrict" }),
  walletAddress: text("wallet_address").notNull(),
  tokenName: text("token_name").notNull(),
  symbol: text("symbol").notNull(),
  description: text("description").notNull(),
  seed: jsonb("seed").$type<number[]>().notNull(),
  pixels: jsonb("pixels").$type<number[]>().notNull(),
  engineVersion: text("engine_version").notNull(),
  cycles: integer("cycles").notNull(),
  cpuDigest: text("cpu_digest").notNull(),
  imageDigest: text("image_digest").notNull(),
  // Artifact and deployment fields are intentionally absent until their
  // respective, independently authenticated stages complete.
  logoUri: text("logo_uri"),
  // Legacy column retained nullable for additive development migrations. It
  // is not part of the approval/API flow and is never populated.
  genesisDigest: text("genesis_digest"),
  verifierAddress: text("verifier_address"),
  verifierSignature: text("verifier_signature"),
  deploymentProofJson: jsonb("deployment_proof_json").$type<Record<string, unknown> | null>(),
  deploymentConfigJson: jsonb("deployment_config_json").$type<Record<string, unknown> | null>(),
  deploymentDigest: text("deployment_digest"),
  deploymentSignature: text("deployment_signature"),
  deploymentStatus: text("deployment_status", {
    enum: ["none", "issued", "expired", "reconciled", "failed"],
  }).notNull().default("none"),
  deploymentIssuedAt: timestamp("deployment_issued_at", { withTimezone: true }),
  deploymentExpiry: timestamp("deployment_expiry", { withTimezone: true }),
  ipfsCid: text("ipfs_cid"),
  pngDigest: text("png_digest").notNull(),
  uploadStatus: text("upload_status", {
    enum: ["pending", "uploading", "uploaded", "failed"],
  }).notNull().default("pending"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
  uploadStartedAt: timestamp("upload_started_at", { withTimezone: true }),
  uploadError: text("upload_error"),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("approved_genesis_recipes_v2_wallet_idx").on(table.walletAddress),
  uniqueIndex("approved_genesis_recipes_v2_provider_job_uidx").on(table.providerJobId),
  uniqueIndex("approved_genesis_recipes_v2_cpu_digest_uidx").on(table.cpuDigest),
  uniqueIndex("approved_genesis_recipes_v2_image_digest_uidx").on(table.imageDigest),
  uniqueIndex("approved_genesis_recipes_v2_ipfs_cid_uidx").on(table.ipfsCid),
  index("approved_genesis_recipes_v2_upload_status_idx").on(table.uploadStatus),
]);

export const insertApprovedGenesisRecipeSchema = createInsertSchema(approvedGenesisRecipesTable)
  .omit({ approvedAt: true });
export type InsertApprovedGenesisRecipe = z.infer<typeof insertApprovedGenesisRecipeSchema>;
export type ApprovedGenesisRecipe = typeof approvedGenesisRecipesTable.$inferSelect;