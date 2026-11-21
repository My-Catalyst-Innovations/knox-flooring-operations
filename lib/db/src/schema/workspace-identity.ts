import { sql } from "drizzle-orm";
import { check, integer, pgTable, text } from "drizzle-orm/pg-core";

export const workspaceIdentityTable = pgTable("catalyst_workspace_identity", {
  id: integer("id").primaryKey().default(1),
  workspaceKey: text("workspace_key").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  check("catalyst_workspace_identity_singleton", sql`${table.id} = 1`),
]);
