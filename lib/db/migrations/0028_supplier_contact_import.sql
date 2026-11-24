CREATE TABLE "supplier_import_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"decisions" jsonb NOT NULL,
	"review_note" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" text NOT NULL,
	CONSTRAINT "supplier_import_approval_batch_unique" UNIQUE("id","batch_id"),
	CONSTRAINT "supplier_import_approval_fingerprint_check" CHECK ("supplier_import_approvals"."fingerprint" ~ '^[a-f0-9]{64}$' AND "supplier_import_approvals"."preview_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "supplier_import_batches" (
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
	CONSTRAINT "supplier_import_batch_source_unique" UNIQUE("id","source_system"),
	CONSTRAINT "supplier_import_batch_status_check" CHECK ("supplier_import_batches"."status" IN ('preview','reviewed','approved','committed')),
	CONSTRAINT "supplier_import_batch_revision_check" CHECK ("supplier_import_batches"."revision">0),
	CONSTRAINT "supplier_import_batch_source_check" CHECK (octet_length("supplier_import_batches"."source_csv") BETWEEN 1 AND 1048576 AND "supplier_import_batches"."delimiter" IN (',',E'	') AND "supplier_import_batches"."source_sha256" ~ '^[a-f0-9]{64}$' AND "supplier_import_batches"."preview_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "supplier_import_batch_rows_check" CHECK (jsonb_typeof("supplier_import_batches"."rows")='array' AND jsonb_array_length("supplier_import_batches"."rows") BETWEEN 1 AND 200),
	CONSTRAINT "supplier_import_batch_approval_check" CHECK ("supplier_import_batches"."status" NOT IN ('approved','committed') OR "supplier_import_batches"."current_approval_id" IS NOT NULL),
	CONSTRAINT "supplier_import_batch_committed_check" CHECK (("supplier_import_batches"."status"='committed')=("supplier_import_batches"."committed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "supplier_import_records" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"source_system" text NOT NULL,
	"source_id" text NOT NULL,
	"source_line" integer NOT NULL,
	"supplier_id" text NOT NULL,
	"action" text NOT NULL,
	"source_data" jsonb NOT NULL,
	"supplier_snapshot" jsonb NOT NULL,
	"source_row_sha256" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "supplier_import_record_source_check" CHECK (length("supplier_import_records"."source_id") BETWEEN 1 AND 160 AND "supplier_import_records"."source_line">0 AND "supplier_import_records"."action" IN ('create','link') AND "supplier_import_records"."source_row_sha256" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("supplier_import_records"."source_data")='object' AND jsonb_typeof("supplier_import_records"."supplier_snapshot")='object')
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"contact_name" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"state" text DEFAULT '' NOT NULL,
	"postal_code" text DEFAULT '' NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "suppliers_revision_check" CHECK ("suppliers"."revision">0),
	CONSTRAINT "suppliers_name_key_check" CHECK (length(btrim("suppliers"."name")) BETWEEN 1 AND 200 AND "suppliers"."name"=btrim("suppliers"."name") AND "suppliers"."name" !~ '[[:cntrl:]]' AND "suppliers"."name_key"=lower(btrim("suppliers"."name")))
);
--> statement-breakpoint
ALTER TABLE "supplier_import_approvals" ADD CONSTRAINT "supplier_import_approval_batch_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."supplier_import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_import_records" ADD CONSTRAINT "supplier_import_records_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_import_records" ADD CONSTRAINT "supplier_import_record_batch_source_fk" FOREIGN KEY ("batch_id","source_system") REFERENCES "public"."supplier_import_batches"("id","source_system") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_import_records" ADD CONSTRAINT "supplier_import_record_approval_batch_fk" FOREIGN KEY ("approval_id","batch_id") REFERENCES "public"."supplier_import_approvals"("id","batch_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_import_approval_fingerprint_unique" ON "supplier_import_approvals" USING btree ("batch_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_import_batch_identity_unique" ON "supplier_import_batches" USING btree ("source_system","batch_key");--> statement-breakpoint
CREATE INDEX "supplier_import_batch_created_idx" ON "supplier_import_batches" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_import_source_identity_unique" ON "supplier_import_records" USING btree ("source_system","source_id");--> statement-breakpoint
CREATE INDEX "supplier_import_record_supplier_idx" ON "supplier_import_records" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_import_record_batch_idx" ON "supplier_import_records" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_name_key_unique" ON "suppliers" USING btree ("name_key");
--> statement-breakpoint
CREATE FUNCTION catalyst_preserve_supplier_import_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Supplier import history is immutable; retain the original source and make a separately reviewed correction.' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER supplier_import_approvals_immutable BEFORE UPDATE OR DELETE ON supplier_import_approvals FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_supplier_import_history();
--> statement-breakpoint
CREATE TRIGGER supplier_import_records_immutable BEFORE UPDATE OR DELETE ON supplier_import_records FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_supplier_import_history();
--> statement-breakpoint
CREATE FUNCTION catalyst_preserve_supplier_import_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Supplier import source batches are retained.' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'committed' OR
     ROW(NEW.id,NEW.workspace_key,NEW.source_system,NEW.batch_key,NEW.file_name,NEW.source_sha256,NEW.source_csv,NEW.delimiter,NEW.created_by,NEW.created_at)
       IS DISTINCT FROM
     ROW(OLD.id,OLD.workspace_key,OLD.source_system,OLD.batch_key,OLD.file_name,OLD.source_sha256,OLD.source_csv,OLD.delimiter,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Supplier import source content and committed batches are immutable.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER supplier_import_batches_preserved BEFORE UPDATE OR DELETE ON supplier_import_batches FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_supplier_import_batch();

--> statement-breakpoint
CREATE FUNCTION catalyst_preserve_supplier_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Supplier records are retained; deactivate the supplier instead of deleting or merging source history.' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.id,NEW.name,NEW.name_key,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.name,OLD.name_key,OLD.created_at) THEN
    RAISE EXCEPTION 'Canonical supplier identity and name are retained; contact edits cannot rename a supplier or rewrite legacy purchasing labels.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER suppliers_identity_preserved BEFORE UPDATE OR DELETE ON suppliers FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_supplier_identity();
