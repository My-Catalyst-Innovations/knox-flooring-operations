CREATE TABLE "physical_stock_piece_events" (
	"id" text PRIMARY KEY NOT NULL,
	"piece_id" text NOT NULL,
	"child_id" text,
	"movement_id" text,
	"action" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "physical_stock_piece_events_action_valid" CHECK ("physical_stock_piece_events"."action" IN ('registered', 'cut', 'moved', 'issued', 'returned')),
	CONSTRAINT "physical_stock_piece_events_links_valid" CHECK (("physical_stock_piece_events"."child_id" IS NOT NULL) = ("physical_stock_piece_events"."action" = 'cut') AND ("physical_stock_piece_events"."movement_id" IS NOT NULL) = ("physical_stock_piece_events"."action" IN ('moved', 'issued', 'returned')))
);
--> statement-breakpoint
CREATE TABLE "physical_stock_pieces" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"parent_id" text,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"lot" text DEFAULT '' NOT NULL,
	"width_inches" double precision NOT NULL,
	"length_inches" double precision NOT NULL,
	"quantity" double precision NOT NULL,
	"warehouse_id" text NOT NULL,
	"bin_id" text,
	"issued_movement_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "physical_stock_pieces_dimensions_valid" CHECK ("physical_stock_pieces"."width_inches" > 0 AND "physical_stock_pieces"."width_inches" <= 1200 AND "physical_stock_pieces"."length_inches" > 0 AND "physical_stock_pieces"."length_inches" <= 120000 AND "physical_stock_pieces"."quantity" > 0 AND "physical_stock_pieces"."quantity" <= 1000000),
	CONSTRAINT "physical_stock_pieces_kind_valid" CHECK ("physical_stock_pieces"."kind" IN ('Roll', 'Remnant')),
	CONSTRAINT "physical_stock_pieces_label_valid" CHECK (char_length("physical_stock_pieces"."label") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "job_id" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "expected_on" date;--> statement-breakpoint
ALTER TABLE "physical_stock_piece_events" ADD CONSTRAINT "physical_stock_piece_events_piece_fk" FOREIGN KEY ("piece_id") REFERENCES "public"."physical_stock_pieces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_stock_piece_events" ADD CONSTRAINT "physical_stock_piece_events_child_fk" FOREIGN KEY ("child_id") REFERENCES "public"."physical_stock_pieces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_stock_piece_events" ADD CONSTRAINT "physical_stock_piece_events_move_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_stock_pieces" ADD CONSTRAINT "physical_stock_pieces_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_stock_pieces" ADD CONSTRAINT "physical_stock_pieces_parent_id_physical_stock_pieces_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."physical_stock_pieces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_stock_pieces" ADD CONSTRAINT "physical_stock_pieces_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_stock_pieces" ADD CONSTRAINT "physical_stock_pieces_issue_fk" FOREIGN KEY ("issued_movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_stock_pieces" ADD CONSTRAINT "physical_stock_pieces_bin_warehouse_fk" FOREIGN KEY ("bin_id","warehouse_id") REFERENCES "public"."warehouse_bins"("id","warehouse_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "physical_stock_piece_events_request_unique" ON "physical_stock_piece_events" USING btree ("request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "physical_stock_piece_events_movement_unique" ON "physical_stock_piece_events" USING btree ("movement_id");--> statement-breakpoint
CREATE INDEX "physical_stock_piece_events_piece_time_idx" ON "physical_stock_piece_events" USING btree ("piece_id","created_at");--> statement-breakpoint
CREATE INDEX "physical_stock_piece_events_child_idx" ON "physical_stock_piece_events" USING btree ("child_id");--> statement-breakpoint
CREATE UNIQUE INDEX "physical_stock_pieces_label_unique" ON "physical_stock_pieces" USING btree (lower("label"));--> statement-breakpoint
CREATE UNIQUE INDEX "physical_stock_pieces_active_issue_unique" ON "physical_stock_pieces" USING btree ("issued_movement_id");--> statement-breakpoint
CREATE INDEX "physical_stock_pieces_location_idx" ON "physical_stock_pieces" USING btree ("product_id","warehouse_id","bin_id");--> statement-breakpoint
CREATE INDEX "physical_stock_pieces_parent_idx" ON "physical_stock_pieces" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_orders_job_id_idx" ON "purchase_orders" USING btree ("job_id");