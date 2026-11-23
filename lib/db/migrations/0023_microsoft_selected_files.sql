CREATE TABLE "job_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"object_path" text NOT NULL,
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_key" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "job_documents_size_valid" CHECK ("job_documents"."size" BETWEEN 1 AND 15728640),
	CONSTRAINT "job_documents_hash_valid" CHECK ("job_documents"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "microsoft_file_mirrors" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"object_path" text NOT NULL,
	"target_key" text NOT NULL,
	"name" text NOT NULL,
	"remote_name" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"status" text NOT NULL,
	"item_id" text,
	"web_url" text,
	"lease_until" text,
	"last_error" text,
	"actor_user_id" text NOT NULL,
	"request_key" text NOT NULL,
	"attempt_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "microsoft_file_mirrors_source_valid" CHECK ("microsoft_file_mirrors"."source_type" IN ('document','photo')),
	CONSTRAINT "microsoft_file_mirrors_status_valid" CHECK ("microsoft_file_mirrors"."status" IN ('syncing','synced','unknown','error')),
	CONSTRAINT "microsoft_file_mirrors_size_valid" CHECK ("microsoft_file_mirrors"."size" BETWEEN 1 AND 15728640),
	CONSTRAINT "microsoft_file_mirrors_hash_valid" CHECK ("microsoft_file_mirrors"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "microsoft_file_mirrors_result_valid" CHECK (("microsoft_file_mirrors"."status"='synced' AND "microsoft_file_mirrors"."item_id" IS NOT NULL AND "microsoft_file_mirrors"."lease_until" IS NULL) OR ("microsoft_file_mirrors"."status"<>'synced' AND "microsoft_file_mirrors"."item_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "microsoft_files_connection" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"account_id" text NOT NULL,
	"account_email" text NOT NULL,
	"client_id" text NOT NULL,
	"granted_scopes" text NOT NULL,
	"status" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"expires_at" text,
	"drive_id" text,
	"folder_id" text,
	"folder_name" text,
	"folder_web_url" text,
	"verified_at" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "microsoft_files_connection_singleton" CHECK ("microsoft_files_connection"."id"=1),
	CONSTRAINT "microsoft_files_connection_status_valid" CHECK ("microsoft_files_connection"."status" IN ('connected','disconnected','reconnect_required')),
	CONSTRAINT "microsoft_files_connection_target_valid" CHECK (("microsoft_files_connection"."drive_id" IS NULL AND "microsoft_files_connection"."folder_id" IS NULL AND "microsoft_files_connection"."folder_name" IS NULL AND "microsoft_files_connection"."verified_at" IS NULL) OR ("microsoft_files_connection"."drive_id" IS NOT NULL AND "microsoft_files_connection"."folder_id" IS NOT NULL AND "microsoft_files_connection"."folder_name" IS NOT NULL AND "microsoft_files_connection"."verified_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "microsoft_job_folders" (
	"job_id" text PRIMARY KEY NOT NULL,
	"target_key" text NOT NULL,
	"drive_id" text NOT NULL,
	"parent_id" text NOT NULL,
	"name" text NOT NULL,
	"item_id" text,
	"web_url" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_documents" ADD CONSTRAINT "job_documents_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microsoft_file_mirrors" ADD CONSTRAINT "microsoft_file_mirrors_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microsoft_job_folders" ADD CONSTRAINT "microsoft_job_folders_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_documents_job_idx" ON "job_documents" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_documents_object_unique" ON "job_documents" USING btree ("object_path");--> statement-breakpoint
CREATE UNIQUE INDEX "job_documents_request_unique" ON "job_documents" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "microsoft_file_mirrors_job_idx" ON "microsoft_file_mirrors" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "microsoft_file_mirrors_source_unique" ON "microsoft_file_mirrors" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "microsoft_file_mirrors_request_unique" ON "microsoft_file_mirrors" USING btree ("request_key");