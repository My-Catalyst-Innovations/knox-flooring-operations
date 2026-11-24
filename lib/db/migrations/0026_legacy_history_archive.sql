CREATE TABLE "legacy_archive_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"decisions" jsonb NOT NULL,
	"review_note" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" text NOT NULL,
	CONSTRAINT "legacy_archive_approval_batch_unique" UNIQUE("id","batch_id"),
	CONSTRAINT "legacy_archive_approval_fingerprint_check" CHECK ("legacy_archive_approvals"."fingerprint" ~ '^[a-f0-9]{64}$' AND "legacy_archive_approvals"."preview_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "legacy_archive_batches" (
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
	CONSTRAINT "legacy_archive_batch_source_unique" UNIQUE("id","source_system"),
	CONSTRAINT "legacy_archive_batch_status_check" CHECK ("legacy_archive_batches"."status" IN ('preview','reviewed','approved','committed')),
	CONSTRAINT "legacy_archive_batch_revision_check" CHECK ("legacy_archive_batches"."revision">0),
	CONSTRAINT "legacy_archive_batch_source_check" CHECK (octet_length("legacy_archive_batches"."source_csv") BETWEEN 1 AND 1048576 AND "legacy_archive_batches"."delimiter" IN (',',E'	') AND "legacy_archive_batches"."source_sha256" ~ '^[a-f0-9]{64}$' AND "legacy_archive_batches"."preview_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "legacy_archive_batch_rows_check" CHECK (jsonb_typeof("legacy_archive_batches"."rows")='array' AND jsonb_array_length("legacy_archive_batches"."rows") BETWEEN 1 AND 200),
	CONSTRAINT "legacy_archive_batch_approval_check" CHECK ("legacy_archive_batches"."status" NOT IN ('approved','committed') OR "legacy_archive_batches"."current_approval_id" IS NOT NULL),
	CONSTRAINT "legacy_archive_batch_committed_check" CHECK (("legacy_archive_batches"."status"='committed')=("legacy_archive_batches"."committed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "legacy_archive_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"record_id" text NOT NULL,
	"object_path" text NOT NULL,
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_key" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "legacy_archive_document_size_check" CHECK ("legacy_archive_documents"."size" BETWEEN 1 AND 15728640 AND "legacy_archive_documents"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "legacy_archive_records" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"source_system" text NOT NULL,
	"source_id" text NOT NULL,
	"source_line" integer NOT NULL,
	"record_type" text NOT NULL,
	"title" text NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"party_name" text DEFAULT '' NOT NULL,
	"occurred_on" date,
	"source_status" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"record_sha256" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "legacy_archive_record_type_check" CHECK ("legacy_archive_records"."record_type" IN ('job','quote','invoice','purchase_order','payment','other')),
	CONSTRAINT "legacy_archive_record_source_check" CHECK (length("legacy_archive_records"."source_id") BETWEEN 1 AND 160 AND "legacy_archive_records"."source_line">0 AND "legacy_archive_records"."record_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "legacy_archive_approvals" ADD CONSTRAINT "legacy_archive_approval_batch_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."legacy_archive_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_archive_documents" ADD CONSTRAINT "legacy_archive_documents_record_id_legacy_archive_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."legacy_archive_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_archive_records" ADD CONSTRAINT "legacy_archive_record_batch_source_fk" FOREIGN KEY ("batch_id","source_system") REFERENCES "public"."legacy_archive_batches"("id","source_system") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_archive_records" ADD CONSTRAINT "legacy_archive_record_approval_batch_fk" FOREIGN KEY ("approval_id","batch_id") REFERENCES "public"."legacy_archive_approvals"("id","batch_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_archive_approval_fingerprint_unique" ON "legacy_archive_approvals" USING btree ("batch_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_archive_batch_identity_unique" ON "legacy_archive_batches" USING btree ("source_system","batch_key");--> statement-breakpoint
CREATE INDEX "legacy_archive_batch_created_idx" ON "legacy_archive_batches" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_archive_document_object_unique" ON "legacy_archive_documents" USING btree ("object_path");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_archive_document_request_unique" ON "legacy_archive_documents" USING btree ("request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_archive_document_content_unique" ON "legacy_archive_documents" USING btree ("record_id","sha256");--> statement-breakpoint
CREATE INDEX "legacy_archive_document_record_idx" ON "legacy_archive_documents" USING btree ("record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_archive_record_source_unique" ON "legacy_archive_records" USING btree ("source_system","record_type","source_id");--> statement-breakpoint
CREATE INDEX "legacy_archive_record_created_idx" ON "legacy_archive_records" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "legacy_archive_record_batch_idx" ON "legacy_archive_records" USING btree ("batch_id");
--> statement-breakpoint
-- Accepted source history and original-document claims are append-only. These
-- tables are an archive, never an operational or accounting ledger.
CREATE FUNCTION catalyst_preserve_legacy_archive_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Legacy archive history is immutable; retain the original source and make a separately reviewed correction.' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER legacy_archive_approvals_immutable BEFORE UPDATE OR DELETE ON legacy_archive_approvals FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_legacy_archive_history();
--> statement-breakpoint
CREATE TRIGGER legacy_archive_records_immutable BEFORE UPDATE OR DELETE ON legacy_archive_records FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_legacy_archive_history();
--> statement-breakpoint
CREATE TRIGGER legacy_archive_documents_immutable BEFORE UPDATE OR DELETE ON legacy_archive_documents FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_legacy_archive_history();
--> statement-breakpoint
CREATE FUNCTION catalyst_preserve_legacy_archive_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Legacy archive source batches are retained.' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'committed' OR
     ROW(NEW.id,NEW.workspace_key,NEW.source_system,NEW.batch_key,NEW.file_name,NEW.source_sha256,NEW.source_csv,NEW.delimiter,NEW.created_by,NEW.created_at)
       IS DISTINCT FROM
     ROW(OLD.id,OLD.workspace_key,OLD.source_system,OLD.batch_key,OLD.file_name,OLD.source_sha256,OLD.source_csv,OLD.delimiter,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Legacy archive source content and committed batches are immutable.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER legacy_archive_batches_preserved BEFORE UPDATE OR DELETE ON legacy_archive_batches FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_legacy_archive_batch();
