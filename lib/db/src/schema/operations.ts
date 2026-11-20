import {
  pgTable,
  text,
  real,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
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

export const inventoryTransfersTable = pgTable("inventory_transfers", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => productsTable.id, { onDelete: "restrict" }),
  sourceWarehouseId: text("source_warehouse_id").references(() => warehousesTable.id, { onDelete: "restrict" }),
  destinationWarehouseId: text("destination_warehouse_id").notNull().references(() => warehousesTable.id, { onDelete: "restrict" }),
  quantity: real("quantity").notNull(),
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
  check("inventory_transfers_positive_quantity", sql`${table.quantity} > 0 AND ${table.quantity} < 'Infinity'::real`),
  check("inventory_transfers_distinct_warehouses", sql`${table.sourceWarehouseId} IS DISTINCT FROM ${table.destinationWarehouseId}`),
  check("inventory_transfers_valid_status", sql`${table.status} IN ('In transit', 'Received')`),
]);

export const inventoryMovementsTable = pgTable(
  "inventory_movements",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    jobId: text("job_id").references(() => jobsTable.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id").references(() => warehousesTable.id, { onDelete: "restrict" }),
    transferId: text("transfer_id").references(() => inventoryTransfersTable.id, { onDelete: "restrict" }),
    returnOfMovementId: text("return_of_movement_id"),
    quantity: real("quantity").notNull(),
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    actorUserId: text("actor_user_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("inventory_movements_idempotency_unique").on(t.idempotencyKey),
    index("inventory_movements_product_idx").on(t.productId),
    index("inventory_movements_job_id_idx").on(t.jobId),
    index("inventory_movements_product_warehouse_idx").on(t.productId, t.warehouseId),
    index("inventory_movements_return_of_idx").on(t.returnOfMovementId),
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
    quantity: real("quantity").notNull(),
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
