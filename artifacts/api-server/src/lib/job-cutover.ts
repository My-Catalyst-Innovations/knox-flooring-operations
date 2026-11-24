import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  auditEventsTable,
  jobsTable,
  jobDocumentsTable,
  invoicesTable,
  activeJobImportRecordsTable as sources,
  jobCutoversTable as cutovers,
  jobCutoverReviewsTable as reviews,
  jobCutoverApprovalsTable as approvals,
  jobCutoverCommitsTable as commits,
  jobCutoverInvoiceRequestsTable as requests,
  crewBookingsTable,
  materialsTable,
  jobMaterialsTable,
  settingsTable,
} from "@workspace/db";
import type {
  JobCutoverKind,
  JobCutoverPayload,
  JobCutoverReview,
  JobMigrationCutover,
} from "@workspace/domain";
import { DomainError, assertRevision } from "./operations-rules";
import { cutoverHash as hash } from "./cutover-hash";
import { jobReadiness } from "./job-readiness";
import { assertActiveCutoverOwner } from "./cutover-owner";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type CutoverWriter = Tx | typeof db;
type Job = typeof jobsTable.$inferSelect;
type State = typeof cutovers.$inferSelect;
type Commit = typeof commits.$inferSelect;
const now = () => new Date().toISOString();
const moneyKeys = [
  "laborEstimate",
  "materialEstimate",
  "estRevenue",
  "estGrossProfit",
  "grossMarginPct",
  "actualRevenue",
  "actualLaborCost",
  "actualMaterialCost",
  "actualAddOnCost",
] as const;
export const jobCutoverMoneyKeys = moneyKeys;
export const jobCutoverScope = (job: Job) => ({
  id: job.id,
  customerId: job.customerId,
  siteId: job.siteId,
  customerName: job.customerName,
  address: job.address,
  city: job.city,
  flooringType: job.flooringType,
  rooms: job.rooms,
  scopeOfWork: job.scopeOfWork,
  squareFootage: job.squareFootage,
});
export const jobCutoverScopeFingerprint = (job: Job) =>
  hash(jobCutoverScope(job));
export function integerCents(value: unknown, label = "Amount"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new DomainError(
      400,
      `${label} must be a nonnegative safe integer in USD cents. Unknown is not zero.`,
    );
  return value;
}
export async function lockedCutoverJob(tx: Tx, id: string) {
  await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
  const [job] = await tx
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, id))
    .for("update");
  if (!job) throw new DomainError(404, "Job not found.");
  return job;
}
async function stateFor(writer: CutoverWriter, jobId: string) {
  const [state] = await writer
    .select()
    .from(cutovers)
    .where(eq(cutovers.jobId, jobId))
    .limit(1);
  return state;
}
async function sourceFor(writer: CutoverWriter, state: State) {
  const [source] = await writer
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.id, state.sourceRecordId),
        eq(sources.jobId, state.jobId),
        eq(sources.action, "create"),
      ),
    );
  if (!source)
    throw new DomainError(
      409,
      "The imported job source identity is unavailable. Keep cutover actions blocked.",
    );
  if (hash(source.sourceData) !== source.sourceRowSha256)
    throw new DomainError(
      409,
      "Imported job source data no longer matches its immutable checksum.",
    );
  return source;
}
async function pointer(
  writer: CutoverWriter,
  id: string | null,
  jobId: string,
  kind: JobCutoverKind,
) {
  if (!id) return null;
  const [row] = await writer
    .select()
    .from(commits)
    .where(
      and(eq(commits.id, id), eq(commits.jobId, jobId), eq(commits.kind, kind)),
    );
  if (!row)
    throw new DomainError(409, "A retained cutover approval is unavailable.");
  return row;
}
export async function cutoverInvoiceConsumption(
  writer: CutoverWriter,
  jobId: string,
) {
  const [invoiceRows, claims] = await Promise.all([
    writer
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(eq(invoicesTable.jobId, jobId)),
    writer.select().from(requests).where(eq(requests.jobId, jobId)),
  ]);
  if (
    invoiceRows.some(
      (invoice) => !claims.some((claim) => claim.invoiceId === invoice.id),
    ) ||
    claims.some(
      (claim) => !invoiceRows.some((invoice) => invoice.id === claim.invoiceId),
    )
  )
    throw new DomainError(
      409,
      "An imported-job invoice lacks its immutable billing consumption. Reconcile it before further invoicing.",
    );
  const sum = claims.reduce(
    (value, row) => value + integerCents(row.currentGrossCents),
    0,
  );
  return integerCents(sum, "Consumed billing amount");
}
const resultPayload = (commit: Commit | null) =>
  commit?.result.payload as JobCutoverPayload | undefined;
const currentCommit = (
  commit: Commit | null,
  job: Job,
  sourceFingerprint: string,
) =>
  !!commit &&
  commit.result.scopeFingerprint === jobCutoverScopeFingerprint(job) &&
  commit.result.sourceFingerprint === sourceFingerprint;
async function operationalEvidence(writer: CutoverWriter, jobId: string) {
  const [bookings, receipts, requirements, settings] = await Promise.all([
    writer
      .select()
      .from(crewBookingsTable)
      .where(eq(crewBookingsTable.jobId, jobId))
      .orderBy(asc(crewBookingsTable.id)),
    writer
      .select()
      .from(materialsTable)
      .where(eq(materialsTable.jobId, jobId))
      .orderBy(asc(materialsTable.id)),
    writer
      .select()
      .from(jobMaterialsTable)
      .where(eq(jobMaterialsTable.jobId, jobId))
      .orderBy(asc(jobMaterialsTable.id)),
    writer
      .select({ policy: settingsTable.transitionPolicy })
      .from(settingsTable)
      .limit(1),
  ]);
  return hash({
    bookings: bookings.map(
      ({
        id,
        crewId,
        jobId,
        taskId,
        startAt,
        endAt,
        plannedLaborHours,
        status,
        revision,
      }) => ({
        id,
        crewId,
        jobId,
        taskId,
        startAt,
        endAt,
        plannedLaborHours,
        status,
        revision,
      }),
    ),
    receipts: receipts.map(
      ({ id, jobId, received, damaged, missingItems, status }) => ({
        id,
        jobId,
        received,
        damaged,
        missingItems,
        status,
      }),
    ),
    requirements: requirements.map(
      ({ id, jobId, productId, name, quantity, unit }) => ({
        id,
        jobId,
        productId,
        name,
        quantity,
        unit,
      }),
    ),
    policy: settings[0]?.policy ?? null,
  });
}
export async function jobMigrationCutover(
  writer: CutoverWriter,
  job: Job,
): Promise<JobMigrationCutover | null> {
  const state = await stateFor(writer, job.id);
  if (!state) return null;
  const source = await sourceFor(writer, state),
    sourceFingerprint = source.sourceRowSha256;
  const [operational, financial, billing] = await Promise.all([
    pointer(writer, state.operationalCommitId, job.id, "operational"),
    pointer(writer, state.financialCommitId, job.id, "financial_context"),
    pointer(writer, state.billingCommitId, job.id, "billing"),
  ]);
  const fp = resultPayload(financial),
    bp = resultPayload(billing);
  const financialCurrent = currentCommit(financial, job, sourceFingerprint),
    billingCurrent = currentCommit(billing, job, sourceFingerprint);
  const operationalCurrent =
    currentCommit(operational, job, sourceFingerprint) &&
    operational?.result.operationalEvidence ===
      (await operationalEvidence(writer, job.id));
  let consumed: number | null = null;
  try {
    consumed = await cutoverInvoiceConsumption(writer, job.id);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
  }
  const ceiling =
    bp?.kind === "billing" ? bp.worksGrossInvoiceCeilingAfterLegacyCents : null;
  const blocks = [
    ...(!operationalCurrent
      ? [
          "Operational cutover requires current owner review and real readiness.",
        ]
      : []),
    ...(!financialCurrent
      ? [
          "Full-job financial forecast is unknown or stale and excluded from financial reports.",
        ]
      : []),
    "Historical actual revenue/costs, full-job profit and commissions remain unknown and excluded.",
    "Customer sharing of imported job history remains off; review new customer-facing documents separately.",
    ...(!billingCurrent || consumed === null
      ? [
          "New invoices require current evidenced remaining-billable scope after all legacy invoices.",
        ]
      : []),
  ];
  return {
    revision: state.revision,
    source: {
      recordId: source.id,
      batchId: source.batchId,
      sourceSystem: source.sourceSystem,
      sourceId: source.sourceId,
      sourceJobNumber: source.sourceData.source_job_number ?? "",
      sourceStatus: source.sourceData.source_status ?? "",
      sourceCreatedAt: source.sourceData.source_created_at ?? "",
      sourceStageAt: source.sourceData.source_stage_at ?? "",
      soldAt: source.sourceData.sold_at ?? "",
      sourceDownloadUrl: `/api/active-job-imports/${source.batchId}/source`,
    },
    operational: {
      status: operational ? "verified" : "pending",
      current: operationalCurrent,
    },
    financial: {
      status: financial ? "context_reviewed" : "unknown",
      current: financialCurrent,
      fullJobRevenueCents:
        fp?.kind === "financial_context" ? fp.fullJobRevenueCents : null,
      fullJobLaborForecastCents:
        fp?.kind === "financial_context" ? fp.fullJobLaborForecastCents : null,
      fullJobMaterialForecastCents:
        fp?.kind === "financial_context"
          ? fp.fullJobMaterialForecastCents
          : null,
      fullJobOtherForecastCents:
        fp?.kind === "financial_context" ? fp.fullJobOtherForecastCents : null,
      evidenceDocumentIds:
        fp && "evidenceDocumentIds" in fp ? fp.evidenceDocumentIds : [],
      note: fp?.note ?? null,
    },
    billing: {
      status: billing ? "reviewed" : "unknown",
      current: billingCurrent && consumed !== null,
      ceilingCents: ceiling,
      consumedCents: consumed,
      remainingCents:
        ceiling !== null && consumed !== null
          ? Math.max(0, ceiling - consumed)
          : null,
      evidenceDocumentIds:
        bp && "evidenceDocumentIds" in bp ? bp.evidenceDocumentIds : [],
      note: bp?.note ?? null,
    },
    forecastReportsEligible: financialCurrent,
    actualProfitReportsEligible: false,
    commissionReportsEligible: false,
    blockedActions: blocks,
  };
}
async function evidenceFor(tx: Tx, jobId: string, ids: string[]) {
  if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length)
    throw new DomainError(
      400,
      "Select 1–10 distinct original evidence documents already saved on this job.",
    );
  const documents = await tx
    .select()
    .from(jobDocumentsTable)
    .where(
      and(
        eq(jobDocumentsTable.jobId, jobId),
        inArray(jobDocumentsTable.id, ids),
      ),
    )
    .orderBy(asc(jobDocumentsTable.id))
    .for("share");
  if (
    documents.length !== ids.length ||
    documents.some(
      (doc) =>
        !/^\/objects\/files\/job-document\/[0-9a-f-]{36}$/.test(
          doc.objectPath,
        ) || !/^[a-f0-9]{64}$/.test(doc.sha256),
    )
  )
    throw new DomainError(
      409,
      "Use only existing same-job private evidence documents with retained hashes and ownership claims.",
    );
  return documents.map(
    ({ id, jobId, objectPath, name, size, sha256, createdAt }) => ({
      id,
      jobId,
      objectPath,
      name,
      size,
      sha256,
      createdAt,
    }),
  );
}
async function captureReview(
  tx: Tx,
  job: Job,
  state: State,
  payload: JobCutoverPayload,
) {
  const source = await sourceFor(tx, state);
  const base = {
    scopeFingerprint: jobCutoverScopeFingerprint(job),
    sourceFingerprint: source.sourceRowSha256,
  };
  if (payload.note.trim().length < 10)
    throw new DomainError(
      400,
      "Record the source, review basis and any remaining limitations in at least 10 characters.",
    );
  if (payload.kind === "operational") {
    if (!payload.confirmRealReadiness)
      throw new DomainError(
        400,
        "Confirm real operational readiness without imported calendar or stock assumptions.",
      );
    const readiness = await jobReadiness(tx, job.id, payload.targetStage);
    if (readiness.blockers.length)
      throw new DomainError(
        409,
        "Complete real booking, material and closeout readiness before operational cutover.",
        readiness,
      );
    if (
      ["Scheduled", "In Progress"].includes(payload.targetStage) &&
      readiness.warnings.some(
        (warning) => warning.code === "materials_unconfirmed",
      )
    )
      throw new DomainError(
        409,
        "Verify actual received materials before accepting imported installation cutover.",
        readiness,
      );
    if (["Completed", "Invoiced"].includes(payload.targetStage))
      throw new DomainError(
        409,
        "Active-job migration does not establish completed work or an invoice. Complete ordinary closeout separately after cutover.",
      );
    return {
      ...base,
      operationalEvidence: await operationalEvidence(tx, job.id),
      stage: payload.targetStage,
    };
  }
  if (payload.kind === "financial_context") {
    for (const key of [
      "fullJobRevenueCents",
      "fullJobLaborForecastCents",
      "fullJobMaterialForecastCents",
      "fullJobOtherForecastCents",
    ] as const)
      integerCents(payload[key], key);
    if (!payload.confirmForecastOnly)
      throw new DomainError(
        400,
        "Confirm this is full-job forecast context, not actuals, balances or remaining billable scope.",
      );
  } else {
    integerCents(
      payload.worksGrossInvoiceCeilingAfterLegacyCents,
      "Remaining billable ceiling",
    );
    if (
      !payload.confirmIncludesAllLegacyInvoices ||
      !payload.confirmNoLegacyBalancesCreated
    )
      throw new DomainError(
        400,
        "Account for all legacy invoices, including unpaid invoices, without creating balances or payments.",
      );
    const used = await cutoverInvoiceConsumption(tx, job.id);
    if (payload.worksGrossInvoiceCeilingAfterLegacyCents < used)
      throw new DomainError(
        409,
        "The new remaining-billable ceiling is below retained Works invoice consumption. Existing drafts, voids and refunds do not silently replenish it.",
      );
  }
  return {
    ...base,
    evidenceDocuments: await evidenceFor(
      tx,
      job.id,
      payload.evidenceDocumentIds,
    ),
  };
}
async function publicReview(
  writer: CutoverWriter,
  review: typeof reviews.$inferSelect,
): Promise<JobCutoverReview> {
  const [approval] = await writer
    .select()
    .from(approvals)
    .where(eq(approvals.reviewId, review.id));
  const [commit] = approval
    ? await writer
        .select()
        .from(commits)
        .where(eq(commits.approvalId, approval.id))
    : [];
  return {
    ...review,
    kind: review.kind as JobCutoverKind,
    payload: review.payload as JobCutoverPayload,
    approval: approval
      ? {
          id: approval.id,
          approvedBy: approval.approvedBy,
          approvedAt: approval.approvedAt,
        }
      : null,
    commit: commit
      ? {
          id: commit.id,
          committedBy: commit.committedBy,
          committedAt: commit.committedAt,
        }
      : null,
  };
}
export async function readJobCutover(jobId: string) {
  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  if (!job) throw new DomainError(404, "Job not found.");
  const cutover = await jobMigrationCutover(db, job);
  const rows = await db
    .select()
    .from(reviews)
    .where(eq(reviews.jobId, jobId))
    .orderBy(desc(reviews.reviewedAt), desc(reviews.id))
    .limit(30);
  const documents = await db
    .select({
      id: jobDocumentsTable.id,
      name: jobDocumentsTable.name,
      sha256: jobDocumentsTable.sha256,
      size: jobDocumentsTable.size,
    })
    .from(jobDocumentsTable)
    .where(eq(jobDocumentsTable.jobId, jobId))
    .orderBy(asc(jobDocumentsTable.createdAt))
    .limit(101);
  return {
    cutover,
    reviews: await Promise.all(rows.map((row) => publicReview(db, row))),
    jobRevision: job.revision,
    scopeFingerprint: jobCutoverScopeFingerprint(job),
    evidenceDocuments: documents.slice(0, 100),
    hasMoreEvidenceDocuments: documents.length > 100,
  };
}
async function reviewAudit(
  tx: Tx,
  actor: string,
  jobId: string,
  action: string,
  details: Record<string, unknown>,
) {
  await tx.insert(auditEventsTable).values({
    id: randomUUID(),
    actorUserId: actor,
    entityType: "job",
    entityId: jobId,
    action: `job.cutover_${action}`,
    details,
    createdAt: now(),
  });
}
export async function reviewJobCutover(
  jobId: string,
  jobRevision: number,
  cutoverRevision: number,
  payload: JobCutoverPayload,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const job = await lockedCutoverJob(tx, jobId),
      state = await stateFor(tx, jobId);
    await assertActiveCutoverOwner(tx, actor);
    if (!state)
      throw new DomainError(
        409,
        "This existing native job has no imported cutover state. Source links never overwrite it.",
      );
    assertRevision(job.revision, jobRevision);
    assertRevision(state.revision, cutoverRevision);
    const evidence = await captureReview(tx, job, state, payload),
      fingerprint = hash([
        jobId,
        job.revision,
        state.revision,
        payload,
        evidence,
      ]);
    const [prior] = await tx
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.jobId, jobId),
          eq(reviews.kind, payload.kind),
          eq(reviews.fingerprint, fingerprint),
        ),
      );
    if (prior) return publicReview(tx, prior);
    const [review] = await tx
      .insert(reviews)
      .values({
        id: randomUUID(),
        jobId,
        kind: payload.kind,
        jobRevision: job.revision,
        cutoverRevision: state.revision,
        scopeFingerprint: evidence.scopeFingerprint,
        sourceFingerprint: evidence.sourceFingerprint,
        payload: payload as unknown as Record<string, unknown>,
        fingerprint,
        reviewedBy: actor,
        reviewedAt: now(),
      })
      .returning();
    await reviewAudit(tx, actor, jobId, "reviewed", {
      reviewId: review.id,
      kind: payload.kind,
      fingerprint,
    });
    return publicReview(tx, review);
  });
}
async function exactReview(
  tx: Tx,
  job: Job,
  state: State,
  reviewId: string,
  fingerprint: string,
) {
  const [review] = await tx
    .select()
    .from(reviews)
    .where(and(eq(reviews.id, reviewId), eq(reviews.jobId, job.id)));
  if (
    !review ||
    review.fingerprint !== fingerprint ||
    review.jobRevision !== job.revision ||
    review.cutoverRevision !== state.revision
  )
    throw new DomainError(
      409,
      "The cutover review is stale. Review the current job, source and evidence again.",
    );
  const payload = review.payload as JobCutoverPayload,
    evidence = await captureReview(tx, job, state, payload);
  if (
    hash([job.id, job.revision, state.revision, payload, evidence]) !==
    fingerprint
  )
    throw new DomainError(
      409,
      "Readiness or evidence changed after review. Review the current state again.",
    );
  return { review, payload, evidence };
}
export async function approveJobCutover(
  jobId: string,
  reviewId: string,
  fingerprint: string,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const job = await lockedCutoverJob(tx, jobId),
      state = await stateFor(tx, jobId);
    await assertActiveCutoverOwner(tx, actor);
    if (!state) throw new DomainError(409, "Imported cutover state not found.");
    const [prior] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.reviewId, reviewId), eq(approvals.jobId, jobId)));
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new DomainError(409, "Another immutable review was approved.");
      const [review] = await tx
        .select()
        .from(reviews)
        .where(eq(reviews.id, reviewId));
      return publicReview(tx, review);
    }
    const { review } = await exactReview(tx, job, state, reviewId, fingerprint);
    const [approval] = await tx
      .insert(approvals)
      .values({
        id: randomUUID(),
        reviewId,
        jobId,
        kind: review.kind,
        fingerprint,
        approvedBy: actor,
        approvedAt: now(),
      })
      .returning();
    await reviewAudit(tx, actor, jobId, "approved", {
      reviewId,
      approvalId: approval.id,
      fingerprint,
    });
    return publicReview(tx, review);
  });
}
export async function commitJobCutover(
  jobId: string,
  reviewId: string,
  approvalId: string,
  fingerprint: string,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const job = await lockedCutoverJob(tx, jobId),
      state = await stateFor(tx, jobId);
    await assertActiveCutoverOwner(tx, actor);
    if (!state) throw new DomainError(409, "Imported cutover state not found.");
    const [approval] = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.id, approvalId),
          eq(approvals.reviewId, reviewId),
          eq(approvals.jobId, jobId),
          eq(approvals.fingerprint, fingerprint),
        ),
      );
    if (!approval)
      throw new DomainError(
        409,
        "Commit only the exact immutable owner approval.",
      );
    const [prior] = await tx
      .select()
      .from(commits)
      .where(eq(commits.approvalId, approvalId));
    if (prior) {
      const [review] = await tx
        .select()
        .from(reviews)
        .where(eq(reviews.id, reviewId));
      return publicReview(tx, review);
    }
    const { review, payload, evidence } = await exactReview(
      tx,
      job,
      state,
      reviewId,
      fingerprint,
    );
    // No invoice, stock, schedule, accounting, customer or provider mutation occurs here.
    // Financial forecasts remain in their exact integer-cent context, never REAL actuals.
    const [commit] = await tx
      .insert(commits)
      .values({
        id: randomUUID(),
        approvalId,
        jobId,
        kind: review.kind,
        fingerprint,
        result: { payload, ...evidence },
        committedBy: actor,
        committedAt: now(),
      })
      .returning();
    if (payload.kind === "operational" && job.status !== payload.targetStage)
      await tx
        .update(jobsTable)
        .set({
          status: payload.targetStage,
          revision: job.revision + 1,
          updatedAt: now(),
        })
        .where(eq(jobsTable.id, jobId));
    await tx
      .update(cutovers)
      .set({
        revision: state.revision + 1,
        updatedAt: now(),
        ...(payload.kind === "operational"
          ? { operationalCommitId: commit.id }
          : payload.kind === "financial_context"
            ? { financialCommitId: commit.id }
            : { billingCommitId: commit.id }),
      })
      .where(eq(cutovers.jobId, jobId));
    await reviewAudit(tx, actor, jobId, "committed", {
      reviewId,
      approvalId,
      commitId: commit.id,
      kind: payload.kind,
      fingerprint,
      noLegacyBalancesCreated: true,
    });
    return publicReview(tx, review);
  });
}
/** Central guard for every ordinary office edit. New tracked cost sources remain separate. */
export async function assertCutoverJobEdit(
  tx: Tx,
  job: Job,
  updates: Record<string, unknown>,
) {
  const state = await stateFor(tx, job.id);
  if (!state) return;
  const keys = [
    ...moneyKeys,
    "estimateSnapshot",
    "shareToken",
    "soldAt",
    "completedAt",
    "eventDateSource",
    "stageHistory",
  ];
  if (keys.some((key) => Object.hasOwn(updates, key)))
    throw new DomainError(
      409,
      "Imported financials, source events and sharing require cutover review; ordinary edits cannot turn unknown history into zero or overwrite full-job context.",
    );
  if (
    Object.hasOwn(updates, "customerId") ||
    Object.hasOwn(updates, "siteId")
  ) {
    const claims = await tx
      .select({ id: requests.id })
      .from(requests)
      .where(eq(requests.jobId, job.id))
      .limit(1);
    if (claims.length)
      throw new DomainError(
        409,
        "This imported job has immutable invoice attribution. Its customer/site cannot be changed after billing consumption.",
      );
  }
}
export async function assertCutoverOperationalTransition(
  tx: Tx,
  job: Job,
  targetStage: string,
) {
  const state = await stateFor(tx, job.id);
  if (!state) return;
  const cutover = await jobMigrationCutover(tx, job);
  if (!cutover?.operational.current)
    throw new DomainError(
      409,
      "Complete current operational cutover review before advancing this imported job.",
    );
  const readiness = await jobReadiness(tx, job.id, targetStage);
  if (readiness.blockers.length)
    throw new DomainError(
      409,
      "Imported jobs must satisfy real operational readiness; owner override cannot substitute for migration cutover evidence.",
      readiness,
    );
  if (targetStage === "Invoiced" && !cutover.billing.current)
    throw new DomainError(
      409,
      "Review remaining billable scope before marking this imported job invoiced.",
    );
}
export async function assertCutoverProviderJobAllowed(
  writer: CutoverWriter,
  jobId: string,
) {
  const [job] = await writer
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .limit(1);
  if (!job) throw new DomainError(404, "Job not found.");
  const cutover = await jobMigrationCutover(writer, job);
  if (cutover && !cutover.operational.current)
    throw new DomainError(
      409,
      "Imported job operational cutover is not current. Provider export remains blocked; local cost capture can continue.",
    );
  return cutover;
}
