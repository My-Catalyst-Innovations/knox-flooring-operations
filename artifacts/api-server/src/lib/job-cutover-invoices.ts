import { and, eq } from "drizzle-orm";
import {
  db,
  invoicesTable,
  jobCutoversTable,
  jobCutoverCommitsTable,
  activeJobImportRecordsTable,
  jobCutoverInvoiceRequestsTable as requests,
  quickbooksEntityMappingsTable,
  quickbooksSyncJobsTable,
  type InvoiceRow,
  type JobRow,
} from "@workspace/db";
import { invoiceSubtotal } from "@workspace/domain";
import { cutoverHash as hash } from "./cutover-hash";
import {
  cutoverInvoiceConsumption,
  integerCents,
  jobCutoverScopeFingerprint,
  jobMigrationCutover,
  lockedCutoverJob,
  type CutoverWriter,
} from "./job-cutover";
import { DomainError } from "./operations-rules";
import { isReviewedInvoiceAmount } from "./quickbooks-invoice-review";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const now = () => new Date().toISOString();
/** PostgreSQL REAL readbacks may be fround(decimal); accept only an exact cent representation. */
function amountCents(value: number, label: string) {
  if (!isReviewedInvoiceAmount(value))
    throw new DomainError(
      409,
      `${label} is not faithfully representable to the cent. Keep imported-job invoicing blocked until its exact amount is supported.`,
    );
  return integerCents(Math.round(value * 100), label);
}
export function cutoverInvoiceFinancialDocument(
  invoice: Pick<
    InvoiceRow,
    | "id"
    | "jobId"
    | "customerId"
    | "invoiceNumber"
    | "jobNumber"
    | "customerName"
    | "issueDate"
    | "dueDate"
    | "notes"
    | "taxCode"
    | "lineItems"
    | "subtotal"
    | "taxableAmount"
    | "taxAmount"
    | "discountAmount"
    | "total"
    | "depositAmount"
  >,
) {
  if (
    !invoice.lineItems.length ||
    invoice.lineItems.some(
      (line) =>
        !Number.isFinite(line.quantity) ||
        line.quantity <= 0 ||
        !Number.isFinite(line.unitPrice) ||
        line.unitPrice < 0,
    )
  )
    throw new DomainError(
      409,
      "Review positive line quantities and nonnegative unit prices. Imported-job billing does not create credit or refund lines.",
    );
  const subtotal = amountCents(
      invoiceSubtotal(invoice.lineItems),
      "Line subtotal",
    ),
    discount = amountCents(invoice.discountAmount, "Discount"),
    tax = amountCents(invoice.taxAmount, "Tax"),
    total = Math.max(0, subtotal - discount) + tax;
  if (
    discount > subtotal ||
    amountCents(invoice.subtotal, "Saved subtotal") !== subtotal ||
    amountCents(invoice.taxableAmount, "Saved taxable amount") !==
      subtotal - discount ||
    amountCents(invoice.total, "Saved gross total") !== total
  )
    throw new DomainError(
      409,
      "The imported-job invoice does not reconcile exactly to its approved line amounts, discount and tax.",
    );
  return {
    id: invoice.id,
    jobId: invoice.jobId,
    customerId: invoice.customerId,
    invoiceNumber: invoice.invoiceNumber,
    jobNumber: invoice.jobNumber,
    customerName: invoice.customerName,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    notes: invoice.notes,
    taxCode: invoice.taxCode,
    lineItems: invoice.lineItems,
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: integerCents(total),
    depositCents: amountCents(invoice.depositAmount, "Deposit"),
  };
}
export const cutoverInvoiceFingerprint = (invoice: InvoiceRow) =>
  hash(cutoverInvoiceFinancialDocument(invoice));
export type CutoverRequestedAmounts = Pick<
  InvoiceRow,
  | "lineItems"
  | "subtotal"
  | "taxableAmount"
  | "taxAmount"
  | "discountAmount"
  | "total"
  | "depositAmount"
>;
export function assertCutoverInvoiceReadback(
  invoice: InvoiceRow,
  requested: CutoverRequestedAmounts,
) {
  if (
    hash(cutoverInvoiceFinancialDocument({ ...invoice, ...requested })) !==
    cutoverInvoiceFingerprint(invoice)
  )
    throw new DomainError(
      409,
      "The database cannot retain these requested invoice amounts exactly to the cent. No invoice or billing consumption was committed; use a supported amount or review the storage model.",
    );
}
export async function presentCutoverInvoice(
  writer: CutoverWriter,
  invoice: InvoiceRow,
) {
  const [state] = await writer
    .select({ jobId: jobCutoversTable.jobId })
    .from(jobCutoversTable)
    .where(eq(jobCutoversTable.jobId, invoice.jobId));
  return {
    ...invoice,
    ...(state
      ? { invoiceFinancialFingerprint: cutoverInvoiceFingerprint(invoice) }
      : {}),
  };
}
async function currentBilling(tx: Tx, job: JobRow, expected?: number) {
  const [state] = await tx
    .select()
    .from(jobCutoversTable)
    .where(eq(jobCutoversTable.jobId, job.id));
  if (!state) return null;
  if (expected !== undefined && state.revision !== expected)
    throw new DomainError(
      409,
      "The imported-job cutover changed. Refresh its remaining billable scope.",
    );
  if (!state.billingCommitId)
    throw new DomainError(
      409,
      "Review the separately evidenced amount still billable after all legacy invoices, including unpaid invoices, before creating or changing this invoice.",
    );
  const [commit] = await tx
    .select()
    .from(jobCutoverCommitsTable)
    .where(
      and(
        eq(jobCutoverCommitsTable.id, state.billingCommitId),
        eq(jobCutoverCommitsTable.jobId, job.id),
        eq(jobCutoverCommitsTable.kind, "billing"),
      ),
    );
  const [source] = await tx
    .select()
    .from(activeJobImportRecordsTable)
    .where(
      and(
        eq(activeJobImportRecordsTable.id, state.sourceRecordId),
        eq(activeJobImportRecordsTable.jobId, job.id),
        eq(activeJobImportRecordsTable.action, "create"),
      ),
    );
  const payload = commit?.result.payload as
    | { kind?: string; worksGrossInvoiceCeilingAfterLegacyCents?: unknown }
    | undefined;
  if (
    !commit ||
    !source ||
    hash(source.sourceData) !== source.sourceRowSha256 ||
    commit.result.sourceFingerprint !== source.sourceRowSha256 ||
    commit.result.scopeFingerprint !== jobCutoverScopeFingerprint(job) ||
    payload?.kind !== "billing"
  )
    throw new DomainError(
      409,
      "The approved remaining-billable scope is stale.",
    );
  const ceilingCents = integerCents(
    payload.worksGrossInvoiceCeilingAfterLegacyCents,
    "Reviewed billing ceiling",
  );
  return { state, cutover: { billing: { ceilingCents } }, commit };
}
export async function replayCutoverInvoice(
  tx: Tx,
  job: JobRow,
  requestKey: unknown,
  payload: Record<string, unknown>,
) {
  const [state] = await tx
    .select()
    .from(jobCutoversTable)
    .where(eq(jobCutoversTable.jobId, job.id));
  if (!state) return null;
  if (
    typeof requestKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      requestKey,
    )
  )
    throw new DomainError(
      400,
      "Use a stable UUID requestKey for this imported-job invoice. Retry the same request after an unknown response.",
    );
  const [prior] = await tx
    .select()
    .from(requests)
    .where(eq(requests.id, requestKey));
  if (!prior) return null;
  if (prior.jobId !== job.id || prior.requestFingerprint !== hash(payload))
    throw new DomainError(
      409,
      "This invoice request key already belongs to different immutable input. Reuse its exact original request or start a new reviewed request.",
      { code: "invoice_request_identity_conflict" },
    );
  const [invoice] = await tx
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.id, prior.invoiceId),
        eq(invoicesTable.jobId, job.id),
      ),
    );
  if (!invoice)
    throw new DomainError(
      409,
      "The retained imported-job invoice is missing. Reconcile it without recreating the request.",
      { code: "invoice_request_identity_conflict" },
    );
  return invoice;
}
export async function consumeCutoverInvoice(
  tx: Tx,
  job: JobRow,
  invoice: InvoiceRow,
  requestKey: string,
  payload: Record<string, unknown>,
  actor: string,
  expected?: number,
  requested?: CutoverRequestedAmounts,
) {
  const billing = await currentBilling(tx, job, expected);
  if (!billing) return;
  if (!requested)
    throw new DomainError(
      409,
      "The original exact requested amounts are required before imported-job billing consumption.",
    );
  assertCutoverInvoiceReadback(invoice, requested);
  if (
    invoice.status !== "Draft" ||
    invoice.depositAmount ||
    invoice.paidAmount ||
    invoice.refundedAmount
  )
    throw new DomainError(
      409,
      "Create an imported-job invoice as an unpaid Draft. This action never establishes legacy payments, deposits, credits or balances.",
    );
  // The new invoice is already inserted in this transaction. Inspect all prior
  // claims directly so the temporary insert-before-claim FK cannot look orphaned.
  const claims = await tx
    .select()
    .from(requests)
    .where(eq(requests.jobId, job.id));
  const existing = await tx
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.jobId, job.id));
  if (
    existing.some(
      (row) =>
        row.id !== invoice.id &&
        !claims.some((claim) => claim.invoiceId === row.id),
    )
  )
    throw new DomainError(
      409,
      "A previous invoice lacks a retained billing claim. Reconcile before creating another.",
    );
  const document = cutoverInvoiceFinancialDocument(invoice),
    used = integerCents(
      claims.reduce((sum, row) => sum + row.currentGrossCents, 0),
    );
  if (used + document.totalCents > billing.cutover.billing.ceilingCents!)
    throw new DomainError(
      409,
      "This gross invoice exceeds the reviewed remaining-billable ceiling. Drafts and all retained invoices consume the ceiling; unpaid legacy invoices are already excluded from it.",
      {
        ceilingCents: billing.cutover.billing.ceilingCents,
        consumedCents: used,
        requestedCents: document.totalCents,
      },
    );
  await tx.insert(requests).values({
    id: requestKey,
    jobId: job.id,
    invoiceId: invoice.id,
    billingCommitId: billing.commit.id,
    requestFingerprint: hash(payload),
    requestPayload: payload,
    initialGrossCents: document.totalCents,
    currentGrossCents: document.totalCents,
    financialFingerprint: hash(document),
    createdBy: actor,
    createdAt: now(),
    updatedAt: now(),
  });
}
export async function assertCutoverInvoiceCreate(
  tx: Tx,
  job: JobRow,
  expected?: number,
) {
  const billing = await currentBilling(tx, job, expected);
  if (billing && expected === undefined)
    throw new DomainError(
      400,
      "Refresh and include expectedCutoverRevision before creating this imported-job invoice.",
    );
  return billing;
}
export async function updateCutoverInvoiceClaim(
  tx: Tx,
  job: JobRow,
  current: InvoiceRow,
  updated: InvoiceRow,
  expected: unknown,
  expectedFingerprint: unknown,
) {
  const [state] = await tx
    .select()
    .from(jobCutoversTable)
    .where(eq(jobCutoversTable.jobId, job.id));
  if (!state) return false;
  if (
    typeof expected !== "number" ||
    typeof expectedFingerprint !== "string" ||
    cutoverInvoiceFingerprint(current) !== expectedFingerprint
  )
    throw new DomainError(
      409,
      "Refresh the exact invoice financial fingerprint and cutover revision before editing it.",
    );
  if (
    updated.jobId !== current.jobId ||
    updated.customerId !== current.customerId
  )
    throw new DomainError(
      409,
      "Imported-job invoice attribution cannot move to another job or customer.",
    );
  if (
    updated.status !== current.status &&
    ["Paid", "Partial", "Credited", "Refunded"].includes(updated.status)
  )
    throw new DomainError(
      409,
      "Imported-job payment, credit and refund status requires actual supported payment evidence; a manual status edit cannot establish it.",
    );
  const [claim] = await tx
    .select()
    .from(requests)
    .where(and(eq(requests.invoiceId, current.id), eq(requests.jobId, job.id)))
    .for("update");
  if (
    !claim ||
    claim.financialFingerprint !== cutoverInvoiceFingerprint(current)
  )
    throw new DomainError(
      409,
      "The invoice differs from its immutable billing consumption. Reconcile it without freeing capacity.",
      { code: "invoice_request_identity_conflict" },
    );
  const newDocument = cutoverInvoiceFinancialDocument(updated),
    changed = hash(newDocument) !== claim.financialFingerprint;
  if (!changed) return true;
  if (
    claim.submissionLocked ||
    current.status !== "Draft" ||
    current.paidAmount ||
    current.depositAmount ||
    current.refundedAmount
  )
    throw new DomainError(
      409,
      "Only an untouched pre-submission draft can change imported-job financial amounts. Payments, voids and refunds do not replenish capacity.",
    );
  const [provider] = await tx
    .select({ id: quickbooksEntityMappingsTable.id })
    .from(quickbooksEntityMappingsTable)
    .where(
      and(
        eq(quickbooksEntityMappingsTable.entityType, "invoice"),
        eq(quickbooksEntityMappingsTable.localId, current.id),
      ),
    )
    .limit(1);
  const queued = await tx
    .select()
    .from(quickbooksSyncJobsTable)
    .where(
      and(
        eq(quickbooksSyncJobsTable.entityType, "invoice"),
        eq(quickbooksSyncJobsTable.localId, current.id),
      ),
    )
    .for("update");
  if (
    provider ||
    queued.some(
      (row) =>
        row.status !== "cancelled" &&
        (row.status !== "pending_approval" ||
          row.approvedAt ||
          row.payload.quickBooksInvoiceCreateAttempt ||
          row.payload.quickBooksAccountingReview),
    )
  )
    throw new DomainError(
      409,
      "Cancel and reconcile existing accounting approval before changing this imported-job draft. Submitted or ambiguous amounts cannot be rewritten.",
    );
  const billing = await currentBilling(tx, job, expected),
    used = await cutoverInvoiceConsumption(tx, job.id);
  if (
    !billing ||
    used - claim.currentGrossCents + newDocument.totalCents >
      billing.cutover.billing.ceilingCents!
  )
    throw new DomainError(
      409,
      "This draft edit exceeds its current reviewed remaining-billable ceiling.",
    );
  await tx
    .update(requests)
    .set({
      currentGrossCents: newDocument.totalCents,
      financialFingerprint: hash(newDocument),
      revision: claim.revision + 1,
      updatedAt: now(),
    })
    .where(eq(requests.id, claim.id));
  for (const row of queued.filter((row) => row.status === "pending_approval"))
    await tx
      .update(quickbooksSyncJobsTable)
      .set({
        status: "cancelled",
        lastError:
          "Unsubmitted draft changed under its current remaining-billable ceiling. Review the replacement document.",
        updatedAt: now(),
      })
      .where(eq(quickbooksSyncJobsTable.id, row.id));
  return true;
}
/** Job -> invoice -> immutable capacity claim. Call inside actual submission claim. */
export async function assertCutoverInvoiceSubmission(
  tx: Tx,
  source: InvoiceRow,
  lockSubmission: boolean,
) {
  const job = await lockedCutoverJob(tx, source.jobId);
  const [state] = await tx
    .select()
    .from(jobCutoversTable)
    .where(eq(jobCutoversTable.jobId, job.id));
  if (!state) return null;
  const [invoice] = await tx
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, source.id))
    .for("update");
  if (!invoice || invoice.updatedAt !== source.updatedAt)
    throw new DomainError(
      409,
      "The invoice changed before accounting submission.",
    );
  if (
    ["Voided", "Credited", "Refunded"].includes(invoice.status) ||
    invoice.refundedAmount !== 0
  )
    throw new DomainError(
      409,
      "A voided, credited or refunded imported-job invoice cannot create or update a QuickBooks invoice through an ordinary export. Reconcile its existing provider record without releasing retained capacity.",
    );
  const billing = await currentBilling(tx, job),
    [claim] = await tx
      .select()
      .from(requests)
      .where(
        and(eq(requests.invoiceId, invoice.id), eq(requests.jobId, job.id)),
      )
      .for("update");
  if (
    !billing ||
    !claim ||
    claim.financialFingerprint !== cutoverInvoiceFingerprint(invoice) ||
    claim.currentGrossCents !==
      cutoverInvoiceFinancialDocument(invoice).totalCents
  )
    throw new DomainError(
      409,
      "The invoice no longer matches its approved remaining-scope consumption.",
    );
  const used = await cutoverInvoiceConsumption(tx, job.id);
  if (used > billing.cutover.billing.ceilingCents!)
    throw new DomainError(
      409,
      "Retained invoice consumption exceeds the current remaining-billable scope.",
    );
  if (lockSubmission && !claim.submissionLocked)
    await tx
      .update(requests)
      .set({
        submissionLocked: true,
        revision: claim.revision + 1,
        updatedAt: now(),
      })
      .where(eq(requests.id, claim.id));
  return {
    cutoverRevision: state.revision,
    billingCommitId: billing.commit.id,
    scopeFingerprint: jobCutoverScopeFingerprint(job),
    financialFingerprint: claim.financialFingerprint,
    grossCents: claim.currentGrossCents,
  };
}
