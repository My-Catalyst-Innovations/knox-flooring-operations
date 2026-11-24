import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  db,
  auditEventsTable,
  legacyArchiveBatchesTable as batches,
  legacyArchiveApprovalsTable as approvals,
  legacyArchiveRecordsTable as records,
  legacyArchiveDocumentsTable as documents,
} from "@workspace/db";
import { workspaceScopeKey } from "@workspace/db/workspace";
import {
  parseLegacyArchiveCsv,
  legacyArchiveIdentity,
  type LegacyArchiveBatch,
  type LegacyArchiveData,
  type LegacyArchiveDecision,
  type LegacyArchiveRow,
  type LegacyArchiveType,
} from "@workspace/domain";
import { assertRevision, DomainError } from "./operations-rules";
import {
  assertOwnedFile,
  getFile,
  getFileMetadata,
  storedFilePath,
} from "./file-store";
import {
  legacyOriginalMaxBytes,
  validateLegacyOriginal,
} from "./legacy-history-files";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Batch = typeof batches.$inferSelect;
const now = () => new Date().toISOString();
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const sourceHash = (csv: string) =>
  createHash("sha256").update(Buffer.from(csv, "utf8")).digest("hex");
const dataHash = (data: LegacyArchiveData) => hash(data);
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
  rows: LegacyArchiveRow[],
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
  decisions: LegacyArchiveDecision[],
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
    entityType: "legacy_archive",
    entityId: id,
    action: `legacy_archive.${action}`,
    details,
    createdAt: now(),
  });
}
async function getBatch(writer: Tx | typeof db, id: string, lock = false) {
  const query = writer.select().from(batches).where(eq(batches.id, id));
  const [batch] = await (lock ? query.for("update") : query);
  if (!batch)
    throw new DomainError(404, "History import not found in this company.");
  return batch;
}
async function capture(
  writer: Tx | typeof db,
  batch: Pick<Batch, "sourceSystem">,
  rows: LegacyArchiveRow[],
) {
  const found = await writer
    .select({
      id: records.id,
      sourceId: records.sourceId,
      recordType: records.recordType,
      recordSha256: records.recordSha256,
    })
    .from(records)
    .where(
      and(
        eq(records.sourceSystem, batch.sourceSystem),
        inArray(records.sourceId, [
          ...new Set(rows.map((row) => row.data.sourceId)),
        ]),
      ),
    );
  const matches = new Map(
    found.map((record) => [legacyArchiveIdentity(record), record]),
  );
  return rows.map((row) => {
    const found = matches.get(legacyArchiveIdentity(row.data));
    return {
      ...row,
      existing: found
        ? { id: found.id, recordSha256: found.recordSha256 }
        : null,
    };
  });
}
function parsedSource(batch: Batch) {
  if (sourceHash(batch.sourceCsv) !== batch.sourceSha256)
    throw new DomainError(
      409,
      "The retained source checksum no longer matches. Keep the original history and request an operator review.",
    );
  return parseLegacyArchiveCsv(batch.sourceCsv, batch.delimiter as "," | "\t");
}
async function present(
  writer: Tx | typeof db,
  batch: Batch,
): Promise<LegacyArchiveBatch> {
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
    rows: batch.rows as LegacyArchiveRow[],
    status: batch.status,
    revision: batch.revision,
    previewFingerprint: batch.previewFingerprint,
    reviewFingerprint: batch.reviewFingerprint,
    decisions: batch.decisions as LegacyArchiveDecision[],
    reviewNote: batch.reviewNote,
    approval: approval
      ? {
          id: approval.id,
          fingerprint: approval.fingerprint,
          approvedBy: approval.approvedBy,
          approvedAt: approval.approvedAt,
        }
      : null,
    result: batch.result as LegacyArchiveBatch["result"],
  };
}
export const listLegacyImports = () =>
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
export const readLegacyImport = async (id: string) =>
  present(db, await getBatch(db, id));
export async function previewLegacyImport(
  input: {
    sourceSystem: string;
    batchKey: string;
    fileName: string;
    csv: string;
    delimiter: "," | "\t";
  },
  actor: string,
) {
  let parsed: ReturnType<typeof parseLegacyArchiveCsv>;
  try {
    parsed = parseLegacyArchiveCsv(input.csv, input.delimiter);
  } catch (error) {
    throw new DomainError(
      400,
      error instanceof Error ? error.message : "Correct the history CSV.",
    );
  }
  const sha = sourceHash(input.csv);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('legacy-history-import'))`,
    );
    const [prior] = await tx
      .select()
      .from(batches)
      .where(
        and(
          eq(batches.sourceSystem, input.sourceSystem),
          eq(batches.batchKey, input.batchKey),
        ),
      );
    if (prior) {
      if (
        prior.sourceSha256 !== sha ||
        prior.fileName !== input.fileName ||
        prior.delimiter !== input.delimiter
      )
        throw new DomainError(
          409,
          "This source/batch identity already describes another file. Preserve it and use a new batch ID.",
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
      sourceSystem: batch.sourceSystem,
      batchKey: batch.batchKey,
      sourceSha256: sha,
      rows: rows.length,
    });
    return present(tx, batch);
  });
}
export async function refreshLegacyImport(
  id: string,
  expected: number,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const batch = await getBatch(tx, id, true);
    assertRevision(batch.revision, expected);
    if (batch.status === "committed")
      throw new DomainError(
        409,
        "Committed historical imports cannot be changed.",
      );
    const rows = await capture(tx, batch, parsedSource(batch).rows);
    const [saved] = await tx
      .update(batches)
      .set({
        rows,
        status: "preview",
        previewFingerprint: previewHash(batch, rows),
        reviewFingerprint: null,
        reviewNote: null,
        decisions: [],
        currentApprovalId: null,
        revision: batch.revision + 1,
        updatedAt: now(),
      })
      .where(eq(batches.id, id))
      .returning();
    await audit(tx, actor, id, "review_refreshed", {
      previousApprovalId: batch.currentApprovalId,
    });
    return present(tx, saved);
  });
}
function decisionsFor(
  rows: LegacyArchiveRow[],
  decisions: LegacyArchiveDecision[],
) {
  if (
    rows.length !== decisions.length ||
    new Set(decisions.map((item) => item.line)).size !== rows.length ||
    decisions.some((item) => !rows.some((row) => row.line === item.line))
  )
    throw new DomainError(400, "Review every source row exactly once.");
  return rows.map((row) => {
    const decision = decisions.find((item) => item.line === row.line)!;
    if (decision.action === "skip") {
      if (decision.note.trim().length < 5)
        throw new DomainError(
          400,
          `Explain why source line ${row.line} is skipped.`,
        );
      return { line: row.line, action: "skip" as const, note: decision.note };
    }
    if (row.errors.length || row.fileDuplicates.length || row.existing)
      throw new DomainError(
        409,
        `Source line ${row.line} has errors, duplicate identity or existing archived history. Correct the source or explicitly skip it; history is never overwritten or linked.`,
      );
    return { line: row.line, action: "archive" as const, note: decision.note };
  });
}
export async function reviewLegacyImport(
  id: string,
  expected: number,
  fingerprint: string,
  decisions: LegacyArchiveDecision[],
  note: string,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const batch = await getBatch(tx, id, true);
    assertRevision(batch.revision, expected);
    if (["approved", "committed"].includes(batch.status))
      throw new DomainError(
        409,
        "Refresh the review explicitly before changing an accepted decision.",
      );
    if (batch.previewFingerprint !== fingerprint)
      throw new DomainError(409, "Refresh and review the current preview.");
    const reviewed = decisionsFor(batch.rows as LegacyArchiveRow[], decisions);
    const [saved] = await tx
      .update(batches)
      .set({
        status: "reviewed",
        decisions: reviewed,
        reviewNote: note,
        reviewFingerprint: reviewHash(batch, reviewed, note),
        revision: batch.revision + 1,
        updatedAt: now(),
      })
      .where(eq(batches.id, id))
      .returning();
    await audit(tx, actor, id, "reviewed");
    return present(tx, saved);
  });
}
export async function approveLegacyImport(
  id: string,
  expected: number,
  fingerprint: string,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const batch = await getBatch(tx, id, true);
    if (batch.status === "approved" && batch.reviewFingerprint === fingerprint)
      return present(tx, batch);
    assertRevision(batch.revision, expected);
    if (
      batch.status !== "reviewed" ||
      !batch.reviewNote ||
      batch.reviewFingerprint !== fingerprint ||
      reviewHash(
        batch,
        batch.decisions as LegacyArchiveDecision[],
        batch.reviewNote,
      ) !== fingerprint
    )
      throw new DomainError(
        409,
        "Approve only the exact saved historical review.",
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
export async function commitLegacyImport(
  id: string,
  expected: number,
  approvalId: string,
  fingerprint: string,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const batch = await getBatch(tx, id, true);
    if (batch.status === "committed") {
      if (
        batch.currentApprovalId !== approvalId ||
        batch.reviewFingerprint !== fingerprint
      )
        throw new DomainError(
          409,
          "This history batch was committed under another approval.",
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
        approval.decisions as LegacyArchiveDecision[],
        approval.reviewNote,
      ) !== fingerprint
    )
      throw new DomainError(
        409,
        "Commit only the immutable owner-approved historical review.",
      );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('legacy-history-import'))`,
    );
    const rows = await capture(tx, batch, parsedSource(batch).rows);
    if (previewHash(batch, rows) !== batch.previewFingerprint)
      throw new DomainError(
        409,
        "Archived source identities changed after review. Refresh and explicitly approve the current preview.",
      );
    const choices = decisionsFor(
        rows,
        approval.decisions as LegacyArchiveDecision[],
      ),
      result = { archived: 0, skipped: 0, recordIds: [] as string[] };
    for (const choice of choices) {
      if (choice.action === "skip") {
        result.skipped++;
        continue;
      }
      const row = rows.find((item) => item.line === choice.line)!,
        recordId = randomUUID();
      await tx.insert(records).values({
        id: recordId,
        batchId: id,
        approvalId,
        sourceSystem: batch.sourceSystem,
        sourceLine: row.line,
        ...row.data,
        recordSha256: dataHash(row.data),
        createdAt: now(),
      });
      result.archived++;
      result.recordIds.push(recordId);
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
      archived: result.archived,
      skipped: result.skipped,
      activeRecordsCreated: 0,
    });
    return present(tx, saved);
  });
}
export async function legacySourceCsv(id: string) {
  const batch = await getBatch(db, id);
  parsedSource(batch);
  return batch.sourceCsv;
}
export async function listLegacyRecords(input: {
  q?: string;
  recordType?: LegacyArchiveType;
  sourceSystem?: string;
  page: number;
}) {
  const term = input.q ? `%${input.q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = await db
    .select({ record: records })
    .from(records)
    .innerJoin(
      batches,
      and(eq(batches.id, records.batchId), eq(batches.status, "committed")),
    )
    .where(
      and(
        input.recordType ? eq(records.recordType, input.recordType) : undefined,
        input.sourceSystem
          ? eq(records.sourceSystem, input.sourceSystem)
          : undefined,
        term
          ? or(
              ilike(records.sourceId, term),
              ilike(records.title, term),
              ilike(records.reference, term),
              ilike(records.partyName, term),
            )
          : undefined,
      ),
    )
    .orderBy(desc(records.createdAt), desc(records.id))
    .limit(51)
    .offset(input.page * 50);
  return {
    records: rows.slice(0, 50).map((row) => row.record),
    hasMore: rows.length > 50,
    page: input.page,
  };
}
async function getRecord(writer: Tx | typeof db, id: string, lock = false) {
  const query = writer
    .select({
      record: records,
      batch: {
        id: batches.id,
        sourceSystem: batches.sourceSystem,
        batchKey: batches.batchKey,
        fileName: batches.fileName,
        sourceSha256: batches.sourceSha256,
        committedAt: batches.committedAt,
      },
    })
    .from(records)
    .innerJoin(
      batches,
      and(eq(batches.id, records.batchId), eq(batches.status, "committed")),
    )
    .where(eq(records.id, id));
  const [found] = await (lock
    ? query.for("key share", { of: records })
    : query);
  if (!found)
    throw new DomainError(404, "Archived record not found in this company.");
  return found;
}
const publicDocument = (doc: typeof documents.$inferSelect) => ({
  id: doc.id,
  recordId: doc.recordId,
  name: doc.name,
  size: doc.size,
  sha256: doc.sha256,
  createdAt: doc.createdAt,
  downloadUrl: `/api/legacy-history/documents/${doc.id}/download`,
});
export async function readLegacyRecord(id: string) {
  const found = await getRecord(db, id);
  const [approval] = await db
    .select({
      id: approvals.id,
      fingerprint: approvals.fingerprint,
      approvedBy: approvals.approvedBy,
      approvedAt: approvals.approvedAt,
      reviewNote: approvals.reviewNote,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.id, found.record.approvalId),
        eq(approvals.batchId, found.record.batchId),
      ),
    );
  if (!approval)
    throw new DomainError(
      409,
      "This archived source needs an approval-history review.",
    );
  const docs = await db
    .select()
    .from(documents)
    .where(eq(documents.recordId, id))
    .orderBy(asc(documents.createdAt), asc(documents.id));
  return { ...found, approval, documents: docs.map(publicDocument) };
}
async function originalBytes(path: string, recordId: string, uploader: string) {
  await assertOwnedFile(path, ["legacy-document"], uploader, recordId);
  const metadata = await getFileMetadata(path);
  if (!metadata) throw new DomainError(404, "Original document not found.");
  const file = await getFile(path);
  if (!file) throw new DomainError(404, "Original document not found.");
  const parts: Buffer[] = [];
  let length = 0;
  for await (const chunk of file.body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > legacyOriginalMaxBytes) {
      file.body.destroy();
      throw new DomainError(413, "The original document exceeds 15 MiB.");
    }
    parts.push(bytes);
  }
  const bytes = Buffer.concat(parts);
  validateLegacyOriginal(metadata.name, bytes);
  return {
    bytes,
    name: metadata.name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
export async function attachLegacyDocument(
  recordId: string,
  objectPath: string,
  requestKey: string,
  actor: string,
) {
  await getRecord(db, recordId);
  const path = storedFilePath(objectPath),
    source = await originalBytes(path, recordId, actor);
  return db.transaction(async (tx) => {
    await getRecord(tx, recordId, true);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${"legacy-document:" + recordId}))`,
    );
    const [prior] = await tx
      .select()
      .from(documents)
      .where(eq(documents.requestKey, requestKey));
    if (prior) {
      if (
        prior.recordId !== recordId ||
        prior.objectPath !== path ||
        prior.actorUserId !== actor ||
        prior.sha256 !== source.sha256
      )
        throw new DomainError(
          409,
          "This original-file request key belongs to another claim.",
        );
      return { status: 200, document: publicDocument(prior) };
    }
    const [same] = await tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.recordId, recordId),
          eq(documents.sha256, source.sha256),
        ),
      );
    if (same)
      throw new DomainError(
        409,
        "This original is already attached. Open its saved claim instead of creating another.",
      );
    const [doc] = await tx
      .insert(documents)
      .values({
        id: randomUUID(),
        recordId,
        objectPath: path,
        name: source.name,
        size: source.bytes.length,
        sha256: source.sha256,
        actorUserId: actor,
        requestKey,
        createdAt: now(),
      })
      .returning();
    await audit(tx, actor, recordId, "original_attached", {
      documentId: doc.id,
      sha256: doc.sha256,
      size: doc.size,
      name: doc.name,
    });
    return { status: 201, document: publicDocument(doc) };
  });
}
export async function downloadLegacyDocument(id: string) {
  const [doc] = await db.select().from(documents).where(eq(documents.id, id));
  if (!doc)
    throw new DomainError(404, "Original document not found in this company.");
  await getRecord(db, doc.recordId);
  const source = await originalBytes(
    doc.objectPath,
    doc.recordId,
    doc.actorUserId,
  );
  if (
    source.sha256 !== doc.sha256 ||
    source.bytes.length !== doc.size ||
    source.name !== doc.name
  )
    throw new DomainError(
      409,
      "The original document no longer matches its immutable claim. No replacement content was downloaded.",
    );
  return { bytes: source.bytes, name: doc.name };
}
