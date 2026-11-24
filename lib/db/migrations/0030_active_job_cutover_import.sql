CREATE TABLE "active_job_import_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"decisions" jsonb NOT NULL,
	"review_note" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" text NOT NULL,
	CONSTRAINT "active_job_import_approval_batch_unique" UNIQUE("id","batch_id"),
	CONSTRAINT "active_job_import_approval_fingerprint_check" CHECK ("active_job_import_approvals"."fingerprint" ~ '^[a-f0-9]{64}$' AND "active_job_import_approvals"."preview_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "active_job_import_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_key" text NOT NULL,
	"source_system" text NOT NULL,
	"batch_key" text NOT NULL,
	"file_name" text NOT NULL,
	"source_sha256" text NOT NULL,
	"source_csv" text NOT NULL,
	"delimiter" text NOT NULL,
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
	CONSTRAINT "active_job_import_batch_source_unique" UNIQUE("id","source_system"),
	CONSTRAINT "active_job_import_batch_status_check" CHECK ("active_job_import_batches"."status" IN ('preview','reviewed','approved','committed')),
	CONSTRAINT "active_job_import_batch_revision_check" CHECK ("active_job_import_batches"."revision">0),
	CONSTRAINT "active_job_import_batch_source_check" CHECK (octet_length("active_job_import_batches"."source_csv") BETWEEN 1 AND 1048576 AND "active_job_import_batches"."delimiter" IN (',',E'	') AND "active_job_import_batches"."source_sha256" ~ '^[a-f0-9]{64}$' AND "active_job_import_batches"."preview_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "active_job_import_batch_rows_check" CHECK (jsonb_typeof("active_job_import_batches"."rows")='array' AND jsonb_array_length("active_job_import_batches"."rows") BETWEEN 1 AND 200),
	CONSTRAINT "active_job_import_batch_approval_check" CHECK ("active_job_import_batches"."status" NOT IN ('approved','committed') OR "active_job_import_batches"."current_approval_id" IS NOT NULL),
	CONSTRAINT "active_job_import_batch_committed_check" CHECK (("active_job_import_batches"."status"='committed')=("active_job_import_batches"."committed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "active_job_import_records" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"source_system" text NOT NULL,
	"source_id" text NOT NULL,
	"source_line" integer NOT NULL,
	"job_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"site_id" text,
	"action" text NOT NULL,
	"source_data" jsonb NOT NULL,
	"decision" jsonb NOT NULL,
	"source_row_sha256" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "active_job_import_record_job_action_unique" UNIQUE("id","job_id","action"),
	CONSTRAINT "active_job_import_record_identity_check" CHECK (length("active_job_import_records"."source_id") BETWEEN 1 AND 160 AND "active_job_import_records"."source_line">0 AND "active_job_import_records"."action" IN ('create','link') AND "active_job_import_records"."source_row_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "job_cutover_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" text NOT NULL,
	CONSTRAINT "job_cutover_approval_binding_unique" UNIQUE("id","job_id","kind","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "job_cutover_commits" (
	"id" text PRIMARY KEY NOT NULL,
	"approval_id" text NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"result" jsonb NOT NULL,
	"committed_by" text NOT NULL,
	"committed_at" text NOT NULL,
	CONSTRAINT "job_cutover_commit_binding_unique" UNIQUE("id","job_id","kind")
);
--> statement-breakpoint
CREATE TABLE "job_cutover_invoice_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"billing_commit_id" text NOT NULL,
	"billing_kind" text DEFAULT 'billing' NOT NULL,
	"request_fingerprint" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"initial_gross_cents" bigint NOT NULL,
	"current_gross_cents" bigint NOT NULL,
	"financial_fingerprint" text NOT NULL,
	"submission_locked" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "job_cutover_invoice_request_valid" CHECK ("job_cutover_invoice_requests"."revision">0 AND "job_cutover_invoice_requests"."billing_kind"='billing' AND "job_cutover_invoice_requests"."initial_gross_cents" BETWEEN 0 AND 9007199254740991 AND "job_cutover_invoice_requests"."current_gross_cents" BETWEEN 0 AND 9007199254740991 AND "job_cutover_invoice_requests"."request_fingerprint" ~ '^[a-f0-9]{64}$' AND "job_cutover_invoice_requests"."financial_fingerprint" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("job_cutover_invoice_requests"."request_payload")='object')
);
--> statement-breakpoint
CREATE TABLE "job_cutover_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"job_revision" integer NOT NULL,
	"cutover_revision" integer NOT NULL,
	"scope_fingerprint" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"reviewed_by" text NOT NULL,
	"reviewed_at" text NOT NULL,
	CONSTRAINT "job_cutover_review_binding_unique" UNIQUE("id","job_id","kind","fingerprint"),
	CONSTRAINT "job_cutover_review_valid" CHECK ("job_cutover_reviews"."job_revision">0 AND "job_cutover_reviews"."cutover_revision">0 AND "job_cutover_reviews"."kind" IN ('operational','financial_context','billing') AND "job_cutover_reviews"."fingerprint" ~ '^[a-f0-9]{64}$' AND "job_cutover_reviews"."scope_fingerprint" ~ '^[a-f0-9]{64}$' AND "job_cutover_reviews"."source_fingerprint" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("job_cutover_reviews"."payload")='object')
);
--> statement-breakpoint
CREATE TABLE "job_cutovers" (
	"job_id" text PRIMARY KEY NOT NULL,
	"source_record_id" text NOT NULL,
	"source_action" text DEFAULT 'create' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"operational_commit_id" text,
	"operational_kind" text DEFAULT 'operational' NOT NULL,
	"financial_commit_id" text,
	"financial_kind" text DEFAULT 'financial_context' NOT NULL,
	"billing_commit_id" text,
	"billing_kind" text DEFAULT 'billing' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "job_cutover_state_valid" CHECK ("job_cutovers"."revision">0 AND "job_cutovers"."source_action"='create' AND "job_cutovers"."operational_kind"='operational' AND "job_cutovers"."financial_kind"='financial_context' AND "job_cutovers"."billing_kind"='billing')
);
--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "labor_estimate" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "material_estimate" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "est_revenue" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "est_gross_profit" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "gross_margin_pct" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "actual_revenue" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "actual_labor_cost" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "actual_material_cost" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "actual_add_on_cost" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "active_job_import_approvals" ADD CONSTRAINT "active_job_import_approval_batch_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."active_job_import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_job_import_records" ADD CONSTRAINT "active_job_import_records_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_job_import_records" ADD CONSTRAINT "active_job_import_records_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_job_import_records" ADD CONSTRAINT "active_job_import_records_site_id_customer_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."customer_sites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_job_import_records" ADD CONSTRAINT "active_job_import_record_batch_source_fk" FOREIGN KEY ("batch_id","source_system") REFERENCES "public"."active_job_import_batches"("id","source_system") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_job_import_records" ADD CONSTRAINT "active_job_import_record_approval_batch_fk" FOREIGN KEY ("approval_id","batch_id") REFERENCES "public"."active_job_import_approvals"("id","batch_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cutover_approvals" ADD CONSTRAINT "job_cutover_approval_review_fk" FOREIGN KEY ("review_id","job_id","kind","fingerprint") REFERENCES "public"."job_cutover_reviews"("id","job_id","kind","fingerprint") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cutover_commits" ADD CONSTRAINT "job_cutover_commit_approval_fk" FOREIGN KEY ("approval_id","job_id","kind","fingerprint") REFERENCES "public"."job_cutover_approvals"("id","job_id","kind","fingerprint") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cutover_invoice_requests" ADD CONSTRAINT "job_cutover_invoice_requests_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cutover_invoice_requests" ADD CONSTRAINT "job_cutover_invoice_requests_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cutover_invoice_requests" ADD CONSTRAINT "job_cutover_invoice_billing_commit_fk" FOREIGN KEY ("billing_commit_id","job_id","billing_kind") REFERENCES "public"."job_cutover_commits"("id","job_id","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cutover_reviews" ADD CONSTRAINT "job_cutover_reviews_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cutovers" ADD CONSTRAINT "job_cutovers_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cutovers" ADD CONSTRAINT "job_cutover_created_source_fk" FOREIGN KEY ("source_record_id","job_id","source_action") REFERENCES "public"."active_job_import_records"("id","job_id","action") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cutovers" ADD CONSTRAINT "job_cutover_operational_commit_fk" FOREIGN KEY ("operational_commit_id","job_id","operational_kind") REFERENCES "public"."job_cutover_commits"("id","job_id","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cutovers" ADD CONSTRAINT "job_cutover_financial_commit_fk" FOREIGN KEY ("financial_commit_id","job_id","financial_kind") REFERENCES "public"."job_cutover_commits"("id","job_id","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cutovers" ADD CONSTRAINT "job_cutover_billing_commit_fk" FOREIGN KEY ("billing_commit_id","job_id","billing_kind") REFERENCES "public"."job_cutover_commits"("id","job_id","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "active_job_import_approval_fingerprint_unique" ON "active_job_import_approvals" USING btree ("batch_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "active_job_import_batch_identity_unique" ON "active_job_import_batches" USING btree ("source_system","batch_key");--> statement-breakpoint
CREATE INDEX "active_job_import_batch_created_idx" ON "active_job_import_batches" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "active_job_import_source_identity_unique" ON "active_job_import_records" USING btree ("source_system","source_id");--> statement-breakpoint
CREATE INDEX "active_job_import_record_job_idx" ON "active_job_import_records" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_cutover_approval_review_unique" ON "job_cutover_approvals" USING btree ("review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_cutover_commit_approval_unique" ON "job_cutover_commits" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_cutover_invoice_request_invoice_unique" ON "job_cutover_invoice_requests" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "job_cutover_invoice_request_job_idx" ON "job_cutover_invoice_requests" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_cutover_review_fingerprint_unique" ON "job_cutover_reviews" USING btree ("job_id","kind","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "job_cutover_created_source_unique" ON "job_cutovers" USING btree ("source_record_id");
--> statement-breakpoint
CREATE FUNCTION catalyst_preserve_active_job_import_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Active job import history is immutable; retain the original source and make a separately reviewed correction.' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER active_job_import_approvals_immutable BEFORE UPDATE OR DELETE ON active_job_import_approvals FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_active_job_import_history();
--> statement-breakpoint
CREATE TRIGGER active_job_import_records_immutable BEFORE UPDATE OR DELETE ON active_job_import_records FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_active_job_import_history();
--> statement-breakpoint
CREATE FUNCTION catalyst_preserve_active_job_import_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Active job import source batches are retained.' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'committed' OR
     ROW(NEW.id,NEW.workspace_key,NEW.source_system,NEW.batch_key,NEW.file_name,NEW.source_sha256,NEW.source_csv,NEW.delimiter,NEW.created_by,NEW.created_at)
       IS DISTINCT FROM
     ROW(OLD.id,OLD.workspace_key,OLD.source_system,OLD.batch_key,OLD.file_name,OLD.source_sha256,OLD.source_csv,OLD.delimiter,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Active job import source content and committed batches are immutable.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER active_job_import_batches_preserved BEFORE UPDATE OR DELETE ON active_job_import_batches FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_active_job_import_batch();

--> statement-breakpoint

--> statement-breakpoint
CREATE TRIGGER job_cutover_reviews_immutable BEFORE UPDATE OR DELETE ON job_cutover_reviews FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_active_job_import_history();

--> statement-breakpoint
CREATE TRIGGER job_cutover_approvals_immutable BEFORE UPDATE OR DELETE ON job_cutover_approvals FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_active_job_import_history();

--> statement-breakpoint
CREATE TRIGGER job_cutover_commits_immutable BEFORE UPDATE OR DELETE ON job_cutover_commits FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_active_job_import_history();
--> statement-breakpoint
CREATE FUNCTION catalyst_preserve_job_cutover_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.job_id,NEW.source_record_id,NEW.source_action,NEW.created_at) IS DISTINCT FROM ROW(OLD.job_id,OLD.source_record_id,OLD.source_action,OLD.created_at) THEN
  RAISE EXCEPTION 'Imported job cutover identity is retained; existing source links cannot be removed or rebound.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER job_cutovers_identity_preserved BEFORE UPDATE OR DELETE ON job_cutovers FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_job_cutover_identity();
--> statement-breakpoint
CREATE FUNCTION catalyst_preserve_cutover_invoice_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.id,NEW.job_id,NEW.invoice_id,NEW.billing_commit_id,NEW.request_fingerprint,NEW.request_payload,NEW.initial_gross_cents,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.job_id,OLD.invoice_id,OLD.billing_commit_id,OLD.request_fingerprint,OLD.request_payload,OLD.initial_gross_cents,OLD.created_by,OLD.created_at) THEN
  RAISE EXCEPTION 'Imported-job invoice request and original billing consumption identity are retained.' USING ERRCODE='23514';
 END IF;
 IF OLD.submission_locked AND (NOT NEW.submission_locked OR ROW(NEW.current_gross_cents,NEW.financial_fingerprint) IS DISTINCT FROM ROW(OLD.current_gross_cents,OLD.financial_fingerprint)) THEN
  RAISE EXCEPTION 'Submitted or ambiguous imported-job invoice consumption cannot be reduced or rewritten.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER job_cutover_invoice_requests_preserved BEFORE UPDATE OR DELETE ON job_cutover_invoice_requests FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_cutover_invoice_request();
--> statement-breakpoint
CREATE FUNCTION catalyst_check_cutover_invoice_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.current_gross_cents<>NEW.initial_gross_cents OR NEW.submission_locked OR NOT EXISTS(
  SELECT 1 FROM invoices i JOIN jobs j ON j.id=i.job_id JOIN job_cutovers c ON c.job_id=j.id
  WHERE i.id=NEW.invoice_id AND i.job_id=NEW.job_id AND i.customer_id IS NOT DISTINCT FROM j.customer_id
   AND c.billing_commit_id=NEW.billing_commit_id AND round(i.total::double precision::numeric*100)=NEW.current_gross_cents
 ) THEN
  RAISE EXCEPTION 'A new imported-job billing claim must match its current approved job, invoice, customer and gross amount.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER job_cutover_invoice_request_bound BEFORE INSERT ON job_cutover_invoice_requests FOR EACH ROW EXECUTE FUNCTION catalyst_check_cutover_invoice_request();
--> statement-breakpoint
CREATE FUNCTION catalyst_preserve_cutover_invoice_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM job_cutovers WHERE job_id=OLD.job_id) THEN
   RAISE EXCEPTION 'Imported-job invoices are retained; deletion cannot free remaining billing capacity.' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 END IF;
 IF ROW(NEW.job_id,NEW.customer_id) IS DISTINCT FROM ROW(OLD.job_id,OLD.customer_id) AND EXISTS(SELECT 1 FROM job_cutovers WHERE job_id IN (OLD.job_id,NEW.job_id)) THEN
  RAISE EXCEPTION 'Imported-job invoice attribution cannot move to another job or customer.' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM job_cutover_invoice_requests WHERE invoice_id=OLD.id AND submission_locked) AND
    ROW(NEW.line_items,NEW.subtotal,NEW.taxable_amount,NEW.tax_amount,NEW.discount_amount,NEW.total,NEW.deposit_amount,NEW.invoice_number,NEW.job_number,NEW.customer_name,NEW.issue_date,NEW.due_date,NEW.notes,NEW.tax_code) IS DISTINCT FROM ROW(OLD.line_items,OLD.subtotal,OLD.taxable_amount,OLD.tax_amount,OLD.discount_amount,OLD.total,OLD.deposit_amount,OLD.invoice_number,OLD.job_number,OLD.customer_name,OLD.issue_date,OLD.due_date,OLD.notes,OLD.tax_code) THEN
  RAISE EXCEPTION 'Submitted or ambiguous imported-job invoice financial fields cannot be edited.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_cutover_attribution_preserved BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_cutover_invoice_attribution();
