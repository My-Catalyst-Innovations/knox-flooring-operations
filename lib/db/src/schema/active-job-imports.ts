import { sql } from "drizzle-orm";
import {
  check,
  bigint,
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

export const activeJobImportBatchesTable = pgTable(
  "active_job_import_batches",
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
    uniqueIndex("active_job_import_batch_identity_unique").on(
      t.sourceSystem,
      t.batchKey,
    ),
    unique("active_job_import_batch_source_unique").on(t.id, t.sourceSystem),
    index("active_job_import_batch_created_idx").on(t.createdAt),
    check(
      "active_job_import_batch_status_check",
      sql`${t.status} IN ('preview','reviewed','approved','committed')`,
    ),
    check("active_job_import_batch_revision_check", sql`${t.revision}>0`),
    check(
      "active_job_import_batch_source_check",
      sql`octet_length(${t.sourceCsv}) BETWEEN 1 AND 1048576 AND ${t.delimiter} IN (',',E'\t') AND ${t.sourceSha256} ~ '^[a-f0-9]{64}$' AND ${t.previewFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "active_job_import_batch_rows_check",
      sql`jsonb_typeof(${t.rows})='array' AND jsonb_array_length(${t.rows}) BETWEEN 1 AND 200`,
    ),
    check(
      "active_job_import_batch_approval_check",
      sql`${t.status} NOT IN ('approved','committed') OR ${t.currentApprovalId} IS NOT NULL`,
    ),
    check(
      "active_job_import_batch_committed_check",
      sql`(${t.status}='committed')=(${t.committedAt} IS NOT NULL)`,
    ),
  ],
);
export const activeJobImportApprovalsTable = pgTable(
  "active_job_import_approvals",
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
    unique("active_job_import_approval_batch_unique").on(t.id, t.batchId),
    uniqueIndex("active_job_import_approval_fingerprint_unique").on(
      t.batchId,
      t.fingerprint,
    ),
    foreignKey({
      name: "active_job_import_approval_batch_fk",
      columns: [t.batchId],
      foreignColumns: [activeJobImportBatchesTable.id],
    }).onDelete("restrict"),
    check(
      "active_job_import_approval_fingerprint_check",
      sql`${t.fingerprint} ~ '^[a-f0-9]{64}$' AND ${t.previewFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

import { jobsTable } from "./jobs";
import { invoicesTable } from "./invoices";
import { customersTable, customerSitesTable } from "./operations";

export const activeJobImportRecordsTable = pgTable(
  "active_job_import_records",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull(),
    approvalId: text("approval_id").notNull(),
    sourceSystem: text("source_system").notNull(),
    sourceId: text("source_id").notNull(),
    sourceLine: integer("source_line").notNull(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobsTable.id, { onDelete: "restrict" }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "restrict" }),
    siteId: text("site_id").references(() => customerSitesTable.id, {
      onDelete: "restrict",
    }),
    action: text("action").$type<"create" | "link">().notNull(),
    sourceData: jsonb("source_data").$type<Record<string, string>>().notNull(),
    decision: jsonb("decision").$type<Record<string, unknown>>().notNull(),
    sourceRowSha256: text("source_row_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("active_job_import_source_identity_unique").on(
      t.sourceSystem,
      t.sourceId,
    ),
    unique("active_job_import_record_job_action_unique").on(
      t.id,
      t.jobId,
      t.action,
    ),
    index("active_job_import_record_job_idx").on(t.jobId),
    foreignKey({
      name: "active_job_import_record_batch_source_fk",
      columns: [t.batchId, t.sourceSystem],
      foreignColumns: [
        activeJobImportBatchesTable.id,
        activeJobImportBatchesTable.sourceSystem,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "active_job_import_record_approval_batch_fk",
      columns: [t.approvalId, t.batchId],
      foreignColumns: [
        activeJobImportApprovalsTable.id,
        activeJobImportApprovalsTable.batchId,
      ],
    }).onDelete("restrict"),
    check(
      "active_job_import_record_identity_check",
      sql`length(${t.sourceId}) BETWEEN 1 AND 160 AND ${t.sourceLine}>0 AND ${t.action} IN ('create','link') AND ${t.sourceRowSha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
export const jobCutoverReviewsTable = pgTable(
  "job_cutover_reviews",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobsTable.id, { onDelete: "restrict" }),
    kind: text("kind")
      .$type<"operational" | "financial_context" | "billing">()
      .notNull(),
    jobRevision: integer("job_revision").notNull(),
    cutoverRevision: integer("cutover_revision").notNull(),
    scopeFingerprint: text("scope_fingerprint").notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    reviewedBy: text("reviewed_by").notNull(),
    reviewedAt: text("reviewed_at").notNull(),
  },
  (t) => [
    unique("job_cutover_review_binding_unique").on(
      t.id,
      t.jobId,
      t.kind,
      t.fingerprint,
    ),
    uniqueIndex("job_cutover_review_fingerprint_unique").on(
      t.jobId,
      t.kind,
      t.fingerprint,
    ),
    check(
      "job_cutover_review_valid",
      sql`${t.jobRevision}>0 AND ${t.cutoverRevision}>0 AND ${t.kind} IN ('operational','financial_context','billing') AND ${t.fingerprint} ~ '^[a-f0-9]{64}$' AND ${t.scopeFingerprint} ~ '^[a-f0-9]{64}$' AND ${t.sourceFingerprint} ~ '^[a-f0-9]{64}$' AND jsonb_typeof(${t.payload})='object'`,
    ),
  ],
);
export const jobCutoverApprovalsTable = pgTable(
  "job_cutover_approvals",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id").notNull(),
    jobId: text("job_id").notNull(),
    kind: text("kind").notNull(),
    fingerprint: text("fingerprint").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: text("approved_at").notNull(),
  },
  (t) => [
    uniqueIndex("job_cutover_approval_review_unique").on(t.reviewId),
    unique("job_cutover_approval_binding_unique").on(
      t.id,
      t.jobId,
      t.kind,
      t.fingerprint,
    ),
    foreignKey({
      name: "job_cutover_approval_review_fk",
      columns: [t.reviewId, t.jobId, t.kind, t.fingerprint],
      foreignColumns: [
        jobCutoverReviewsTable.id,
        jobCutoverReviewsTable.jobId,
        jobCutoverReviewsTable.kind,
        jobCutoverReviewsTable.fingerprint,
      ],
    }).onDelete("restrict"),
  ],
);
export const jobCutoverCommitsTable = pgTable(
  "job_cutover_commits",
  {
    id: text("id").primaryKey(),
    approvalId: text("approval_id").notNull(),
    jobId: text("job_id").notNull(),
    kind: text("kind").notNull(),
    fingerprint: text("fingerprint").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    committedBy: text("committed_by").notNull(),
    committedAt: text("committed_at").notNull(),
  },
  (t) => [
    uniqueIndex("job_cutover_commit_approval_unique").on(t.approvalId),
    unique("job_cutover_commit_binding_unique").on(t.id, t.jobId, t.kind),
    foreignKey({
      name: "job_cutover_commit_approval_fk",
      columns: [t.approvalId, t.jobId, t.kind, t.fingerprint],
      foreignColumns: [
        jobCutoverApprovalsTable.id,
        jobCutoverApprovalsTable.jobId,
        jobCutoverApprovalsTable.kind,
        jobCutoverApprovalsTable.fingerprint,
      ],
    }).onDelete("restrict"),
  ],
);
export const jobCutoversTable = pgTable(
  "job_cutovers",
  {
    jobId: text("job_id")
      .primaryKey()
      .references(() => jobsTable.id, { onDelete: "restrict" }),
    sourceRecordId: text("source_record_id").notNull(),
    sourceAction: text("source_action").notNull().default("create"),
    revision: integer("revision").notNull().default(1),
    operationalCommitId: text("operational_commit_id"),
    operationalKind: text("operational_kind").notNull().default("operational"),
    financialCommitId: text("financial_commit_id"),
    financialKind: text("financial_kind")
      .notNull()
      .default("financial_context"),
    billingCommitId: text("billing_commit_id"),
    billingKind: text("billing_kind").notNull().default("billing"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("job_cutover_created_source_unique").on(t.sourceRecordId),
    check(
      "job_cutover_state_valid",
      sql`${t.revision}>0 AND ${t.sourceAction}='create' AND ${t.operationalKind}='operational' AND ${t.financialKind}='financial_context' AND ${t.billingKind}='billing'`,
    ),
    foreignKey({
      name: "job_cutover_created_source_fk",
      columns: [t.sourceRecordId, t.jobId, t.sourceAction],
      foreignColumns: [
        activeJobImportRecordsTable.id,
        activeJobImportRecordsTable.jobId,
        activeJobImportRecordsTable.action,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "job_cutover_operational_commit_fk",
      columns: [t.operationalCommitId, t.jobId, t.operationalKind],
      foreignColumns: [
        jobCutoverCommitsTable.id,
        jobCutoverCommitsTable.jobId,
        jobCutoverCommitsTable.kind,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "job_cutover_financial_commit_fk",
      columns: [t.financialCommitId, t.jobId, t.financialKind],
      foreignColumns: [
        jobCutoverCommitsTable.id,
        jobCutoverCommitsTable.jobId,
        jobCutoverCommitsTable.kind,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "job_cutover_billing_commit_fk",
      columns: [t.billingCommitId, t.jobId, t.billingKind],
      foreignColumns: [
        jobCutoverCommitsTable.id,
        jobCutoverCommitsTable.jobId,
        jobCutoverCommitsTable.kind,
      ],
    }).onDelete("restrict"),
  ],
);
export const jobCutoverInvoiceRequestsTable = pgTable(
  "job_cutover_invoice_requests",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobsTable.id, { onDelete: "restrict" }),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoicesTable.id, { onDelete: "restrict" }),
    billingCommitId: text("billing_commit_id").notNull(),
    billingKind: text("billing_kind").notNull().default("billing"),
    requestFingerprint: text("request_fingerprint").notNull(),
    requestPayload: jsonb("request_payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    initialGrossCents: bigint("initial_gross_cents", {
      mode: "number",
    }).notNull(),
    currentGrossCents: bigint("current_gross_cents", {
      mode: "number",
    }).notNull(),
    financialFingerprint: text("financial_fingerprint").notNull(),
    submissionLocked: boolean("submission_locked").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("job_cutover_invoice_request_invoice_unique").on(t.invoiceId),
    index("job_cutover_invoice_request_job_idx").on(t.jobId),
    foreignKey({
      name: "job_cutover_invoice_billing_commit_fk",
      columns: [t.billingCommitId, t.jobId, t.billingKind],
      foreignColumns: [
        jobCutoverCommitsTable.id,
        jobCutoverCommitsTable.jobId,
        jobCutoverCommitsTable.kind,
      ],
    }).onDelete("restrict"),
    check(
      "job_cutover_invoice_request_valid",
      sql`${t.revision}>0 AND ${t.billingKind}='billing' AND ${t.initialGrossCents} BETWEEN 0 AND 9007199254740991 AND ${t.currentGrossCents} BETWEEN 0 AND 9007199254740991 AND ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' AND ${t.financialFingerprint} ~ '^[a-f0-9]{64}$' AND jsonb_typeof(${t.requestPayload})='object'`,
    ),
  ],
);
