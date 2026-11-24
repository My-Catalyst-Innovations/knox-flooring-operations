import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { purchaseReceiptLinesTable } from "./purchase-orders";
import { quickbooksSyncJobsTable } from "./quickbooks";
import { inventoryMovementsTable } from "./operations";
import { productsTable } from "./products";
import { jobsTable } from "./jobs";
type Snapshot = Record<string, unknown>;
const quantity = (name: string) => numeric(name, { precision: 18, scale: 6 });

export const vendorBillCoverageApprovalsTable = pgTable(
  "vendor_bill_coverage_approvals",
  {
    id: text("id").primaryKey(),
    requestKey: text("request_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    fingerprint: text("fingerprint").notNull(),
    mode: text("mode")
      .$type<"local_review" | "quickbooks_verified">()
      .notNull(),
    workspaceKey: text("workspace_key").notNull(),
    connectionId: text("connection_id"),
    realmId: text("realm_id"),
    environment: text("environment"),
    choice: jsonb("choice").$type<Snapshot>().notNull(),
    sourceSnapshot: jsonb("source_snapshot").$type<Snapshot>().notNull(),
    note: text("note").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("vendor_bill_coverage_request_unique").on(t.requestKey),
    uniqueIndex("vendor_bill_coverage_id_mode_unique").on(t.id, t.mode),
    uniqueIndex("vendor_bill_coverage_id_company_unique").on(
      t.id,
      t.realmId,
      t.environment,
    ),
    index("vendor_bill_coverage_company_idx").on(t.realmId, t.environment),
    check(
      "vendor_bill_coverage_approval_valid",
      sql`${t.requestFingerprint} ~ '^[a-f0-9]{64}$' AND ${t.fingerprint} ~ '^[a-f0-9]{64}$' AND length(btrim(${t.note})) BETWEEN 10 AND 1000 AND jsonb_typeof(${t.choice})='object' AND jsonb_typeof(${t.sourceSnapshot})='object' AND ((${t.mode}='local_review' AND ${t.connectionId} IS NULL AND ${t.realmId} IS NULL AND ${t.environment} IS NULL) OR (${t.mode}='quickbooks_verified' AND ${t.connectionId} IS NOT NULL AND ${t.realmId} IS NOT NULL AND ${t.environment} IS NOT NULL AND ${t.realmId} ~ '^[0-9]{1,30}$' AND ${t.environment} IN ('sandbox','production')))`,
    ),
  ],
);

export const vendorBillReceiptAllocationsTable = pgTable(
  "vendor_bill_receipt_allocations",
  {
    id: text("id").primaryKey(),
    approvalId: text("approval_id").notNull(),
    receiptLineId: text("receipt_line_id").notNull(),
    billId: text("bill_id").notNull(),
    billLineIndex: integer("bill_line_index").notNull(),
    productId: text("product_id").notNull(),
    aliasId: text("alias_id").notNull(),
    priceId: text("price_id").notNull(),
    mode: text("mode")
      .$type<"local_review" | "quickbooks_verified">()
      .notNull(),
    stockUnit: text("stock_unit").notNull(),
    quantity: quantity("quantity").notNull(),
    receiptUnitCost: quantity("receipt_unit_cost").notNull(),
    billedUnitCost: quantity("billed_unit_cost").notNull(),
    billLineQuantity: quantity("bill_line_quantity").notNull(),
    billSource: jsonb("bill_source").$type<Snapshot>().notNull(),
    billSourceFingerprint: text("bill_source_fingerprint").notNull(),
    receiptSnapshot: jsonb("receipt_snapshot").$type<Snapshot>().notNull(),
    identitySnapshot: jsonb("identity_snapshot").$type<Snapshot>().notNull(),
    varianceNote: text("variance_note").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "vbc_allocation_receipt_fk",
      columns: [t.receiptLineId],
      foreignColumns: [purchaseReceiptLinesTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "vbc_allocation_bill_fk",
      columns: [t.billId],
      foreignColumns: [quickbooksSyncJobsTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "vbc_allocation_product_fk",
      columns: [t.productId],
      foreignColumns: [productsTable.id],
    }).onDelete("restrict"),
    uniqueIndex("vendor_bill_allocation_approval_pair_unique").on(
      t.approvalId,
      t.receiptLineId,
      t.billId,
      t.billLineIndex,
    ),
    index("vendor_bill_allocation_receipt_idx").on(t.receiptLineId),
    index("vendor_bill_allocation_bill_idx").on(t.billId, t.billLineIndex),
    foreignKey({
      name: "vendor_bill_allocation_approval_mode_fk",
      columns: [t.approvalId, t.mode],
      foreignColumns: [
        vendorBillCoverageApprovalsTable.id,
        vendorBillCoverageApprovalsTable.mode,
      ],
    }).onDelete("restrict"),
    check(
      "vendor_bill_allocation_valid",
      sql`${t.billLineIndex}>=0 AND ${t.quantity}>0 AND ${t.quantity}<'Infinity'::numeric AND ${t.receiptUnitCost}>=0 AND ${t.receiptUnitCost}<'Infinity'::numeric AND ${t.billedUnitCost}>=0 AND ${t.billedUnitCost}<'Infinity'::numeric AND ${t.billLineQuantity}>0 AND ${t.billLineQuantity}<'Infinity'::numeric AND ${t.mode} IN ('local_review','quickbooks_verified') AND ${t.billSourceFingerprint} ~ '^[a-f0-9]{64}$' AND length(${t.varianceNote})<=500 AND (${t.receiptUnitCost}=${t.billedUnitCost} OR length(btrim(${t.varianceNote}))>=10) AND jsonb_typeof(${t.billSource})='object' AND jsonb_typeof(${t.receiptSnapshot})='object' AND jsonb_typeof(${t.identitySnapshot})='object'`,
    ),
  ],
);

export const vendorBillCoverageBindingsTable = pgTable(
  "vendor_bill_coverage_bindings",
  {
    id: text("id").primaryKey(),
    approvalId: text("approval_id").notNull(),
    allocationId: text("allocation_id").notNull(),
    billId: text("bill_id").notNull(),
    billLineIndex: integer("bill_line_index").notNull(),
    connectionId: text("connection_id").notNull(),
    realmId: text("realm_id").notNull(),
    environment: text("environment").notNull(),
    vendorId: text("vendor_id").notNull(),
    itemId: text("item_id").notNull(),
    postedBillId: text("posted_bill_id").notNull(),
    quantity: quantity("quantity").notNull(),
    billLineQuantity: quantity("bill_line_quantity").notNull(),
    billedUnitCost: quantity("billed_unit_cost").notNull(),
    billSource: jsonb("bill_source").$type<Snapshot>().notNull(),
    billSourceFingerprint: text("bill_source_fingerprint").notNull(),
    providerSnapshot: jsonb("provider_snapshot").$type<Snapshot>().notNull(),
    identitySnapshot: jsonb("identity_snapshot").$type<Snapshot>().notNull(),
    varianceNote: text("variance_note").notNull(),
    reconciliationNote: text("reconciliation_note").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "vbc_binding_allocation_fk",
      columns: [t.allocationId],
      foreignColumns: [vendorBillReceiptAllocationsTable.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "vbc_binding_bill_fk",
      columns: [t.billId],
      foreignColumns: [quickbooksSyncJobsTable.id],
    }).onDelete("restrict"),
    uniqueIndex("vendor_bill_binding_approval_pair_unique").on(
      t.approvalId,
      t.allocationId,
      t.billId,
      t.billLineIndex,
    ),
    index("vendor_bill_binding_allocation_idx").on(t.allocationId),
    index("vendor_bill_binding_bill_idx").on(t.billId, t.billLineIndex),
    index("vendor_bill_binding_company_idx").on(t.realmId, t.environment),
    index("vendor_bill_binding_provider_line_idx").on(
      t.realmId,
      t.environment,
      t.postedBillId,
      t.billLineIndex,
    ),
    foreignKey({
      name: "vendor_bill_binding_approval_company_fk",
      columns: [t.approvalId, t.realmId, t.environment],
      foreignColumns: [
        vendorBillCoverageApprovalsTable.id,
        vendorBillCoverageApprovalsTable.realmId,
        vendorBillCoverageApprovalsTable.environment,
      ],
    }).onDelete("restrict"),
    check(
      "vendor_bill_binding_valid",
      sql`${t.billLineIndex}>=0 AND ${t.quantity}>0 AND ${t.quantity}<'Infinity'::numeric AND ${t.billLineQuantity}>0 AND ${t.billLineQuantity}<'Infinity'::numeric AND ${t.billedUnitCost}>=0 AND ${t.billedUnitCost}<'Infinity'::numeric AND ${t.realmId} ~ '^[0-9]{1,30}$' AND ${t.environment} IN ('sandbox','production') AND ${t.vendorId} ~ '^[0-9]{1,30}$' AND ${t.itemId} ~ '^[0-9]{1,30}$' AND ${t.postedBillId} ~ '^[0-9]{1,30}$' AND ${t.billSourceFingerprint} ~ '^[a-f0-9]{64}$' AND length(${t.varianceNote})<=500 AND length(${t.reconciliationNote})<=500 AND jsonb_typeof(${t.billSource})='object' AND jsonb_typeof(${t.providerSnapshot})='object' AND jsonb_typeof(${t.identitySnapshot})='object'`,
    ),
  ],
);

export const vendorBillDocumentsTable = pgTable(
  "vendor_bill_documents",
  {
    id: text("id").primaryKey(),
    billId: text("bill_id")
      .notNull()
      .references(() => quickbooksSyncJobsTable.id, { onDelete: "restrict" }),
    objectPath: text("object_path").notNull(),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    requestKey: text("request_key").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("vendor_bill_document_request_unique").on(t.requestKey),
    uniqueIndex("vendor_bill_document_object_unique").on(t.objectPath),
    uniqueIndex("vendor_bill_document_hash_unique").on(t.billId, t.sha256),
    index("vendor_bill_document_bill_idx").on(t.billId),
    check(
      "vendor_bill_document_valid",
      sql`${t.size}>0 AND ${t.size}<=10485760 AND ${t.sha256} ~ '^[a-f0-9]{64}$' AND length(${t.name}) BETWEEN 1 AND 255`,
    ),
  ],
);

export const inventoryAccountingCasesTable = pgTable(
  "inventory_accounting_cases",
  {
    id: text("id").primaryKey(),
    requestKey: text("request_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    fingerprint: text("fingerprint").notNull(),
    kind: text("kind")
      .$type<"return_quantity_plan" | "manual_review">()
      .notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "restrict" }),
    jobId: text("job_id").references(() => jobsTable.id, {
      onDelete: "restrict",
    }),
    connectionId: text("connection_id"),
    realmId: text("realm_id"),
    environment: text("environment"),
    note: text("note").notNull(),
    reasonCodes: jsonb("reason_codes").$type<string[]>().notNull(),
    sourceSnapshot: jsonb("source_snapshot").$type<Snapshot>().notNull(),
    document: jsonb("document").$type<Snapshot>(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("inventory_accounting_case_request_unique").on(t.requestKey),
    uniqueIndex("inventory_accounting_case_id_company_unique").on(
      t.id,
      t.realmId,
      t.environment,
    ),
    index("inventory_accounting_case_product_idx").on(t.productId),
    index("inventory_accounting_case_company_idx").on(t.realmId, t.environment),
    check(
      "inventory_accounting_case_valid",
      sql`${t.kind} IN ('return_quantity_plan','manual_review') AND ${t.fingerprint} ~ '^[a-f0-9]{64}$' AND ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' AND length(btrim(${t.note})) BETWEEN 10 AND 1000 AND jsonb_typeof(${t.reasonCodes})='array' AND jsonb_typeof(${t.sourceSnapshot})='object' AND (${t.kind}<>'return_quantity_plan' OR ${t.connectionId} IS NOT NULL) AND ((${t.connectionId} IS NULL AND ${t.realmId} IS NULL AND ${t.environment} IS NULL) OR (${t.connectionId} IS NOT NULL AND ${t.realmId} IS NOT NULL AND ${t.environment} IS NOT NULL AND ${t.realmId} ~ '^[0-9]{1,30}$' AND ${t.environment} IN ('sandbox','production')))`,
    ),
  ],
);

export const inventoryAccountingCaseReturnsTable = pgTable(
  "inventory_accounting_case_returns",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull(),
    returnId: text("return_id").notNull(),
    realmId: text("realm_id").notNull(),
    environment: text("environment").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "inventory_case_return_movement_fk",
      columns: [t.returnId],
      foreignColumns: [inventoryMovementsTable.id],
    }).onDelete("restrict"),
    uniqueIndex("inventory_accounting_return_company_unique").on(
      t.returnId,
      t.realmId,
      t.environment,
    ),
    index("inventory_accounting_case_return_idx").on(t.caseId),
    foreignKey({
      name: "inventory_accounting_return_case_company_fk",
      columns: [t.caseId, t.realmId, t.environment],
      foreignColumns: [
        inventoryAccountingCasesTable.id,
        inventoryAccountingCasesTable.realmId,
        inventoryAccountingCasesTable.environment,
      ],
    }).onDelete("restrict"),
    check(
      "inventory_accounting_case_return_valid",
      sql`${t.realmId} ~ '^[0-9]{1,30}$' AND ${t.environment} IN ('sandbox','production')`,
    ),
  ],
);

export const inventoryAccountingCaseEventsTable = pgTable(
  "inventory_accounting_case_events",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull(),
    requestKey: text("request_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    kind: text("kind")
      .$type<"operator_note" | "external_adjustment_verified">()
      .notNull(),
    note: text("note").notNull(),
    adjustmentId: text("adjustment_id"),
    realmId: text("realm_id"),
    environment: text("environment"),
    providerSnapshot: jsonb("provider_snapshot").$type<Snapshot>(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "inventory_case_event_case_fk",
      columns: [t.caseId],
      foreignColumns: [inventoryAccountingCasesTable.id],
    }).onDelete("restrict"),
    uniqueIndex("inventory_accounting_event_request_unique").on(t.requestKey),
    uniqueIndex("inventory_accounting_case_external_once_unique")
      .on(t.caseId)
      .where(sql`${t.kind}='external_adjustment_verified'`),
    uniqueIndex("inventory_accounting_adjustment_company_unique").on(
      t.adjustmentId,
      t.realmId,
      t.environment,
    ),
    index("inventory_accounting_event_case_idx").on(t.caseId),
    foreignKey({
      name: "inventory_accounting_event_case_company_fk",
      columns: [t.caseId, t.realmId, t.environment],
      foreignColumns: [
        inventoryAccountingCasesTable.id,
        inventoryAccountingCasesTable.realmId,
        inventoryAccountingCasesTable.environment,
      ],
    }).onDelete("restrict"),
    check(
      "inventory_accounting_case_event_valid",
      sql`${t.requestFingerprint} ~ '^[a-f0-9]{64}$' AND length(btrim(${t.note})) BETWEEN 10 AND 1000 AND ((${t.kind}='operator_note' AND ${t.adjustmentId} IS NULL AND ${t.providerSnapshot} IS NULL AND ${t.realmId} IS NULL AND ${t.environment} IS NULL) OR (${t.kind}='external_adjustment_verified' AND ${t.adjustmentId} IS NOT NULL AND ${t.realmId} IS NOT NULL AND ${t.environment} IS NOT NULL AND ${t.providerSnapshot} IS NOT NULL AND ${t.adjustmentId} ~ '^[0-9]{1,30}$' AND ${t.realmId} ~ '^[0-9]{1,30}$' AND ${t.environment} IN ('sandbox','production') AND jsonb_typeof(${t.providerSnapshot})='object'))`,
    ),
  ],
);
