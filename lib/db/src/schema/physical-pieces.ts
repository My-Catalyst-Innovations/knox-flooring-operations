import { sql } from "drizzle-orm";
import { check, doublePrecision, foreignKey, index, integer, jsonb, pgTable, text, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { inventoryMovementsTable, warehouseBinsTable, warehousesTable } from "./operations";
import { productsTable } from "./products";
import type { InventoryCostSlice } from "./operations";

export const physicalPiecesTable = pgTable("physical_stock_pieces", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => productsTable.id, { onDelete: "restrict" }),
  parentId: text("parent_id").references((): AnyPgColumn => physicalPiecesTable.id, { onDelete: "restrict" }),
  label: text("label").notNull(),
  kind: text("kind").$type<"Roll" | "Remnant">().notNull(),
  lot: text("lot").notNull().default(""),
  widthInches: doublePrecision("width_inches").notNull(),
  lengthInches: doublePrecision("length_inches").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  warehouseId: text("warehouse_id").notNull().references(() => warehousesTable.id, { onDelete: "restrict" }),
  binId: text("bin_id"),
  issuedMovementId: text("issued_movement_id"),
  costAllocations: jsonb("cost_allocations").$type<InventoryCostSlice[]>(),
  costReviewedBy: text("cost_reviewed_by"),
  costReviewedAt: text("cost_reviewed_at"),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("physical_stock_pieces_label_unique").on(sql`lower(${table.label})`),
  uniqueIndex("physical_stock_pieces_active_issue_unique").on(table.issuedMovementId),
  index("physical_stock_pieces_location_idx").on(table.productId, table.warehouseId, table.binId),
  index("physical_stock_pieces_parent_idx").on(table.parentId),
  foreignKey({ columns: [table.issuedMovementId], foreignColumns: [inventoryMovementsTable.id], name: "physical_stock_pieces_issue_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.binId, table.warehouseId], foreignColumns: [warehouseBinsTable.id, warehouseBinsTable.warehouseId], name: "physical_stock_pieces_bin_warehouse_fk" }).onDelete("restrict"),
  check("physical_stock_pieces_dimensions_valid", sql`${table.widthInches} > 0 AND ${table.widthInches} <= 1200 AND ${table.lengthInches} > 0 AND ${table.lengthInches} <= 120000 AND ${table.quantity} > 0 AND ${table.quantity} <= 1000000`),
  check("physical_stock_pieces_kind_valid", sql`${table.kind} IN ('Roll', 'Remnant')`),
  check("physical_stock_pieces_label_valid", sql`char_length(${table.label}) between 1 and 80`),
  check("physical_stock_pieces_cost_review_valid", sql`(${table.costAllocations} IS NULL AND ${table.costReviewedBy} IS NULL AND ${table.costReviewedAt} IS NULL) OR (${table.costAllocations} IS NOT NULL AND jsonb_typeof(${table.costAllocations}) = 'array' AND jsonb_array_length(${table.costAllocations}) > 0 AND ${table.costReviewedBy} IS NOT NULL AND ${table.costReviewedAt} IS NOT NULL)`),
]);

export const physicalPieceEventsTable = pgTable("physical_stock_piece_events", {
  id: text("id").primaryKey(),
  pieceId: text("piece_id").notNull(),
  childId: text("child_id"),
  movementId: text("movement_id"),
  action: text("action").$type<"registered" | "cost_bound" | "cut" | "moved" | "issued" | "returned">().notNull(),
  actorUserId: text("actor_user_id").notNull(),
  requestKey: text("request_key").notNull(),
  requestHash: text("request_hash").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("physical_stock_piece_events_request_unique").on(table.requestKey),
  uniqueIndex("physical_stock_piece_events_movement_unique").on(table.movementId),
  index("physical_stock_piece_events_piece_time_idx").on(table.pieceId, table.createdAt),
  index("physical_stock_piece_events_child_idx").on(table.childId),
  foreignKey({ columns: [table.pieceId], foreignColumns: [physicalPiecesTable.id], name: "physical_stock_piece_events_piece_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.childId], foreignColumns: [physicalPiecesTable.id], name: "physical_stock_piece_events_child_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.movementId], foreignColumns: [inventoryMovementsTable.id], name: "physical_stock_piece_events_move_fk" }).onDelete("restrict"),
  check("physical_stock_piece_events_action_valid", sql`${table.action} IN ('registered', 'cost_bound', 'cut', 'moved', 'issued', 'returned')`),
  check("physical_stock_piece_events_links_valid", sql`(${table.childId} IS NOT NULL) = (${table.action} = 'cut') AND (${table.movementId} IS NOT NULL) = (${table.action} IN ('moved', 'issued', 'returned'))`),
]);

export type PhysicalPiece = typeof physicalPiecesTable.$inferSelect;
