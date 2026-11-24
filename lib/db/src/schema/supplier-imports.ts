import { sql } from "drizzle-orm";
import {
  check,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const supplierImportBatchesTable = pgTable(
  "supplier_import_batches",
  {
    id: text("id").primaryKey(),
    workspaceKey: text("workspace_key").notNull(),
    sourceSystem: text("source_system").notNull(),
    batchKey: text("batch_key").notNull(),
    fileName: text("file_name").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    sourceCsv: text("source_csv").notNull(),
    delimiter: text("delimiter").notNull(),
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
  (t) => [
    uniqueIndex("supplier_import_batch_identity_unique").on(
      t.sourceSystem,
      t.batchKey,
    ),
    unique("supplier_import_batch_source_unique").on(t.id, t.sourceSystem),
    index("supplier_import_batch_created_idx").on(t.createdAt),
    check(
      "supplier_import_batch_status_check",
      sql`${t.status} IN ('preview','reviewed','approved','committed')`,
    ),
    check("supplier_import_batch_revision_check", sql`${t.revision}>0`),
    check(
      "supplier_import_batch_source_check",
      sql`octet_length(${t.sourceCsv}) BETWEEN 1 AND 1048576 AND ${t.delimiter} IN (',',E'\t') AND ${t.sourceSha256} ~ '^[a-f0-9]{64}$' AND ${t.previewFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "supplier_import_batch_rows_check",
      sql`jsonb_typeof(${t.rows})='array' AND jsonb_array_length(${t.rows}) BETWEEN 1 AND 200`,
    ),
    check(
      "supplier_import_batch_approval_check",
      sql`${t.status} NOT IN ('approved','committed') OR ${t.currentApprovalId} IS NOT NULL`,
    ),
    check(
      "supplier_import_batch_committed_check",
      sql`(${t.status}='committed')=(${t.committedAt} IS NOT NULL)`,
    ),
  ],
);
export const supplierImportApprovalsTable = pgTable(
  "supplier_import_approvals",
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
  (t) => [
    unique("supplier_import_approval_batch_unique").on(t.id, t.batchId),
    uniqueIndex("supplier_import_approval_fingerprint_unique").on(
      t.batchId,
      t.fingerprint,
    ),
    foreignKey({
      name: "supplier_import_approval_batch_fk",
      columns: [t.batchId],
      foreignColumns: [supplierImportBatchesTable.id],
    }).onDelete("restrict"),
    check(
      "supplier_import_approval_fingerprint_check",
      sql`${t.fingerprint} ~ '^[a-f0-9]{64}$' AND ${t.previewFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
export const suppliersTable = pgTable(
  "suppliers",
  {
    id: text("id").primaryKey(),
    revision: integer("revision").notNull().default(1),
    active: boolean("active").notNull().default(true),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    contactName: text("contact_name").notNull().default(""),
    email: text("email").notNull().default(""),
    phone: text("phone").notNull().default(""),
    address: text("address").notNull().default(""),
    city: text("city").notNull().default(""),
    state: text("state").notNull().default(""),
    postalCode: text("postal_code").notNull().default(""),
    country: text("country").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("suppliers_name_key_unique").on(t.nameKey),
    check("suppliers_revision_check", sql`${t.revision}>0`),
    check(
      "suppliers_name_key_check",
      sql`length(btrim(${t.name})) BETWEEN 1 AND 200 AND ${t.name}=btrim(${t.name}) AND ${t.name} !~ '[[:cntrl:]]' AND ${t.nameKey}=lower(btrim(${t.name}))`,
    ),
  ],
);
export const supplierImportRecordsTable = pgTable(
  "supplier_import_records",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull(),
    approvalId: text("approval_id").notNull(),
    sourceSystem: text("source_system").notNull(),
    sourceId: text("source_id").notNull(),
    sourceLine: integer("source_line").notNull(),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "restrict" }),
    action: text("action").$type<"create" | "link">().notNull(),
    sourceData: jsonb("source_data").$type<Record<string, string>>().notNull(),
    supplierSnapshot: jsonb("supplier_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    sourceRowSha256: text("source_row_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("supplier_import_source_identity_unique").on(
      t.sourceSystem,
      t.sourceId,
    ),
    index("supplier_import_record_supplier_idx").on(t.supplierId),
    index("supplier_import_record_batch_idx").on(t.batchId),
    foreignKey({
      name: "supplier_import_record_batch_source_fk",
      columns: [t.batchId, t.sourceSystem],
      foreignColumns: [
        supplierImportBatchesTable.id,
        supplierImportBatchesTable.sourceSystem,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "supplier_import_record_approval_batch_fk",
      columns: [t.approvalId, t.batchId],
      foreignColumns: [
        supplierImportApprovalsTable.id,
        supplierImportApprovalsTable.batchId,
      ],
    }).onDelete("restrict"),
    check(
      "supplier_import_record_source_check",
      sql`length(${t.sourceId}) BETWEEN 1 AND 160 AND ${t.sourceLine}>0 AND ${t.action} IN ('create','link') AND ${t.sourceRowSha256} ~ '^[a-f0-9]{64}$' AND jsonb_typeof(${t.sourceData})='object' AND jsonb_typeof(${t.supplierSnapshot})='object'`,
    ),
  ],
);
