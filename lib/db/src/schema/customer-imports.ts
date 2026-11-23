import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { customersTable, customerSitesTable } from "./operations";

export const customerImportBatchesTable = pgTable(
  "customer_import_batches",
  {
    id: text("id").primaryKey(),
    workspaceKey: text("workspace_key").notNull(),
    sourceSystem: text("source_system").notNull(),
    batchKey: text("batch_key").notNull(),
    fileName: text("file_name").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    headers: jsonb("headers").$type<string[]>().notNull(),
    mapping: jsonb("mapping").$type<Record<string, string>>().notNull(),
    rows: jsonb("rows").$type<unknown[]>().notNull(),
    status: text("status")
      .$type<"preview" | "reviewed" | "approved" | "committed">()
      .notNull()
      .default("preview"),
    revision: integer("revision").notNull().default(1),
    previewFingerprint: text("preview_fingerprint").notNull(),
    reviewFingerprint: text("review_fingerprint"),
    decisions: jsonb("decisions").$type<unknown[]>().notNull().default([]),
    reviewNote: text("review_note"),
    currentApprovalId: text("current_approval_id"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    committedAt: text("committed_at"),
  },
  (table) => [
    uniqueIndex("customer_import_batch_identity_unique").on(
      table.sourceSystem,
      table.batchKey,
    ),
    unique("customer_import_batch_scope_unique").on(
      table.id,
      table.workspaceKey,
      table.sourceSystem,
    ),
    index("customer_import_batch_created_idx").on(table.createdAt),
    check(
      "customer_import_batch_status_check",
      sql`${table.status} IN ('preview','reviewed','approved','committed')`,
    ),
    check("customer_import_batch_revision_check", sql`${table.revision} > 0`),
    check(
      "customer_import_batch_hash_check",
      sql`${table.sourceSha256} ~ '^[a-f0-9]{64}$' AND ${table.previewFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "customer_import_batch_rows_check",
      sql`jsonb_typeof(${table.rows})='array' AND jsonb_array_length(${table.rows}) BETWEEN 1 AND 200`,
    ),
    check(
      "customer_import_batch_approval_check",
      sql`${table.status} NOT IN ('approved','committed') OR ${table.currentApprovalId} IS NOT NULL`,
    ),
    check(
      "customer_import_batch_committed_check",
      sql`(${table.status}='committed') = (${table.committedAt} IS NOT NULL)`,
    ),
  ],
);
export const customerImportApprovalsTable = pgTable(
  "customer_import_approvals",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    previewFingerprint: text("preview_fingerprint").notNull(),
    decisions: jsonb("decisions").$type<unknown[]>().notNull(),
    reviewNote: text("review_note").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: text("approved_at").notNull(),
  },
  (table) => [
    uniqueIndex("customer_import_approval_fingerprint_unique").on(
      table.batchId,
      table.fingerprint,
    ),
    unique("customer_import_approval_batch_unique").on(table.id, table.batchId),
    foreignKey({
      name: "customer_import_approval_batch_fk",
      columns: [table.batchId],
      foreignColumns: [customerImportBatchesTable.id],
    }).onDelete("restrict"),
  ],
);
export const customerImportRecordsTable = pgTable(
  "customer_import_records",
  {
    id: text("id").primaryKey(),
    workspaceKey: text("workspace_key").notNull(),
    sourceSystem: text("source_system").notNull(),
    sourceId: text("source_id").notNull(),
    batchId: text("batch_id").notNull(),
    approvalId: text("approval_id").notNull(),
    sourceLine: integer("source_line").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "restrict" }),
    siteId: text("site_id").references(() => customerSitesTable.id, {
      onDelete: "restrict",
    }),
    action: text("action").$type<"create" | "link">().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("customer_import_source_identity_unique").on(
      table.sourceSystem,
      table.sourceId,
    ),
    index("customer_import_record_batch_idx").on(table.batchId),
    index("customer_import_record_approval_idx").on(
      table.approvalId,
      table.batchId,
    ),
    index("customer_import_record_customer_idx").on(table.customerId),
    index("customer_import_record_site_idx").on(table.siteId),
    check(
      "customer_import_record_action_check",
      sql`${table.action} IN ('create','link') AND ${table.sourceLine} > 0 AND length(${table.sourceId}) BETWEEN 1 AND 160`,
    ),
    foreignKey({
      name: "customer_import_record_batch_scope_fk",
      columns: [table.batchId, table.workspaceKey, table.sourceSystem],
      foreignColumns: [
        customerImportBatchesTable.id,
        customerImportBatchesTable.workspaceKey,
        customerImportBatchesTable.sourceSystem,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "customer_import_record_approval_batch_fk",
      columns: [table.approvalId, table.batchId],
      foreignColumns: [
        customerImportApprovalsTable.id,
        customerImportApprovalsTable.batchId,
      ],
    }).onDelete("restrict"),
  ],
);
