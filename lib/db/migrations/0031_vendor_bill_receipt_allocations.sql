CREATE TABLE "inventory_accounting_case_events" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"request_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"note" text NOT NULL,
	"adjustment_id" text,
	"realm_id" text,
	"environment" text,
	"provider_snapshot" jsonb,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "inventory_accounting_case_event_valid" CHECK ("inventory_accounting_case_events"."request_fingerprint" ~ '^[a-f0-9]{64}$' AND length(btrim("inventory_accounting_case_events"."note")) BETWEEN 10 AND 1000 AND (("inventory_accounting_case_events"."kind"='operator_note' AND "inventory_accounting_case_events"."adjustment_id" IS NULL AND "inventory_accounting_case_events"."provider_snapshot" IS NULL AND "inventory_accounting_case_events"."realm_id" IS NULL AND "inventory_accounting_case_events"."environment" IS NULL) OR ("inventory_accounting_case_events"."kind"='external_adjustment_verified' AND "inventory_accounting_case_events"."adjustment_id" IS NOT NULL AND "inventory_accounting_case_events"."realm_id" IS NOT NULL AND "inventory_accounting_case_events"."environment" IS NOT NULL AND "inventory_accounting_case_events"."provider_snapshot" IS NOT NULL AND "inventory_accounting_case_events"."adjustment_id" ~ '^[0-9]{1,30}$' AND "inventory_accounting_case_events"."realm_id" ~ '^[0-9]{1,30}$' AND "inventory_accounting_case_events"."environment" IN ('sandbox','production') AND jsonb_typeof("inventory_accounting_case_events"."provider_snapshot")='object')))
);
--> statement-breakpoint
CREATE TABLE "inventory_accounting_case_returns" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"return_id" text NOT NULL,
	"realm_id" text NOT NULL,
	"environment" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "inventory_accounting_case_return_valid" CHECK ("inventory_accounting_case_returns"."realm_id" ~ '^[0-9]{1,30}$' AND "inventory_accounting_case_returns"."environment" IN ('sandbox','production'))
);
--> statement-breakpoint
CREATE TABLE "inventory_accounting_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"request_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"product_id" text NOT NULL,
	"job_id" text,
	"connection_id" text,
	"realm_id" text,
	"environment" text,
	"note" text NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"source_snapshot" jsonb NOT NULL,
	"document" jsonb,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "inventory_accounting_case_valid" CHECK ("inventory_accounting_cases"."kind" IN ('return_quantity_plan','manual_review') AND "inventory_accounting_cases"."fingerprint" ~ '^[a-f0-9]{64}$' AND "inventory_accounting_cases"."request_fingerprint" ~ '^[a-f0-9]{64}$' AND length(btrim("inventory_accounting_cases"."note")) BETWEEN 10 AND 1000 AND jsonb_typeof("inventory_accounting_cases"."reason_codes")='array' AND jsonb_typeof("inventory_accounting_cases"."source_snapshot")='object' AND ("inventory_accounting_cases"."kind"<>'return_quantity_plan' OR "inventory_accounting_cases"."connection_id" IS NOT NULL) AND (("inventory_accounting_cases"."connection_id" IS NULL AND "inventory_accounting_cases"."realm_id" IS NULL AND "inventory_accounting_cases"."environment" IS NULL) OR ("inventory_accounting_cases"."connection_id" IS NOT NULL AND "inventory_accounting_cases"."realm_id" IS NOT NULL AND "inventory_accounting_cases"."environment" IS NOT NULL AND "inventory_accounting_cases"."realm_id" ~ '^[0-9]{1,30}$' AND "inventory_accounting_cases"."environment" IN ('sandbox','production'))))
);
--> statement-breakpoint
CREATE TABLE "vendor_bill_coverage_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"request_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"fingerprint" text NOT NULL,
	"mode" text NOT NULL,
	"workspace_key" text NOT NULL,
	"connection_id" text,
	"realm_id" text,
	"environment" text,
	"choice" jsonb NOT NULL,
	"source_snapshot" jsonb NOT NULL,
	"note" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "vendor_bill_coverage_approval_valid" CHECK ("vendor_bill_coverage_approvals"."request_fingerprint" ~ '^[a-f0-9]{64}$' AND "vendor_bill_coverage_approvals"."fingerprint" ~ '^[a-f0-9]{64}$' AND length(btrim("vendor_bill_coverage_approvals"."note")) BETWEEN 10 AND 1000 AND jsonb_typeof("vendor_bill_coverage_approvals"."choice")='object' AND jsonb_typeof("vendor_bill_coverage_approvals"."source_snapshot")='object' AND (("vendor_bill_coverage_approvals"."mode"='local_review' AND "vendor_bill_coverage_approvals"."connection_id" IS NULL AND "vendor_bill_coverage_approvals"."realm_id" IS NULL AND "vendor_bill_coverage_approvals"."environment" IS NULL) OR ("vendor_bill_coverage_approvals"."mode"='quickbooks_verified' AND "vendor_bill_coverage_approvals"."connection_id" IS NOT NULL AND "vendor_bill_coverage_approvals"."realm_id" IS NOT NULL AND "vendor_bill_coverage_approvals"."environment" IS NOT NULL AND "vendor_bill_coverage_approvals"."realm_id" ~ '^[0-9]{1,30}$' AND "vendor_bill_coverage_approvals"."environment" IN ('sandbox','production'))))
);
--> statement-breakpoint
CREATE TABLE "vendor_bill_coverage_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"approval_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"bill_id" text NOT NULL,
	"bill_line_index" integer NOT NULL,
	"connection_id" text NOT NULL,
	"realm_id" text NOT NULL,
	"environment" text NOT NULL,
	"vendor_id" text NOT NULL,
	"item_id" text NOT NULL,
	"posted_bill_id" text NOT NULL,
	"quantity" numeric(18, 6) NOT NULL,
	"bill_line_quantity" numeric(18, 6) NOT NULL,
	"billed_unit_cost" numeric(18, 6) NOT NULL,
	"bill_source" jsonb NOT NULL,
	"bill_source_fingerprint" text NOT NULL,
	"provider_snapshot" jsonb NOT NULL,
	"identity_snapshot" jsonb NOT NULL,
	"variance_note" text NOT NULL,
	"reconciliation_note" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "vendor_bill_binding_valid" CHECK ("vendor_bill_coverage_bindings"."bill_line_index">=0 AND "vendor_bill_coverage_bindings"."quantity">0 AND "vendor_bill_coverage_bindings"."quantity"<'Infinity'::numeric AND "vendor_bill_coverage_bindings"."bill_line_quantity">0 AND "vendor_bill_coverage_bindings"."bill_line_quantity"<'Infinity'::numeric AND "vendor_bill_coverage_bindings"."billed_unit_cost">=0 AND "vendor_bill_coverage_bindings"."billed_unit_cost"<'Infinity'::numeric AND "vendor_bill_coverage_bindings"."realm_id" ~ '^[0-9]{1,30}$' AND "vendor_bill_coverage_bindings"."environment" IN ('sandbox','production') AND "vendor_bill_coverage_bindings"."vendor_id" ~ '^[0-9]{1,30}$' AND "vendor_bill_coverage_bindings"."item_id" ~ '^[0-9]{1,30}$' AND "vendor_bill_coverage_bindings"."posted_bill_id" ~ '^[0-9]{1,30}$' AND "vendor_bill_coverage_bindings"."bill_source_fingerprint" ~ '^[a-f0-9]{64}$' AND length("vendor_bill_coverage_bindings"."variance_note")<=500 AND length("vendor_bill_coverage_bindings"."reconciliation_note")<=500 AND jsonb_typeof("vendor_bill_coverage_bindings"."bill_source")='object' AND jsonb_typeof("vendor_bill_coverage_bindings"."provider_snapshot")='object' AND jsonb_typeof("vendor_bill_coverage_bindings"."identity_snapshot")='object')
);
--> statement-breakpoint
CREATE TABLE "vendor_bill_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"bill_id" text NOT NULL,
	"object_path" text NOT NULL,
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"request_key" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "vendor_bill_document_valid" CHECK ("vendor_bill_documents"."size">0 AND "vendor_bill_documents"."size"<=10485760 AND "vendor_bill_documents"."sha256" ~ '^[a-f0-9]{64}$' AND length("vendor_bill_documents"."name") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE TABLE "vendor_bill_receipt_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"approval_id" text NOT NULL,
	"receipt_line_id" text NOT NULL,
	"bill_id" text NOT NULL,
	"bill_line_index" integer NOT NULL,
	"product_id" text NOT NULL,
	"alias_id" text NOT NULL,
	"price_id" text NOT NULL,
	"mode" text NOT NULL,
	"stock_unit" text NOT NULL,
	"quantity" numeric(18, 6) NOT NULL,
	"receipt_unit_cost" numeric(18, 6) NOT NULL,
	"billed_unit_cost" numeric(18, 6) NOT NULL,
	"bill_line_quantity" numeric(18, 6) NOT NULL,
	"bill_source" jsonb NOT NULL,
	"bill_source_fingerprint" text NOT NULL,
	"receipt_snapshot" jsonb NOT NULL,
	"identity_snapshot" jsonb NOT NULL,
	"variance_note" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "vendor_bill_allocation_valid" CHECK ("vendor_bill_receipt_allocations"."bill_line_index">=0 AND "vendor_bill_receipt_allocations"."quantity">0 AND "vendor_bill_receipt_allocations"."quantity"<'Infinity'::numeric AND "vendor_bill_receipt_allocations"."receipt_unit_cost">=0 AND "vendor_bill_receipt_allocations"."receipt_unit_cost"<'Infinity'::numeric AND "vendor_bill_receipt_allocations"."billed_unit_cost">=0 AND "vendor_bill_receipt_allocations"."billed_unit_cost"<'Infinity'::numeric AND "vendor_bill_receipt_allocations"."bill_line_quantity">0 AND "vendor_bill_receipt_allocations"."bill_line_quantity"<'Infinity'::numeric AND "vendor_bill_receipt_allocations"."mode" IN ('local_review','quickbooks_verified') AND "vendor_bill_receipt_allocations"."bill_source_fingerprint" ~ '^[a-f0-9]{64}$' AND length("vendor_bill_receipt_allocations"."variance_note")<=500 AND ("vendor_bill_receipt_allocations"."receipt_unit_cost"="vendor_bill_receipt_allocations"."billed_unit_cost" OR length(btrim("vendor_bill_receipt_allocations"."variance_note"))>=10) AND jsonb_typeof("vendor_bill_receipt_allocations"."bill_source")='object' AND jsonb_typeof("vendor_bill_receipt_allocations"."receipt_snapshot")='object' AND jsonb_typeof("vendor_bill_receipt_allocations"."identity_snapshot")='object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_accounting_event_request_unique" ON "inventory_accounting_case_events" USING btree ("request_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_accounting_case_external_once_unique" ON "inventory_accounting_case_events" USING btree ("case_id") WHERE "inventory_accounting_case_events"."kind"='external_adjustment_verified';
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_accounting_adjustment_company_unique" ON "inventory_accounting_case_events" USING btree ("adjustment_id","realm_id","environment");
--> statement-breakpoint
CREATE INDEX "inventory_accounting_event_case_idx" ON "inventory_accounting_case_events" USING btree ("case_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_accounting_return_company_unique" ON "inventory_accounting_case_returns" USING btree ("return_id","realm_id","environment");
--> statement-breakpoint
CREATE INDEX "inventory_accounting_case_return_idx" ON "inventory_accounting_case_returns" USING btree ("case_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_accounting_case_request_unique" ON "inventory_accounting_cases" USING btree ("request_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_accounting_case_id_company_unique" ON "inventory_accounting_cases" USING btree ("id","realm_id","environment");
--> statement-breakpoint
CREATE INDEX "inventory_accounting_case_product_idx" ON "inventory_accounting_cases" USING btree ("product_id");
--> statement-breakpoint
CREATE INDEX "inventory_accounting_case_company_idx" ON "inventory_accounting_cases" USING btree ("realm_id","environment");
--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bill_coverage_request_unique" ON "vendor_bill_coverage_approvals" USING btree ("request_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bill_coverage_id_mode_unique" ON "vendor_bill_coverage_approvals" USING btree ("id","mode");
--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bill_coverage_id_company_unique" ON "vendor_bill_coverage_approvals" USING btree ("id","realm_id","environment");
--> statement-breakpoint
CREATE INDEX "vendor_bill_coverage_company_idx" ON "vendor_bill_coverage_approvals" USING btree ("realm_id","environment");
--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bill_binding_approval_pair_unique" ON "vendor_bill_coverage_bindings" USING btree ("approval_id","allocation_id","bill_id","bill_line_index");
--> statement-breakpoint
CREATE INDEX "vendor_bill_binding_allocation_idx" ON "vendor_bill_coverage_bindings" USING btree ("allocation_id");
--> statement-breakpoint
CREATE INDEX "vendor_bill_binding_bill_idx" ON "vendor_bill_coverage_bindings" USING btree ("bill_id","bill_line_index");
--> statement-breakpoint
CREATE INDEX "vendor_bill_binding_company_idx" ON "vendor_bill_coverage_bindings" USING btree ("realm_id","environment");
--> statement-breakpoint
CREATE INDEX "vendor_bill_binding_provider_line_idx" ON "vendor_bill_coverage_bindings" USING btree ("realm_id","environment","posted_bill_id","bill_line_index");
--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bill_document_request_unique" ON "vendor_bill_documents" USING btree ("request_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bill_document_object_unique" ON "vendor_bill_documents" USING btree ("object_path");
--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bill_document_hash_unique" ON "vendor_bill_documents" USING btree ("bill_id","sha256");
--> statement-breakpoint
CREATE INDEX "vendor_bill_document_bill_idx" ON "vendor_bill_documents" USING btree ("bill_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bill_allocation_approval_pair_unique" ON "vendor_bill_receipt_allocations" USING btree ("approval_id","receipt_line_id","bill_id","bill_line_index");
--> statement-breakpoint
CREATE INDEX "vendor_bill_allocation_receipt_idx" ON "vendor_bill_receipt_allocations" USING btree ("receipt_line_id");
--> statement-breakpoint
CREATE INDEX "vendor_bill_allocation_bill_idx" ON "vendor_bill_receipt_allocations" USING btree ("bill_id","bill_line_index");
--> statement-breakpoint
ALTER TABLE "inventory_accounting_case_events" ADD CONSTRAINT "inventory_case_event_case_fk" FOREIGN KEY ("case_id") REFERENCES "public"."inventory_accounting_cases"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_accounting_case_events" ADD CONSTRAINT "inventory_accounting_event_case_company_fk" FOREIGN KEY ("case_id","realm_id","environment") REFERENCES "public"."inventory_accounting_cases"("id","realm_id","environment") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_accounting_case_returns" ADD CONSTRAINT "inventory_case_return_movement_fk" FOREIGN KEY ("return_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_accounting_case_returns" ADD CONSTRAINT "inventory_accounting_return_case_company_fk" FOREIGN KEY ("case_id","realm_id","environment") REFERENCES "public"."inventory_accounting_cases"("id","realm_id","environment") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_accounting_cases" ADD CONSTRAINT "inventory_accounting_cases_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory_accounting_cases" ADD CONSTRAINT "inventory_accounting_cases_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_bill_coverage_bindings" ADD CONSTRAINT "vbc_binding_allocation_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."vendor_bill_receipt_allocations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_bill_coverage_bindings" ADD CONSTRAINT "vbc_binding_bill_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."quickbooks_sync_jobs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_bill_coverage_bindings" ADD CONSTRAINT "vendor_bill_binding_approval_company_fk" FOREIGN KEY ("approval_id","realm_id","environment") REFERENCES "public"."vendor_bill_coverage_approvals"("id","realm_id","environment") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_bill_documents" ADD CONSTRAINT "vendor_bill_documents_bill_id_quickbooks_sync_jobs_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."quickbooks_sync_jobs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_bill_receipt_allocations" ADD CONSTRAINT "vbc_allocation_receipt_fk" FOREIGN KEY ("receipt_line_id") REFERENCES "public"."purchase_receipt_lines"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_bill_receipt_allocations" ADD CONSTRAINT "vbc_allocation_bill_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."quickbooks_sync_jobs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_bill_receipt_allocations" ADD CONSTRAINT "vbc_allocation_product_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vendor_bill_receipt_allocations" ADD CONSTRAINT "vendor_bill_allocation_approval_mode_fk" FOREIGN KEY ("approval_id","mode") REFERENCES "public"."vendor_bill_coverage_approvals"("id","mode") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION catalyst_preserve_bill_coverage_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Reviewed bill coverage, original-file claims and accounting review history are immutable; append an explicit new review without rewriting source or freeing covered quantity.' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER vendor_bill_coverage_approval_preserved BEFORE UPDATE OR DELETE ON vendor_bill_coverage_approvals FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_bill_coverage_history();
--> statement-breakpoint
CREATE TRIGGER vendor_bill_receipt_allocation_preserved BEFORE UPDATE OR DELETE ON vendor_bill_receipt_allocations FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_bill_coverage_history();
--> statement-breakpoint
CREATE TRIGGER vendor_bill_coverage_binding_preserved BEFORE UPDATE OR DELETE ON vendor_bill_coverage_bindings FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_bill_coverage_history();
--> statement-breakpoint
CREATE TRIGGER vendor_bill_document_preserved BEFORE UPDATE OR DELETE ON vendor_bill_documents FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_bill_coverage_history();
--> statement-breakpoint
CREATE TRIGGER inventory_accounting_case_preserved BEFORE UPDATE OR DELETE ON inventory_accounting_cases FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_bill_coverage_history();
--> statement-breakpoint
CREATE TRIGGER inventory_accounting_case_return_preserved BEFORE UPDATE OR DELETE ON inventory_accounting_case_returns FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_bill_coverage_history();
--> statement-breakpoint
CREATE TRIGGER inventory_accounting_case_event_preserved BEFORE UPDATE OR DELETE ON inventory_accounting_case_events FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_bill_coverage_history();
--> statement-breakpoint
CREATE FUNCTION catalyst_coverage_rounding_valid(proof jsonb,entry jsonb,price supplier_buy_prices,receipt_cost numeric,bill_cost numeric,bill_quantity numeric) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE buy_quantity numeric; buy_cost numeric; factor numeric; printed numeric; received numeric; billed numeric; stock numeric;
BEGIN
 IF proof IS NULL OR jsonb_typeof(proof)<>'object' OR proof->>'version' IS DISTINCT FROM '1' THEN RETURN false; END IF;
 buy_quantity:=(proof->>'buyQuantity')::numeric;buy_cost:=(proof->>'buyUnitCost')::numeric;factor:=(proof->>'stockUnitsPerBuyUnit')::numeric;
 printed:=(proof->>'printedLineAmountCents')::numeric;received:=(proof->>'receiptStockUnitCost')::numeric;billed:=(proof->>'billedStockUnitCost')::numeric;stock:=(proof->>'stockQuantity')::numeric;
 RETURN COALESCE(buy_quantity>0 AND factor>1 AND stock>0 AND printed>=0 AND printed=trunc(printed)
  AND buy_cost=price.unit_cost AND buy_cost=(proof->>'approvedBuyUnitCost')::numeric
  AND factor=price.stock_units_per_buy_unit AND factor=(proof->>'approvedStockUnitsPerBuyUnit')::numeric
  AND buy_quantity=(entry->>'quantity')::numeric AND buy_cost=(entry->>'billedUnitCost')::numeric
  AND factor=(entry#>>'{stockConversion,unitsPerBuyUnit}')::numeric AND printed=(entry->>'totalCents')::numeric
  AND stock=bill_quantity AND received=receipt_cost AND billed=bill_cost
  AND buy_quantity*factor=stock AND round(buy_cost/factor,6)=billed
  AND abs(billed-received)=0.000001
  AND round(buy_quantity*buy_cost*100)=printed AND round(stock*billed*100)=printed AND round(stock*received*100)=printed,false);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero THEN RETURN false;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION catalyst_check_vendor_bill_receipt_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt record; bill record; entry jsonb; allowed numeric; used numeric; price supplier_buy_prices%ROWTYPE;
BEGIN
 -- Same order as the HTTP commit: receipt lines, then bill queue rows. The
 -- receipt lock also serializes endorsements against the original allocation.
 SELECT r.*,p.product_id,p.unit,o.supplier,m.kind,m.product_id AS movement_product,m.acquisition_unit_cost
 INTO receipt FROM purchase_receipt_lines r JOIN purchase_order_lines p ON p.id=r.line_id
 JOIN purchase_receipts h ON h.id=r.receipt_id JOIN purchase_orders o ON o.id=h.order_id AND o.id=p.order_id
 JOIN inventory_movements m ON m.id=r.movement_id WHERE r.id=NEW.receipt_line_id FOR UPDATE OF r;
 SELECT * INTO bill FROM quickbooks_sync_jobs WHERE id=NEW.bill_id FOR UPDATE;
 IF receipt.id IS NULL OR bill.id IS NULL OR bill.entity_type<>'vendor_bill' OR receipt.quantity<=0
  OR receipt.kind<>'receipt' OR receipt.product_id<>NEW.product_id OR receipt.movement_product<>NEW.product_id
  OR receipt.unit<>NEW.stock_unit OR receipt.acquisition_unit_cost IS NULL OR receipt.acquisition_unit_cost<>NEW.receipt_unit_cost
  OR bill.payload-'postedId'-'reconciledExisting'<>NEW.bill_source THEN
  RAISE EXCEPTION 'Coverage must retain the exact accepted purchase receipt, stock unit, acquisition cost and immutable bill source.' USING ERRCODE='23514';
 END IF;
 entry:=bill.payload->'lines'->NEW.bill_line_index;
 SELECT * INTO price FROM supplier_buy_prices WHERE id=NEW.price_id;
 IF NEW.identity_snapshot->>'varianceClassification'='unit_conversion_rounding'
 AND NOT catalyst_coverage_rounding_valid(NEW.identity_snapshot->'roundingEvidence',entry,price,NEW.receipt_unit_cost,NEW.billed_unit_cost,NEW.bill_line_quantity) THEN
  RAISE EXCEPTION 'A rounding label must retain the actual approved buy price, factor and printed source arithmetic; it cannot hide a price difference.' USING ERRCODE='23514';
 END IF;
 IF entry IS NULL OR jsonb_typeof(entry)<>'object'
  OR lower(btrim(COALESCE(bill.payload->>'supplier','')))<>lower(btrim(receipt.supplier))
  OR COALESCE((entry#>>'{stockLine,quantity}')::numeric,(entry->>'quantity')::numeric) IS DISTINCT FROM NEW.bill_line_quantity
  OR COALESCE((entry#>>'{stockLine,unitCost}')::numeric,(entry->>'billedUnitCost')::numeric) IS DISTINCT FROM NEW.billed_unit_cost
  OR NOT EXISTS(SELECT 1 FROM products p JOIN supplier_product_aliases a ON a.product_id=p.id
   JOIN supplier_buy_prices v ON v.alias_id=a.id WHERE p.id=NEW.product_id AND p.unit=NEW.stock_unit
   AND p.sku=entry->>'internalSku' AND a.id=NEW.alias_id AND v.id=NEW.price_id
   AND a.supplier_key=lower(btrim(receipt.supplier))) THEN
  RAISE EXCEPTION 'Coverage requires one exact merchandise-line identity and actual supplier/product/price binding.' USING ERRCODE='23514';
 END IF;
 IF (NEW.mode='local_review' AND (COALESCE(bill.payload->>'mode','')<>'review' OR bill.status<>'reviewed'))
  OR (NEW.mode='quickbooks_verified' AND (COALESCE(bill.payload->>'mode','') NOT IN ('sandbox','production') OR bill.status<>'completed' OR NOT (COALESCE(bill.payload->>'postedId','') ~ '^[0-9]{1,30}$'))) THEN
  RAISE EXCEPTION 'Local reviews and confirmed posted-company bill sources are separate coverage dispositions.' USING ERRCODE='23514';
 END IF;
 SELECT COALESCE(sum(quantity),0) INTO used FROM vendor_bill_receipt_allocations WHERE receipt_line_id=NEW.receipt_line_id;
 IF used+NEW.quantity>receipt.quantity THEN
  RAISE EXCEPTION 'Coverage exceeds the exact accepted receipt quantity; damages, returns or another company do not replenish coverage.' USING ERRCODE='23514';
 END IF;
 IF NEW.mode='local_review' THEN
  SELECT COALESCE(sum(quantity),0) INTO used FROM vendor_bill_receipt_allocations WHERE bill_id=NEW.bill_id AND bill_line_index=NEW.bill_line_index;
  IF used+NEW.quantity>NEW.bill_line_quantity THEN RAISE EXCEPTION 'Coverage exceeds the original local bill merchandise quantity.' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER vendor_bill_receipt_coverage_bound BEFORE INSERT ON vendor_bill_receipt_allocations FOR EACH ROW EXECUTE FUNCTION catalyst_check_vendor_bill_receipt_coverage();
--> statement-breakpoint
CREATE FUNCTION catalyst_check_vendor_bill_provider_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE base vendor_bill_receipt_allocations%ROWTYPE; bill quickbooks_sync_jobs%ROWTYPE; used numeric; entry jsonb; approval vendor_bill_coverage_approvals%ROWTYPE; price supplier_buy_prices%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(1959031411);
 SELECT * INTO base FROM vendor_bill_receipt_allocations WHERE id=NEW.allocation_id;
 IF base.id IS NULL THEN RAISE EXCEPTION 'Original received-stock coverage was not found.' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM purchase_receipt_lines WHERE id=base.receipt_line_id FOR UPDATE;
 PERFORM 1 FROM quickbooks_sync_jobs WHERE id IN (base.bill_id,NEW.bill_id) ORDER BY id FOR UPDATE;
 SELECT * INTO bill FROM quickbooks_sync_jobs WHERE id=NEW.bill_id;
 SELECT * INTO approval FROM vendor_bill_coverage_approvals WHERE id=NEW.approval_id;
 IF approval.mode IS DISTINCT FROM 'quickbooks_verified' OR approval.connection_id IS DISTINCT FROM NEW.connection_id THEN
  RAISE EXCEPTION 'Provider evidence requires the exact immutable approved connection, not only a coincident realm.' USING ERRCODE='23514';
 END IF;
 entry:=bill.payload->'lines'->NEW.bill_line_index;
 IF bill.id IS NULL OR bill.entity_type<>'vendor_bill' OR bill.status<>'completed' OR bill.payload->>'mode' IS DISTINCT FROM NEW.environment
  OR bill.payload->>'realmId' IS DISTINCT FROM NEW.realm_id OR bill.payload->>'postedId' IS DISTINCT FROM NEW.posted_bill_id
  OR bill.payload#>>'{quickBooksBill,VendorRef,value}' IS DISTINCT FROM NEW.vendor_id
  OR bill.payload#>>ARRAY['quickBooksBill','Line',NEW.bill_line_index::text,'ItemBasedExpenseLineDetail','ItemRef','value'] IS DISTINCT FROM NEW.item_id
  OR bill.payload-'postedId'-'reconciledExisting' IS DISTINCT FROM NEW.bill_source OR entry IS NULL
  OR COALESCE((entry#>>'{stockLine,quantity}')::numeric,(entry->>'quantity')::numeric) IS DISTINCT FROM NEW.bill_line_quantity
  OR COALESCE((entry#>>'{stockLine,unitCost}')::numeric,(entry->>'billedUnitCost')::numeric) IS DISTINCT FROM NEW.billed_unit_cost THEN
  RAISE EXCEPTION 'Provider evidence must retain the exact current company, posted bill and immutable stock-unit merchandise line.' USING ERRCODE='23514';
 END IF;
 SELECT * INTO price FROM supplier_buy_prices WHERE id=NEW.identity_snapshot#>>'{price,id}';
 IF NEW.identity_snapshot->>'varianceClassification'='unit_conversion_rounding'
 AND NOT catalyst_coverage_rounding_valid(NEW.identity_snapshot->'roundingEvidence',entry,price,base.receipt_unit_cost,NEW.billed_unit_cost,NEW.bill_line_quantity) THEN
  RAISE EXCEPTION 'Provider rounding evidence must retain its exact approved source conversion.' USING ERRCODE='23514';
 END IF;
 IF base.mode='quickbooks_verified' AND (base.bill_id<>NEW.bill_id OR base.bill_line_index<>NEW.bill_line_index OR base.billed_unit_cost<>NEW.billed_unit_cost) THEN
  RAISE EXCEPTION 'Direct verified coverage must bind its own original bill line without replacement.' USING ERRCODE='23514';
 END IF;
 IF base.mode='local_review' AND (lower(btrim(COALESCE(base.bill_source->>'billNumber',base.bill_source#>>'{quickBooksBill,DocNumber}','')))<>lower(btrim(COALESCE(NEW.bill_source->>'billNumber',NEW.bill_source#>>'{quickBooksBill,DocNumber}','')))
  OR lower(btrim(COALESCE(base.bill_source->>'supplier','')))<>lower(btrim(COALESCE(NEW.bill_source->>'supplier','')))) THEN
  RAISE EXCEPTION 'Appending provider evidence requires the same original local supplier bill identity.' USING ERRCODE='23514';
 END IF;
 IF base.receipt_unit_cost<>NEW.billed_unit_cost AND length(btrim(NEW.variance_note))<10 THEN
  RAISE EXCEPTION 'Retain an explicit receipt-cost versus provider-cost variance review.' USING ERRCODE='23514';
 END IF;
 IF base.billed_unit_cost<>NEW.billed_unit_cost AND length(btrim(NEW.reconciliation_note))<10 THEN
  RAISE EXCEPTION 'Separately review a changed original local bill price; never overwrite historical costs.' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM vendor_bill_coverage_bindings WHERE realm_id=NEW.realm_id AND environment=NEW.environment AND posted_bill_id=NEW.posted_bill_id AND bill_id<>NEW.bill_id) THEN
  RAISE EXCEPTION 'One actual posted bill must retain one immutable queue source; reordered duplicate queue copies cannot create merchandise-line capacity.' USING ERRCODE='23514';
 END IF;
 SELECT COALESCE(sum(quantity),0) INTO used FROM vendor_bill_coverage_bindings WHERE allocation_id=NEW.allocation_id;
 IF used+NEW.quantity>base.quantity THEN RAISE EXCEPTION 'Provider evidence exceeds the original stock coverage across companies.' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(sum(quantity),0) INTO used FROM vendor_bill_coverage_bindings WHERE realm_id=NEW.realm_id AND environment=NEW.environment AND posted_bill_id=NEW.posted_bill_id AND bill_line_index=NEW.bill_line_index;
 IF used+NEW.quantity>NEW.bill_line_quantity THEN RAISE EXCEPTION 'Provider evidence exceeds the posted bill line quantity.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER vendor_bill_provider_coverage_bound BEFORE INSERT ON vendor_bill_coverage_bindings FOR EACH ROW EXECUTE FUNCTION catalyst_check_vendor_bill_provider_coverage();
--> statement-breakpoint
CREATE FUNCTION catalyst_preserve_covered_bill_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.payload->'postedId') IS DISTINCT FROM (OLD.payload->'postedId')
 AND EXISTS(SELECT 1 FROM vendor_bill_coverage_bindings WHERE bill_id=OLD.id) THEN
  RAISE EXCEPTION 'A coverage-bound posted provider bill identifier cannot be replaced.' USING ERRCODE='23514';
 END IF;
 IF (NEW.payload-'postedId'-'reconciledExisting') IS DISTINCT FROM (OLD.payload-'postedId'-'reconciledExisting')
 AND (EXISTS(SELECT 1 FROM vendor_bill_receipt_allocations WHERE bill_id=OLD.id)
  OR EXISTS(SELECT 1 FROM vendor_bill_coverage_bindings WHERE bill_id=OLD.id)
  OR EXISTS(SELECT 1 FROM vendor_bill_documents WHERE bill_id=OLD.id)) THEN
  RAISE EXCEPTION 'A retained supplier bill source cannot be replaced; posting results may be appended without changing original lines, identifiers or prices.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER covered_vendor_bill_source_preserved BEFORE UPDATE ON quickbooks_sync_jobs FOR EACH ROW EXECUTE FUNCTION catalyst_preserve_covered_bill_source();
--> statement-breakpoint
CREATE FUNCTION catalyst_check_inventory_accounting_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent inventory_accounting_cases%ROWTYPE; returned inventory_movements%ROWTYPE; amount numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(1959031411);
 SELECT * INTO parent FROM inventory_accounting_cases WHERE id=NEW.case_id FOR UPDATE;
 SELECT * INTO returned FROM inventory_movements WHERE id=NEW.return_id FOR SHARE;
 IF parent.id IS NULL OR parent.kind<>'return_quantity_plan' OR parent.source_snapshot#>>'{plan,kind}' IS DISTINCT FROM 'ready_quantity_plan'
  OR returned.id IS NULL OR returned.kind<>'return' OR returned.return_of_movement_id IS NULL OR returned.quantity<=0
  OR returned.product_id IS DISTINCT FROM parent.product_id OR returned.job_id IS DISTINCT FROM parent.job_id
  OR jsonb_typeof(parent.source_snapshot#>'{plan,returnQuantities}') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'A return claim requires the exact original positive returned stock and approved quantity plan in this company.' USING ERRCODE='23514';
 END IF;
 SELECT (entry->>'quantity')::numeric INTO amount FROM jsonb_array_elements(parent.source_snapshot#>'{plan,returnQuantities}') entry WHERE entry->>'returnId'=NEW.return_id;
 IF amount IS NULL OR amount<=0 OR amount>returned.quantity::numeric THEN
  RAISE EXCEPTION 'A claim cannot reserve more than its immutable original returned quantity.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inventory_accounting_return_claim_bound BEFORE INSERT ON inventory_accounting_case_returns FOR EACH ROW EXECUTE FUNCTION catalyst_check_inventory_accounting_claim();
