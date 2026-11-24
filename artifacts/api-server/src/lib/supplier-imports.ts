import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  db,
  auditEventsTable,
  suppliersTable,
  supplierImportBatchesTable as batches,
  supplierImportApprovalsTable as approvals,
  supplierImportRecordsTable as records,
} from "@workspace/db";
import { workspaceScopeKey } from "@workspace/db/workspace";
import {
  parseSupplierImportCsv,
  supplierPhoneKey,
  type SupplierContact,
  type SupplierContactData,
  type SupplierImportBatch,
  type SupplierImportData,
  type SupplierImportDecision,
  type SupplierImportRow,
} from "@workspace/domain";
import { assertRevision, DomainError } from "./operations-rules";
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
const dataHash = (data: SupplierImportData) => hash(data);
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
  rows: SupplierImportRow[],
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
  decisions: SupplierImportDecision[],
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
    entityType: "supplier_import",
    entityId: id,
    action: `supplier_import.${action}`,
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
type Supplier = typeof suppliersTable.$inferSelect;
const publicSupplier = ({ nameKey: _key, ...row }: Supplier): SupplierContact =>
  row;
const directoryLock = (tx: Tx) =>
  tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('supplier-contact-directory'))`,
  );
async function nameKeys(writer: Tx | typeof db, values: string[]) {
  const unique = [...new Set(values)];
  const result = await writer.execute<{ value: string; key: string }>(
    sql`SELECT value,lower(btrim(value)) AS key FROM unnest(ARRAY[${sql.join(
      unique.map((value) => sql`${value}`),
      sql`, `,
    )}]::text[]) AS value`,
  );
  return new Map(result.rows.map((row) => [row.value, row.key]));
}
async function capture(
  writer: Tx | typeof db,
  batch: Pick<Batch, "sourceSystem">,
  input: SupplierImportRow[],
) {
  const keys = await nameKeys(
    writer,
    input.map((row) => row.data.name),
  );
  const names = [...new Set(keys.values())],
    emails = [
      ...new Set(
        input.map((row) => row.data.email.toLowerCase()).filter(Boolean),
      ),
    ],
    phones = [
      ...new Set(
        input.map((row) => supplierPhoneKey(row.data.phone)).filter(Boolean),
      ),
    ];
  const candidates = await writer
    .select()
    .from(suppliersTable)
    .where(
      or(
        inArray(suppliersTable.nameKey, names),
        emails.length
          ? inArray(sql<string>`lower(btrim(${suppliersTable.email}))`, emails)
          : undefined,
        phones.length
          ? inArray(
              sql<string>`regexp_replace(${suppliersTable.phone},'[^0-9]','','g')`,
              phones,
            )
          : undefined,
      ),
    )
    .orderBy(asc(suppliersTable.id))
    .limit(5001);
  if (candidates.length > 5000)
    throw new DomainError(
      409,
      "Too many possible supplier matches. Narrow or correct the contact source before review.",
    );
  const imported = await writer
    .select()
    .from(records)
    .where(
      and(
        eq(records.sourceSystem, batch.sourceSystem),
        inArray(
          records.sourceId,
          input.map((row) => row.data.sourceId),
        ),
      ),
    );
  const legacy = await writer.execute<{ supplier: string; key: string }>(
    sql`SELECT DISTINCT supplier,lower(btrim(supplier)) AS key FROM (SELECT supplier FROM products UNION ALL SELECT supplier FROM supplier_product_aliases UNION ALL SELECT supplier FROM purchase_orders UNION ALL SELECT supplier FROM materials) labels WHERE lower(btrim(supplier)) IN (${sql.join(
      names.map((key) => sql`${key}`),
      sql`, `,
    )}) ORDER BY supplier LIMIT 1001`,
  );
  if (legacy.rows.length > 1000)
    throw new DomainError(
      409,
      "Too many historical supplier labels match. Review a smaller source before importing.",
    );
  return input.map((row) => ({
    ...row,
    nameDuplicates: input
      .filter(
        (other) =>
          other.line !== row.line &&
          keys.get(other.data.name) === keys.get(row.data.name),
      )
      .map((other) => other.line),
    candidates: candidates.flatMap((candidate) => {
      const reasons: ("name" | "email" | "phone")[] = [];
      if (candidate.nameKey === keys.get(row.data.name)) reasons.push("name");
      if (
        row.data.email &&
        candidate.email.toLowerCase() === row.data.email.toLowerCase()
      )
        reasons.push("email");
      if (
        supplierPhoneKey(row.data.phone) &&
        supplierPhoneKey(candidate.phone) === supplierPhoneKey(row.data.phone)
      )
        reasons.push("phone");
      return reasons.length ? [{ ...publicSupplier(candidate), reasons }] : [];
    }),
    legacyNames: legacy.rows
      .filter((label) => label.key === keys.get(row.data.name))
      .map((label) => label.supplier),
    imported: (() => {
      const found = imported.find(
        (record) => record.sourceId === row.data.sourceId,
      );
      return found
        ? { supplierId: found.supplierId, batchId: found.batchId }
        : null;
    })(),
  }));
}
async function currentRows(tx: Tx, batch: Batch) {
  await directoryLock(tx);
  const rows = await capture(tx, batch, parsedSource(batch).rows);
  if (previewHash(batch, rows) !== batch.previewFingerprint)
    throw new DomainError(
      409,
      "Supplier matches or source identities changed. Refresh the preview and explicitly review it again.",
    );
  return rows;
}
function parsedSource(batch: Batch) {
  if (sourceHash(batch.sourceCsv) !== batch.sourceSha256)
    throw new DomainError(
      409,
      "The retained source checksum no longer matches. Keep the original supplier contact and request an operator review.",
    );
  return parseSupplierImportCsv(batch.sourceCsv, batch.delimiter as "," | "\t");
}
async function present(
  writer: Tx | typeof db,
  batch: Batch,
): Promise<SupplierImportBatch> {
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
    rows: batch.rows as SupplierImportRow[],
    status: batch.status,
    revision: batch.revision,
    previewFingerprint: batch.previewFingerprint,
    reviewFingerprint: batch.reviewFingerprint,
    decisions: batch.decisions as SupplierImportDecision[],
    reviewNote: batch.reviewNote,
    approval: approval
      ? {
          id: approval.id,
          fingerprint: approval.fingerprint,
          approvedBy: approval.approvedBy,
          approvedAt: approval.approvedAt,
        }
      : null,
    result: batch.result as SupplierImportBatch["result"],
  };
}
export const listSupplierImports = () =>
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
export const readSupplierImport = async (id: string) =>
  present(db, await getBatch(db, id));
export async function previewSupplierImport(
  input: {
    sourceSystem: string;
    batchKey: string;
    fileName: string;
    csv: string;
    delimiter: "," | "\t";
  },
  actor: string,
) {
  let parsed: ReturnType<typeof parseSupplierImportCsv>;
  try {
    parsed = parseSupplierImportCsv(input.csv, input.delimiter);
  } catch (error) {
    throw new DomainError(
      400,
      error instanceof Error
        ? error.message
        : "Correct the supplier contact CSV.",
    );
  }
  const sha = sourceHash(input.csv);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('supplier-contact-directory'))`,
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
export async function refreshSupplierImport(
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
        "Committed supplier contact imports cannot be changed.",
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
async function decisionsFor(
  tx: Tx,
  rows: SupplierImportRow[],
  decisions: SupplierImportDecision[],
) {
  if (
    rows.length !== decisions.length ||
    new Set(decisions.map((choice) => choice.line)).size !== rows.length ||
    decisions.some((choice) => !rows.some((row) => row.line === choice.line))
  )
    throw new DomainError(400, "Review every source row exactly once.");
  const ids = decisions.flatMap((choice) =>
    choice.action === "link" && choice.supplierId ? [choice.supplierId] : [],
  );
  const selected = ids.length
    ? await tx
        .select()
        .from(suppliersTable)
        .where(inArray(suppliersTable.id, ids))
        .orderBy(asc(suppliersTable.id))
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
        `Source line ${row.line} is invalid, duplicated or already bound. Correct the file or explicitly skip it; retained source identities cannot be rebound.`,
      );
    const sameName = row.candidates.filter((candidate) =>
      candidate.reasons.includes("name"),
    );
    if (choice.action === "create") {
      if (
        sameName.length ||
        row.nameDuplicates.some((line) =>
          decisions.some(
            (other) => other.line === line && other.action === "create",
          ),
        )
      )
        throw new DomainError(
          409,
          `Source line ${row.line} would duplicate a canonical supplier name. Explicitly link the existing active supplier or skip the row; reactivate an inactive supplier first.`,
        );
      if (
        (row.candidates.length ||
          row.legacyNames.length ||
          row.nameDuplicates.length) &&
        choice.note.trim().length < 5
      )
        throw new DomainError(
          400,
          `Explain the separate new supplier identity for source line ${row.line}; old labels and product mappings will remain unchanged.`,
        );
      return { line: row.line, action: "create" as const, note: choice.note };
    }
    const target = selected.find(
      (supplier) => supplier.id === choice.supplierId,
    );
    if (
      !target ||
      !target.active ||
      target.revision !== choice.supplierRevision ||
      choice.note.trim().length < 5
    )
      throw new DomainError(
        409,
        `Choose an active supplier at its current revision and explain the explicit link for line ${row.line}.`,
      );
    if (
      sameName.length &&
      !sameName.some((candidate) => candidate.id === target.id)
    )
      throw new DomainError(
        409,
        `The canonical source name on line ${row.line} belongs to another supplier. Review that exact identity instead of linking it elsewhere.`,
      );
    const snapshot = publicSupplier(target);
    if (
      choice.supplierSnapshot &&
      hash(choice.supplierSnapshot) !== hash(snapshot)
    )
      throw new DomainError(
        409,
        "The approved supplier contact changed. Refresh and review the current supplier before committing.",
      );
    return {
      line: row.line,
      action: "link" as const,
      supplierId: target.id,
      supplierRevision: target.revision,
      supplierSnapshot: snapshot,
      note: choice.note,
    };
  });
}
export async function reviewSupplierImport(
  id: string,
  expected: number,
  fingerprint: string,
  decisions: SupplierImportDecision[],
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
    const rows = await currentRows(tx, batch);
    const reviewed = await decisionsFor(tx, rows, decisions);
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
export async function approveSupplierImport(
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
        batch.decisions as SupplierImportDecision[],
        batch.reviewNote,
      ) !== fingerprint
    )
      throw new DomainError(
        409,
        "Approve only the exact saved supplier contact review.",
      );
    const current = await currentRows(tx, batch);
    await decisionsFor(
      tx,
      current,
      batch.decisions as SupplierImportDecision[],
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
export async function commitSupplierImport(
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
          "This supplier contact batch was committed under another approval.",
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
        approval.decisions as SupplierImportDecision[],
        approval.reviewNote,
      ) !== fingerprint
    )
      throw new DomainError(
        409,
        "Commit only the immutable owner-approved supplier contact review.",
      );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('supplier-contact-directory'))`,
    );
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`LOCK TABLE suppliers IN SHARE ROW EXCLUSIVE MODE`);
    const rows = await capture(tx, batch, parsedSource(batch).rows);
    if (previewHash(batch, rows) !== batch.previewFingerprint)
      throw new DomainError(
        409,
        "Archived source identities changed after review. Refresh and explicitly approve the current preview.",
      );
    const choices = await decisionsFor(
        tx,
        rows,
        approval.decisions as SupplierImportDecision[],
      ),
      result = {
        created: 0,
        linked: 0,
        skipped: 0,
        supplierIds: [] as string[],
      };
    for (const choice of choices) {
      if (choice.action === "skip") {
        result.skipped++;
        continue;
      }
      const row = rows.find((item) => item.line === choice.line)!;
      let supplier: SupplierContact;
      if (choice.action === "create") {
        const { sourceId: _sourceId, ...contact } = row.data;
        const key = (await nameKeys(tx, [contact.name])).get(contact.name)!;
        const [created] = await tx
          .insert(suppliersTable)
          .values({
            id: randomUUID(),
            ...contact,
            nameKey: key,
            createdAt: now(),
            updatedAt: now(),
          })
          .returning();
        supplier = publicSupplier(created);
        result.created++;
      } else {
        supplier = choice.supplierSnapshot!;
        result.linked++;
      }
      await tx.insert(records).values({
        id: randomUUID(),
        batchId: id,
        approvalId,
        sourceSystem: batch.sourceSystem,
        sourceId: row.data.sourceId,
        sourceLine: row.line,
        supplierId: supplier.id,
        action: choice.action,
        sourceData: { ...row.data },
        supplierSnapshot: { ...supplier },
        sourceRowSha256: dataHash(row.data),
        createdAt: now(),
      });
      result.supplierIds.push(supplier.id);
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
      created: result.created,
      linked: result.linked,
      skipped: result.skipped,
      supplierIds: result.supplierIds,
    });
    return present(tx, saved);
  });
}
export async function supplierSourceCsv(id: string) {
  const batch = await getBatch(db, id);
  parsedSource(batch);
  return batch.sourceCsv;
}

export async function listSuppliers(input: {
  q?: string;
  active: "active" | "inactive" | "all";
  page: number;
}) {
  const term = input.q ? `%${input.q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = await db
    .select()
    .from(suppliersTable)
    .where(
      and(
        input.active === "all"
          ? undefined
          : eq(suppliersTable.active, input.active === "active"),
        term
          ? or(
              ilike(suppliersTable.name, term),
              ilike(suppliersTable.contactName, term),
              ilike(suppliersTable.email, term),
              ilike(suppliersTable.phone, term),
              ilike(suppliersTable.address, term),
            )
          : undefined,
      ),
    )
    .orderBy(asc(suppliersTable.nameKey), asc(suppliersTable.id))
    .limit(51)
    .offset(input.page * 50);
  return {
    suppliers: rows.slice(0, 50).map(publicSupplier),
    page: input.page,
    hasMore: rows.length > 50,
  };
}
export async function readSupplier(id: string) {
  const [supplier] = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.id, id));
  if (!supplier)
    throw new DomainError(404, "Supplier not found in this company.");
  const history = await db
    .select({
      record: records,
      batch: {
        id: batches.id,
        fileName: batches.fileName,
        sourceSha256: batches.sourceSha256,
        committedAt: batches.committedAt,
      },
      approval: {
        id: approvals.id,
        fingerprint: approvals.fingerprint,
        approvedBy: approvals.approvedBy,
        approvedAt: approvals.approvedAt,
        reviewNote: approvals.reviewNote,
      },
    })
    .from(records)
    .innerJoin(
      batches,
      and(eq(batches.id, records.batchId), eq(batches.status, "committed")),
    )
    .innerJoin(
      approvals,
      and(
        eq(approvals.id, records.approvalId),
        eq(approvals.batchId, records.batchId),
      ),
    )
    .where(eq(records.supplierId, id))
    .orderBy(desc(records.createdAt), desc(records.id))
    .limit(201);
  if (history.length > 200)
    throw new DomainError(
      409,
      "This supplier has extensive import history. An operator must review its retained source batches before continuing.",
    );
  return { supplier: publicSupplier(supplier), provenance: history };
}
export async function createSupplier(
  contact: SupplierContactData,
  actor: string,
) {
  return db.transaction(async (tx) => {
    await directoryLock(tx);
    const key = (await nameKeys(tx, [contact.name])).get(contact.name)!;
    const [prior] = await tx
      .select({ id: suppliersTable.id })
      .from(suppliersTable)
      .where(eq(suppliersTable.nameKey, key));
    if (prior)
      throw new DomainError(
        409,
        "This canonical supplier name already exists. Review the existing supplier or reactivate it; duplicate names can make purchasing ambiguous.",
      );
    const [created] = await tx
      .insert(suppliersTable)
      .values({
        id: randomUUID(),
        ...contact,
        nameKey: key,
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    await audit(tx, actor, created.id, "supplier_created_manually", {
      revision: created.revision,
    });
    return publicSupplier(created);
  });
}
export async function editSupplier(
  id: string,
  expected: number,
  contact: Partial<Omit<SupplierContactData, "name">>,
  actor: string,
) {
  return db.transaction(async (tx) => {
    await directoryLock(tx);
    const [current] = await tx
      .select()
      .from(suppliersTable)
      .where(eq(suppliersTable.id, id))
      .for("update");
    if (!current)
      throw new DomainError(404, "Supplier not found in this company.");
    assertRevision(current.revision, expected);
    const [saved] = await tx
      .update(suppliersTable)
      .set({ ...contact, revision: current.revision + 1, updatedAt: now() })
      .where(eq(suppliersTable.id, id))
      .returning();
    await audit(tx, actor, id, "supplier_contacts_updated", {
      previousRevision: current.revision,
      revision: saved.revision,
      fields: Object.keys(contact).sort(),
    });
    return publicSupplier(saved);
  });
}
export async function activateSupplier(
  id: string,
  expected: number,
  active: boolean,
  reason: string,
  actor: string,
) {
  return db.transaction(async (tx) => {
    await directoryLock(tx);
    const [current] = await tx
      .select()
      .from(suppliersTable)
      .where(eq(suppliersTable.id, id))
      .for("update");
    if (!current)
      throw new DomainError(404, "Supplier not found in this company.");
    assertRevision(current.revision, expected);
    if (current.active === active) return publicSupplier(current);
    const [saved] = await tx
      .update(suppliersTable)
      .set({ active, revision: current.revision + 1, updatedAt: now() })
      .where(eq(suppliersTable.id, id))
      .returning();
    await audit(
      tx,
      actor,
      id,
      active ? "supplier_reactivated" : "supplier_deactivated",
      {
        previousRevision: current.revision,
        revision: saved.revision,
        reason,
        existingPurchasingLabelsChanged: false,
      },
    );
    return publicSupplier(saved);
  });
}
