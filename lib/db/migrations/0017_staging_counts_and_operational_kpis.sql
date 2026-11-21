CREATE TABLE "inventory_stock_counts" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"bin_id" text,
	"sku" text NOT NULL,
	"product_name" text NOT NULL,
	"unit" text NOT NULL,
	"booked_quantity" double precision NOT NULL,
	"counted_quantity" double precision NOT NULL,
	"reason" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"snapshot_key" text NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"counted_by" text NOT NULL,
	"counter_name" text NOT NULL,
	"created_at" text NOT NULL,
	"movement_id" text,
	"resolved_by" text,
	"reviewer_name" text,
	"resolved_at" text,
	"resolution_note" text,
	CONSTRAINT "inventory_stock_counts_quantities" CHECK ("inventory_stock_counts"."booked_quantity" > '-Infinity'::double precision AND "inventory_stock_counts"."booked_quantity" < 'Infinity'::double precision AND "inventory_stock_counts"."counted_quantity" >= 0 AND "inventory_stock_counts"."counted_quantity" <= 1000000),
	CONSTRAINT "inventory_stock_counts_reason" CHECK ("inventory_stock_counts"."reason" IN ('count', 'damage', 'waste') AND ("inventory_stock_counts"."reason" = 'count' OR "inventory_stock_counts"."counted_quantity" < "inventory_stock_counts"."booked_quantity")),
	CONSTRAINT "inventory_stock_counts_note" CHECK (char_length("inventory_stock_counts"."note") <= 500 AND ("inventory_stock_counts"."counted_quantity" = "inventory_stock_counts"."booked_quantity" OR char_length(btrim("inventory_stock_counts"."note")) > 0)),
	CONSTRAINT "inventory_stock_counts_status" CHECK ("inventory_stock_counts"."status" IN ('Pending', 'Reconciled', 'Dismissed') AND ("inventory_stock_counts"."status" = 'Pending') = ("inventory_stock_counts"."resolved_at" IS NULL) AND ("inventory_stock_counts"."resolved_at" IS NULL) = ("inventory_stock_counts"."resolved_by" IS NULL) AND ("inventory_stock_counts"."resolved_at" IS NULL) = ("inventory_stock_counts"."reviewer_name" IS NULL)),
	CONSTRAINT "inventory_stock_counts_resolution" CHECK (("inventory_stock_counts"."movement_id" IS NOT NULL) = ("inventory_stock_counts"."status" = 'Reconciled' AND "inventory_stock_counts"."booked_quantity" <> "inventory_stock_counts"."counted_quantity") AND ("inventory_stock_counts"."status" = 'Dismissed') = ("inventory_stock_counts"."resolution_note" IS NOT NULL) AND ("inventory_stock_counts"."resolution_note" IS NULL OR char_length(btrim("inventory_stock_counts"."resolution_note")) BETWEEN 1 AND 500))
);
--> statement-breakpoint
ALTER TABLE "inventory_transfers" DROP CONSTRAINT "inventory_transfers_distinct_warehouses";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "committed_completion_date" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "committed_completion_recorded_at" text;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD COLUMN "staged_bin_id" text;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD COLUMN "source_reservation_id" text;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD COLUMN "staged_transfer_id" text;--> statement-breakpoint
ALTER TABLE "inventory_stock_counts" ADD CONSTRAINT "inventory_stock_counts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_counts" ADD CONSTRAINT "inventory_stock_counts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_counts" ADD CONSTRAINT "inventory_stock_counts_movement_id_inventory_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_counts" ADD CONSTRAINT "inventory_stock_counts_bin_warehouse_fk" FOREIGN KEY ("bin_id","warehouse_id") REFERENCES "public"."warehouse_bins"("id","warehouse_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_counts_request_unique" ON "inventory_stock_counts" USING btree ("request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_counts_movement_unique" ON "inventory_stock_counts" USING btree ("movement_id");--> statement-breakpoint
CREATE INDEX "inventory_stock_counts_warehouse_date_idx" ON "inventory_stock_counts" USING btree ("warehouse_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_stock_counts_product_idx" ON "inventory_stock_counts" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "inventory_stock_counts_status_resolved_idx" ON "inventory_stock_counts" USING btree ("status","resolved_at");--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservation_staging_bin_fk" FOREIGN KEY ("staged_bin_id","warehouse_id") REFERENCES "public"."warehouse_bins"("id","warehouse_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservation_source_fk" FOREIGN KEY ("source_reservation_id") REFERENCES "public"."inventory_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservation_staged_transfer_fk" FOREIGN KEY ("staged_transfer_id") REFERENCES "public"."inventory_transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_movements_created_at_idx" ON "inventory_movements" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "inventory_reservations_staging_bin_idx" ON "inventory_reservations" USING btree ("staged_bin_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_source_idx" ON "inventory_reservations" USING btree ("source_reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservations_staged_transfer_idx" ON "inventory_reservations" USING btree ("staged_transfer_id");--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_staging_links_valid" CHECK (("inventory_reservations"."staged_bin_id" IS NULL AND "inventory_reservations"."source_reservation_id" IS NULL AND "inventory_reservations"."staged_transfer_id" IS NULL) OR ("inventory_reservations"."warehouse_id" IS NOT NULL AND "inventory_reservations"."staged_bin_id" IS NOT NULL AND "inventory_reservations"."source_reservation_id" IS NOT NULL AND "inventory_reservations"."staged_transfer_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_distinct_locations" CHECK ("inventory_transfers"."source_warehouse_id" IS DISTINCT FROM "inventory_transfers"."destination_warehouse_id" OR "inventory_transfers"."source_bin_id" IS DISTINCT FROM "inventory_transfers"."destination_bin_id");