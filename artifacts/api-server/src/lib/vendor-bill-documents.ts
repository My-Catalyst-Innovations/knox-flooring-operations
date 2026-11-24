import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  auditEventsTable,
  db,
  quickbooksSyncJobsTable as bills,
  vendorBillDocumentsTable as documents,
} from "@workspace/db";
import {
  assertOwnedFile,
  getFile,
  getFileMetadata,
  storedFilePath,
} from "./file-store";
import {
  assertCoverageOwner,
  type CoverageTransaction,
} from "./bill-coverage-owner";
import { DomainError } from "./operations-rules";
import {
  validateVendorBillOriginal,
  vendorBillOriginalMaxBytes,
} from "./vendor-bill-original";
import { vendorBillEntity } from "./vendor-bill";
export async function billForOriginal(
  reader: typeof db | CoverageTransaction,
  id: string,
  lock = false,
) {
  const query = reader
    .select({
      id: bills.id,
      entityType: bills.entityType,
      payload: bills.payload,
    })
    .from(bills)
    .where(eq(bills.id, id));
  const [bill] = await (lock ? query.for("share") : query);
  if (
    !bill ||
    bill.entityType !== vendorBillEntity ||
    !["review", "sandbox", "production"].includes(String(bill.payload.mode))
  )
    throw new DomainError(
      404,
      "A retained supplier bill was not found in this company.",
    );
  return bill;
}
const present = (document: typeof documents.$inferSelect) => ({
  id: document.id,
  billId: document.billId,
  fileName: document.name,
  size: document.size,
  sha256: document.sha256,
  downloadUrl: `/api/quickbooks/vendor-bills/documents/${document.id}/download`,
  createdAt: document.createdAt,
});
async function originalBytes(path: string, billId: string, actor: string) {
  await assertOwnedFile(path, ["vendor-bill-document"], actor, billId);
  const metadata = await getFileMetadata(path),
    file = await getFile(path);
  if (!metadata || !file)
    throw new DomainError(404, "Original supplier bill file not found.");
  const parts: Buffer[] = [];
  let length = 0;
  for await (const chunk of file.body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > vendorBillOriginalMaxBytes) {
      file.body.destroy();
      throw new DomainError(413, "The original exceeds 10 MiB.");
    }
    parts.push(bytes);
  }
  const bytes = Buffer.concat(parts);
  validateVendorBillOriginal(metadata.name, bytes);
  return {
    bytes,
    name: metadata.name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
export async function listVendorBillDocuments(billId: string) {
  await billForOriginal(db, billId);
  return (
    await db
      .select()
      .from(documents)
      .where(eq(documents.billId, billId))
      .orderBy(asc(documents.createdAt), asc(documents.id))
  ).map(present);
}
export async function attachVendorBillDocument(
  billId: string,
  objectPath: string,
  requestKey: string,
  actor: string,
) {
  await billForOriginal(db, billId);
  const path = storedFilePath(objectPath),
    source = await originalBytes(path, billId, actor);
  return db.transaction(async (tx) => {
    await billForOriginal(tx, billId, true);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${"vendor-bill-document:" + billId},0))`,
    );
    await assertCoverageOwner(tx, actor);
    const [prior] = await tx
      .select()
      .from(documents)
      .where(eq(documents.requestKey, requestKey));
    if (prior) {
      if (
        prior.billId !== billId ||
        prior.objectPath !== path ||
        prior.actorUserId !== actor ||
        prior.sha256 !== source.sha256
      )
        throw new DomainError(
          409,
          "This original-file request key belongs to a different immutable claim.",
        );
      return { status: 200, document: present(prior) };
    }
    const [same] = await tx
      .select()
      .from(documents)
      .where(
        and(eq(documents.billId, billId), eq(documents.sha256, source.sha256)),
      );
    if (same)
      throw new DomainError(
        409,
        "This original is already retained. Open its saved claim rather than attaching another copy.",
      );
    const at = new Date().toISOString(),
      [document] = await tx
        .insert(documents)
        .values({
          id: randomUUID(),
          billId,
          objectPath: path,
          name: source.name,
          size: source.bytes.length,
          sha256: source.sha256,
          requestKey,
          actorUserId: actor,
          createdAt: at,
        })
        .returning();
    await tx
      .insert(auditEventsTable)
      .values({
        id: randomUUID(),
        action: "vendor_bill.original_retained",
        actorUserId: actor,
        entityType: "vendor_bill",
        entityId: billId,
        details: {
          documentId: document.id,
          sha256: document.sha256,
          size: document.size,
        },
        createdAt: at,
      });
    return { status: 201, document: present(document) };
  });
}
export async function downloadVendorBillDocument(id: string) {
  const [document] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, id));
  if (!document)
    throw new DomainError(
      404,
      "Original supplier bill not found in this company.",
    );
  await billForOriginal(db, document.billId);
  const source = await originalBytes(
    document.objectPath,
    document.billId,
    document.actorUserId,
  );
  if (
    source.sha256 !== document.sha256 ||
    source.bytes.length !== document.size ||
    source.name !== document.name
  )
    throw new DomainError(
      409,
      "The original no longer matches its immutable file claim; no replacement content was downloaded.",
    );
  return source;
}
