import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  db,
  auditEventsTable,
  customersTable,
  customerSitesTable,
  customerImportBatchesTable as batches,
  customerImportApprovalsTable as approvals,
  customerImportRecordsTable as records,
} from "@workspace/db";
import { workspaceScopeKey } from "@workspace/db/workspace";
import {
  customerNameKey,
  customerPhoneKey,
  customerImportMatches,
  mapCustomerCsv,
  type CustomerImportBatch,
  type CustomerImportDecision,
  type CustomerImportRow,
  type CustomerImportMapping,
} from "@workspace/domain";
import { DomainError, assertRevision } from "./operations-rules";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Batch = typeof batches.$inferSelect;
// The request's trusted workspace selects the company database. Its label is
// historical provenance, never a second namespace that could hide old imports.
const workspaceLabel = () => workspaceScopeKey() || "default";
// jsonb changes object key order. Fingerprints must survive durable round trips.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  return value;
}
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const now = () => new Date().toISOString();
const previewHash = (
  batch: Pick<
    Batch,
    | "id"
    | "workspaceKey"
    | "sourceSystem"
    | "batchKey"
    | "sourceSha256"
    | "mapping"
  >,
  rows: CustomerImportRow[],
) =>
  hash([
    batch.id,
    batch.workspaceKey,
    batch.sourceSystem,
    batch.batchKey,
    batch.sourceSha256,
    batch.mapping,
    rows,
  ]);
const reviewHash = (
  batch: Batch,
  decisions: CustomerImportDecision[],
  note: string,
) =>
  hash([
    batch.id,
    batch.workspaceKey,
    batch.previewFingerprint,
    decisions,
    note,
  ]);
async function audit(
  tx: Tx,
  actor: string,
  batch: Batch,
  action: string,
  details: Record<string, unknown> = {},
) {
  await tx.insert(auditEventsTable).values({
    id: randomUUID(),
    actorUserId: actor,
    action: `customer_import.${action}`,
    entityType: "customer_import",
    entityId: batch.id,
    details: {
      sourceSystem: batch.sourceSystem,
      batchKey: batch.batchKey,
      sourceSha256: batch.sourceSha256,
      ...details,
    },
    createdAt: now(),
  });
}
async function getBatch(tx: Tx | typeof db, batchId: string, locked = false) {
  const query = tx.select().from(batches).where(eq(batches.id, batchId));
  const [batch] = await (locked ? query.for("update") : query);
  if (!batch)
    throw new DomainError(
      404,
      "Customer import batch not found in this company.",
    );
  return batch;
}
async function resolveCustomers(tx: Tx | typeof db, ids: string[]) {
  const found = new Map<string, typeof customersTable.$inferSelect>();
  let pending = [...new Set(ids)];
  for (let depth = 0; pending.length && depth < 30; depth++) {
    const rows = await tx
      .select()
      .from(customersTable)
      .where(inArray(customersTable.id, pending));
    for (const row of rows) found.set(row.id, row);
    if (found.size > 5000)
      throw new DomainError(
        409,
        "This import has extensive customer merge history. Use a smaller batch for owner review.",
      );
    pending = [
      ...new Set(
        rows.flatMap((row) =>
          row.mergedIntoId && !found.has(row.mergedIntoId)
            ? [row.mergedIntoId]
            : [],
        ),
      ),
    ];
  }
  const effective = (id: string) => {
    const seen = new Set<string>();
    let row = found.get(id);
    while (row?.mergedIntoId) {
      if (seen.has(row.id) || seen.size >= 30)
        throw new DomainError(
          409,
          "Customer merge history needs owner review before importing.",
        );
      seen.add(row.id);
      row = found.get(row.mergedIntoId);
    }
    if (!row)
      throw new DomainError(
        409,
        "An imported customer history link is unavailable. Review its source record.",
      );
    return row.id;
  };
  return { found, effective };
}
async function capture(
  tx: Tx | typeof db,
  batch: Pick<Batch, "sourceSystem">,
  input: CustomerImportRow[],
) {
  const names = [
    ...new Set(
      input.map((row) => customerNameKey(row.data.name)).filter(Boolean),
    ),
  ];
  const emails = [
    ...new Set(
      input.map((row) => row.data.email.toLowerCase()).filter(Boolean),
    ),
  ];
  const phones = [
    ...new Set(
      input.map((row) => customerPhoneKey(row.data.phone)).filter(Boolean),
    ),
  ];
  const conditions = [
    names.length
      ? inArray(
          sql<string>`lower(regexp_replace(btrim(${customersTable.name}), '[[:space:]]+', ' ', 'g'))`,
          names,
        )
      : undefined,
    emails.length
      ? inArray(sql<string>`lower(btrim(${customersTable.email}))`, emails)
      : undefined,
    phones.length
      ? inArray(
          sql<string>`(CASE WHEN regexp_replace(${customersTable.phone}, '[^0-9]', '', 'g') ~ '^1[0-9]{10}$' THEN right(regexp_replace(${customersTable.phone}, '[^0-9]', '', 'g'), 10) ELSE regexp_replace(${customersTable.phone}, '[^0-9]', '', 'g') END)`,
          phones,
        )
      : undefined,
  ].filter(Boolean);
  // A retired customer's old contact details can still identify the retained record.
  // Resolve those matches for explicit owner linking instead of hiding merge history.
  const candidates = conditions.length
    ? await tx
        .select()
        .from(customersTable)
        .where(or(...conditions))
        .orderBy(customersTable.id)
        .limit(2001)
    : [];
  if (candidates.length > 2000)
    throw new DomainError(
      409,
      "More than 2,000 possible customer matches. Split this file or resolve existing duplicates before importing.",
    );
  const sourceIds = [
    ...new Set(input.map((row) => row.data.sourceId).filter(Boolean)),
  ];
  const imported = sourceIds.length
    ? await tx
        .select()
        .from(records)
        .where(
          and(
            eq(records.sourceSystem, batch.sourceSystem),
            inArray(records.sourceId, sourceIds),
          ),
        )
    : [];
  const links = new Map(imported.map((record) => [record.sourceId, record]));
  const resolved = await resolveCustomers(tx, [
    ...imported.map((record) => record.customerId),
    ...candidates.map((candidate) => candidate.id),
  ]);
  return input.map((row) => {
    const matchedIds = [
      ...new Set(
        candidates
          .filter((candidate) => customerImportMatches(row.data, candidate))
          .map((candidate) => resolved.effective(candidate.id)),
      ),
    ].sort();
    const matches = matchedIds.map((id) => resolved.found.get(id)!);
    const record = links.get(row.data.sourceId);
    return {
      ...row,
      errors: [
        ...row.errors.filter(
          (error) => !error.startsWith("More than 20 matching"),
        ),
        ...(matches.length > 20
          ? [
              "More than 20 matching customers. Skip this row and resolve duplicates first.",
            ]
          : []),
      ],
      candidates: matches
        .slice(0, 20)
        .map(
          ({ id, name, email, phone, revision, updatedAt, mergedIntoId }) => ({
            id,
            name,
            email,
            phone,
            revision,
            updatedAt,
            mergedIntoId,
          }),
        ),
      imported: record
        ? {
            customerId: record.customerId,
            effectiveCustomerId: resolved.effective(record.customerId),
            batchId: record.batchId,
          }
        : null,
    };
  });
}
async function present(
  tx: Tx | typeof db,
  batch: Batch,
): Promise<CustomerImportBatch> {
  const [approval] = batch.currentApprovalId
    ? await tx
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
    headers: batch.headers,
    mapping: batch.mapping,
    rows: batch.rows as CustomerImportRow[],
    status: batch.status,
    revision: batch.revision,
    previewFingerprint: batch.previewFingerprint,
    reviewFingerprint: batch.reviewFingerprint,
    decisions: batch.decisions as CustomerImportDecision[],
    reviewNote: batch.reviewNote,
    approval: approval
      ? {
          id: approval.id,
          fingerprint: approval.fingerprint,
          approvedAt: approval.approvedAt,
          approvedBy: approval.approvedBy,
        }
      : null,
    result: batch.result as CustomerImportBatch["result"],
  };
}
export async function listCustomerImports() {
  return db
    .select({
      id: batches.id,
      sourceSystem: batches.sourceSystem,
      batchKey: batches.batchKey,
      status: batches.status,
      createdAt: batches.createdAt,
    })
    .from(batches)
    .orderBy(desc(batches.createdAt))
    .limit(30);
}
export async function readCustomerImport(id: string) {
  return present(db, await getBatch(db, id));
}
export async function previewCustomerImport(
  input: {
    csv: string;
    mapping: CustomerImportMapping;
    sourceSystem: string;
    batchKey: string;
    fileName: string;
    delimiter: "," | "\t";
  },
  actor: string,
) {
  let mapped: ReturnType<typeof mapCustomerCsv>;
  try {
    mapped = mapCustomerCsv(input.csv, input.mapping, input.delimiter);
  } catch (error) {
    throw new DomainError(
      400,
      error instanceof Error ? error.message : "Correct the customer CSV.",
    );
  }
  const sourceSha256 = createHash("sha256").update(input.csv).digest("hex");
  return db.transaction(async (tx) => {
    const identity = and(
      eq(batches.sourceSystem, input.sourceSystem),
      eq(batches.batchKey, input.batchKey),
    );
    const [existing] = await tx.select().from(batches).where(identity);
    if (existing) {
      if (
        existing.sourceSha256 !== sourceSha256 ||
        hash(existing.mapping) !== hash(input.mapping) ||
        existing.fileName !== input.fileName
      )
        throw new DomainError(
          409,
          "This source/batch identity already describes a different file or mapping. Choose a new batch ID.",
        );
      return present(tx, existing);
    }
    const data = {
      id: randomUUID(),
      workspaceKey: workspaceLabel(),
      sourceSystem: input.sourceSystem,
      batchKey: input.batchKey,
      fileName: input.fileName,
      sourceSha256,
      mapping: input.mapping as Record<string, string>,
      headers: mapped.headers,
    };
    const rows = await capture(tx, data, mapped.rows);
    const [created] = await tx
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
    await audit(tx, actor, created, "previewed", { rows: rows.length });
    return present(tx, created);
  });
}
export async function refreshCustomerImport(
  batchId: string,
  revision: number,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const batch = await getBatch(tx, batchId, true);
    assertRevision(batch.revision, revision);
    if (batch.status === "committed")
      throw new DomainError(
        409,
        "Committed imports are immutable. Use a new batch for additional records.",
      );
    const rows = await capture(tx, batch, batch.rows as CustomerImportRow[]);
    const [saved] = await tx
      .update(batches)
      .set({
        rows,
        previewFingerprint: previewHash(batch, rows),
        status: "preview",
        decisions: [],
        reviewFingerprint: null,
        reviewNote: null,
        currentApprovalId: null,
        revision: batch.revision + 1,
        updatedAt: now(),
      })
      .where(eq(batches.id, batch.id))
      .returning();
    await audit(tx, actor, batch, "review_refreshed", {
      previousApprovalId: batch.currentApprovalId,
    });
    return present(tx, saved);
  });
}
export function validateCustomerDecisions(
  rows: CustomerImportRow[],
  decisions: CustomerImportDecision[],
) {
  if (
    decisions.length !== rows.length ||
    new Set(decisions.map((item) => item.line)).size !== rows.length ||
    decisions.some((item) => !rows.some((row) => row.line === item.line))
  )
    throw new DomainError(400, "Review every source row exactly once.");
  return rows.map((row) => {
    const decision = decisions.find((item) => item.line === row.line)!;
    if (decision.action === "skip") {
      if (decision.note.length < 5)
        throw new DomainError(
          400,
          `Explain why source line ${row.line} is skipped.`,
        );
      return { line: row.line, action: "skip" as const, note: decision.note };
    }
    if (row.errors.length || row.imported)
      throw new DomainError(
        409,
        `Source line ${row.line} has errors or was already imported. Correct the file or skip it explicitly.`,
      );
    if (decision.action === "create") {
      if (
        (row.candidates.length || row.fileDuplicates.length) &&
        decision.note.length < 5
      )
        throw new DomainError(
          400,
          `Explain why line ${row.line} is a separate customer despite possible duplicates.`,
        );
      return { line: row.line, action: "create" as const, note: decision.note };
    }
    const candidate = row.candidates.find(
      (item) =>
        item.id === decision.customerId &&
        item.revision === decision.customerRevision,
    );
    if (!candidate || decision.note.length < 5)
      throw new DomainError(
        409,
        `Select a reviewed matching customer and explain the link for line ${row.line}.`,
      );
    return {
      line: row.line,
      action: "link" as const,
      customerId: candidate.id,
      customerRevision: candidate.revision,
      note: decision.note,
    };
  });
}
export async function reviewCustomerImport(
  batchId: string,
  expected: number,
  fingerprint: string,
  decisions: CustomerImportDecision[],
  note: string,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const batch = await getBatch(tx, batchId, true);
    assertRevision(batch.revision, expected);
    if (batch.status === "approved" || batch.status === "committed")
      throw new DomainError(
        409,
        "Approval is immutable. Refresh the review explicitly before changing decisions.",
      );
    if (fingerprint !== batch.previewFingerprint)
      throw new DomainError(
        409,
        "The preview changed. Refresh and review it again.",
      );
    const reviewed = validateCustomerDecisions(
      batch.rows as CustomerImportRow[],
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
      .where(eq(batches.id, batch.id))
      .returning();
    await audit(tx, actor, batch, "reviewed");
    return present(tx, saved);
  });
}
export async function approveCustomerImport(
  batchId: string,
  expected: number,
  fingerprint: string,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const batch = await getBatch(tx, batchId, true);
    if (batch.status === "approved" && batch.reviewFingerprint === fingerprint)
      return present(tx, batch);
    assertRevision(batch.revision, expected);
    if (
      batch.status !== "reviewed" ||
      !batch.reviewNote ||
      batch.reviewFingerprint !== fingerprint ||
      reviewHash(
        batch,
        batch.decisions as CustomerImportDecision[],
        batch.reviewNote,
      ) !== fingerprint
    )
      throw new DomainError(
        409,
        "Approve the exact saved review and its fingerprint.",
      );
    const [approval] = await tx
      .insert(approvals)
      .values({
        id: randomUUID(),
        batchId: batch.id,
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
    const existing =
      approval ??
      (
        await tx
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.batchId, batch.id),
              eq(approvals.fingerprint, fingerprint),
            ),
          )
      )[0];
    const [saved] = await tx
      .update(batches)
      .set({
        status: "approved",
        currentApprovalId: existing.id,
        revision: batch.revision + 1,
        updatedAt: now(),
      })
      .where(eq(batches.id, batch.id))
      .returning();
    await audit(tx, actor, batch, "approved", {
      approvalId: existing.id,
      fingerprint,
    });
    return present(tx, saved);
  });
}
export async function commitCustomerImport(
  batchId: string,
  expected: number,
  approvalId: string,
  fingerprint: string,
  actor: string,
) {
  return db
    .transaction(async (tx) => {
      const batch = await getBatch(tx, batchId, true);
      if (batch.status === "committed") {
        if (
          batch.currentApprovalId !== approvalId ||
          batch.reviewFingerprint !== fingerprint
        )
          throw new DomainError(
            409,
            "This batch was committed under another approval.",
          );
        return present(tx, batch);
      }
      assertRevision(batch.revision, expected);
      const [approval] = await tx
        .select()
        .from(approvals)
        .where(
          and(eq(approvals.id, approvalId), eq(approvals.batchId, batch.id)),
        );
      if (
        batch.status !== "approved" ||
        batch.currentApprovalId !== approvalId ||
        !approval ||
        approval.fingerprint !== fingerprint ||
        approval.previewFingerprint !== batch.previewFingerprint ||
        reviewHash(
          batch,
          approval.decisions as CustomerImportDecision[],
          approval.reviewNote,
        ) !== fingerprint
      )
        throw new DomainError(
          409,
          "Commit only the exact immutable owner-approved import.",
        );
      // Coordinates with customer writes AND the row locks taken by merge/review.
      // Ordinary reads remain available; no user/provider work occurs under this lock.
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`LOCK TABLE customers IN EXCLUSIVE MODE`);
      const rows = await capture(tx, batch, batch.rows as CustomerImportRow[]);
      if (previewHash(batch, rows) !== batch.previewFingerprint)
        throw new DomainError(
          409,
          "Customer matches or source identities changed after review. Refresh and explicitly approve the updated review.",
        );
      const decisions = validateCustomerDecisions(
        rows,
        approval.decisions as CustomerImportDecision[],
      );
      const result = {
        created: 0,
        linked: 0,
        skipped: 0,
        customerIds: [] as string[],
      };
      for (const decision of decisions) {
        if (decision.action === "skip") {
          result.skipped++;
          continue;
        }
        const row = rows.find((item) => item.line === decision.line)!;
        let customerId = decision.customerId!,
          siteId: string | null = null;
        if (decision.action === "create") {
          customerId = randomUUID();
          const { name, email, phone, notes } = row.data;
          await tx.insert(customersTable).values({
            id: customerId,
            name,
            email,
            phone,
            notes,
            createdAt: now(),
            updatedAt: now(),
          });
          if (row.data.address) {
            siteId = randomUUID();
            const { address, city, state, zip } = row.data;
            await tx.insert(customerSitesTable).values({
              id: siteId,
              customerId,
              label: "Imported location",
              address,
              city,
              state,
              zip,
              createdAt: now(),
              updatedAt: now(),
            });
          }
          result.created++;
        } else result.linked++;
        await tx.insert(records).values({
          id: randomUUID(),
          workspaceKey: batch.workspaceKey,
          sourceSystem: batch.sourceSystem,
          sourceId: row.data.sourceId,
          batchId: batch.id,
          approvalId: approval.id,
          sourceLine: row.line,
          customerId,
          siteId,
          action: decision.action,
          createdAt: now(),
        });
        result.customerIds.push(customerId);
      }
      const [saved] = await tx
        .update(batches)
        .set({
          status: "committed",
          result,
          committedAt: now(),
          updatedAt: now(),
          revision: batch.revision + 1,
        })
        .where(eq(batches.id, batch.id))
        .returning();
      await audit(tx, actor, batch, "committed", {
        approvalId,
        created: result.created,
        linked: result.linked,
        skipped: result.skipped,
      });
      return present(tx, saved);
    })
    .catch((error: unknown) => {
      const code =
        (error as { code?: string; cause?: { code?: string } })?.cause?.code ??
        (error as { code?: string })?.code;
      if (code === "55P03")
        throw new DomainError(
          409,
          "Customer records are being edited. This import was rolled back; retry the same approved batch after that edit finishes.",
        );
      throw error;
    });
}
export async function customerImportProvenance(customerId: string) {
  const resolved = await resolveCustomers(db, [customerId]);
  if (!resolved.found.has(customerId))
    throw new DomainError(404, "Customer not found.");
  const current = resolved.effective(customerId);
  const ancestry = await db.execute(sql<{
    id: string;
  }>`WITH RECURSIVE ancestry(id, path) AS (
    SELECT id, ARRAY[id] FROM customers WHERE id = ${current}
    UNION ALL SELECT c.id, a.path || c.id FROM customers c JOIN ancestry a ON c.merged_into_id = a.id
    WHERE NOT c.id = ANY(a.path) AND cardinality(a.path) < 30
  ) SELECT DISTINCT id FROM ancestry LIMIT 2001`);
  if (ancestry.rows.length > 2000)
    throw new DomainError(
      409,
      "This customer has extensive merge history. Review its archived source batches directly.",
    );
  const ids = ancestry.rows.map((row) => String(row.id));
  const history = await db
    .select({
      id: records.id,
      sourceSystem: records.sourceSystem,
      sourceId: records.sourceId,
      originalCustomerId: records.customerId,
      batchId: records.batchId,
      approvalId: records.approvalId,
      sourceLine: records.sourceLine,
      action: records.action,
      createdAt: records.createdAt,
      fileName: batches.fileName,
      sourceSha256: batches.sourceSha256,
      batchKey: batches.batchKey,
    })
    .from(records)
    .innerJoin(batches, eq(batches.id, records.batchId))
    .where(inArray(records.customerId, ids))
    .orderBy(desc(records.createdAt), records.id)
    .limit(201);
  return {
    customerId,
    effectiveCustomerId: current,
    records: history.slice(0, 200),
    hasMore: history.length > 200,
  };
}
