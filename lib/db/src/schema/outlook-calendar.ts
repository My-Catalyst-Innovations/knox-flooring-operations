import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { crewBookingsTable } from "./operations";

export const outlookCalendarConnectionTable = pgTable(
  "outlook_calendar_connection",
  {
    id: integer("id").primaryKey().default(1),
    accountId: text("account_id").notNull(),
    accountName: text("account_name").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: text("access_token_expires_at"),
    calendarId: text("calendar_id"),
    calendarName: text("calendar_name"),
    status: text("status").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("outlook_calendar_connection_singleton", sql`${table.id} = 1`),
  ],
);

export const outlookBookingSyncTable = pgTable(
  "outlook_booking_sync",
  {
    bookingId: text("booking_id")
      .primaryKey()
      .references(() => crewBookingsTable.id, { onDelete: "restrict" }),
    accountId: text("account_id").notNull(),
    calendarId: text("calendar_id").notNull(),
    eventId: text("event_id"),
    generation: integer("generation").notNull().default(1),
    syncedRevision: integer("synced_revision").notNull().default(0),
    lastSyncedAt: text("last_synced_at"),
    lastError: text("last_error"),
    retryAt: text("retry_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("outlook_booking_sync_retry_idx").on(table.retryAt)],
);
