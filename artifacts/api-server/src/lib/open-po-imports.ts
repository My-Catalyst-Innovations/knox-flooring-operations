import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  db,
  auditEventsTable,
  usersTable,
  suppliersTable,
  warehousesTable,
  productsTable,
  jobsTable,
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  purchaseReceiptLinesTable,
  purchaseReceiptsTable,
  openPoImportBatchesTable as batches,
  openPoImportApprovalsTable as approvals,
  openPoImportRecordsTable as records,
} from "@workspace/db";
import { workspaceScopeKey } from "@workspace/db/workspace";
import {
  openPoDecimal,
  openPoMicros,
  openPoSnapshotTimes,
  parseOpenPoCsv,
  validateOpenPoChoices,
  type OpenPoDecision,
  type OpenPoExistingOrder,
  type OpenPoImportBatch,
  type OpenPoJob,
  type OpenPoPreviewOrder,
  type OpenPoProduct,
  type OpenPoReviewedOrder,
  type OpenPoSourceOrder,
  type OpenPoSupplier,
  type OpenPoWarehouse,
} from "@workspace/domain";
import { assertRevision, DomainError } from "./operations-rules";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Tx | typeof db;
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
const poNumber = (number: number) => `PO-${String(number).padStart(6, "0")}`;
const supplierFields = {
  id: suppliersTable.id,
  revision: suppliersTable.revision,
  name: suppliersTable.name,
  active: suppliersTable.active,
};
const warehouseFields = {
  id: warehousesTable.id,
  name: warehousesTable.name,
  updatedAt: warehousesTable.updatedAt,
};
const productFields = {
  id: productsTable.id,
  revision: productsTable.revision,
  name: productsTable.name,
  sku: productsTable.sku,
  unit: productsTable.unit,
  active: productsTable.active,
  inventoryType: productsTable.inventoryType,
  updatedAt: productsTable.updatedAt,
};
const jobFields = {
  id: jobsTable.id,
  revision: jobsTable.revision,
  jobNumber: jobsTable.jobNumber,
  customerName: jobsTable.customerName,
  status: jobsTable.status,
  updatedAt: jobsTable.updatedAt,
};
async function guarded<T>(actor: string, work: (tx: Tx) => Promise<T>) {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('open-po-import'))`,
      );
      const [owner] = await tx
        .select({
          role: usersTable.role,
          active: usersTable.active,
          lockedUntil: usersTable.lockedUntil,
        })
        .from(usersTable)
        .where(eq(usersTable.id, actor))
        .for("share");
      if (
        !owner?.active ||
        owner.role !== "owner" ||
        (owner.lockedUntil && Date.parse(owner.lockedUntil) > Date.now())
      )
        throw new DomainError(403, "An active owner must review this import.");
      return work(tx);
    });
  } catch (error) {
    const code =
      (error as { code?: string; cause?: { code?: string } })?.cause?.code ??
      (error as { code?: string })?.code;
    if (code === "55P03" || code === "40P01")
      throw new DomainError(
        409,
        "Operational records are being edited. This import was rolled back; retry the same approved batch after that edit finishes.",
      );
    throw error;
  }
}
async function lockOperationalRecords(tx: Tx) {
  // Normal receipt and order edits first lock their order. EXCLUSIVE also blocks
  // those row-locking reads, avoiding a misleading half-received snapshot.
  // These short local transactions perform no network/provider work.
  await tx.execute(
    sql`LOCK TABLE purchase_orders,purchase_order_lines,purchase_receipt_lines,suppliers,warehouses,products,jobs IN EXCLUSIVE MODE`,
  );
}
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
    entityType: "open_po_import",
    entityId: id,
    action: `open_po_import.${action}`,
    details,
    createdAt: now(),
  });
}
async function getBatch(reader: Reader, id: string, lock = false) {
  const query = reader.select().from(batches).where(eq(batches.id, id));
  const [batch] = await (lock ? query.for("update") : query);
  if (!batch)
    throw new DomainError(
      404,
      "Purchase-order import not found in this company.",
    );
  return batch;
}
function sourceOrders(batch: Batch) {
  if (sourceHash(batch.sourceCsv) !== batch.sourceSha256)
    throw new DomainError(
      409,
      "The retained source checksum changed. Preserve the original and request an operator review.",
    );
  return parseOpenPoCsv(batch.sourceCsv, batch.delimiter as "," | "\t");
}
async function capture(
  reader: Reader,
  sourceSystem: string,
  source: OpenPoSourceOrder[],
): Promise<OpenPoPreviewOrder[]> {
  const found = await reader
    .select({
      id: records.id,
      sourcePoId: records.sourcePoId,
      orderId: records.orderId,
    })
    .from(records)
    .where(
      and(
        eq(records.sourceSystem, sourceSystem),
        inArray(
          records.sourcePoId,
          source.map((item) => item.sourcePoId),
        ),
      ),
    );
  return source.map((order) => ({
    ...order,
    imported:
      found.find((record) => record.sourcePoId === order.sourcePoId) ?? null,
  }));
}
const previewHash = (
  batch: Pick<
    Batch,
    | "id"
    | "workspaceKey"
    | "sourceSystem"
    | "batchKey"
    | "fileName"
    | "sourceSha256"
    | "sourceSnapshotAt"
    | "cutoverAt"
  >,
  rows: OpenPoPreviewOrder[],
) =>
  hash([
    batch.id,
    batch.workspaceKey,
    batch.sourceSystem,
    batch.batchKey,
    batch.fileName,
    batch.sourceSha256,
    batch.sourceSnapshotAt,
    batch.cutoverAt,
    rows,
  ]);
const reviewHash = (
  batch: Batch,
  reviewed: OpenPoReviewedOrder[],
  note: string,
) => hash([batch.id, batch.previewFingerprint, reviewed, note]);
async function present(
  reader: Reader,
  batch: Batch,
): Promise<OpenPoImportBatch> {
  const [approval] = batch.currentApprovalId
    ? await reader
        .select({
          id: approvals.id,
          fingerprint: approvals.fingerprint,
          approvedBy: approvals.approvedBy,
          approvedAt: approvals.approvedAt,
        })
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
    sourceSnapshotAt: batch.sourceSnapshotAt,
    cutoverAt: batch.cutoverAt,
    rows: batch.rows as OpenPoPreviewOrder[],
    status: batch.status,
    revision: batch.revision,
    previewFingerprint: batch.previewFingerprint,
    reviewFingerprint: batch.reviewFingerprint,
    reviewed: batch.reviewed as OpenPoReviewedOrder[],
    reviewNote: batch.reviewNote,
    approval: approval ?? null,
    result: batch.result as OpenPoImportBatch["result"],
  };
}
export async function listOpenPoImports() {
  return db
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
    .limit(50);
}
export async function readOpenPoImport(id: string) {
  return present(db, await getBatch(db, id));
}
export async function readOpenPoSource(id: string) {
  const batch = await getBatch(db, id);
  sourceOrders(batch);
  return batch.sourceCsv;
}
export async function previewOpenPoImport(
  input: {
    sourceSystem: string;
    batchKey: string;
    fileName: string;
    csv: string;
    delimiter: "," | "\t";
    sourceSnapshotAt: string;
    cutoverAt: string;
  },
  actor: string,
) {
  if (!openPoSnapshotTimes(input.sourceSnapshotAt, input.cutoverAt))
    throw new DomainError(
      400,
      "Enter real past snapshot and cutover timestamps with time zones; snapshot cannot be later than cutover.",
    );
  let parsed: OpenPoSourceOrder[];
  try {
    parsed = parseOpenPoCsv(input.csv, input.delimiter);
  } catch (error) {
    throw new DomainError(
      400,
      error instanceof Error ? error.message : "Correct the source CSV.",
    );
  }
  return guarded(actor, async (tx) => {
    const sha = sourceHash(input.csv);
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
        prior.delimiter !== input.delimiter ||
        prior.sourceSnapshotAt !== input.sourceSnapshotAt ||
        prior.cutoverAt !== input.cutoverAt
      )
        throw new DomainError(
          409,
          "This source/batch identity already belongs to another snapshot. Preserve it and choose a new batch ID.",
        );
      return present(tx, prior);
    }
    const metadata = {
      id: randomUUID(),
      workspaceKey: workspaceScopeKey() || "default",
      sourceSystem: input.sourceSystem,
      batchKey: input.batchKey,
      fileName: input.fileName,
      sourceSha256: sha,
      sourceCsv: input.csv,
      delimiter: input.delimiter,
      sourceSnapshotAt: input.sourceSnapshotAt,
      cutoverAt: input.cutoverAt,
    };
    const rows = await capture(tx, input.sourceSystem, parsed);
    const [batch] = await tx
      .insert(batches)
      .values({
        ...metadata,
        rows,
        previewFingerprint: previewHash(metadata, rows),
        createdBy: actor,
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    await audit(tx, actor, batch.id, "previewed", {
      sourceSha256: sha,
      orders: rows.length,
      sourceLines: parsed.reduce((sum, item) => sum + item.lines.length, 0),
    });
    return present(tx, batch);
  });
}
export async function refreshOpenPoImport(
  id: string,
  revision: number,
  actor: string,
) {
  return guarded(actor, async (tx) => {
    const batch = await getBatch(tx, id, true);
    assertRevision(batch.revision, revision);
    if (batch.status === "committed")
      throw new DomainError(409, "Committed source imports are immutable.");
    const rows = await capture(tx, batch.sourceSystem, sourceOrders(batch));
    const [saved] = await tx
      .update(batches)
      .set({
        rows,
        status: "preview",
        previewFingerprint: previewHash(batch, rows),
        reviewed: [],
        reviewFingerprint: null,
        reviewNote: null,
        currentApprovalId: null,
        revision: batch.revision + 1,
        updatedAt: now(),
      })
      .where(eq(batches.id, id))
      .returning();
    await audit(tx, actor, id, "refreshed", {
      previousApprovalId: batch.currentApprovalId,
    });
    return present(tx, saved);
  });
}
async function existingOrder(
  reader: Reader,
  id: string,
): Promise<OpenPoExistingOrder | null> {
  const [order] = await reader
    .select()
    .from(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.id, id));
  if (!order) return null;
  const raw = await reader
    .select({
      id: purchaseOrderLinesTable.id,
      productId: purchaseOrderLinesTable.productId,
      productName: purchaseOrderLinesTable.productName,
      sku: purchaseOrderLinesTable.sku,
      unit: purchaseOrderLinesTable.unit,
      unitCost: purchaseOrderLinesTable.unitCost,
      quantity: purchaseOrderLinesTable.quantity,
      receivedQty: sql<string>`coalesce(sum(${purchaseReceiptLinesTable.quantity}),0)::text`,
    })
    .from(purchaseOrderLinesTable)
    .leftJoin(
      purchaseReceiptLinesTable,
      eq(purchaseReceiptLinesTable.lineId, purchaseOrderLinesTable.id),
    )
    .where(eq(purchaseOrderLinesTable.orderId, id))
    .groupBy(purchaseOrderLinesTable.id)
    .orderBy(asc(purchaseOrderLinesTable.position));
  let lines: OpenPoExistingOrder["lines"];
  try {
    lines = raw.map((line) => ({
      ...line,
      outstandingQty: openPoDecimal(
        openPoMicros(line.quantity) - openPoMicros(line.receivedQty),
      ),
    }));
  } catch {
    throw new DomainError(
      409,
      "This existing order has unsupported historical quantities. Review it in the normal purchasing workflow before linking.",
    );
  }
  const receiptHeaders = await reader
    .select()
    .from(purchaseReceiptsTable)
    .where(eq(purchaseReceiptsTable.orderId, id))
    .orderBy(asc(purchaseReceiptsTable.id));
  const receiptDetails = receiptHeaders.length
    ? await reader
        .select()
        .from(purchaseReceiptLinesTable)
        .where(
          inArray(
            purchaseReceiptLinesTable.receiptId,
            receiptHeaders.map((receipt) => receipt.id),
          ),
        )
        .orderBy(asc(purchaseReceiptLinesTable.id))
    : [];
  const data = {
    id: order.id,
    revision: order.revision,
    orderNumber: poNumber(order.number),
    supplier: order.supplier,
    warehouseId: order.warehouseId,
    jobId: order.jobId,
    status: order.status,
    expectedOn: order.expectedOn,
    updatedAt: order.updatedAt,
    lines,
    receiptFingerprint: hash([receiptHeaders, receiptDetails]),
  };
  return { ...data, fingerprint: hash(data) };
}
export async function openPoImportOptions(
  kind: "supplier" | "warehouse" | "product" | "job" | "order",
  q: string,
  page: number,
) {
  const term = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null,
    limit = 51,
    offset = page * 50;
  let items: unknown[];
  if (kind === "supplier")
    items = await db
      .select(supplierFields)
      .from(suppliersTable)
      .where(
        and(
          eq(suppliersTable.active, true),
          term
            ? or(
                ilike(suppliersTable.name, term),
                ilike(suppliersTable.id, term),
              )
            : undefined,
        ),
      )
      .orderBy(asc(suppliersTable.name), asc(suppliersTable.id))
      .limit(limit)
      .offset(offset);
  else if (kind === "warehouse")
    items = await db
      .select(warehouseFields)
      .from(warehousesTable)
      .where(
        term
          ? or(
              ilike(warehousesTable.name, term),
              ilike(warehousesTable.id, term),
            )
          : undefined,
      )
      .orderBy(asc(warehousesTable.name), asc(warehousesTable.id))
      .limit(limit)
      .offset(offset);
  else if (kind === "product")
    items = await db
      .select(productFields)
      .from(productsTable)
      .where(
        and(
          eq(productsTable.active, true),
          eq(productsTable.inventoryType, "Inventory"),
          term
            ? or(
                ilike(productsTable.name, term),
                ilike(productsTable.sku, term),
                ilike(productsTable.id, term),
              )
            : undefined,
        ),
      )
      .orderBy(asc(productsTable.name), asc(productsTable.id))
      .limit(limit)
      .offset(offset);
  else if (kind === "job")
    items = await db
      .select(jobFields)
      .from(jobsTable)
      .where(
        term
          ? or(
              ilike(jobsTable.jobNumber, term),
              ilike(jobsTable.customerName, term),
              ilike(jobsTable.id, term),
            )
          : undefined,
      )
      .orderBy(asc(jobsTable.jobNumber), asc(jobsTable.id))
      .limit(limit)
      .offset(offset);
  else {
    const orders = await db
      .select({ id: purchaseOrdersTable.id })
      .from(purchaseOrdersTable)
      .where(
        and(
          inArray(purchaseOrdersTable.status, [
            "Ordered",
            "Partially received",
          ]),
          term
            ? or(
                ilike(purchaseOrdersTable.supplier, term),
                ilike(purchaseOrdersTable.id, term),
                ilike(
                  sql<string>`'PO-'||lpad(${purchaseOrdersTable.number}::text,6,'0')`,
                  term,
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(purchaseOrdersTable.number))
      .limit(limit)
      .offset(offset);
    items = await Promise.all(
      orders.map((order) => existingOrder(db, order.id)),
    );
  }
  return { kind, items: items.slice(0, 50), hasMore: items.length > 50, page };
}
async function resolveReview(
  tx: Tx,
  rows: OpenPoPreviewOrder[],
  choices: OpenPoDecision[],
): Promise<OpenPoReviewedOrder[]> {
  if (
    rows.length !== choices.length ||
    new Set(choices.map((item) => item.sourcePoId)).size !== rows.length ||
    choices.some(
      (item) => !rows.some((row) => row.sourcePoId === item.sourcePoId),
    )
  )
    throw new DomainError(400, "Review every source order exactly once.");
  const output: OpenPoReviewedOrder[] = [];
  for (const row of rows) {
    const decision = choices.find(
      (item) => item.sourcePoId === row.sourcePoId,
    )!;
    let included: ReturnType<typeof validateOpenPoChoices>;
    try {
      included = validateOpenPoChoices(row, decision);
    } catch (error) {
      throw new DomainError(
        409,
        error instanceof Error ? error.message : "Correct the source review.",
      );
    }
    if (decision.action === "skip") {
      output.push({ decision, selected: null });
      continue;
    }
    if (
      decision.action === "create" &&
      (decision.orderId !== undefined ||
        decision.orderRevision !== undefined ||
        decision.orderFingerprint !== undefined)
    )
      throw new DomainError(
        400,
        "A create decision cannot also name an existing order. Select one explicit action.",
      );
    if (row.imported)
      throw new DomainError(
        409,
        "This source order already has an immutable Works link. Open that record or explicitly skip it.",
      );
    const [supplier] = await tx
      .select(supplierFields)
      .from(suppliersTable)
      .where(eq(suppliersTable.id, decision.supplierId!));
    if (!supplier?.active || supplier.revision !== decision.supplierRevision)
      throw new DomainError(
        409,
        "The selected supplier changed or is inactive. Refresh and review it again.",
      );
    const [warehouse] = await tx
      .select(warehouseFields)
      .from(warehousesTable)
      .where(eq(warehousesTable.id, decision.warehouseId!));
    if (!warehouse || warehouse.updatedAt !== decision.warehouseUpdatedAt)
      throw new DomainError(
        409,
        "The selected warehouse changed. Refresh and review it again.",
      );
    let job: OpenPoJob | null = null;
    if (decision.jobId) {
      const [found] = await tx
        .select(jobFields)
        .from(jobsTable)
        .where(eq(jobsTable.id, decision.jobId));
      if (
        !found ||
        found.revision !== decision.jobRevision ||
        found.updatedAt !== decision.jobUpdatedAt
      )
        throw new DomainError(
          409,
          "The selected job changed. Refresh and review it again.",
        );
      job = found;
    } else if (row.lines[0].jobRef)
      throw new DomainError(
        409,
        "The source contains a job reference. Explicitly link its existing Works job before carrying this order forward.",
      );
    const lines: NonNullable<OpenPoReviewedOrder["selected"]>["lines"] = [];
    for (const item of included) {
      const [product] = await tx
        .select(productFields)
        .from(productsTable)
        .where(eq(productsTable.id, item.decision.productId!));
      if (
        !product?.active ||
        product.inventoryType !== "Inventory" ||
        product.revision !== item.decision.productRevision
      )
        throw new DomainError(
          409,
          `Source line ${item.source.line}: the selected stocked product changed or is inactive.`,
        );
      if (product.unit !== item.source.unit)
        throw new DomainError(
          409,
          `Source line ${item.source.line}: source and stock units must match exactly. No conversion or price substitution is performed.`,
        );
      lines.push({ source: item.source, choice: item.decision, product });
    }
    let order: OpenPoExistingOrder | null = null;
    if (decision.action === "link") {
      order = await existingOrder(tx, decision.orderId!);
      if (
        !order ||
        !["Ordered", "Partially received"].includes(order.status) ||
        order.revision !== decision.orderRevision ||
        order.fingerprint !== decision.orderFingerprint
      )
        throw new DomainError(
          409,
          "The selected open purchase order or its receipts changed. Review the current order again.",
        );
      const [prior] = await tx
        .select({ id: records.id })
        .from(records)
        .where(eq(records.orderId, order.id));
      if (prior)
        throw new DomainError(
          409,
          "That Works purchase order already belongs to an imported source identity.",
        );
      const pending = order.lines.filter(
        (line) => openPoMicros(line.outstandingQty) > 0n,
      );
      if (
        order.supplier !== supplier.name ||
        order.warehouseId !== warehouse.id ||
        order.jobId !== (job?.id ?? null) ||
        order.expectedOn !== (row.lines[0].expectedOn || null) ||
        pending.length !== lines.length ||
        lines.some(
          (item) =>
            !pending.some(
              (line) =>
                line.productId === item.product.id &&
                line.unit === item.source.unit &&
                openPoMicros(line.outstandingQty) ===
                  openPoMicros(item.source.outstandingQty) &&
                openPoMicros(line.unitCost) ===
                  openPoMicros(item.source.unitCost),
            ),
        )
      )
        throw new DomainError(
          409,
          "The existing order must exactly match the reviewed supplier, warehouse, job, delivery date and outstanding product quantities/costs. Linking never overwrites it.",
        );
    }
    output.push({
      decision,
      selected: { supplier, warehouse, job, lines, existingOrder: order },
    });
  }
  const targets = output.flatMap((item) =>
    item.selected?.existingOrder ? [item.selected.existingOrder.id] : [],
  );
  if (new Set(targets).size !== targets.length)
    throw new DomainError(
      409,
      "Each Works order can be linked to only one source order identity. Review duplicate selections before approval.",
    );
  return output;
}
export async function reviewOpenPoImport(
  id: string,
  revision: number,
  fingerprint: string,
  choices: OpenPoDecision[],
  note: string,
  actor: string,
) {
  return guarded(actor, async (tx) => {
    const batch = await getBatch(tx, id, true);
    assertRevision(batch.revision, revision);
    if (
      !["preview", "reviewed"].includes(batch.status) ||
      batch.previewFingerprint !== fingerprint
    )
      throw new DomainError(
        409,
        "Refresh the exact source preview before changing this review.",
      );
    await lockOperationalRecords(tx);
    const rows = await capture(tx, batch.sourceSystem, sourceOrders(batch));
    if (previewHash(batch, rows) !== batch.previewFingerprint)
      throw new DomainError(
        409,
        "Source identities changed. Refresh and review the current source snapshot.",
      );
    const reviewed = await resolveReview(tx, rows, choices);
    const [saved] = await tx
      .update(batches)
      .set({
        reviewed,
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
export async function approveOpenPoImport(
  id: string,
  revision: number,
  fingerprint: string,
  actor: string,
) {
  return guarded(actor, async (tx) => {
    const batch = await getBatch(tx, id, true);
    if (batch.status === "approved" && batch.reviewFingerprint === fingerprint)
      return present(tx, batch);
    assertRevision(batch.revision, revision);
    if (
      batch.status !== "reviewed" ||
      !batch.reviewNote ||
      batch.reviewFingerprint !== fingerprint ||
      reviewHash(
        batch,
        batch.reviewed as OpenPoReviewedOrder[],
        batch.reviewNote,
      ) !== fingerprint
    )
      throw new DomainError(
        409,
        "Approve only the exact saved outstanding-only review.",
      );
    const [created] = await tx
      .insert(approvals)
      .values({
        id: randomUUID(),
        batchId: id,
        fingerprint,
        previewFingerprint: batch.previewFingerprint,
        reviewed: batch.reviewed,
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
export async function commitOpenPoImport(
  id: string,
  revision: number,
  approvalId: string,
  fingerprint: string,
  actor: string,
) {
  return guarded(actor, async (tx) => {
    const batch = await getBatch(tx, id, true);
    if (batch.status === "committed") {
      if (
        batch.currentApprovalId !== approvalId ||
        batch.reviewFingerprint !== fingerprint
      )
        throw new DomainError(
          409,
          "This source snapshot was committed under another approval.",
        );
      return present(tx, batch);
    }
    assertRevision(batch.revision, revision);
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
        approval.reviewed as OpenPoReviewedOrder[],
        approval.reviewNote,
      ) !== fingerprint
    )
      throw new DomainError(
        409,
        "Commit only the exact immutable owner-approved outstanding-only review.",
      );
    await lockOperationalRecords(tx);
    const rows = await capture(tx, batch.sourceSystem, sourceOrders(batch));
    if (previewHash(batch, rows) !== batch.previewFingerprint)
      throw new DomainError(
        409,
        "Source identities changed after approval. Refresh and review the updated source snapshot.",
      );
    const frozen = approval.reviewed as OpenPoReviewedOrder[],
      current = await resolveReview(
        tx,
        rows,
        frozen.map((item) => item.decision),
      );
    if (hash(current) !== hash(frozen))
      throw new DomainError(
        409,
        "Selected operational records changed after approval. Refresh and explicitly review them again.",
      );
    const result: NonNullable<OpenPoImportBatch["result"]> = {
      created: 0,
      linked: 0,
      skipped: 0,
      orders: [],
    };
    for (const entry of current) {
      if (!entry.selected) {
        result.skipped++;
        continue;
      }
      const { decision, selected } = entry,
        source = rows.find((row) => row.sourcePoId === decision.sourcePoId)!;
      let orderId: string, orderNumber: string;
      let targetLines: Array<{
        sourceLineId: string;
        sourceLine: number;
        orderLineId: string;
        productId: string;
        quantity: string;
        outstandingQty: string;
        unit: string;
        unitCost: string;
      }>;
      if (decision.action === "create") {
        orderId = randomUUID();
        const at = now();
        const [created] = await tx
          .insert(purchaseOrdersTable)
          .values({
            id: orderId,
            supplier: selected.supplier.name,
            warehouseId: selected.warehouse.id,
            jobId: selected.job?.id ?? null,
            expectedOn: source.lines[0].expectedOn || null,
            status: "Ordered",
            notes: `Outstanding-only import of source PO ${source.lines[0].sourcePoNumber}. Source snapshot ${batch.sourceSnapshotAt}; cutover ${batch.cutoverAt}. Earlier receipts and financial balances were not imported.`,
            createdBy: actor,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        orderNumber = poNumber(created.number);
        const coreLines = selected.lines.map((item, position) => ({
          id: randomUUID(),
          orderId,
          productId: item.product.id,
          productName: item.product.name,
          sku: item.product.sku,
          unit: item.product.unit,
          position,
          quantity: openPoDecimal(openPoMicros(item.source.outstandingQty)),
          unitCost: openPoDecimal(openPoMicros(item.source.unitCost)),
        }));
        await tx.insert(purchaseOrderLinesTable).values(coreLines);
        targetLines = coreLines.map((line, position) => ({
          sourceLineId: selected.lines[position].source.sourceLineId,
          sourceLine: selected.lines[position].source.line,
          orderLineId: line.id,
          productId: line.productId,
          quantity: line.quantity,
          outstandingQty: line.quantity,
          unit: line.unit,
          unitCost: line.unitCost,
        }));
        result.created++;
      } else {
        orderId = selected.existingOrder!.id;
        orderNumber = selected.existingOrder!.orderNumber;
        result.linked++;
        targetLines = selected.lines.map((item) => {
          const line = selected.existingOrder!.lines.find(
            (line) => line.productId === item.product.id,
          )!;
          return {
            sourceLineId: item.source.sourceLineId,
            sourceLine: item.source.line,
            orderLineId: line.id,
            productId: line.productId,
            quantity: line.quantity,
            outstandingQty: openPoDecimal(
              openPoMicros(item.source.outstandingQty),
            ),
            unit: line.unit,
            unitCost: line.unitCost,
          };
        });
      }
      await tx.insert(records).values({
        id: randomUUID(),
        batchId: id,
        approvalId,
        sourceSystem: batch.sourceSystem,
        sourcePoId: source.sourcePoId,
        sourcePoNumber: source.lines[0].sourcePoNumber,
        orderId,
        supplierId: selected.supplier.id,
        sourceData: { ...source },
        reviewedDecision: { ...entry, targetLines },
        sourceRecordSha256: hash(source),
        action: decision.action as "create" | "link",
        createdAt: now(),
      });
      result.orders.push({
        sourcePoId: source.sourcePoId,
        sourcePoNumber: source.lines[0].sourcePoNumber,
        orderId,
        orderNumber,
        action: decision.action as "create" | "link",
      });
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
      created: result.created,
      linked: result.linked,
      skipped: result.skipped,
      receiptsCreated: 0,
      stockMovementsCreated: 0,
      providerCalls: 0,
    });
    return present(tx, saved);
  });
}
export async function openPoImportProvenance(orderId: string) {
  const [record] = await db
    .select()
    .from(records)
    .where(eq(records.orderId, orderId));
  if (!record)
    throw new DomainError(
      404,
      "No imported source history is linked to this order.",
    );
  const batch = await getBatch(db, record.batchId),
    [approval] = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.id, record.approvalId),
          eq(approvals.batchId, batch.id),
        ),
      );
  if (
    batch.status !== "committed" ||
    !approval ||
    hash(record.sourceData) !== record.sourceRecordSha256
  )
    throw new DomainError(
      409,
      "The immutable source history needs operator review.",
    );
  return {
    record,
    batch: await present(db, batch),
    approval: {
      id: approval.id,
      fingerprint: approval.fingerprint,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
    },
    outstandingOnly: true,
  };
}
