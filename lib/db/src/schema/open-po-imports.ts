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
import { purchaseOrdersTable } from "./purchase-orders";
import { suppliersTable } from "./supplier-imports";
export const openPoImportBatchesTable = pgTable(
  "open_po_import_batches",
  {
    id: text("id").primaryKey(),
    workspaceKey: text("workspace_key").notNull(),
    sourceSystem: text("source_system").notNull(),
    batchKey: text("batch_key").notNull(),
    fileName: text("file_name").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    sourceCsv: text("source_csv").notNull(),
    delimiter: text("delimiter").notNull(),
    sourceSnapshotAt: text("source_snapshot_at").notNull(),
    cutoverAt: text("cutover_at").notNull(),
    rows: jsonb("rows").$type<unknown[]>().notNull(),
    status: text("status")
      .$type<"preview" | "reviewed" | "approved" | "committed">()
      .notNull()
      .default("preview"),
    revision: integer("revision").notNull().default(1),
    previewFingerprint: text("preview_fingerprint").notNull(),
    reviewFingerprint: text("review_fingerprint"),
    reviewed: jsonb("reviewed").$type<unknown[]>().notNull().default([]),
    reviewNote: text("review_note"),
    currentApprovalId: text("current_approval_id"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    committedAt: text("committed_at"),
  },
  (table) => [
    uniqueIndex("open_po_import_batch_identity_unique").on(
      table.sourceSystem,
      table.batchKey,
    ),
    unique("open_po_import_batch_source_unique").on(
      table.id,
      table.sourceSystem,
    ),
    index("open_po_import_batch_created_idx").on(table.createdAt),
    check(
      "open_po_import_batch_status_check",
      sql`${table.status} IN ('preview','reviewed','approved','committed')`,
    ),
    check("open_po_import_batch_revision_check", sql`${table.revision}>0`),
    check(
      "open_po_import_batch_source_check",
      sql`octet_length(${table.sourceCsv}) BETWEEN 1 AND 200000 AND ${table.delimiter} IN (',',E'\t') AND ${table.sourceSha256} ~ '^[a-f0-9]{64}$' AND ${table.previewFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "open_po_import_batch_rows_check",
      sql`jsonb_typeof(${table.rows})='array' AND jsonb_array_length(${table.rows}) BETWEEN 1 AND 200`,
    ),
    check(
      "open_po_import_batch_approval_check",
      sql`${table.status} NOT IN ('approved','committed') OR ${table.currentApprovalId} IS NOT NULL`,
    ),
    check(
      "open_po_import_batch_committed_check",
      sql`(${table.status}='committed')=(${table.committedAt} IS NOT NULL)`,
    ),
  ],
);
export const openPoImportApprovalsTable = pgTable(
  "open_po_import_approvals",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => openPoImportBatchesTable.id, { onDelete: "restrict" }),
    fingerprint: text("fingerprint").notNull(),
    previewFingerprint: text("preview_fingerprint").notNull(),
    reviewed: jsonb("reviewed").$type<unknown[]>().notNull(),
    reviewNote: text("review_note").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: text("approved_at").notNull(),
  },
  (table) => [
    uniqueIndex("open_po_import_approval_fingerprint_unique").on(
      table.batchId,
      table.fingerprint,
    ),
    unique("open_po_import_approval_batch_unique").on(table.id, table.batchId),
    check(
      "open_po_import_approval_hash_check",
      sql`${table.fingerprint} ~ '^[a-f0-9]{64}$' AND ${table.previewFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
export const openPoImportRecordsTable = pgTable(
  "open_po_import_records",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull(),
    approvalId: text("approval_id").notNull(),
    sourceSystem: text("source_system").notNull(),
    sourcePoId: text("source_po_id").notNull(),
    sourcePoNumber: text("source_po_number").notNull(),
    orderId: text("order_id")
      .notNull()
      .references(() => purchaseOrdersTable.id, { onDelete: "restrict" }),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "restrict" }),
    sourceData: jsonb("source_data").$type<Record<string, unknown>>().notNull(),
    reviewedDecision: jsonb("reviewed_decision")
      .$type<Record<string, unknown>>()
      .notNull(),
    sourceRecordSha256: text("source_record_sha256").notNull(),
    action: text("action").$type<"create" | "link">().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "open_po_import_record_batch_source_fk",
      columns: [table.batchId, table.sourceSystem],
      foreignColumns: [
        openPoImportBatchesTable.id,
        openPoImportBatchesTable.sourceSystem,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "open_po_import_record_approval_batch_fk",
      columns: [table.approvalId, table.batchId],
      foreignColumns: [
        openPoImportApprovalsTable.id,
        openPoImportApprovalsTable.batchId,
      ],
    }).onDelete("restrict"),
    uniqueIndex("open_po_import_source_identity_unique").on(
      table.sourceSystem,
      table.sourcePoId,
    ),
    uniqueIndex("open_po_import_target_order_unique").on(table.orderId),
    index("open_po_import_record_batch_idx").on(table.batchId),
    index("open_po_import_record_supplier_idx").on(table.supplierId),
    check(
      "open_po_import_record_action_check",
      sql`${table.action} IN ('create','link')`,
    ),
    check(
      "open_po_import_record_hash_check",
      sql`${table.sourceRecordSha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
