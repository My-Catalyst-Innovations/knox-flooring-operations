CREATE TABLE "warehouses" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_name_unique" ON "warehouses" (lower("name"));--> statement-breakpoint
CREATE TABLE "inventory_transfers" (
  "id" text PRIMARY KEY,
  "product_id" text NOT NULL,
  "source_warehouse_id" text,
  "destination_warehouse_id" text NOT NULL,
  "quantity" real NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "dispatched_by" text NOT NULL,
  "received_by" text,
  "received_at" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "inventory_transfers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE restrict,
  CONSTRAINT "inventory_transfers_source_warehouse_id_warehouses_id_fk" FOREIGN KEY ("source_warehouse_id") REFERENCES "warehouses"("id") ON DELETE restrict,
  CONSTRAINT "inventory_transfers_destination_warehouse_id_warehouses_id_fk" FOREIGN KEY ("destination_warehouse_id") REFERENCES "warehouses"("id") ON DELETE restrict,
  CONSTRAINT "inventory_transfers_positive_quantity" CHECK ("quantity" > 0 AND "quantity" < 'Infinity'::real),
  CONSTRAINT "inventory_transfers_distinct_warehouses" CHECK ("source_warehouse_id" IS DISTINCT FROM "destination_warehouse_id"),
  CONSTRAINT "inventory_transfers_valid_status" CHECK ("status" IN ('In transit', 'Received'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_transfers_idempotency_unique" ON "inventory_transfers" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "inventory_transfers_product_idx" ON "inventory_transfers" ("product_id");--> statement-breakpoint
ALTER TABLE "inventory_movements"
  ADD COLUMN "warehouse_id" text,
  ADD COLUMN "transfer_id" text,
  ADD COLUMN "return_of_movement_id" text,
  ADD CONSTRAINT "inventory_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE restrict,
  ADD CONSTRAINT "inventory_movements_transfer_id_inventory_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "inventory_transfers"("id") ON DELETE restrict,
  ADD CONSTRAINT "inventory_movements_return_of_fk" FOREIGN KEY ("return_of_movement_id") REFERENCES "inventory_movements"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "inventory_reservations"
  ADD COLUMN "warehouse_id" text,
  ADD CONSTRAINT "inventory_reservations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE restrict;--> statement-breakpoint
CREATE INDEX "inventory_movements_product_warehouse_idx" ON "inventory_movements" ("product_id", "warehouse_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_return_of_idx" ON "inventory_movements" ("return_of_movement_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_product_warehouse_idx" ON "inventory_reservations" ("product_id", "warehouse_id");
