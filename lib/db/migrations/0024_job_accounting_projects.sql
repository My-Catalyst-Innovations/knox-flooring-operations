CREATE TABLE "job_expenses" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"request_key" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"vendor_name" text NOT NULL,
	"transaction_date" text NOT NULL,
	"due_date" text,
	"currency" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"reference" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"receipt_document_id" text NOT NULL,
	"receipt_sha256" text NOT NULL,
	"related_labor_entry_id" text,
	"actor_user_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "job_expenses_kind_valid" CHECK ("job_expenses"."kind" IN ('paid_purchase','contractor_bill')),
	CONSTRAINT "job_expenses_category_valid" CHECK ("job_expenses"."category" IN ('materials','labor','other')),
	CONSTRAINT "job_expenses_amount_valid" CHECK ("job_expenses"."currency"='USD' AND "job_expenses"."amount_cents">0 AND "job_expenses"."tax_cents" BETWEEN 0 AND "job_expenses"."amount_cents" AND "job_expenses"."revision">0),
	CONSTRAINT "job_expenses_due_valid" CHECK (("job_expenses"."kind"='paid_purchase' AND "job_expenses"."due_date" IS NULL) OR ("job_expenses"."kind"='contractor_bill' AND "job_expenses"."due_date" IS NOT NULL)),
	CONSTRAINT "job_expenses_labor_link_valid" CHECK ("job_expenses"."related_labor_entry_id" IS NULL OR ("job_expenses"."kind"='contractor_bill' AND "job_expenses"."category"='labor')),
	CONSTRAINT "job_expenses_receipt_hash_valid" CHECK ("job_expenses"."receipt_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "quickbooks_job_cost_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"labor_entry_id" text,
	"expense_id" text,
	"job_id" text NOT NULL,
	"queue_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"realm_id" text NOT NULL,
	"environment" text NOT NULL,
	"state" text NOT NULL,
	"source_revision" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"request_id" text NOT NULL,
	"remote_entity" text NOT NULL,
	"remote_id" text,
	"sync_token" text,
	"selection" jsonb NOT NULL,
	"document" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" text NOT NULL,
	"submitted_at" text,
	"confirmed_at" text,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "quickbooks_job_cost_source_valid" CHECK (("quickbooks_job_cost_exports"."source_kind"='labor' AND "quickbooks_job_cost_exports"."labor_entry_id" IS NOT NULL AND "quickbooks_job_cost_exports"."labor_entry_id"="quickbooks_job_cost_exports"."source_id" AND "quickbooks_job_cost_exports"."expense_id" IS NULL) OR ("quickbooks_job_cost_exports"."source_kind"='expense' AND "quickbooks_job_cost_exports"."expense_id" IS NOT NULL AND "quickbooks_job_cost_exports"."expense_id"="quickbooks_job_cost_exports"."source_id" AND "quickbooks_job_cost_exports"."labor_entry_id" IS NULL)),
	CONSTRAINT "quickbooks_job_cost_state_valid" CHECK ("quickbooks_job_cost_exports"."state" IN ('prepared','submitting','unknown','confirmed','rejected','cancelled')),
	CONSTRAINT "quickbooks_job_cost_request_valid" CHECK (length("quickbooks_job_cost_exports"."request_id") BETWEEN 1 AND 50)
);
--> statement-breakpoint
CREATE TABLE "quickbooks_project_links" (
	"job_id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"realm_id" text NOT NULL,
	"environment" text NOT NULL,
	"quickbooks_project_id" text NOT NULL,
	"quickbooks_customer_id" text NOT NULL,
	"project_name" text NOT NULL,
	"project_status" text NOT NULL,
	"fingerprint" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "quickbooks_project_link_version_valid" CHECK ("quickbooks_project_links"."revision">0 AND "quickbooks_project_links"."environment" IN ('sandbox','production'))
);
--> statement-breakpoint
CREATE TABLE "quickbooks_project_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"realm_id" text NOT NULL,
	"environment" text NOT NULL,
	"quickbooks_customer_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"job_revision" integer NOT NULL,
	"job_updated_at" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"fingerprint" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"submitted_at" text,
	"quickbooks_project_id" text,
	"last_error" text,
	"approved_by" text,
	"approved_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "quickbooks_project_review_version_valid" CHECK ("quickbooks_project_reviews"."revision">0 AND "quickbooks_project_reviews"."job_revision">0 AND "quickbooks_project_reviews"."environment" IN ('sandbox','production')),
	CONSTRAINT "quickbooks_project_review_state_valid" CHECK ("quickbooks_project_reviews"."status" IN ('pending_approval','submitting','unknown','linked','failed','cancelled')),
	CONSTRAINT "quickbooks_project_review_submission_valid" CHECK ("quickbooks_project_reviews"."status" NOT IN ('submitting','unknown','linked','failed') OR "quickbooks_project_reviews"."submitted_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "labor_entries" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "labor_entries" ADD COLUMN "cost_reviewed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "labor_entries" ADD COLUMN "single_worker_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "labor_entries" ADD COLUMN "worker_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "labor_entries" ADD COLUMN "service_item_external_id" text;--> statement-breakpoint
ALTER TABLE "quickbooks_connections" ADD COLUMN "granted_scopes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_expenses" ADD CONSTRAINT "job_expenses_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_expenses" ADD CONSTRAINT "job_expenses_receipt_document_id_job_documents_id_fk" FOREIGN KEY ("receipt_document_id") REFERENCES "public"."job_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_expenses" ADD CONSTRAINT "job_expenses_related_labor_entry_id_labor_entries_id_fk" FOREIGN KEY ("related_labor_entry_id") REFERENCES "public"."labor_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quickbooks_job_cost_exports" ADD CONSTRAINT "quickbooks_job_cost_exports_labor_entry_id_labor_entries_id_fk" FOREIGN KEY ("labor_entry_id") REFERENCES "public"."labor_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quickbooks_job_cost_exports" ADD CONSTRAINT "quickbooks_job_cost_exports_expense_id_job_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."job_expenses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quickbooks_job_cost_exports" ADD CONSTRAINT "quickbooks_job_cost_exports_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quickbooks_job_cost_exports" ADD CONSTRAINT "quickbooks_job_cost_exports_queue_id_quickbooks_sync_jobs_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."quickbooks_sync_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quickbooks_project_links" ADD CONSTRAINT "quickbooks_project_links_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quickbooks_project_reviews" ADD CONSTRAINT "quickbooks_project_reviews_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_expenses_job_idx" ON "job_expenses" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_expenses_request_unique" ON "job_expenses" USING btree ("request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "job_expenses_receipt_unique" ON "job_expenses" USING btree ("receipt_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_expenses_receipt_hash_unique" ON "job_expenses" USING btree ("receipt_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "job_expenses_related_labor_unique" ON "job_expenses" USING btree ("related_labor_entry_id");--> statement-breakpoint
CREATE INDEX "quickbooks_job_cost_job_idx" ON "quickbooks_job_cost_exports" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "quickbooks_job_cost_labor_idx" ON "quickbooks_job_cost_exports" USING btree ("labor_entry_id");--> statement-breakpoint
CREATE INDEX "quickbooks_job_cost_expense_idx" ON "quickbooks_job_cost_exports" USING btree ("expense_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quickbooks_job_cost_queue_unique" ON "quickbooks_job_cost_exports" USING btree ("queue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quickbooks_job_cost_request_unique" ON "quickbooks_job_cost_exports" USING btree ("realm_id","environment","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quickbooks_job_cost_source_active_unique" ON "quickbooks_job_cost_exports" USING btree ("source_kind","source_id") WHERE "quickbooks_job_cost_exports"."state" NOT IN ('cancelled','rejected');--> statement-breakpoint
CREATE UNIQUE INDEX "quickbooks_project_remote_unique" ON "quickbooks_project_links" USING btree ("connection_id","quickbooks_project_id");--> statement-breakpoint
CREATE INDEX "quickbooks_project_reviews_job_idx" ON "quickbooks_project_reviews" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quickbooks_project_review_company_unique" ON "quickbooks_project_reviews" USING btree ("job_id","connection_id");