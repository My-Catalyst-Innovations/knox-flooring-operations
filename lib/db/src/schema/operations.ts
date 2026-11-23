import {
  pgTable,
  text,
  real,
  doublePrecision,
  numeric,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
  unique,
  index,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { jobsTable } from "./jobs";
import { productsTable } from "./products";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};
export const customersTable = pgTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  notes: text("notes").notNull().default(""),
  mergedIntoId: text("merged_into_id"),
  revision: integer("revision").notNull().default(1),
  ...timestamps,
});
export const customerSitesTable = pgTable("customer_sites", {
  id: text("id").primaryKey(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customersTable.id),
  label: text("label").notNull().default(""),
  address: text("address").notNull().default(""),
  city: text("city").notNull().default(""),
  state: text("state").notNull().default(""),
  zip: text("zip").notNull().default(""),
  ...timestamps,
});
export const crewsTable = pgTable("crews", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  timezone: text("timezone").notNull().default("America/New_York"),
  size: integer("size"),
  dailyCapacityHours: real("daily_capacity_hours"),
  workingDays: jsonb("working_days").$type<number[]>().notNull().default([]),
  unavailableDates: jsonb("unavailable_dates")
    .$type<string[]>()
    .notNull()
    .default([]),
  revision: integer("revision").notNull().default(1),
  ...timestamps,
});
export const crewBookingsTable = pgTable(
  "crew_bookings",
  {
    id: text("id").primaryKey(),
    crewId: text("crew_id")
      .notNull()
      .references(() => crewsTable.id),
    jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "restrict" }),
    taskId: text("task_id"),
    calendarSyncStatus: text("calendar_sync_status")
      .notNull()
      .default("pending"),
    calendarSyncError: text("calendar_sync_error"),
    startAt: text("start_at").notNull(),
    endAt: text("end_at").notNull(),
    plannedLaborHours: real("planned_labor_hours").notNull(),
    status: text("status").notNull().default("Confirmed"),
    notes: text("notes").notNull().default(""),
    revision: integer("revision").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index("crew_bookings_crew_dates_idx").on(t.crewId, t.startAt, t.endAt),
    index("crew_bookings_job_id_idx").on(t.jobId),
  ],
);
export const jobCallbacksTable = pgTable("job_callbacks", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("Open"),
  assignedTo: text("assigned_to").notNull().default(""),
  notes: text("notes").notNull().default(""),
  resolvedAt: text("resolved_at"),
  ...timestamps,
}, (table) => [index("job_callbacks_job_id_idx").on(table.jobId)]);
export const warehousesTable = pgTable("warehouses", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("warehouses_name_unique").on(sql`lower(${table.name})`)]);

export const warehouseBinsTable = pgTable("warehouse_bins", {
  id: text("id").primaryKey(),
  warehouseId: text("warehouse_id").notNull().references(() => warehousesTable.id, { onDelete: "restrict" }),
  code: text("code").notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("warehouse_bins_warehouse_code_unique").on(table.warehouseId, sql`lower(${table.code})`),
  unique("warehouse_bins_id_warehouse_unique").on(table.id, table.warehouseId),
]);

export const inventoryTransfersTable = pgTable("inventory_transfers", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => productsTable.id, { onDelete: "restrict" }),
  sourceWarehouseId: text("source_warehouse_id").references(() => warehousesTable.id, { onDelete: "restrict" }),
  destinationWarehouseId: text("destination_warehouse_id").notNull().references(() => warehousesTable.id, { onDelete: "restrict" }),
  sourceBinId: text("source_bin_id"),
  destinationBinId: text("destination_bin_id"),
  quantity: doublePrecision("quantity").notNull(),
  reason: text("reason").notNull(),
  status: text("status").$type<"In transit" | "Received">().notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  dispatchedBy: text("dispatched_by").notNull(),
  receivedBy: text("received_by"),
  receivedAt: text("received_at"),
  ...timestamps,
}, (table) => [
  uniqueIndex("inventory_transfers_idempotency_unique").on(table.idempotencyKey),
  index("inventory_transfers_product_idx").on(table.productId),
  index("inventory_transfers_source_bin_idx").on(table.sourceBinId, table.sourceWarehouseId),
  index("inventory_transfers_destination_bin_idx").on(table.destinationBinId, table.destinationWarehouseId),
  check("inventory_transfers_source_bin_requires_warehouse", sql`${table.sourceBinId} IS NULL OR ${table.sourceWarehouseId} IS NOT NULL`),
  foreignKey({ columns: [table.sourceBinId, table.sourceWarehouseId], foreignColumns: [warehouseBinsTable.id, warehouseBinsTable.warehouseId], name: "inventory_transfers_source_bin_warehouse_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.destinationBinId, table.destinationWarehouseId], foreignColumns: [warehouseBinsTable.id, warehouseBinsTable.warehouseId], name: "inventory_transfers_destination_bin_warehouse_fk" }).onDelete("restrict"),
  check("inventory_transfers_positive_quantity", sql`${table.quantity} > 0 AND ${table.quantity} < 'Infinity'::real`),
  check("inventory_transfers_distinct_locations", sql`${table.sourceWarehouseId} IS DISTINCT FROM ${table.destinationWarehouseId} OR ${table.sourceBinId} IS DISTINCT FROM ${table.destinationBinId}`),
  check("inventory_transfers_valid_status", sql`${table.status} IN ('In transit', 'Received')`),
]);

export type InventoryCostSlice = {
  layerId: string | null;
  sourceMovementId: string;
  source: "purchase_order" | "stock_receipt" | "catalog" | "historical_issue" | "reviewed_opening";
  acquiredAt: string;
  quantity: number;
  unitCost: string;
};

export const inventoryMovementsTable = pgTable(
  "inventory_movements",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    jobId: text("job_id").references(() => jobsTable.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id").references(() => warehousesTable.id, { onDelete: "restrict" }),
    binId: text("bin_id"),
    transferId: text("transfer_id").references(() => inventoryTransfersTable.id, { onDelete: "restrict" }),
    returnOfMovementId: text("return_of_movement_id"),
    issueUnitCost: numeric("issue_unit_cost"),
    acquisitionUnitCost: numeric("acquisition_unit_cost", { precision: 18, scale: 6 }),
    costAllocations: jsonb("cost_allocations").$type<InventoryCostSlice[]>(),
    quantity: doublePrecision("quantity").notNull(),
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    actorUserId: text("actor_user_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("inventory_movements_idempotency_unique").on(t.idempotencyKey),
    index("inventory_movements_product_idx").on(t.productId),
    index("inventory_movements_created_at_idx").on(t.createdAt),
    index("inventory_movements_job_id_idx").on(t.jobId),
    index("inventory_movements_product_warehouse_idx").on(t.productId, t.warehouseId),
    index("inventory_movements_bin_warehouse_idx").on(t.binId, t.warehouseId),
    index("inventory_movements_return_of_idx").on(t.returnOfMovementId),
    check("inventory_movements_issue_unit_cost_valid", sql`${t.issueUnitCost} IS NULL OR (${t.kind} = 'consume' AND ${t.jobId} IS NOT NULL AND ${t.issueUnitCost} >= 0 AND ${t.issueUnitCost} < 'Infinity'::numeric)`),
    check("inventory_movements_acquisition_cost_valid", sql`${t.acquisitionUnitCost} IS NULL OR (${t.kind} = 'receipt' AND ${t.acquisitionUnitCost} >= 0 AND ${t.acquisitionUnitCost} < 'Infinity'::numeric)`),
    check("inventory_movements_cost_allocations_valid", sql`${t.costAllocations} IS NULL OR jsonb_typeof(${t.costAllocations}) = 'array'`),
    check("inventory_movements_bin_requires_warehouse", sql`${t.binId} IS NULL OR ${t.warehouseId} IS NOT NULL`),
    foreignKey({ columns: [t.binId, t.warehouseId], foreignColumns: [warehouseBinsTable.id, warehouseBinsTable.warehouseId], name: "inventory_movements_bin_warehouse_fk" }).onDelete("restrict"),
    foreignKey({
      columns: [t.returnOfMovementId],
      foreignColumns: [t.id],
      name: "inventory_movements_return_of_fk",
    }).onDelete("restrict"),
  ],
);
export const inventoryReservationsTable = pgTable(
  "inventory_reservations",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id").references(() => warehousesTable.id, { onDelete: "restrict" }),
    stagedBinId: text("staged_bin_id"),
    sourceReservationId: text("source_reservation_id"),
    stagedTransferId: text("staged_transfer_id"),
    quantity: doublePrecision("quantity").notNull(),
    status: text("status").notNull().default("Active"),
    idempotencyKey: text("idempotency_key").notNull(),
    revision: integer("revision").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("inventory_reservations_idempotency_unique").on(
      t.idempotencyKey,
    ),
    index("inventory_reservations_job_id_idx").on(t.jobId),
    index("inventory_reservations_product_warehouse_idx").on(t.productId, t.warehouseId),
    index("inventory_reservations_staging_bin_idx").on(t.stagedBinId),
    index("inventory_reservations_source_idx").on(t.sourceReservationId),
    uniqueIndex("inventory_reservations_staged_transfer_idx").on(t.stagedTransferId),
    foreignKey({ columns: [t.stagedBinId, t.warehouseId], foreignColumns: [warehouseBinsTable.id, warehouseBinsTable.warehouseId], name: "inventory_reservation_staging_bin_fk" }).onDelete("restrict"),
    foreignKey({ columns: [t.sourceReservationId], foreignColumns: [t.id], name: "inventory_reservation_source_fk" }).onDelete("restrict"),
    foreignKey({ columns: [t.stagedTransferId], foreignColumns: [inventoryTransfersTable.id], name: "inventory_reservation_staged_transfer_fk" }).onDelete("restrict"),
    check("inventory_reservations_staging_links_valid", sql`(${t.stagedBinId} IS NULL AND ${t.sourceReservationId} IS NULL AND ${t.stagedTransferId} IS NULL) OR (${t.warehouseId} IS NOT NULL AND ${t.stagedBinId} IS NOT NULL AND ${t.sourceReservationId} IS NOT NULL AND ${t.stagedTransferId} IS NOT NULL)`),
  ],
);
export const estimateDraftsTable = pgTable("estimate_drafts", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  title: text("title").notNull().default("Untitled estimate"),
  customerId: text("customer_id"),
  siteId: text("site_id"),
  leadId: text("lead_id"),
  inputs: jsonb("inputs")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
  schemaVersion: integer("schema_version").notNull().default(1),
  revision: integer("revision").notNull().default(1),
  state: text("state").notNull().default("Draft"),
  convertedProposalId: text("converted_proposal_id"),
  convertedJobId: text("converted_job_id").references(() => jobsTable.id, { onDelete: "restrict" }),
  ...timestamps,
}, (table) => [index("estimate_drafts_converted_job_id_idx").on(table.convertedJobId)]);
