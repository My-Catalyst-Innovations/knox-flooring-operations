import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";
import { jobDocumentsTable } from "./microsoft-files";
import { laborEntriesTable } from "./labor-entries";
import {
  quickbooksConnectionsTable,
  quickbooksSyncJobsTable,
} from "./quickbooks";

export const jobExpensesTable = pgTable(
  "job_expenses",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobsTable.id, { onDelete: "restrict" }),
    requestKey: text("request_key").notNull(),
    revision: integer("revision").notNull().default(1),
    kind: text("kind").$type<"paid_purchase" | "contractor_bill">().notNull(),
    category: text("category")
      .$type<"materials" | "labor" | "other">()
      .notNull(),
    description: text("description").notNull(),
    vendorName: text("vendor_name").notNull(),
    transactionDate: text("transaction_date").notNull(),
    dueDate: text("due_date"),
    currency: text("currency").notNull(),
    amountCents: integer("amount_cents").notNull(),
    taxCents: integer("tax_cents").notNull(),
    reference: text("reference").notNull(),
    notes: text("notes").notNull().default(""),
    receiptDocumentId: text("receipt_document_id")
      .notNull()
      .references(() => jobDocumentsTable.id, { onDelete: "restrict" }),
    receiptSha256: text("receipt_sha256").notNull(),
    relatedLaborEntryId: text("related_labor_entry_id").references(
      () => laborEntriesTable.id,
      { onDelete: "restrict" },
    ),
    actorUserId: text("actor_user_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("job_expenses_job_idx").on(t.jobId),
    uniqueIndex("job_expenses_request_unique").on(t.requestKey),
    uniqueIndex("job_expenses_receipt_unique").on(t.receiptDocumentId),
    uniqueIndex("job_expenses_receipt_hash_unique").on(t.receiptSha256),
    uniqueIndex("job_expenses_related_labor_unique").on(t.relatedLaborEntryId),
    check(
      "job_expenses_kind_valid",
      sql`${t.kind} IN ('paid_purchase','contractor_bill')`,
    ),
    check(
      "job_expenses_category_valid",
      sql`${t.category} IN ('materials','labor','other')`,
    ),
    check(
      "job_expenses_amount_valid",
      sql`${t.currency}='USD' AND ${t.amountCents}>0 AND ${t.taxCents} BETWEEN 0 AND ${t.amountCents} AND ${t.revision}>0`,
    ),
    check(
      "job_expenses_due_valid",
      sql`(${t.kind}='paid_purchase' AND ${t.dueDate} IS NULL) OR (${t.kind}='contractor_bill' AND ${t.dueDate} IS NOT NULL)`,
    ),
    check(
      "job_expenses_labor_link_valid",
      sql`${t.relatedLaborEntryId} IS NULL OR (${t.kind}='contractor_bill' AND ${t.category}='labor')`,
    ),
    check(
      "job_expenses_receipt_hash_valid",
      sql`${t.receiptSha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const quickbooksJobCostExportsTable = pgTable(
  "quickbooks_job_cost_exports",
  {
    id: text("id").primaryKey(),
    sourceKind: text("source_kind").$type<"labor" | "expense">().notNull(),
    sourceId: text("source_id").notNull(),
    laborEntryId: text("labor_entry_id").references(
      () => laborEntriesTable.id,
      { onDelete: "restrict" },
    ),
    expenseId: text("expense_id").references(() => jobExpensesTable.id, {
      onDelete: "restrict",
    }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobsTable.id, { onDelete: "restrict" }),
    queueId: text("queue_id")
      .notNull()
      .references(() => quickbooksSyncJobsTable.id, { onDelete: "restrict" }),
    connectionId: text("connection_id").notNull(),
    realmId: text("realm_id").notNull(),
    environment: text("environment").notNull(),
    state: text("state")
      .$type<
        | "prepared"
        | "submitting"
        | "unknown"
        | "confirmed"
        | "rejected"
        | "cancelled"
      >()
      .notNull(),
    sourceRevision: integer("source_revision").notNull(),
    fingerprint: text("fingerprint").notNull(),
    requestId: text("request_id").notNull(),
    remoteEntity: text("remote_entity")
      .$type<"TimeActivity" | "Purchase" | "Bill">()
      .notNull(),
    remoteId: text("remote_id"),
    syncToken: text("sync_token"),
    selection: jsonb("selection").$type<Record<string, unknown>>().notNull(),
    document: jsonb("document").$type<Record<string, unknown>>().notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: text("approved_at").notNull(),
    submittedAt: text("submitted_at"),
    confirmedAt: text("confirmed_at"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("quickbooks_job_cost_job_idx").on(t.jobId),
    index("quickbooks_job_cost_labor_idx").on(t.laborEntryId),
    index("quickbooks_job_cost_expense_idx").on(t.expenseId),
    uniqueIndex("quickbooks_job_cost_queue_unique").on(t.queueId),
    uniqueIndex("quickbooks_job_cost_request_unique").on(
      t.realmId,
      t.environment,
      t.requestId,
    ),
    uniqueIndex("quickbooks_job_cost_source_active_unique")
      .on(t.sourceKind, t.sourceId)
      .where(sql`${t.state} NOT IN ('cancelled','rejected')`),
    check(
      "quickbooks_job_cost_source_valid",
      sql`(${t.sourceKind}='labor' AND ${t.laborEntryId} IS NOT NULL AND ${t.laborEntryId}=${t.sourceId} AND ${t.expenseId} IS NULL) OR (${t.sourceKind}='expense' AND ${t.expenseId} IS NOT NULL AND ${t.expenseId}=${t.sourceId} AND ${t.laborEntryId} IS NULL)`,
    ),
    check(
      "quickbooks_job_cost_state_valid",
      sql`${t.state} IN ('prepared','submitting','unknown','confirmed','rejected','cancelled')`,
    ),
    check(
      "quickbooks_job_cost_request_valid",
      sql`length(${t.requestId}) BETWEEN 1 AND 50`,
    ),
  ],
);

export const quickbooksProjectLinksTable = pgTable(
  "quickbooks_project_links",
  {
    jobId: text("job_id")
      .primaryKey()
      .references(() => jobsTable.id, { onDelete: "restrict" }),
    connectionId: text("connection_id").notNull(),
    realmId: text("realm_id").notNull(),
    environment: text("environment").notNull(),
    quickbooksProjectId: text("quickbooks_project_id").notNull(),
    quickbooksCustomerId: text("quickbooks_customer_id").notNull(),
    projectName: text("project_name").notNull(),
    projectStatus: text("project_status").notNull(),
    fingerprint: text("fingerprint").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: text("approved_at").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("quickbooks_project_remote_unique").on(
      t.connectionId,
      t.quickbooksProjectId,
    ),
    check(
      "quickbooks_project_link_version_valid",
      sql`${t.revision}>0 AND ${t.environment} IN ('sandbox','production')`,
    ),
  ],
);
export const quickbooksProjectReviewsTable = pgTable(
  "quickbooks_project_reviews",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobsTable.id, { onDelete: "restrict" }),
    connectionId: text("connection_id").notNull(),
    realmId: text("realm_id").notNull(),
    environment: text("environment").notNull(),
    quickbooksCustomerId: text("quickbooks_customer_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    jobRevision: integer("job_revision").notNull(),
    jobUpdatedAt: text("job_updated_at").notNull(),
    revision: integer("revision").notNull().default(1),
    fingerprint: text("fingerprint").notNull(),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text("status")
      .$type<
        | "pending_approval"
        | "submitting"
        | "unknown"
        | "linked"
        | "failed"
        | "cancelled"
      >()
      .notNull(),
    submittedAt: text("submitted_at"),
    quickbooksProjectId: text("quickbooks_project_id"),
    lastError: text("last_error"),
    approvedBy: text("approved_by"),
    approvedAt: text("approved_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("quickbooks_project_reviews_job_idx").on(t.jobId),
    uniqueIndex("quickbooks_project_review_company_unique").on(
      t.jobId,
      t.connectionId,
    ),
    check(
      "quickbooks_project_review_version_valid",
      sql`${t.revision}>0 AND ${t.jobRevision}>0 AND ${t.environment} IN ('sandbox','production')`,
    ),
    check(
      "quickbooks_project_review_state_valid",
      sql`${t.status} IN ('pending_approval','submitting','unknown','linked','failed','cancelled')`,
    ),
    check(
      "quickbooks_project_review_submission_valid",
      sql`${t.status} NOT IN ('submitting','unknown','linked','failed') OR ${t.submittedAt} IS NOT NULL`,
    ),
  ],
);
