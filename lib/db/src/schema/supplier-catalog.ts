import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { productsTable } from "./products";

export const supplierProductAliasesTable = pgTable(
  "supplier_product_aliases",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    supplier: text("supplier").notNull(),
    supplierKey: text("supplier_key").notNull(),
    supplierSku: text("supplier_sku").notNull(),
    supplierSkuKey: text("supplier_sku_key").notNull(),
    manufacturerPartNumber: text("manufacturer_part_number"),
    approvedBy: text("approved_by").notNull(),
    approvedAt: text("approved_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "supplier_product_aliases_product_fk",
      columns: [table.productId],
      foreignColumns: [productsTable.id],
    }).onDelete("restrict"),
    uniqueIndex("supplier_product_aliases_supplier_sku_unique").on(
      table.supplierKey,
      table.supplierSkuKey,
    ),
    index("supplier_product_aliases_product_idx").on(table.productId),
  ],
);

export const supplierBuyPricesTable = pgTable(
  "supplier_buy_prices",
  {
    id: text("id").primaryKey(),
    aliasId: text("alias_id").notNull(),
    unit: text("unit").notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 6 }).notNull(),
    effectiveOn: date("effective_on").notNull(),
    source: text("source").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: text("approved_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "supplier_buy_prices_alias_fk",
      columns: [table.aliasId],
      foreignColumns: [supplierProductAliasesTable.id],
    }).onDelete("restrict"),
    uniqueIndex("supplier_buy_prices_alias_date_unique").on(
      table.aliasId,
      table.effectiveOn,
    ),
    check(
      "supplier_buy_prices_cost_valid",
      sql`${table.unitCost} >= 0 AND ${table.unitCost} <> 'NaN'::numeric`,
    ),
  ],
);
