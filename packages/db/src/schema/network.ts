import { createInsertSchema } from "drizzle-zod";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { providerJobsTable } from "./providers";

export const verificationEventsTable = pgTable("verification_events", {
  id: uuid("id").primaryKey(),
  jobId: uuid("job_id").notNull().references(() => providerJobsTable.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  digest: text("digest").notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("verification_events_job_idx").on(table.jobId),
  index("verification_events_checked_at_idx").on(table.checkedAt),
]);

export const disputesTable = pgTable("disputes", {
  id: uuid("id").primaryKey(),
  jobId: uuid("job_id").notNull().references(() => providerJobsTable.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  status: text("status").notNull(),
  digest: text("digest"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("disputes_job_idx").on(table.jobId),
  index("disputes_created_at_idx").on(table.createdAt),
]);

export const insertVerificationEventSchema = createInsertSchema(verificationEventsTable);
export const insertDisputeSchema = createInsertSchema(disputesTable);
export type InsertVerificationEvent = z.infer<typeof insertVerificationEventSchema>;
export type VerificationEvent = typeof verificationEventsTable.$inferSelect;
export type InsertDispute = z.infer<typeof insertDisputeSchema>;
export type Dispute = typeof disputesTable.$inferSelect;