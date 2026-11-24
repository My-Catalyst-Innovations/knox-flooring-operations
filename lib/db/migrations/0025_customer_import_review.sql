CREATE TABLE "customer_import_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"decisions" jsonb NOT NULL,
	"review_note" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" text NOT NULL,
	CONSTRAINT "customer_import_approval_batch_unique" UNIQUE("id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "customer_import_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_key" text NOT NULL,
	"source_system" text NOT NULL,
	"batch_key" text NOT NULL,
	"file_name" text NOT NULL,
	"source_sha256" text NOT NULL,
	"headers" jsonb NOT NULL,
	"mapping" jsonb NOT NULL,
	"rows" jsonb NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"review_fingerprint" text,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_note" text,
	"current_approval_id" text,
	"result" jsonb,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"committed_at" text,
	CONSTRAINT "customer_import_batch_scope_unique" UNIQUE("id","workspace_key","source_system"),
	CONSTRAINT "customer_import_batch_status_check" CHECK ("customer_import_batches"."status" IN ('preview','reviewed','approved','committed')),
	CONSTRAINT "customer_import_batch_revision_check" CHECK ("customer_import_batches"."revision" > 0),
	CONSTRAINT "customer_import_batch_hash_check" CHECK ("customer_import_batches"."source_sha256" ~ '^[a-f0-9]{64}$' AND "customer_import_batches"."preview_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "customer_import_batch_rows_check" CHECK (jsonb_typeof("customer_import_batches"."rows")='array' AND jsonb_array_length("customer_import_batches"."rows") BETWEEN 1 AND 200),
	CONSTRAINT "customer_import_batch_approval_check" CHECK ("customer_import_batches"."status" NOT IN ('approved','committed') OR "customer_import_batches"."current_approval_id" IS NOT NULL),
	CONSTRAINT "customer_import_batch_committed_check" CHECK (("customer_import_batches"."status"='committed') = ("customer_import_batches"."committed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "customer_import_records" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_key" text NOT NULL,
	"source_system" text NOT NULL,
	"source_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"source_line" integer NOT NULL,
	"customer_id" text NOT NULL,
	"site_id" text,
	"action" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "customer_import_record_action_check" CHECK ("customer_import_records"."action" IN ('create','link') AND "customer_import_records"."source_line" > 0 AND length("customer_import_records"."source_id") BETWEEN 1 AND 160)
);
--> statement-breakpoint
ALTER TABLE "customer_import_approvals" ADD CONSTRAINT "customer_import_approval_batch_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."customer_import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_import_records" ADD CONSTRAINT "customer_import_records_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_import_records" ADD CONSTRAINT "customer_import_records_site_id_customer_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."customer_sites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_import_records" ADD CONSTRAINT "customer_import_record_batch_scope_fk" FOREIGN KEY ("batch_id","workspace_key","source_system") REFERENCES "public"."customer_import_batches"("id","workspace_key","source_system") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_import_records" ADD CONSTRAINT "customer_import_record_approval_batch_fk" FOREIGN KEY ("approval_id","batch_id") REFERENCES "public"."customer_import_approvals"("id","batch_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_import_approval_fingerprint_unique" ON "customer_import_approvals" USING btree ("batch_id","fingerprint");--> statement-breakpoint
-- Company isolation is the selected database, so changing its hostname cannot
-- hide previous source identities or make the same customer importable again.
CREATE UNIQUE INDEX "customer_import_batch_identity_unique" ON "customer_import_batches" USING btree ("source_system","batch_key");--> statement-breakpoint
CREATE INDEX "customer_import_batch_created_idx" ON "customer_import_batches" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_import_source_identity_unique" ON "customer_import_records" USING btree ("source_system","source_id");--> statement-breakpoint
CREATE INDEX "customer_import_record_batch_idx" ON "customer_import_records" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "customer_import_record_approval_idx" ON "customer_import_records" USING btree ("approval_id","batch_id");--> statement-breakpoint
CREATE INDEX "customer_import_record_customer_idx" ON "customer_import_records" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_import_record_site_idx" ON "customer_import_records" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "customers_import_name_match_idx" ON "customers" USING btree (lower(regexp_replace(btrim("name"), '[[:space:]]+', ' ', 'g')));--> statement-breakpoint
CREATE INDEX "customers_import_email_match_idx" ON "customers" USING btree (lower(btrim("email")));--> statement-breakpoint
CREATE INDEX "customers_import_phone_match_idx" ON "customers" USING btree ((CASE WHEN regexp_replace("phone", '[^0-9]', '', 'g') ~ '^1[0-9]{10}$' THEN right(regexp_replace("phone", '[^0-9]', '', 'g'), 10) ELSE regexp_replace("phone", '[^0-9]', '', 'g') END));
--> statement-breakpoint
-- Approvals and imported source identities are retained through customer merges.
-- Correct a draft through a new review/approval; never rewrite accepted history.
CREATE FUNCTION catalyst_preserve_customer_import_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Customer import approval and source history are immutable; create a reviewed correction instead.' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER customer_import_approvals_immutable BEFORE UPDATE OR DELETE ON customer_import_approvals FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_customer_import_history();
--> statement-breakpoint
CREATE TRIGGER customer_import_records_immutable BEFORE UPDATE OR DELETE ON customer_import_records FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_customer_import_history();
