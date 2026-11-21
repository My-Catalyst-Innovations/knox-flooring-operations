CREATE TABLE "catalyst_workspace_identity" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"workspace_key" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "catalyst_workspace_identity_singleton" CHECK ("catalyst_workspace_identity"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "supplier_buy_prices" ADD COLUMN "stock_units_per_buy_unit" numeric(18, 6) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_buy_prices" ADD CONSTRAINT "supplier_buy_prices_stock_factor_valid" CHECK ("supplier_buy_prices"."stock_units_per_buy_unit" > 0 AND "supplier_buy_prices"."stock_units_per_buy_unit" <= 1000000);