ALTER TABLE "communications" ADD COLUMN "email_provider" text;--> statement-breakpoint
ALTER TABLE "outlook_calendar_connection" ADD COLUMN "mailbox_email" text;--> statement-breakpoint
ALTER TABLE "outlook_calendar_connection" ADD COLUMN "granted_scopes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_email_provider_check" CHECK ("communications"."email_provider" IN ('resend','outlook'));