import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { crewBookingsTable } from "./operations";

export type OutlookEventSnapshot = { id: string; etag: string; changeKey: string; subject: string; startAt: string; endAt: string; isCancelled: boolean; isAllDay: boolean; type: string };

export const outlookCalendarConnectionTable = pgTable(
  "outlook_calendar_connection",
  {
    id: integer("id").primaryKey().default(1),
    accountId: text("account_id").notNull(),
    accountName: text("account_name").notNull(),
    mailboxEmail: text("mailbox_email"),
    grantedScopes: text("granted_scopes").notNull().default(""),
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
    externalSnapshot: jsonb("external_snapshot").$type<OutlookEventSnapshot>(),
    externalCheckedAt: text("external_checked_at"),
    lastError: text("last_error"),
    retryAt: text("retry_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("outlook_booking_sync_retry_idx").on(table.retryAt), index("outlook_booking_sync_poll_idx").on(table.accountId, table.externalCheckedAt)],
);

export const outlookBookingReviewsTable = pgTable("outlook_booking_reviews", {
  bookingId: text("booking_id").primaryKey().references(() => crewBookingsTable.id, { onDelete: "restrict" }),
  revision: integer("revision").notNull().default(1),
  status: text("status").$type<"pending" | "resolved">().notNull().default("pending"),
  kind: text("kind").$type<"edited" | "deleted" | "unverified">().notNull(),
  previousSnapshot: jsonb("previous_snapshot").$type<OutlookEventSnapshot>(),
  remoteSnapshot: jsonb("remote_snapshot").$type<OutlookEventSnapshot>(),
  detectedAt: text("detected_at").notNull(),
  resolvedAt: text("resolved_at"),
  resolvedBy: text("resolved_by"),
  resolution: text("resolution").$type<"use_outlook" | "reapply_local">(),
  note: text("note"),
}, (table) => [
  index("outlook_booking_reviews_status_idx").on(table.status, table.detectedAt),
  check("outlook_booking_reviews_revision_positive", sql`${table.revision} > 0`),
  check("outlook_booking_reviews_kind_valid", sql`${table.kind} IN ('edited','deleted','unverified')`),
  check("outlook_booking_reviews_resolution_valid", sql`(${table.status} = 'pending' AND ${table.resolvedAt} IS NULL AND ${table.resolvedBy} IS NULL AND ${table.resolution} IS NULL AND ${table.note} IS NULL) OR (${table.status} = 'resolved' AND ${table.resolvedAt} IS NOT NULL AND ${table.resolvedBy} IS NOT NULL AND ${table.resolution} IS NOT NULL AND ${table.resolution} IN ('use_outlook','reapply_local') AND ${table.note} IS NOT NULL AND char_length(btrim(${table.note})) BETWEEN 1 AND 500)`),
  check("outlook_booking_reviews_snapshot_valid", sql`(${table.kind} = 'deleted' AND ${table.remoteSnapshot} IS NULL) OR (${table.kind} <> 'deleted' AND ${table.remoteSnapshot} IS NOT NULL)`),
]);
