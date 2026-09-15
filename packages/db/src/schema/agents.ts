import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { providerJobsTable } from "./providers";
export { agentsTable } from "./agent-definitions";
import { agentsTable } from "./agent-definitions";

export const agentEventsTable = pgTable("agent_events", {
  id: uuid("id").primaryKey(),
  agentId: uuid("agent_id").notNull().references(() => agentsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  providerJobId: uuid("provider_job_id").references(() => providerJobsTable.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("agent_events_agent_created_idx").on(table.agentId, table.createdAt),
  index("agent_events_provider_job_idx").on(table.providerJobId),
]);

export type Agent = typeof agentsTable.$inferSelect;
export type AgentEvent = typeof agentEventsTable.$inferSelect;