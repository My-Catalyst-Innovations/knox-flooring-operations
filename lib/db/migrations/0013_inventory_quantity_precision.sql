-- Preserve the decimal quantities returned for REAL columns by the database client.
SET LOCAL extra_float_digits = 1;
--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "quantity_on_hand" SET DATA TYPE double precision USING ("quantity_on_hand"::text::double precision);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "quantity" SET DATA TYPE double precision USING ("quantity"::text::double precision);
--> statement-breakpoint
ALTER TABLE "inventory_reservations" ALTER COLUMN "quantity" SET DATA TYPE double precision USING ("quantity"::text::double precision);
--> statement-breakpoint
ALTER TABLE "inventory_transfers" ALTER COLUMN "quantity" SET DATA TYPE double precision USING ("quantity"::text::double precision);
