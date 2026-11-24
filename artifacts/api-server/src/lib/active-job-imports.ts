import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  db,
  auditEventsTable,
  jobsTable,
  customersTable,
  customerSitesTable,
  activeJobImportBatchesTable as batches,
  activeJobImportApprovalsTable as approvals,
  activeJobImportRecordsTable as records,
  jobCutoversTable,
} from "@workspace/db";
import { workspaceScopeKey } from "@workspace/db/workspace";
import {
  activeJobEntryStages,
  parseActiveJobCsv,
  type ActiveJobImportBatch,
  type ActiveJobImportDecision,
  type ActiveJobSourceRow,
} from "@workspace/domain";
import { assertRevision, DomainError } from "./operations-rules";
import {
  cutoverHash as hash,
  cutoverSourceHash as sourceHash,
} from "./cutover-hash";
import { nextDocumentNumber } from "./conversions";
import { assertActiveCutoverOwner } from "./cutover-owner";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Batch = typeof batches.$inferSelect;
const now = () => new Date().toISOString();
const floors = [
  "Carpet",
  "Hardwood",
  "Tile",
  "Laminate",
  "Luxury Vinyl Plank (LVP)",
  "Luxury Vinyl Tile (LVT)",
  "Waterproof Flooring",
  "Commercial Carpet Tile",
  "Commercial LVT",
];
const lock = async (tx: Tx) => {
  await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
  return tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('active-job-source-import'))`,
  );
};
const previewHash = (
  batch: Pick<
    Batch,
    | "id"
    | "workspaceKey"
    | "sourceSystem"
    | "batchKey"
    | "fileName"
    | "sourceSha256"
  >,
  rows: ActiveJobSourceRow[],
) =>
  hash([
    batch.id,
    batch.workspaceKey,
    batch.sourceSystem,
    batch.batchKey,
    batch.fileName,
    batch.sourceSha256,
    rows,
  ]);
const reviewHash = (
  batch: Batch,
  decisions: ActiveJobImportDecision[],
  note: string,
) => hash([batch.id, batch.previewFingerprint, decisions, note]);
async function audit(
  tx: Tx,
  actor: string,
  id: string,
  action: string,
  details: Record<string, unknown> = {},
) {
  await tx.insert(auditEventsTable).values({
    id: randomUUID(),
    actorUserId: actor,
    entityType: "active_job_import",
    entityId: id,
    action: `active_job_import.${action}`,
    details,
    createdAt: now(),
  });
}
async function getBatch(writer: Tx | typeof db, id: string, exclusive = false) {
  const query = writer.select().from(batches).where(eq(batches.id, id));
  const [batch] = await (exclusive ? query.for("update") : query);
  if (!batch)
    throw new DomainError(
      404,
      "Active-job source import not found in this company.",
    );
  // workspaceKey is retained ingestion provenance, not an authorization key.
  // The trusted tenant boundary has already selected this company's database;
  // adoption from a default host must not orphan its retained source history.
  return batch;
}
function parsedSource(batch: Batch) {
  if (sourceHash(batch.sourceCsv) !== batch.sourceSha256)
    throw new DomainError(
      409,
      "The retained source checksum changed. Preserve the file and request operator review.",
    );
  return parseActiveJobCsv(batch.sourceCsv, batch.delimiter as "," | "\t");
}
async function capture(
  writer: Tx | typeof db,
  batch: Pick<Batch, "sourceSystem">,
  rows: ActiveJobSourceRow[],
) {
  const previous = await writer
    .select()
    .from(records)
    .where(
      and(
        eq(records.sourceSystem, batch.sourceSystem),
        inArray(
          records.sourceId,
          rows.map((row) => row.data.source_id),
        ),
      ),
    );
  return rows.map((row) => ({
    ...row,
    imported: (() => {
      const prior = previous.find(
        (item) => item.sourceId === row.data.source_id,
      );
      return prior ? { jobId: prior.jobId, batchId: prior.batchId } : null;
    })(),
  }));
}
async function present(
  writer: Tx | typeof db,
  batch: Batch,
): Promise<ActiveJobImportBatch> {
  const [approval] = batch.currentApprovalId
    ? await writer
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.id, batch.currentApprovalId),
            eq(approvals.batchId, batch.id),
          ),
        )
    : [];
  return {
    id: batch.id,
    sourceSystem: batch.sourceSystem,
    batchKey: batch.batchKey,
    fileName: batch.fileName,
    sourceSha256: batch.sourceSha256,
    rows: batch.rows as ActiveJobSourceRow[],
    status: batch.status,
    revision: batch.revision,
    previewFingerprint: batch.previewFingerprint,
    reviewFingerprint: batch.reviewFingerprint,
    decisions: batch.decisions as ActiveJobImportDecision[],
    reviewNote: batch.reviewNote,
    approval: approval
      ? {
          id: approval.id,
          fingerprint: approval.fingerprint,
          approvedBy: approval.approvedBy,
          approvedAt: approval.approvedAt,
        }
      : null,
    result: batch.result as ActiveJobImportBatch["result"],
  };
}
export const listActiveJobImports = () =>
  db
    .select({
      id: batches.id,
      sourceSystem: batches.sourceSystem,
      batchKey: batches.batchKey,
      fileName: batches.fileName,
      status: batches.status,
      createdAt: batches.createdAt,
    })
    .from(batches)
    .orderBy(desc(batches.createdAt), desc(batches.id))
    .limit(30);
export const readActiveJobImport = async (id: string) =>
  present(db, await getBatch(db, id));
export const activeJobSourceCsv = async (id: string) => {
  const batch = await getBatch(db, id);
  parsedSource(batch);
  return batch.sourceCsv;
};
export async function activeJobImportChoices(q: string) {
  const term = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const customers = await db
    .select({
      id: customersTable.id,
      name: customersTable.name,
      revision: customersTable.revision,
    })
    .from(customersTable)
    .where(
      and(
        sql`${customersTable.mergedIntoId} IS NULL`,
        q ? ilike(customersTable.name, term) : undefined,
      ),
    )
    .orderBy(asc(customersTable.name), asc(customersTable.id))
    .limit(51);
  const sites = customers.length
    ? await db
        .select()
        .from(customerSitesTable)
        .where(
          inArray(
            customerSitesTable.customerId,
            customers.map((row) => row.id),
          ),
        )
        .orderBy(asc(customerSitesTable.id))
        .limit(1001)
    : [];
  if (sites.length > 1000)
    throw new DomainError(
      409,
      "Narrow the customer search before selecting a job site.",
    );
  const jobs = await db
    .select({
      id: jobsTable.id,
      jobNumber: jobsTable.jobNumber,
      customerId: jobsTable.customerId,
      siteId: jobsTable.siteId,
      revision: jobsTable.revision,
      status: jobsTable.status,
    })
    .from(jobsTable)
    .where(
      q
        ? or(
            ilike(jobsTable.jobNumber, term),
            ilike(jobsTable.customerName, term),
          )
        : undefined,
    )
    .orderBy(desc(jobsTable.updatedAt), asc(jobsTable.id))
    .limit(51);
  return {
    customers: customers.slice(0, 50).map((row) => ({
      ...row,
      sites: sites
        .filter((site) => site.customerId === row.id)
        .map((site) => ({
          id: site.id,
          address: site.address,
          city: site.city,
          label: site.label,
          fingerprint: hash(site),
        })),
    })),
    jobs: jobs.slice(0, 50),
    hasMoreCustomers: customers.length > 50,
    hasMoreJobs: jobs.length > 50,
    flooringTypes: floors,
    entryStages: activeJobEntryStages,
  };
}
export async function previewActiveJobImport(
  input: {
    sourceSystem: string;
    batchKey: string;
    fileName: string;
    csv: string;
    delimiter: "," | "\t";
  },
  actor: string,
) {
  let parsed: ReturnType<typeof parseActiveJobCsv>;
  try {
    parsed = parseActiveJobCsv(input.csv, input.delimiter);
  } catch (error) {
    throw new DomainError(
      400,
      error instanceof Error
        ? error.message
        : "Correct the active-job source CSV.",
    );
  }
  return db.transaction(async (tx) => {
    await lock(tx);
    await assertActiveCutoverOwner(tx, actor);
    const [prior] = await tx
      .select()
      .from(batches)
      .where(
        and(
          eq(batches.sourceSystem, input.sourceSystem),
          eq(batches.batchKey, input.batchKey),
        ),
      );
    const sha = sourceHash(input.csv);
    if (prior) {
      if (
        prior.sourceSha256 !== sha ||
        prior.fileName !== input.fileName ||
        prior.delimiter !== input.delimiter
      )
        throw new DomainError(
          409,
          "This source/batch identity already retains a different source. Use a new batch identity without changing the original.",
        );
      return present(tx, prior);
    }
    const data = {
      id: randomUUID(),
      workspaceKey: workspaceScopeKey() || "default",
      sourceSystem: input.sourceSystem,
      batchKey: input.batchKey,
      fileName: input.fileName,
      sourceSha256: sha,
      sourceCsv: input.csv,
      delimiter: input.delimiter,
    };
    const rows = await capture(tx, data, parsed.rows);
    const [batch] = await tx
      .insert(batches)
      .values({
        ...data,
        rows,
        previewFingerprint: previewHash(data, rows),
        createdBy: actor,
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    await audit(tx, actor, batch.id, "previewed", {
      sourceSha256: sha,
      rows: rows.length,
    });
    return present(tx, batch);
  });
}
export async function refreshActiveJobImport(
  id: string,
  expected: number,
  actor: string,
) {
  return db.transaction(async (tx) => {
    await lock(tx);
    const batch = await getBatch(tx, id, true);
    await assertActiveCutoverOwner(tx, actor);
    assertRevision(batch.revision, expected);
    if (batch.status === "committed")
      throw new DomainError(
        409,
        "Committed active-job source imports are immutable.",
      );
    const rows = await capture(tx, batch, parsedSource(batch).rows);
    const [saved] = await tx
      .update(batches)
      .set({
        rows,
        status: "preview",
        previewFingerprint: previewHash(batch, rows),
        reviewFingerprint: null,
        decisions: [],
        reviewNote: null,
        currentApprovalId: null,
        revision: batch.revision + 1,
        updatedAt: now(),
      })
      .where(eq(batches.id, id))
      .returning();
    await audit(tx, actor, id, "refreshed");
    return present(tx, saved);
  });
}
async function currentRows(tx: Tx, batch: Batch) {
  const rows = await capture(tx, batch, parsedSource(batch).rows);
  if (previewHash(batch, rows) !== batch.previewFingerprint)
    throw new DomainError(
      409,
      "Source identities changed. Refresh and review the current preview.",
    );
  return rows;
}
async function decisionsFor(
  tx: Tx,
  rows: ActiveJobSourceRow[],
  decisions: ActiveJobImportDecision[],
) {
  if (
    rows.length !== decisions.length ||
    new Set(decisions.map((item) => item.line)).size !== rows.length ||
    decisions.some((item) => !rows.some((row) => row.line === item.line))
  )
    throw new DomainError(400, "Review every source row exactly once.");
  // Global import lock -> jobs in ID order -> selected customers/sites in ID order.
  // Normal customer merge takes customer locks before jobs; table-share locks below
  // prevent changes during recapture without reversing that row-lock order.
  const jobIds = [
    ...new Set(
      decisions.flatMap((choice) =>
        choice.action === "link" && choice.jobId ? [choice.jobId] : [],
      ),
    ),
  ].sort();
  const linked = jobIds.length
    ? await tx
        .select()
        .from(jobsTable)
        .where(inArray(jobsTable.id, jobIds))
        .orderBy(asc(jobsTable.id))
        .for("share")
    : [];
  const ids = [
    ...new Set(
      decisions.flatMap((choice) =>
        choice.action !== "skip" && choice.customerId
          ? [choice.customerId]
          : [],
      ),
    ),
  ].sort();
  const customers = ids.length
    ? await tx
        .select()
        .from(customersTable)
        .where(inArray(customersTable.id, ids))
        .orderBy(asc(customersTable.id))
        .for("share")
    : [];
  const siteIds = [
    ...new Set(
      decisions.flatMap((choice) =>
        choice.action !== "skip" && choice.siteId ? [choice.siteId] : [],
      ),
    ),
  ].sort();
  const sites = siteIds.length
    ? await tx
        .select()
        .from(customerSitesTable)
        .where(inArray(customerSitesTable.id, siteIds))
        .orderBy(asc(customerSitesTable.id))
        .for("share")
    : [];
  return rows.map((row) => {
    const choice = decisions.find((item) => item.line === row.line)!;
    if (choice.action === "skip") {
      if (choice.note.trim().length < 5)
        throw new DomainError(
          400,
          `Explain why source line ${row.line} is skipped.`,
        );
      return { line: row.line, action: "skip" as const, note: choice.note };
    }
    if (row.errors.length || row.fileDuplicates.length || row.imported)
      throw new DomainError(
        409,
        `Source line ${row.line} is invalid, duplicated or already bound. Correct it or skip explicitly; retained source identities cannot be rebound.`,
      );
    const customer = customers.find((item) => item.id === choice.customerId);
    const site = choice.siteId
      ? sites.find((item) => item.id === choice.siteId)
      : null;
    if (
      !customer ||
      customer.mergedIntoId ||
      customer.revision !== choice.customerRevision ||
      (choice.siteId &&
        (!site ||
          site.customerId !== customer.id ||
          hash(site) !== choice.siteFingerprint))
    )
      throw new DomainError(
        409,
        `Choose the current unmerged customer and an explicitly reviewed site belonging to it for line ${row.line}.`,
      );
    if (!choice.note || choice.note.trim().length < 5)
      throw new DomainError(
        400,
        `Explain the explicit customer/site and job identity decision for line ${row.line}.`,
      );
    const job =
      choice.action === "link"
        ? linked.find((item) => item.id === choice.jobId)
        : null;
    if (
      choice.action === "link" &&
      (!job ||
        job.revision !== choice.jobRevision ||
        job.customerId !== customer.id ||
        (job.siteId ?? null) !== (site?.id ?? null))
    )
      throw new DomainError(
        409,
        `Choose an existing job at its current revision with exactly this customer and site for line ${row.line}. Linking never edits it.`,
      );
    if (choice.action === "create") {
      if (
        !choice.entryStage ||
        !activeJobEntryStages.includes(
          choice.entryStage as (typeof activeJobEntryStages)[number],
        ) ||
        !choice.flooringType ||
        !floors.includes(choice.flooringType)
      )
        throw new DomainError(
          400,
          `Choose an explicit safe entry stage and supported flooring type for line ${row.line}. Scheduled, in-progress and closed stages require later operational reconciliation.`,
        );
      if (
        choice.entryStage !== row.data.source_status &&
        (!choice.stageMappingReason ||
          choice.stageMappingReason.trim().length < 5)
      )
        throw new DomainError(
          400,
          `Explain the entry-stage mapping for line ${row.line}; the original status remains unchanged in provenance.`,
        );
      if (typeof choice.acceptSourceDates !== "boolean")
        throw new DomainError(
          400,
          `Explicitly accept or defer the source dates on line ${row.line}.`,
        );
    }
    const snapshot = { customer, site, job };
    if (choice.snapshot && hash(choice.snapshot) !== hash(snapshot))
      throw new DomainError(
        409,
        "A selected customer, site or linked job changed. Refresh and review its exact current identity.",
      );
    return {
      ...choice,
      siteId: site?.id ?? null,
      siteFingerprint: site ? hash(site) : null,
      snapshot,
    };
  });
}
async function prepareLocked(tx: Tx, id: string, actor: string) {
  await lock(tx);
  await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
  await tx.execute(
    sql`LOCK TABLE customers,customer_sites,jobs IN SHARE ROW EXCLUSIVE MODE`,
  );
  const batch = await getBatch(tx, id, true);
  await assertActiveCutoverOwner(tx, actor);
  return batch;
}
export async function reviewActiveJobImport(
  id: string,
  expected: number,
  fingerprint: string,
  decisions: ActiveJobImportDecision[],
  note: string,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const batch = await prepareLocked(tx, id, actor);
    assertRevision(batch.revision, expected);
    if (
      !["preview", "reviewed"].includes(batch.status) ||
      batch.previewFingerprint !== fingerprint
    )
      throw new DomainError(
        409,
        "Refresh and review the current preview before changing an accepted decision.",
      );
    const reviewed = await decisionsFor(
      tx,
      await currentRows(tx, batch),
      decisions,
    );
    const [saved] = await tx
      .update(batches)
      .set({
        decisions: reviewed,
        reviewNote: note,
        reviewFingerprint: reviewHash(batch, reviewed, note),
        status: "reviewed",
        revision: batch.revision + 1,
        updatedAt: now(),
      })
      .where(eq(batches.id, id))
      .returning();
    await audit(tx, actor, id, "reviewed");
    return present(tx, saved);
  });
}
export async function approveActiveJobImport(
  id: string,
  expected: number,
  fingerprint: string,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const batch = await prepareLocked(tx, id, actor);
    if (batch.status === "approved" && batch.reviewFingerprint === fingerprint)
      return present(tx, batch);
    assertRevision(batch.revision, expected);
    if (
      batch.status !== "reviewed" ||
      !batch.reviewNote ||
      batch.reviewFingerprint !== fingerprint ||
      reviewHash(
        batch,
        batch.decisions as ActiveJobImportDecision[],
        batch.reviewNote,
      ) !== fingerprint
    )
      throw new DomainError(
        409,
        "Approve only the exact saved active-job review.",
      );
    await decisionsFor(
      tx,
      await currentRows(tx, batch),
      batch.decisions as ActiveJobImportDecision[],
    );
    const [created] = await tx
      .insert(approvals)
      .values({
        id: randomUUID(),
        batchId: id,
        fingerprint,
        previewFingerprint: batch.previewFingerprint,
        decisions: batch.decisions,
        reviewNote: batch.reviewNote,
        approvedBy: actor,
        approvedAt: now(),
      })
      .onConflictDoNothing({
        target: [approvals.batchId, approvals.fingerprint],
      })
      .returning();
    const approval =
      created ??
      (
        await tx
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.batchId, id),
              eq(approvals.fingerprint, fingerprint),
            ),
          )
          .limit(1)
      )[0];
    const [saved] = await tx
      .update(batches)
      .set({
        status: "approved",
        currentApprovalId: approval.id,
        revision: batch.revision + 1,
        updatedAt: now(),
      })
      .where(eq(batches.id, id))
      .returning();
    await audit(tx, actor, id, "approved", {
      approvalId: approval.id,
      fingerprint,
    });
    return present(tx, saved);
  });
}
export async function commitActiveJobImport(
  id: string,
  expected: number,
  approvalId: string,
  fingerprint: string,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const batch = await prepareLocked(tx, id, actor);
    if (batch.status === "committed") {
      if (
        batch.currentApprovalId !== approvalId ||
        batch.reviewFingerprint !== fingerprint
      )
        throw new DomainError(
          409,
          "This batch was committed under a different immutable approval.",
        );
      return present(tx, batch);
    }
    assertRevision(batch.revision, expected);
    const [approval] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.batchId, id)));
    if (
      batch.status !== "approved" ||
      batch.currentApprovalId !== approvalId ||
      !approval ||
      approval.fingerprint !== fingerprint ||
      approval.previewFingerprint !== batch.previewFingerprint ||
      reviewHash(
        batch,
        approval.decisions as ActiveJobImportDecision[],
        approval.reviewNote,
      ) !== fingerprint
    )
      throw new DomainError(
        409,
        "Commit only the immutable owner-approved source review.",
      );
    const rows = await currentRows(tx, batch),
      choices = await decisionsFor(
        tx,
        rows,
        approval.decisions as ActiveJobImportDecision[],
      ),
      result = { created: 0, linked: 0, skipped: 0, jobIds: [] as string[] };
    for (const choice of choices) {
      if (choice.action === "skip") {
        result.skipped++;
        continue;
      }
      const row = rows.find((item) => item.line === choice.line)!,
        source = row.data;
      let jobId = choice.jobId;
      if (choice.action === "create") {
        const snapshot = choice.snapshot as {
          customer: typeof customersTable.$inferSelect;
          site: typeof customerSitesTable.$inferSelect | null;
        };
        const accepted = choice.acceptSourceDates;
        const [job] = await tx
          .insert(jobsTable)
          .values({
            id: randomUUID(),
            jobNumber: await nextDocumentNumber(tx, "job"),
            customerId: choice.customerId,
            siteId: choice.siteId,
            customerName: snapshot.customer.name,
            phone: snapshot.customer.phone,
            email: snapshot.customer.email,
            address: snapshot.site?.address ?? source.address,
            city: snapshot.site?.city ?? source.city,
            flooringType: choice.flooringType!,
            scopeOfWork: source.scope_of_work,
            rooms: [],
            squareFootage: source.square_feet ? Number(source.square_feet) : 0,
            status: choice.entryStage!,
            materialStatus: "Not Ordered",
            crewAssigned: "Unassigned",
            priorityLevel: "Medium",
            riskLevel: "Low",
            laborEstimate: null,
            materialEstimate: null,
            estRevenue: null,
            estGrossProfit: null,
            grossMarginPct: null,
            actualRevenue: null,
            actualLaborCost: null,
            actualMaterialCost: null,
            actualAddOnCost: null,
            estLaborHours: 0,
            notes: source.notes,
            shareToken: "",
            stageHistory: [],
            soldAt: accepted && source.sold_at ? source.sold_at : null,
            eventDateSource:
              accepted && source.sold_at ? "reviewed_import_source" : null,
            estStartDate:
              accepted && source.est_start_on ? source.est_start_on : null,
            estCompletionDate:
              accepted && source.est_completion_on
                ? source.est_completion_on
                : null,
            committedCompletionDate:
              accepted && source.committed_completion_on
                ? source.committed_completion_on
                : null,
            committedCompletionRecordedAt: null,
            createdAt: now(),
            updatedAt: now(),
          })
          .returning();
        jobId = job.id;
        result.created++;
      } else result.linked++;
      const recordId = randomUUID();
      await tx.insert(records).values({
        id: recordId,
        batchId: id,
        approvalId,
        sourceSystem: batch.sourceSystem,
        sourceId: source.source_id,
        sourceLine: row.line,
        jobId: jobId!,
        customerId: choice.customerId!,
        siteId: choice.siteId,
        action: choice.action,
        sourceData: source,
        decision: choice as Record<string, unknown>,
        sourceRowSha256: hash(source),
        createdAt: now(),
      });
      if (choice.action === "create")
        await tx.insert(jobCutoversTable).values({
          jobId: jobId!,
          sourceRecordId: recordId,
          createdAt: now(),
          updatedAt: now(),
        });
      result.jobIds.push(jobId!);
    }
    const [saved] = await tx
      .update(batches)
      .set({
        status: "committed",
        result,
        committedAt: now(),
        revision: batch.revision + 1,
        updatedAt: now(),
      })
      .where(eq(batches.id, id))
      .returning();
    await audit(tx, actor, id, "committed", {
      approvalId,
      fingerprint,
      ...result,
      noOperationalOrFinancialSideEffects: true,
    });
    return present(tx, saved);
  });
}
