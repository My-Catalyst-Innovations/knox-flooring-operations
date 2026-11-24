CREATE TABLE "open_po_import_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"reviewed" jsonb NOT NULL,
	"review_note" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" text NOT NULL,
	CONSTRAINT "open_po_import_approval_batch_unique" UNIQUE("id","batch_id"),
	CONSTRAINT "open_po_import_approval_hash_check" CHECK ("open_po_import_approvals"."fingerprint" ~ '^[a-f0-9]{64}$' AND "open_po_import_approvals"."preview_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "open_po_import_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_key" text NOT NULL,
	"source_system" text NOT NULL,
	"batch_key" text NOT NULL,
	"file_name" text NOT NULL,
	"source_sha256" text NOT NULL,
	"source_csv" text NOT NULL,
	"delimiter" text NOT NULL,
	"source_snapshot_at" text NOT NULL,
	"cutover_at" text NOT NULL,
	"rows" jsonb NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"review_fingerprint" text,
	"reviewed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_note" text,
	"current_approval_id" text,
	"result" jsonb,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"committed_at" text,
	CONSTRAINT "open_po_import_batch_source_unique" UNIQUE("id","source_system"),
	CONSTRAINT "open_po_import_batch_status_check" CHECK ("open_po_import_batches"."status" IN ('preview','reviewed','approved','committed')),
	CONSTRAINT "open_po_import_batch_revision_check" CHECK ("open_po_import_batches"."revision">0),
	CONSTRAINT "open_po_import_batch_source_check" CHECK (octet_length("open_po_import_batches"."source_csv") BETWEEN 1 AND 200000 AND "open_po_import_batches"."delimiter" IN (',',E'	') AND "open_po_import_batches"."source_sha256" ~ '^[a-f0-9]{64}$' AND "open_po_import_batches"."preview_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "open_po_import_batch_rows_check" CHECK (jsonb_typeof("open_po_import_batches"."rows")='array' AND jsonb_array_length("open_po_import_batches"."rows") BETWEEN 1 AND 200),
	CONSTRAINT "open_po_import_batch_approval_check" CHECK ("open_po_import_batches"."status" NOT IN ('approved','committed') OR "open_po_import_batches"."current_approval_id" IS NOT NULL),
	CONSTRAINT "open_po_import_batch_committed_check" CHECK (("open_po_import_batches"."status"='committed')=("open_po_import_batches"."committed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "open_po_import_records" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"source_system" text NOT NULL,
	"source_po_id" text NOT NULL,
	"source_po_number" text NOT NULL,
	"order_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"source_data" jsonb NOT NULL,
	"reviewed_decision" jsonb NOT NULL,
	"source_record_sha256" text NOT NULL,
	"action" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "open_po_import_record_action_check" CHECK ("open_po_import_records"."action" IN ('create','link')),
	CONSTRAINT "open_po_import_record_hash_check" CHECK ("open_po_import_records"."source_record_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "open_po_import_approvals" ADD CONSTRAINT "open_po_import_approvals_batch_id_open_po_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."open_po_import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_po_import_records" ADD CONSTRAINT "open_po_import_records_order_id_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_po_import_records" ADD CONSTRAINT "open_po_import_records_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_po_import_records" ADD CONSTRAINT "open_po_import_record_batch_source_fk" FOREIGN KEY ("batch_id","source_system") REFERENCES "public"."open_po_import_batches"("id","source_system") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_po_import_records" ADD CONSTRAINT "open_po_import_record_approval_batch_fk" FOREIGN KEY ("approval_id","batch_id") REFERENCES "public"."open_po_import_approvals"("id","batch_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "open_po_import_approval_fingerprint_unique" ON "open_po_import_approvals" USING btree ("batch_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "open_po_import_batch_identity_unique" ON "open_po_import_batches" USING btree ("source_system","batch_key");--> statement-breakpoint
CREATE INDEX "open_po_import_batch_created_idx" ON "open_po_import_batches" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "open_po_import_source_identity_unique" ON "open_po_import_records" USING btree ("source_system","source_po_id");--> statement-breakpoint
CREATE UNIQUE INDEX "open_po_import_target_order_unique" ON "open_po_import_records" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "open_po_import_record_batch_idx" ON "open_po_import_records" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "open_po_import_record_supplier_idx" ON "open_po_import_records" USING btree ("supplier_id");
--> statement-breakpoint
-- Source snapshots and accepted provenance never become operational receipts,
-- accounting balances or mutable overwrite instructions.
CREATE FUNCTION catalyst_open_po_import_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Outstanding PO import history is immutable; retain the original and prepare a separately reviewed correction.' USING ERRCODE='23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER open_po_import_approvals_immutable BEFORE UPDATE OR DELETE ON open_po_import_approvals FOR EACH ROW EXECUTE FUNCTION catalyst_open_po_import_history_immutable();
--> statement-breakpoint
CREATE TRIGGER open_po_import_records_immutable BEFORE UPDATE OR DELETE ON open_po_import_records FOR EACH ROW EXECUTE FUNCTION catalyst_open_po_import_history_immutable();
--> statement-breakpoint
CREATE FUNCTION catalyst_open_po_import_batch_preserved() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Outstanding PO source snapshots are retained.' USING ERRCODE='23514'; END IF;
  IF OLD.status='committed' OR
    ROW(NEW.id,NEW.workspace_key,NEW.source_system,NEW.batch_key,NEW.file_name,NEW.source_sha256,NEW.source_csv,NEW.delimiter,NEW.source_snapshot_at,NEW.cutover_at,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id,OLD.workspace_key,OLD.source_system,OLD.batch_key,OLD.file_name,OLD.source_sha256,OLD.source_csv,OLD.delimiter,OLD.source_snapshot_at,OLD.cutover_at,OLD.created_by,OLD.created_at)
  THEN RAISE EXCEPTION 'Outstanding PO source content and committed batches are immutable.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER open_po_import_batches_preserved BEFORE UPDATE OR DELETE ON open_po_import_batches FOR EACH ROW EXECUTE FUNCTION catalyst_open_po_import_batch_preserved();
