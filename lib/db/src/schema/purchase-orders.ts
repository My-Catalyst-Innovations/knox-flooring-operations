import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { inventoryMovementsTable, warehousesTable } from "./operations";
import { productsTable } from "./products";

export const purchaseOrderStatuses = [
  "Draft",
  "Ordered",
  "Partially received",
  "Received",
  "Cancelled",
] as const;

export const purchaseOrdersTable = pgTable(
  "purchase_orders",
  {
    id: text("id").primaryKey(),
    number: serial("number").notNull(),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehousesTable.id, { onDelete: "restrict" }),
    supplier: text("supplier").notNull(),
    notes: text("notes").notNull(),
    status: text("status")
      .$type<(typeof purchaseOrderStatuses)[number]>()
      .notNull()
      .default("Draft"),
    revision: integer("revision").notNull().default(1),
    requestKey: text("request_key"),
    requestHash: text("request_hash"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("purchase_orders_number_unique").on(table.number),
    uniqueIndex("purchase_orders_request_key_unique").on(table.requestKey),
    index("purchase_orders_warehouse_idx").on(table.warehouseId),
    check(
      "purchase_orders_status_valid",
      sql`${table.status} in ('Draft', 'Ordered', 'Partially received', 'Received', 'Cancelled')`,
    ),
  ],
);

export const purchaseOrderLinesTable = pgTable(
  "purchase_order_lines",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => purchaseOrdersTable.id, { onDelete: "restrict" }),
    productId: text("product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "restrict" }),
    productName: text("product_name").notNull(),
    sku: text("sku").notNull(),
    unit: text("unit").notNull(),
    position: integer("position").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 6 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 6 }).notNull(),
  },
  (table) => [
    uniqueIndex("purchase_order_lines_order_product_unique").on(
      table.orderId,
      table.productId,
    ),
    index("purchase_order_lines_product_idx").on(table.productId),
    check(
      "purchase_order_lines_quantity_valid",
      sql`${table.quantity} > 0 AND ${table.quantity} < 'Infinity'::numeric`,
    ),
    check(
      "purchase_order_lines_cost_valid",
      sql`${table.unitCost} >= 0 AND ${table.unitCost} < 'Infinity'::numeric`,
    ),
  ],
);

export const purchaseReceiptsTable = pgTable(
  "purchase_receipts",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => purchaseOrdersTable.id, { onDelete: "restrict" }),
    reference: text("reference").notNull(),
    requestKey: text("request_key").notNull(),
    requestHash: text("request_hash").notNull(),
    receivedBy: text("received_by").notNull(),
    receivedAt: text("received_at").notNull(),
  },
  (table) => [
    uniqueIndex("purchase_receipts_request_key_unique").on(table.requestKey),
    index("purchase_receipts_order_idx").on(table.orderId),
  ],
);

export const purchaseReceiptLinesTable = pgTable(
  "purchase_receipt_lines",
  {
    id: text("id").primaryKey(),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => purchaseReceiptsTable.id, { onDelete: "restrict" }),
    lineId: text("line_id")
      .notNull()
      .references(() => purchaseOrderLinesTable.id, { onDelete: "restrict" }),
    movementId: text("movement_id")
      .notNull()
      .references(() => inventoryMovementsTable.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 18, scale: 6 }).notNull(),
  },
  (table) => [
    uniqueIndex("purchase_receipt_lines_movement_unique").on(table.movementId),
    index("purchase_receipt_lines_receipt_idx").on(table.receiptId),
    index("purchase_receipt_lines_order_line_idx").on(table.lineId),
    check(
      "purchase_receipt_lines_quantity_valid",
      sql`${table.quantity} > 0 AND ${table.quantity} < 'Infinity'::numeric`,
    ),
  ],
);
