import { sql } from "drizzle-orm";
import { check, doublePrecision, foreignKey, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { inventoryMovementsTable, warehouseBinsTable, warehousesTable } from "./operations";
import { productsTable } from "./products";

export const inventoryStockCountsTable = pgTable("inventory_stock_counts", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => productsTable.id, { onDelete: "restrict" }),
  warehouseId: text("warehouse_id").notNull().references(() => warehousesTable.id, { onDelete: "restrict" }),
  binId: text("bin_id"),
  sku: text("sku").notNull(),
  productName: text("product_name").notNull(),
  unit: text("unit").notNull(),
  bookedQuantity: doublePrecision("booked_quantity").notNull(),
  countedQuantity: doublePrecision("counted_quantity").notNull(),
  reason: text("reason").$type<"count" | "damage" | "waste">().notNull(),
  note: text("note").notNull().default(""),
  status: text("status").$type<"Pending" | "Reconciled" | "Dismissed">().notNull().default("Pending"),
  snapshotKey: text("snapshot_key").notNull(),
  requestKey: text("request_key").notNull(),
  requestHash: text("request_hash").notNull(),
  countedBy: text("counted_by").notNull(),
  counterName: text("counter_name").notNull(),
  createdAt: text("created_at").notNull(),
  movementId: text("movement_id").references(() => inventoryMovementsTable.id, { onDelete: "restrict" }),
  resolvedBy: text("resolved_by"),
  reviewerName: text("reviewer_name"),
  resolvedAt: text("resolved_at"),
  resolutionNote: text("resolution_note"),
}, (table) => [
  uniqueIndex("inventory_stock_counts_request_unique").on(table.requestKey),
  uniqueIndex("inventory_stock_counts_movement_unique").on(table.movementId),
  index("inventory_stock_counts_warehouse_date_idx").on(table.warehouseId, table.createdAt),
  index("inventory_stock_counts_product_idx").on(table.productId),
  index("inventory_stock_counts_status_resolved_idx").on(table.status, table.resolvedAt),
  foreignKey({ columns: [table.binId, table.warehouseId], foreignColumns: [warehouseBinsTable.id, warehouseBinsTable.warehouseId], name: "inventory_stock_counts_bin_warehouse_fk" }).onDelete("restrict"),
  check("inventory_stock_counts_quantities", sql`${table.bookedQuantity} > '-Infinity'::double precision AND ${table.bookedQuantity} < 'Infinity'::double precision AND ${table.countedQuantity} >= 0 AND ${table.countedQuantity} <= 1000000`),
  check("inventory_stock_counts_reason", sql`${table.reason} IN ('count', 'damage', 'waste') AND (${table.reason} = 'count' OR ${table.countedQuantity} < ${table.bookedQuantity})`),
  check("inventory_stock_counts_note", sql`char_length(${table.note}) <= 500 AND (${table.countedQuantity} = ${table.bookedQuantity} OR char_length(btrim(${table.note})) > 0)`),
  check("inventory_stock_counts_status", sql`${table.status} IN ('Pending', 'Reconciled', 'Dismissed') AND (${table.status} = 'Pending') = (${table.resolvedAt} IS NULL) AND (${table.resolvedAt} IS NULL) = (${table.resolvedBy} IS NULL) AND (${table.resolvedAt} IS NULL) = (${table.reviewerName} IS NULL)`),
  check("inventory_stock_counts_resolution", sql`(${table.movementId} IS NOT NULL) = (${table.status} = 'Reconciled' AND ${table.bookedQuantity} <> ${table.countedQuantity}) AND (${table.status} = 'Dismissed') = (${table.resolutionNote} IS NOT NULL) AND (${table.resolutionNote} IS NULL OR char_length(btrim(${table.resolutionNote})) BETWEEN 1 AND 500)`),
]);

export type InventoryStockCount = typeof inventoryStockCountsTable.$inferSelect;
