CREATE TABLE "warehouse_bins" (
	"id" text PRIMARY KEY NOT NULL,
	"warehouse_id" text NOT NULL,
	"code" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "warehouse_bins_id_warehouse_unique" UNIQUE("id","warehouse_id")
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"sku" text NOT NULL,
	"unit" text NOT NULL,
	"position" integer NOT NULL,
	"quantity" numeric(18, 6) NOT NULL,
	"unit_cost" numeric(18, 6) NOT NULL,
	CONSTRAINT "purchase_order_lines_quantity_valid" CHECK ("purchase_order_lines"."quantity" > 0 AND "purchase_order_lines"."quantity" < 'Infinity'::numeric),
	CONSTRAINT "purchase_order_lines_cost_valid" CHECK ("purchase_order_lines"."unit_cost" >= 0 AND "purchase_order_lines"."unit_cost" < 'Infinity'::numeric)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"number" serial NOT NULL,
	"warehouse_id" text NOT NULL,
	"supplier" text NOT NULL,
	"notes" text NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"request_key" text,
	"request_hash" text,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "purchase_orders_status_valid" CHECK ("purchase_orders"."status" in ('Draft', 'Ordered', 'Partially received', 'Received', 'Cancelled'))
);
--> statement-breakpoint
CREATE TABLE "purchase_receipt_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"receipt_id" text NOT NULL,
	"line_id" text NOT NULL,
	"movement_id" text NOT NULL,
	"quantity" numeric(18, 6) NOT NULL,
	CONSTRAINT "purchase_receipt_lines_quantity_valid" CHECK ("purchase_receipt_lines"."quantity" > 0 AND "purchase_receipt_lines"."quantity" < 'Infinity'::numeric)
);
--> statement-breakpoint
CREATE TABLE "purchase_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"reference" text NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"received_by" text NOT NULL,
	"received_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "bin_id" text;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD COLUMN "source_bin_id" text;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD COLUMN "destination_bin_id" text;--> statement-breakpoint
ALTER TABLE "warehouse_bins" ADD CONSTRAINT "warehouse_bins_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_order_id_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_receipt_id_purchase_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."purchase_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_movement_id_inventory_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_order_id_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_bins_warehouse_code_unique" ON "warehouse_bins" USING btree ("warehouse_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_order_product_unique" ON "purchase_order_lines" USING btree ("order_id","product_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_product_idx" ON "purchase_order_lines" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_number_unique" ON "purchase_orders" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_request_key_unique" ON "purchase_orders" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "purchase_orders_warehouse_idx" ON "purchase_orders" USING btree ("warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_receipt_lines_movement_unique" ON "purchase_receipt_lines" USING btree ("movement_id");--> statement-breakpoint
CREATE INDEX "purchase_receipt_lines_receipt_idx" ON "purchase_receipt_lines" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "purchase_receipt_lines_order_line_idx" ON "purchase_receipt_lines" USING btree ("line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_receipts_request_key_unique" ON "purchase_receipts" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "purchase_receipts_order_idx" ON "purchase_receipts" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_bin_warehouse_fk" FOREIGN KEY ("bin_id","warehouse_id") REFERENCES "public"."warehouse_bins"("id","warehouse_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_source_bin_warehouse_fk" FOREIGN KEY ("source_bin_id","source_warehouse_id") REFERENCES "public"."warehouse_bins"("id","warehouse_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_destination_bin_warehouse_fk" FOREIGN KEY ("destination_bin_id","destination_warehouse_id") REFERENCES "public"."warehouse_bins"("id","warehouse_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_movements_bin_warehouse_idx" ON "inventory_movements" USING btree ("bin_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "inventory_transfers_source_bin_idx" ON "inventory_transfers" USING btree ("source_bin_id","source_warehouse_id");--> statement-breakpoint
CREATE INDEX "inventory_transfers_destination_bin_idx" ON "inventory_transfers" USING btree ("destination_bin_id","destination_warehouse_id");--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_bin_requires_warehouse" CHECK ("inventory_movements"."bin_id" IS NULL OR "inventory_movements"."warehouse_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_source_bin_requires_warehouse" CHECK ("inventory_transfers"."source_bin_id" IS NULL OR "inventory_transfers"."source_warehouse_id" IS NOT NULL);