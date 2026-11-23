CREATE TABLE "outlook_booking_reviews" (
	"booking_id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"kind" text NOT NULL,
	"previous_snapshot" jsonb,
	"remote_snapshot" jsonb,
	"detected_at" text NOT NULL,
	"resolved_at" text,
	"resolved_by" text,
	"resolution" text,
	"note" text,
	CONSTRAINT "outlook_booking_reviews_revision_positive" CHECK ("outlook_booking_reviews"."revision" > 0),
	CONSTRAINT "outlook_booking_reviews_kind_valid" CHECK ("outlook_booking_reviews"."kind" IN ('edited','deleted','unverified')),
	CONSTRAINT "outlook_booking_reviews_resolution_valid" CHECK (("outlook_booking_reviews"."status" = 'pending' AND "outlook_booking_reviews"."resolved_at" IS NULL AND "outlook_booking_reviews"."resolved_by" IS NULL AND "outlook_booking_reviews"."resolution" IS NULL AND "outlook_booking_reviews"."note" IS NULL) OR ("outlook_booking_reviews"."status" = 'resolved' AND "outlook_booking_reviews"."resolved_at" IS NOT NULL AND "outlook_booking_reviews"."resolved_by" IS NOT NULL AND "outlook_booking_reviews"."resolution" IS NOT NULL AND "outlook_booking_reviews"."resolution" IN ('use_outlook','reapply_local') AND "outlook_booking_reviews"."note" IS NOT NULL AND char_length(btrim("outlook_booking_reviews"."note")) BETWEEN 1 AND 500)),
	CONSTRAINT "outlook_booking_reviews_snapshot_valid" CHECK (("outlook_booking_reviews"."kind" = 'deleted' AND "outlook_booking_reviews"."remote_snapshot" IS NULL) OR ("outlook_booking_reviews"."kind" <> 'deleted' AND "outlook_booking_reviews"."remote_snapshot" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "outlook_booking_sync" ADD COLUMN "external_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "outlook_booking_sync" ADD COLUMN "external_checked_at" text;--> statement-breakpoint
ALTER TABLE "outlook_booking_reviews" ADD CONSTRAINT "outlook_booking_reviews_booking_id_crew_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."crew_bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outlook_booking_reviews_status_idx" ON "outlook_booking_reviews" USING btree ("status","detected_at");--> statement-breakpoint
CREATE INDEX "outlook_booking_sync_poll_idx" ON "outlook_booking_sync" USING btree ("account_id","external_checked_at");