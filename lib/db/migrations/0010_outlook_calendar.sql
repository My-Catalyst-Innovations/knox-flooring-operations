CREATE TABLE "outlook_calendar_connection" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "account_id" text NOT NULL,
  "account_name" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "access_token_expires_at" text,
  "calendar_id" text,
  "calendar_name" text,
  "status" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "outlook_calendar_connection_singleton" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "outlook_booking_sync" (
  "booking_id" text PRIMARY KEY,
  "account_id" text NOT NULL,
  "calendar_id" text NOT NULL,
  "event_id" text,
  "generation" integer DEFAULT 1 NOT NULL,
  "synced_revision" integer DEFAULT 0 NOT NULL,
  "last_synced_at" text,
  "last_error" text,
  "retry_at" text,
  "updated_at" text NOT NULL,
  CONSTRAINT "outlook_booking_sync_booking_id_crew_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "crew_bookings" ("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "outlook_booking_sync_retry_idx" ON "outlook_booking_sync" USING btree ("retry_at");
