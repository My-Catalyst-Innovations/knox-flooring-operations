import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const legacyArchiveBatchesTable = pgTable(
  "legacy_archive_batches",
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
    uniqueIndex("legacy_archive_batch_identity_unique").on(
      t.sourceSystem,
      t.batchKey,
    ),
    unique("legacy_archive_batch_source_unique").on(t.id, t.sourceSystem),
    index("legacy_archive_batch_created_idx").on(t.createdAt),
    check(
      "legacy_archive_batch_status_check",
      sql`${t.status} IN ('preview','reviewed','approved','committed')`,
    ),
    check("legacy_archive_batch_revision_check", sql`${t.revision}>0`),
    check(
      "legacy_archive_batch_source_check",
      sql`octet_length(${t.sourceCsv}) BETWEEN 1 AND 1048576 AND ${t.delimiter} IN (',',E'\t') AND ${t.sourceSha256} ~ '^[a-f0-9]{64}$' AND ${t.previewFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "legacy_archive_batch_rows_check",
      sql`jsonb_typeof(${t.rows})='array' AND jsonb_array_length(${t.rows}) BETWEEN 1 AND 200`,
    ),
    check(
      "legacy_archive_batch_approval_check",
      sql`${t.status} NOT IN ('approved','committed') OR ${t.currentApprovalId} IS NOT NULL`,
    ),
    check(
      "legacy_archive_batch_committed_check",
      sql`(${t.status}='committed')=(${t.committedAt} IS NOT NULL)`,
    ),
  ],
);
export const legacyArchiveApprovalsTable = pgTable(
  "legacy_archive_approvals",
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
    unique("legacy_archive_approval_batch_unique").on(t.id, t.batchId),
    uniqueIndex("legacy_archive_approval_fingerprint_unique").on(
      t.batchId,
      t.fingerprint,
    ),
    foreignKey({
      name: "legacy_archive_approval_batch_fk",
      columns: [t.batchId],
      foreignColumns: [legacyArchiveBatchesTable.id],
    }).onDelete("restrict"),
    check(
      "legacy_archive_approval_fingerprint_check",
      sql`${t.fingerprint} ~ '^[a-f0-9]{64}$' AND ${t.previewFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
export const legacyArchiveRecordsTable = pgTable(
  "legacy_archive_records",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull(),
    approvalId: text("approval_id").notNull(),
    sourceSystem: text("source_system").notNull(),
    sourceId: text("source_id").notNull(),
    sourceLine: integer("source_line").notNull(),
    recordType: text("record_type")
      .$type<
        "job" | "quote" | "invoice" | "purchase_order" | "payment" | "other"
      >()
      .notNull(),
    title: text("title").notNull(),
    reference: text("reference").notNull().default(""),
    partyName: text("party_name").notNull().default(""),
    occurredOn: date("occurred_on"),
    status: text("source_status").notNull().default(""),
    summary: text("summary").notNull().default(""),
    recordSha256: text("record_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("legacy_archive_record_source_unique").on(
      t.sourceSystem,
      t.recordType,
      t.sourceId,
    ),
    index("legacy_archive_record_created_idx").on(t.createdAt, t.id),
    index("legacy_archive_record_batch_idx").on(t.batchId),
    foreignKey({
      name: "legacy_archive_record_batch_source_fk",
      columns: [t.batchId, t.sourceSystem],
      foreignColumns: [
        legacyArchiveBatchesTable.id,
        legacyArchiveBatchesTable.sourceSystem,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "legacy_archive_record_approval_batch_fk",
      columns: [t.approvalId, t.batchId],
      foreignColumns: [
        legacyArchiveApprovalsTable.id,
        legacyArchiveApprovalsTable.batchId,
      ],
    }).onDelete("restrict"),
    check(
      "legacy_archive_record_type_check",
      sql`${t.recordType} IN ('job','quote','invoice','purchase_order','payment','other')`,
    ),
    check(
      "legacy_archive_record_source_check",
      sql`length(${t.sourceId}) BETWEEN 1 AND 160 AND ${t.sourceLine}>0 AND ${t.recordSha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
export const legacyArchiveDocumentsTable = pgTable(
  "legacy_archive_documents",
  {
    id: text("id").primaryKey(),
    recordId: text("record_id")
      .notNull()
      .references(() => legacyArchiveRecordsTable.id, { onDelete: "restrict" }),
    objectPath: text("object_path").notNull(),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    requestKey: text("request_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("legacy_archive_document_object_unique").on(t.objectPath),
    uniqueIndex("legacy_archive_document_request_unique").on(t.requestKey),
    uniqueIndex("legacy_archive_document_content_unique").on(
      t.recordId,
      t.sha256,
    ),
    index("legacy_archive_document_record_idx").on(t.recordId),
    check(
      "legacy_archive_document_size_check",
      sql`${t.size} BETWEEN 1 AND 15728640 AND ${t.sha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
