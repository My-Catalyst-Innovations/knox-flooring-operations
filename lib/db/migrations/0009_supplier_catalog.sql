CREATE TABLE "supplier_product_aliases" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL,
  "supplier" text NOT NULL,
  "supplier_key" text NOT NULL,
  "supplier_sku" text NOT NULL,
  "supplier_sku_key" text NOT NULL,
  "manufacturer_part_number" text,
  "approved_by" text NOT NULL,
  "approved_at" text NOT NULL,
  CONSTRAINT "supplier_product_aliases_product_fk" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_product_aliases_supplier_sku_unique" ON "supplier_product_aliases" ("supplier_key", "supplier_sku_key");
--> statement-breakpoint
CREATE INDEX "supplier_product_aliases_product_idx" ON "supplier_product_aliases" ("product_id");
--> statement-breakpoint
CREATE TABLE "supplier_buy_prices" (
  "id" text PRIMARY KEY NOT NULL,
  "alias_id" text NOT NULL,
  "unit" text NOT NULL,
  "unit_cost" numeric(18, 6) NOT NULL,
  "effective_on" date NOT NULL,
  "source" text NOT NULL,
  "approved_by" text NOT NULL,
  "approved_at" text NOT NULL,
  CONSTRAINT "supplier_buy_prices_alias_fk" FOREIGN KEY ("alias_id") REFERENCES "supplier_product_aliases" ("id") ON DELETE RESTRICT,
  CONSTRAINT "supplier_buy_prices_cost_valid" CHECK ("unit_cost" >= 0 AND "unit_cost" <> 'NaN'::numeric)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_buy_prices_alias_date_unique" ON "supplier_buy_prices" ("alias_id", "effective_on");
--> statement-breakpoint
ALTER TABLE "quickbooks_entity_mappings" ADD COLUMN "realm_id" text, ADD COLUMN "environment" text;
