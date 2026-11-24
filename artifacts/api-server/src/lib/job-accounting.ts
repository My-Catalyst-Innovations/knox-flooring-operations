import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  jobDocumentsTable,
  jobExpensesTable,
  jobsTable,
  laborEntriesTable,
  quickbooksConnectionsTable,
  quickbooksEntityMappingsTable,
  quickbooksJobCostExportsTable,
  quickbooksProjectLinksTable,
  quickbooksSyncJobsTable,
} from "@workspace/db";
import { DomainError } from "./operations-rules";
import { audit } from "./auth";
import {
  getConnection,
  qboQuery,
  qboRequest,
  QuickBooksRequestError,
} from "./quickbooks";
import { verifiedProjectForJob } from "./quickbooks-projects";
import { assertCutoverProviderJobAllowed } from "./job-cutover";
import {
  costDocument,
  costRemoteMatches,
  costSelection,
  findCostRemote,
  jobCostExportsAvailable,
  stableFingerprint,
  verifyCostCompany,
  verifyCostEntity,
  reviewedLaborCostCents,
  type CostKind,
  type CostProvider,
  type CostSelection,
} from "./quickbooks-job-cost";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const activeStates = [
  "prepared",
  "submitting",
  "unknown",
  "confirmed",
] as const;
export const costEntities = [
  "labor_time",
  "job_expense_purchase",
  "job_expense_bill",
];
const exports = quickbooksJobCostExportsTable,
  expenses = jobExpensesTable,
  labor = laborEntriesTable,
  queue = quickbooksSyncJobsTable;
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Enter a valid calendar date.");
export const expenseFields = z
  .object({
    kind: z.enum(["paid_purchase", "contractor_bill"]),
    category: z.enum(["materials", "labor", "other"]),
    description: z.string().trim().min(1).max(1000),
    vendorName: z.string().trim().min(1).max(150),
    transactionDate: date,
    dueDate: date.nullable(),
    currency: z.literal("USD"),
    amountCents: z.number().int().positive().max(1_000_000_000),
    taxCents: z.number().int().nonnegative().max(1_000_000_000),
    receiptDocumentId: z.string().min(1),
    relatedLaborEntryId: z.string().min(1).nullable().optional().default(null),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(21)
      .refine((v) => !/\p{C}/u.test(v)),
    notes: z.string().max(2000).optional().default(""),
  })
  .strict();
export const expenseCreate = expenseFields
  .extend({ requestKey: z.string().min(8).max(180) })
  .strict();
export const expensePatch = expenseFields
  .partial()
  .extend({ revision: z.number().int().positive() })
  .strict();
export const laborAccountingInput = z
  .object({
    revision: z.number().int().positive(),
    singleWorkerConfirmed: z.literal(true),
    workerType: z.enum(["Employee", "Vendor"]),
    workerExternalId: z.string().regex(/^\d{1,30}$/),
    workerName: z.string().trim().min(1).max(150),
    serviceItemExternalId: z.string().regex(/^\d{1,30}$/),
    hourlyCost: z
      .number()
      .finite()
      .nonnegative()
      .max(10_000_000)
      .refine(
        (v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.000001,
        "Enter a cost rate to two decimal places.",
      ),
  })
  .strict();
export const providerFor = (connectionId: string): CostProvider => ({
  request: (path, init) => qboRequest(path, init, connectionId),
  query: (statement) => qboQuery(statement, connectionId),
});
export const publicCostExport = (row: typeof exports.$inferSelect) => ({
  id: row.id,
  state: row.state,
  remoteId: row.remoteId,
  lastError: row.lastError,
  sourceKind: row.sourceKind,
  sourceId: row.sourceId,
  sourceRevision: row.sourceRevision,
  submittedAt: row.submittedAt,
  confirmedAt: row.confirmedAt,
  connectionId: row.connectionId,
  realmId: row.realmId,
  environment: row.environment,
  remoteEntity: row.remoteEntity,
});
export async function assertCostSourceEditable(
  tx: Transaction,
  kind: CostKind,
  sourceId: string,
) {
  const [held] = await tx
    .select({ id: exports.id })
    .from(exports)
    .where(
      and(
        eq(exports.sourceKind, kind),
        eq(exports.sourceId, sourceId),
        inArray(exports.state, [...activeStates]),
      ),
    )
    .limit(1);
  if (held)
    throw new DomainError(
      409,
      "This source has an approved or submitted QuickBooks export. Cancel an unsubmitted review, or reconcile its original accounting record before changing it.",
    );
}
export async function assertLaborNotReplaced(tx: Transaction, entryId: string) {
  const [related] = await tx
    .select({ id: expenses.id })
    .from(expenses)
    .where(eq(expenses.relatedLaborEntryId, entryId))
    .limit(1);
  if (related)
    throw new DomainError(
      409,
      "This labor entry is linked to an actual contractor bill. Preserve its source history and review the linked receipt expense.",
    );
}
export async function accountingCosts(jobId: string) {
  const [job] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  if (!job) throw new DomainError(404, "Job not found.");
  const [laborRows, expenseRows, attempts] = await Promise.all([
    db.select().from(labor).where(eq(labor.jobId, jobId)),
    db
      .select({ source: expenses, receipt: jobDocumentsTable })
      .from(expenses)
      .innerJoin(
        jobDocumentsTable,
        eq(expenses.receiptDocumentId, jobDocumentsTable.id),
      )
      .where(eq(expenses.jobId, jobId)),
    db.select().from(exports).where(eq(exports.jobId, jobId)),
  ]);
  const latest = (kind: CostKind, id: string) =>
    attempts
      .filter((a) => a.sourceKind === kind && a.sourceId === id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const unpricedLaborCount = laborRows.filter(
    (row) => !row.costReviewed,
  ).length;
  const billedLabor = new Set(
    expenseRows.map((row) => row.source.relatedLaborEntryId).filter(Boolean),
  );
  return {
    labor: laborRows.map((row) => {
      const attempt = latest("labor", row.id);
      return {
        ...row,
        exportState: attempt?.state ?? "unreviewed",
        export: attempt ? publicCostExport(attempt) : null,
      };
    }),
    expenses: expenseRows.map(({ source, receipt }) => {
      const attempt = latest("expense", source.id);
      return {
        ...source,
        receiptName: receipt.name,
        receiptUrl: `/api/storage${receipt.objectPath}`,
        receiptSha256: receipt.sha256,
        exportState: attempt?.state ?? "unreviewed",
        export: attempt ? publicCostExport(attempt) : null,
      };
    }),
    totals: {
      trackedLaborCost: laborRows.some((row) => row.costReviewed)
        ? Math.round(
            laborRows
              .filter((row) => row.costReviewed && !billedLabor.has(row.id))
              .reduce(
                (sum, row) =>
                  sum + reviewedLaborCostCents(row.hours, row.hourlyCost),
                0,
              ),
          ) / 100
        : null,
      unpricedLaborCount,
      trackedExpenseCost:
        expenseRows.reduce((sum, row) => sum + row.source.amountCents, 0) / 100,
    },
    warnings: unpricedLaborCount
      ? [
          "Some time entries have no reviewed individual cost rate. Tracked labor cost is incomplete.",
        ]
      : [],
  };
}
async function validateExpense(
  tx: Transaction,
  jobId: string,
  value: z.infer<typeof expenseFields>,
) {
  if (value.taxCents > value.amountCents)
    throw new DomainError(400, "Receipt tax cannot exceed its gross total.");
  if (
    (value.kind === "paid_purchase" && value.dueDate !== null) ||
    (value.kind === "contractor_bill" &&
      (!value.dueDate ||
        value.dueDate < value.transactionDate ||
        value.category !== "labor"))
  )
    throw new DomainError(
      400,
      "An unpaid contractor labor bill needs its actual due date. A paid receipt must not have a bill due date.",
    );
  if (value.relatedLaborEntryId) {
    if (value.kind !== "contractor_bill")
      throw new DomainError(
        400,
        "Only a contractor labor bill can replace a named vendor labor cost.",
      );
    const [related] = await tx
      .select()
      .from(labor)
      .where(
        and(eq(labor.id, value.relatedLaborEntryId), eq(labor.jobId, jobId)),
      )
      .for("update");
    if (
      !related ||
      related.workerType !== "Vendor" ||
      !related.singleWorkerConfirmed ||
      related.workerName !== value.vendorName
    )
      throw new DomainError(
        409,
        "Link only one same-job individually confirmed Vendor time row for this contractor.",
      );
    await assertCostSourceEditable(tx, "labor", related.id);
  }
  const [document] = await tx
    .select()
    .from(jobDocumentsTable)
    .where(
      and(
        eq(jobDocumentsTable.id, value.receiptDocumentId),
        eq(jobDocumentsTable.jobId, jobId),
      ),
    )
    .for("share");
  if (!document)
    throw new DomainError(
      409,
      "Attach the original receipt as a document on this job before recording its expense.",
    );
  return document;
}
export async function createExpense(
  jobId: string,
  input: z.infer<typeof expenseCreate>,
  actorUserId: string,
) {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .for("update");
    if (!job) throw new DomainError(404, "Job not found.");
    const [prior] = await tx
      .select()
      .from(expenses)
      .where(eq(expenses.requestKey, input.requestKey));
    if (prior) {
      const fields = expenseFields.strip().parse(prior);
      if (
        prior.jobId !== jobId ||
        stableFingerprint(fields) !==
          stableFingerprint(expenseFields.strip().parse(input))
      )
        throw new DomainError(
          409,
          "This request key belongs to a different saved expense.",
        );
      return prior;
    }
    const receipt = await validateExpense(tx, jobId, input);
    const now = new Date().toISOString();
    const [saved] = await tx
      .insert(expenses)
      .values({
        ...input,
        receiptSha256: receipt.sha256,
        id: randomUUID(),
        jobId,
        actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await audit(
      "job.expense_recorded",
      {
        userId: actorUserId,
        entityType: "job_expense",
        entityId: saved.id,
        details: {
          jobId,
          amountCents: saved.amountCents,
          currency: saved.currency,
          receiptDocumentId: saved.receiptDocumentId,
        },
      },
      tx,
    );
    return saved;
  });
}
export async function updateExpense(
  jobId: string,
  expenseId: string,
  input: z.infer<typeof expensePatch>,
  actorUserId: string,
) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .for("update");
    const [source] = await tx
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.jobId, jobId)))
      .for("update");
    if (!source) throw new DomainError(404, "Expense not found.");
    if (source.revision !== input.revision)
      throw new DomainError(
        409,
        "The receipt expense changed. Refresh before editing.",
      );
    await assertCostSourceEditable(tx, "expense", source.id);
    const { revision, ...changes } = input,
      value = expenseFields.strip().parse({ ...source, ...changes });
    const receipt = await validateExpense(tx, jobId, value);
    const [saved] = await tx
      .update(expenses)
      .set({
        ...value,
        receiptSha256: receipt.sha256,
        revision: revision + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(expenses.id, source.id))
      .returning();
    await audit(
      "job.expense_updated",
      {
        userId: actorUserId,
        entityType: "job_expense",
        entityId: source.id,
        details: { revision: saved.revision },
      },
      tx,
    );
    return saved;
  });
}
export async function updateLaborAccounting(
  jobId: string,
  entryId: string,
  input: z.infer<typeof laborAccountingInput>,
  actorUserId: string,
) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .for("update");
    const [source] = await tx
      .select()
      .from(labor)
      .where(and(eq(labor.id, entryId), eq(labor.jobId, jobId)))
      .for("update");
    if (!source) throw new DomainError(404, "Labor entry not found.");
    if (source.revision !== input.revision)
      throw new DomainError(
        409,
        "The labor entry changed. Refresh before reviewing its cost.",
      );
    try {
      reviewedLaborCostCents(source.hours, input.hourlyCost);
    } catch (error) {
      throw new DomainError(
        400,
        error instanceof Error
          ? error.message
          : "Review an individual time entry in whole minutes before pricing it.",
      );
    }
    await assertCostSourceEditable(tx, "labor", source.id);
    const [billed] = await tx
      .select({ id: expenses.id })
      .from(expenses)
      .where(eq(expenses.relatedLaborEntryId, source.id))
      .limit(1);
    if (billed)
      throw new DomainError(
        409,
        "This labor cost is replaced by a linked contractor bill. Review that receipt expense before changing the worker or rate.",
      );
    const [saved] = await tx
      .update(labor)
      .set({
        ...input,
        revision: input.revision + 1,
        costReviewed: true,
        accountingStatus: "review_required",
      })
      .where(eq(labor.id, source.id))
      .returning();
    await audit(
      "job.labor_cost_reviewed",
      {
        userId: actorUserId,
        entityType: "labor_entry",
        entityId: source.id,
        details: { revision: saved.revision, workerType: saved.workerType },
      },
      tx,
    );
    return saved;
  });
}
async function sourceFor(
  kind: CostKind,
  sourceId: string,
  reader: Pick<typeof db, "select"> = db,
) {
  const source =
    kind === "labor"
      ? (await reader.select().from(labor).where(eq(labor.id, sourceId)))[0]
      : (
          await reader.select().from(expenses).where(eq(expenses.id, sourceId))
        )[0];
  if (!source) throw new DomainError(404, "Job-cost source not found.");
  return source;
}
async function assertAttribution(
  tx: Transaction,
  evidence: Record<string, any>,
) {
  const [job] = await tx
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, evidence.job.id))
    .for("share");
  if (
    !job ||
    job.revision !== evidence.job.revision ||
    job.updatedAt !== evidence.job.updatedAt
  )
    throw new DomainError(
      409,
      "The job changed after accounting review. Review its customer and Project again.",
    );
  const currentCutover=await assertCutoverProviderJobAllowed(tx,job.id);
  if(currentCutover&&stableFingerprint({revision:currentCutover.revision,operational:currentCutover.operational})!==stableFingerprint(evidence.migrationCutover))throw new DomainError(409,"Imported job cutover changed after accounting approval. Review its current operational attribution again.");
  const [mapping] = await tx
    .select()
    .from(quickbooksEntityMappingsTable)
    .where(eq(quickbooksEntityMappingsTable.id, evidence.customerMapping.id))
    .for("share");
  if (
    stableFingerprint(mapping) !== stableFingerprint(evidence.customerMapping)
  )
    throw new DomainError(
      409,
      "The QuickBooks customer mapping changed after accounting review.",
    );
  if (evidence.project) {
    const [link] = await tx
      .select()
      .from(quickbooksProjectLinksTable)
      .where(eq(quickbooksProjectLinksTable.jobId, job.id))
      .for("share");
    if (
      !link ||
      link.revision !== evidence.project.linkRevision ||
      link.fingerprint !== evidence.project.fingerprint ||
      link.quickbooksProjectId !== evidence.project.projectId ||
      link.quickbooksCustomerId !== evidence.project.customerId
    )
      throw new DomainError(
        409,
        "The actual QuickBooks Project link changed after accounting review.",
      );
  }
}
export async function prepareJobCost(
  kind: CostKind,
  sourceId: string,
  selection: CostSelection,
  providerOverride?: CostProvider,
) {
  const connection = await getConnection();
  if (
    !connection ||
    !jobCostExportsAvailable(connection) ||
    connection.id !== selection.connectionId
  )
    throw new DomainError(
      409,
      "Connect the intended enabled QuickBooks company before reviewing job costs.",
    );
  const source = await sourceFor(kind, sourceId);
  const migrationCutover=await assertCutoverProviderJobAllowed(db,source.jobId);
  if (source.revision !== selection.sourceRevision)
    throw new DomainError(
      409,
      "This source changed. Refresh and review its current revision.",
    );
  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, source.jobId));
  const [customer] = await db
    .select()
    .from(quickbooksEntityMappingsTable)
    .where(
      and(
        eq(quickbooksEntityMappingsTable.entityType, "customer"),
        eq(quickbooksEntityMappingsTable.localId, source.jobId),
      ),
    );
  if (
    !job ||
    !customer ||
    customer.status !== "linked" ||
    customer.realmId !== connection.realmId ||
    customer.environment !== connection.environment
  )
    throw new DomainError(
      409,
      "Reconcile this job's customer in the intended QuickBooks company first.",
    );
  const provider = providerOverride ?? providerFor(connection.id);
  const evidence: Record<string, any> = {
    ...(migrationCutover?{migrationCutover:{revision:migrationCutover.revision,operational:migrationCutover.operational}}:{}),
    source,
    job: { id: job.id, revision: job.revision, updatedAt: job.updatedAt },
    customerMapping: customer,
    company: await verifyCostCompany(
      provider,
      connection.realmId,
      customer.quickbooksId,
    ),
  };
  let project: null | Awaited<ReturnType<typeof verifiedProjectForJob>> = null;
  if (selection.projectMode === "project") {
    project = await verifiedProjectForJob(
      job.id,
      customer.quickbooksId,
      connection,
    );
    if (!project)
      throw new DomainError(
        409,
        "Link and verify an actual QuickBooks Project for this job before exporting project-attributed costs.",
      );
  }
  evidence.project = project;
  if (kind === "labor") {
    const item = source as typeof labor.$inferSelect;
    const [billed] = await db
      .select({ id: expenses.id })
      .from(expenses)
      .where(eq(expenses.relatedLaborEntryId, item.id));
    if (billed)
      throw new DomainError(
        409,
        "This labor is represented by a contractor bill. It cannot also be exported as a TimeActivity.",
      );
    if (!["Employee", "Vendor"].includes(item.workerType))
      throw new DomainError(
        409,
        "Select the named individual employee or vendor before reviewing time.",
      );
    evidence.worker = await verifyCostEntity(
      provider,
      item.workerType as "Employee" | "Vendor",
      item.workerExternalId ?? "",
    );
    if (
      evidence.worker.DisplayName !== item.workerName &&
      `${evidence.worker.GivenName ?? ""} ${evidence.worker.FamilyName ?? ""}`.trim() !==
        item.workerName
    )
      throw new DomainError(
        409,
        "The selected worker name differs from QuickBooks. Reconcile this individual worker before exporting.",
      );
    evidence.service = await verifyCostEntity(
      provider,
      "Item",
      item.serviceItemExternalId ?? "",
    );
    if (evidence.service.Type !== "Service")
      throw new DomainError(
        409,
        "Select an active service item for ordinary time tracking.",
      );
    if (
      selection.vendorId ||
      selection.expenseAccountId ||
      selection.paymentType ||
      selection.paymentAccountId
    )
      throw new DomainError(
        400,
        "Ordinary TimeActivity must not specify expense payment accounts.",
      );
  } else {
    const expense = source as typeof expenses.$inferSelect;
    const [receipt] = await db
      .select()
      .from(jobDocumentsTable)
      .where(
        and(
          eq(jobDocumentsTable.id, expense.receiptDocumentId),
          eq(jobDocumentsTable.jobId, expense.jobId),
        ),
      );
    if (!receipt)
      throw new DomainError(
        409,
        "The source receipt is unavailable on this job.",
      );
    evidence.receipt = receipt;
    evidence.vendor = await verifyCostEntity(
      provider,
      "Vendor",
      selection.vendorId ?? "",
    );
    evidence.expenseAccount = await verifyCostEntity(
      provider,
      "Account",
      selection.expenseAccountId ?? "",
    );
    if (
      !["Expense", "Cost of Goods Sold", "Other Expense"].includes(
        evidence.expenseAccount.AccountType,
      )
    )
      throw new DomainError(
        409,
        "Select an active expense or cost-of-goods-sold account; inventory assets cannot be expensed again.",
      );
    if (evidence.vendor.DisplayName !== expense.vendorName)
      throw new DomainError(
        409,
        "The receipt vendor name differs from the selected QuickBooks vendor. Reconcile the source before approving.",
      );
    if (expense.relatedLaborEntryId) {
      const [related] = await db
        .select()
        .from(labor)
        .where(
          and(
            eq(labor.id, expense.relatedLaborEntryId),
            eq(labor.jobId, expense.jobId),
          ),
        );
      if (
        !related ||
        related.workerType !== "Vendor" ||
        related.workerExternalId !== selection.vendorId
      )
        throw new DomainError(
          409,
          "The linked labor worker differs from the selected contractor vendor.",
        );
      const [held] = await db
        .select({ id: exports.id })
        .from(exports)
        .where(
          and(
            eq(exports.sourceKind, "labor"),
            eq(exports.sourceId, related.id),
            inArray(exports.state, [...activeStates]),
          ),
        );
      if (held)
        throw new DomainError(
          409,
          "Reconcile the existing TimeActivity approval before approving a contractor bill for the same work.",
        );
      evidence.relatedLabor = related;
    }
    if (expense.kind === "paid_purchase") {
      evidence.paymentAccount = await verifyCostEntity(
        provider,
        "Account",
        selection.paymentAccountId ?? "",
      );
      if (
        evidence.paymentAccount.AccountType !==
        (selection.paymentType === "CreditCard" ? "Credit Card" : "Bank")
      )
        throw new DomainError(
          409,
          "Use the actual bank or credit-card account matching this receipt's payment method.",
        );
    }
  }
  const reference = `CW-COST-${stableFingerprint({ kind, sourceId, realm: connection.realmId, environment: connection.environment }).slice(0, 24)}`;
  const document = costDocument(
    kind,
    source,
    selection,
    customer.quickbooksId,
    project?.projectId ?? null,
    reference,
  );
  const remoteEntity: "TimeActivity" | "Bill" | "Purchase" =
    kind === "labor"
      ? "TimeActivity"
      : (source as typeof expenses.$inferSelect).kind === "contractor_bill"
        ? "Bill"
        : "Purchase";
  const existingRemote = await findCostRemote(
    { document, remoteEntity },
    provider,
  );
  const company = {
    connectionId: connection.id,
    realmId: connection.realmId,
    environment: connection.environment,
    name: connection.companyName,
  };
  const fingerprint = stableFingerprint({
    kind,
    sourceId,
    selection,
    document,
    evidence,
    company,
    existingRemote,
  });
  return {
    kind,
    sourceId,
    sourceRevision: source.revision,
    company,
    document,
    selection,
    evidence,
    fingerprint,
    remoteEntity,
    existingRemoteId: existingRemote?.Id ?? null,
    warnings:
      kind === "labor"
        ? [
            "This records one worker's ordinary nonbillable time and cost rate. It does not pay the worker or run payroll.",
          ]
        : [
            "Receipt gross cost includes its recorded tax. This does not move warehouse stock or initiate a payment.",
          ],
  };
}
export async function approveJobCost(
  prepared: Awaited<ReturnType<typeof prepareJobCost>>,
  actorUserId: string,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
    const [company] = await tx
      .select()
      .from(quickbooksConnectionsTable)
      .where(eq(quickbooksConnectionsTable.id, prepared.company.connectionId))
      .for("update");
    if (
      !company ||
      !jobCostExportsAvailable(company) ||
      company.realmId !== prepared.company.realmId ||
      company.environment !== prepared.company.environment
    )
      throw new DomainError(
        409,
        "The QuickBooks company changed. Review the cost again.",
      );
    await assertAttribution(tx, prepared.evidence);
    const table = prepared.kind === "labor" ? labor : expenses;
    const [source] = await tx
      .select()
      .from(table)
      .where(eq(table.id, prepared.sourceId))
      .for("update");
    if (
      !source ||
      stableFingerprint(source) !== stableFingerprint(prepared.evidence.source)
    )
      throw new DomainError(
        409,
        "The job-cost source changed before approval.",
      );
    if (prepared.kind === "labor") {
      const [billed] = await tx
        .select({ id: expenses.id })
        .from(expenses)
        .where(eq(expenses.relatedLaborEntryId, source.id));
      if (billed)
        throw new DomainError(
          409,
          "This labor is already represented by a contractor bill.",
        );
    } else if ((source as typeof expenses.$inferSelect).relatedLaborEntryId) {
      await assertCostSourceEditable(
        tx,
        "labor",
        (source as typeof expenses.$inferSelect).relatedLaborEntryId!,
      );
    }
    const [existing] = await tx
      .select()
      .from(exports)
      .where(
        and(
          eq(exports.sourceKind, prepared.kind),
          eq(exports.sourceId, prepared.sourceId),
          inArray(exports.state, [...activeStates]),
        ),
      )
      .for("update");
    if (existing) {
      if (existing.fingerprint !== prepared.fingerprint)
        throw new DomainError(
          409,
          "An earlier approval exists for this source. Cancel an unsubmitted approval or reconcile its original record.",
        );
      return { export: publicCostExport(existing), queueId: existing.queueId };
    }
    const now = new Date().toISOString(),
      exportId = randomUUID(),
      queueId = randomUUID(),
      requestId = `cwc-${randomUUID()}`;
    await tx.insert(queue).values({
      id: queueId,
      idempotencyKey: `job-cost:${exportId}`,
      entityType:
        prepared.kind === "labor"
          ? costEntities[0]
          : prepared.remoteEntity === "Bill"
            ? costEntities[2]
            : costEntities[1],
      localId: prepared.sourceId,
      action: "create",
      status: "approved",
      payload: { jobCostExportId: exportId },
      nextAttemptAt: now,
      approvedAt: now,
      approvedBy: actorUserId,
      createdAt: now,
      updatedAt: now,
    });
    const [saved] = await tx
      .insert(exports)
      .values({
        id: exportId,
        sourceKind: prepared.kind,
        sourceId: prepared.sourceId,
        laborEntryId: prepared.kind === "labor" ? prepared.sourceId : null,
        expenseId: prepared.kind === "expense" ? prepared.sourceId : null,
        jobId: source.jobId,
        queueId,
        connectionId: company.id,
        realmId: company.realmId,
        environment: company.environment,
        state: "prepared",
        sourceRevision: prepared.sourceRevision,
        fingerprint: prepared.fingerprint,
        requestId,
        remoteEntity: prepared.remoteEntity,
        remoteId: prepared.existingRemoteId,
        selection: prepared.selection,
        document: prepared.document,
        evidence: prepared.evidence,
        approvedBy: actorUserId,
        approvedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await audit(
      "quickbooks.job_cost_approved",
      {
        userId: actorUserId,
        entityType: prepared.kind,
        entityId: prepared.sourceId,
        details: {
          exportId,
          realmId: company.realmId,
          environment: company.environment,
          fingerprint: prepared.fingerprint,
        },
      },
      tx,
    );
    return { export: publicCostExport(saved), queueId };
  });
}
export async function processJobCostExport(
  exportId: string,
  {
    allowSubmit = false,
    provider: providerOverride,
  }: { allowSubmit?: boolean; provider?: CostProvider } = {},
) {
  let [attempt] = await db
    .select()
    .from(exports)
    .where(eq(exports.id, exportId));
  if (!attempt) throw new DomainError(404, "Accounting export not found.");
  const company = await getConnection();
  if (
    !company ||
    company.status !== "connected" ||
    company.realmId !== attempt.realmId ||
    company.environment !== attempt.environment ||
    (allowSubmit &&
      attempt.state === "prepared" &&
      (company.id !== attempt.connectionId ||
        !jobCostExportsAvailable(company)))
  )
    throw new DomainError(
      409,
      "Connect the original QuickBooks company and environment before reconciling this export. A new connection requires fresh owner approval before any financial submission.",
    );
  if (["cancelled", "rejected"].includes(attempt.state))
    throw new DomainError(409, "This accounting approval is no longer active.");
  const provider = providerOverride ?? providerFor(company.id);
  const confirm = async (remote: any) => {
    let sourceChanged = false;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
      const [connection] = await tx
        .select()
        .from(quickbooksConnectionsTable)
        .where(eq(quickbooksConnectionsTable.id, company.id))
        .for("update");
      if (
        !connection ||
        connection.status !== "connected" ||
        connection.realmId !== attempt.realmId ||
        connection.environment !== attempt.environment
      )
        throw new DomainError(
          409,
          "The QuickBooks connection changed during reconciliation.",
        );
      const sourceTable = attempt.sourceKind === "labor" ? labor : expenses;
      const [currentSource] = await tx
        .select()
        .from(sourceTable)
        .where(eq(sourceTable.id, attempt.sourceId))
        .for("update");
      const sourceSnapshot = (value: any) => {
        if (!value) return null;
        const { accountingStatus, ...rest } = value;
        return rest;
      };
      sourceChanged =
        stableFingerprint(sourceSnapshot(currentSource)) !==
        stableFingerprint(sourceSnapshot(attempt.evidence.source));
      const [held] = await tx
        .select()
        .from(exports)
        .where(eq(exports.id, attempt.id))
        .for("update");
      if (!held || ["cancelled", "rejected"].includes(held.state))
        throw new DomainError(
          409,
          "The cost approval changed before confirmation.",
        );
      const now = new Date().toISOString();
      const [saved] = await tx
        .update(exports)
        .set({
          state: "confirmed",
          remoteId: remote.Id,
          syncToken: String(remote.SyncToken ?? "0"),
          confirmedAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(exports.id, attempt.id))
        .returning();
      attempt = saved;
      await tx
        .update(queue)
        .set({
          status: "completed",
          completedAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(queue.id, attempt.queueId));
      if (attempt.sourceKind === "labor")
        await tx
          .update(labor)
          .set({
            accountingStatus: sourceChanged ? "review_required" : "exported",
          })
          .where(eq(labor.id, attempt.sourceId));
      await audit(
        "quickbooks.job_cost_confirmed",
        {
          entityType: attempt.sourceKind,
          entityId: attempt.sourceId,
          details: {
            exportId: attempt.id,
            remoteId: remote.Id,
            realmId: attempt.realmId,
            reconciliationConnectionId: company.id,
            sourceChanged,
          },
        },
        tx,
      );
    });
    return {
      export: publicCostExport(attempt),
      outcome: "confirmed" as const,
      ...(sourceChanged
        ? {
            warning:
              "Recovered the originally approved QuickBooks record. The local source has since changed and needs accounting review; no new financial record was submitted.",
          }
        : {}),
    };
  };
  const found = await findCostRemote(attempt, provider);
  if (found) return confirm(found);
  if (!allowSubmit || attempt.state !== "prepared")
    return {
      export: publicCostExport(attempt),
      outcome: "unresolved" as const,
    };
  const prepared = await prepareJobCost(
    attempt.sourceKind,
    attempt.sourceId,
    costSelection.parse(attempt.selection),
    provider,
  );
  if (prepared.fingerprint !== attempt.fingerprint)
    throw new DomainError(
      409,
      "Source records or verified QuickBooks mappings changed after approval. Cancel the unsubmitted approval and review again.",
    );
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
    const [connection] = await tx
      .select()
      .from(quickbooksConnectionsTable)
      .where(eq(quickbooksConnectionsTable.id, attempt.connectionId))
      .for("update");
    if (
      !connection ||
      connection.realmId !== attempt.realmId ||
      connection.environment !== attempt.environment ||
      !jobCostExportsAvailable(connection)
    )
      throw new DomainError(
        409,
        "The original approved QuickBooks company is unavailable.",
      );
    await assertAttribution(tx, attempt.evidence);
    const table = attempt.sourceKind === "labor" ? labor : expenses;
    const [source] = await tx
      .select()
      .from(table)
      .where(eq(table.id, attempt.sourceId))
      .for("update");
    if (
      stableFingerprint(source) !== stableFingerprint(attempt.evidence.source)
    )
      throw new DomainError(409, "The source changed after approval.");
    const [held] = await tx
      .select()
      .from(exports)
      .where(eq(exports.id, attempt.id))
      .for("update");
    if (held?.state !== "prepared" || held.fingerprint !== attempt.fingerprint)
      throw new DomainError(
        409,
        "Another worker already claimed this submission. Reconcile it before retrying.",
      );
    const now = new Date().toISOString();
    [attempt] = await tx
      .update(exports)
      .set({ state: "submitting", submittedAt: now, updatedAt: now })
      .where(eq(exports.id, attempt.id))
      .returning();
  });
  try {
    const response = await provider.request(
        `/${attempt.remoteEntity.toLowerCase()}?requestid=${encodeURIComponent(attempt.requestId)}`,
        { method: "POST", body: JSON.stringify(attempt.document) },
      ),
      remote = response[attempt.remoteEntity];
    if (!costRemoteMatches(attempt.document, remote, attempt.remoteEntity))
      throw Error(
        "QuickBooks did not confirm the exact approved cost. Reconcile its original record; it will not be resubmitted.",
      );
    return await confirm(remote);
  } catch (error) {
    const now = new Date().toISOString(),
      message =
        error instanceof Error
          ? error.message
          : "QuickBooks submission was not confirmed.";
    const definitive =
      error instanceof QuickBooksRequestError &&
      error.status === 400 &&
      error.faultType === "ValidationFault";
    await db
      .update(exports)
      .set({
        state: definitive ? "rejected" : "unknown",
        lastError: message,
        updatedAt: now,
      })
      .where(and(eq(exports.id, attempt.id), eq(exports.state, "submitting")));
    await db
      .update(queue)
      .set({
        status: "failed",
        lastError: definitive
          ? "QuickBooks rejected this exact request. Correct the source or mapping and make a fresh owner review."
          : "Submission unconfirmed. Use Reconcile; this request will not be posted again.",
        updatedAt: now,
      })
      .where(eq(queue.id, attempt.queueId));
    if (definitive)
      throw new DomainError(
        409,
        "QuickBooks rejected this request without creating a record. Correct the source or mapping and make a fresh owner review.",
      );
    throw new DomainError(
      409,
      "QuickBooks submission is unconfirmed. Reconcile its original record before doing anything else; it was not resubmitted.",
    );
  }
}
export async function processQueuedJobCost(
  job: Pick<
    typeof queue.$inferSelect,
    "id" | "entityType" | "localId" | "payload"
  >,
) {
  if (typeof job.payload.jobCostExportId !== "string")
    throw new DomainError(
      409,
      "A dedicated owner approval is required for this cost.",
    );
  const [attempt] = await db
    .select()
    .from(exports)
    .where(eq(exports.id, job.payload.jobCostExportId));
  const expected =
    attempt?.sourceKind === "labor"
      ? costEntities[0]
      : attempt?.remoteEntity === "Bill"
        ? costEntities[2]
        : costEntities[1];
  if (
    !attempt ||
    attempt.queueId !== job.id ||
    attempt.sourceId !== job.localId ||
    job.entityType !== expected
  )
    throw new DomainError(
      409,
      "This queue row does not own the approved cost snapshot.",
    );
  return processJobCostExport(attempt.id, { allowSubmit: true });
}
export async function cancelJobCost(
  exportId: string,
  connectionId: string,
  actorUserId: string,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
    const [currentCompany] = await tx
      .select()
      .from(quickbooksConnectionsTable)
      .where(eq(quickbooksConnectionsTable.id, connectionId))
      .for("update");
    const [held] = await tx
      .select()
      .from(exports)
      .where(eq(exports.id, exportId))
      .for("update");
    if (
      !held ||
      !currentCompany ||
      currentCompany.status !== "connected" ||
      held.realmId !== currentCompany.realmId ||
      held.environment !== currentCompany.environment
    )
      throw new DomainError(
        404,
        "Accounting approval not found in this company.",
      );
    if (held.state !== "prepared" || held.submittedAt)
      throw new DomainError(
        409,
        "Only an unsubmitted approval can be cancelled. Reconcile any submitted or unknown result.",
      );
    const now = new Date().toISOString();
    const [saved] = await tx
      .update(exports)
      .set({ state: "cancelled", updatedAt: now })
      .where(eq(exports.id, held.id))
      .returning();
    await tx
      .update(queue)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(queue.id, held.queueId));
    await audit(
      "quickbooks.job_cost_cancelled",
      {
        userId: actorUserId,
        entityType: held.sourceKind,
        entityId: held.sourceId,
        details: { exportId },
      },
      tx,
    );
    return { export: publicCostExport(saved) };
  });
}
