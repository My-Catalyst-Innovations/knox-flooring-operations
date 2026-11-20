ALTER TABLE "inventory_movements" ADD COLUMN "acquisition_unit_cost" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "cost_allocations" jsonb;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_acquisition_cost_valid" CHECK ("inventory_movements"."acquisition_unit_cost" IS NULL OR ("inventory_movements"."kind" = 'receipt' AND "inventory_movements"."acquisition_unit_cost" >= 0 AND "inventory_movements"."acquisition_unit_cost" < 'Infinity'::numeric));--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_cost_allocations_valid" CHECK ("inventory_movements"."cost_allocations" IS NULL OR jsonb_typeof("inventory_movements"."cost_allocations") = 'array');
--> statement-breakpoint
-- Preserve the quantities and charges that users previously saw when decoding REAL values.
SET LOCAL extra_float_digits = 1;
--> statement-breakpoint
ALTER TABLE "material_usage" ALTER COLUMN "quantity" SET DATA TYPE double precision USING ("quantity"::text::double precision);
--> statement-breakpoint
ALTER TABLE "material_usage" ALTER COLUMN "cost" SET DATA TYPE double precision USING ("cost"::text::double precision);
