import { index, pgTable, text } from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";

export const jobUpdatesTable = pgTable("job_updates", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "restrict" }),
  authorId: text("author_id").notNull(),
  authorName: text("author_name").notNull(),
  message: text("message").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("job_updates_job_created_idx").on(table.jobId, table.createdAt)]);
