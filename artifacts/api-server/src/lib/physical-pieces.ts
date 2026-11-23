import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { inventoryMovementsTable, inventoryReservationsTable, inventoryTransfersTable, physicalPieceEventsTable, physicalPiecesTable, productsTable, type PhysicalPiece } from "@workspace/db";
import { assertBinWithdrawal, binBalances, lockStockProduct, roundStock, verifyBin, verifyWarehouse, type StockTransaction } from "./inventory-stock";
import { acquisitionCostSlice, inventoryUnitCostPattern, normalizeInventoryUnitCost, placeStockCosts, sliceCostLayers, stockCostAvailability, verifiedPieceCosts, withdrawStockCosts } from "./inventory-costing";
import { assertRevision, DomainError } from "./operations-rules";

export function pieceArea(widthInches: number, lengthInches: number) {
  return roundStock(widthInches * lengthInches / 144);
}

export function pieceCut(piece: Pick<PhysicalPiece, "widthInches" | "lengthInches" | "quantity">, lengthInches: number) {
  const childQuantity = pieceArea(piece.widthInches, lengthInches);
  const remainingLength = Math.round((piece.lengthInches - lengthInches) * 1_000) / 1_000;
  const remainingQuantity = roundStock(piece.quantity - childQuantity);
  if (remainingLength <= 0 || remainingQuantity <= 0 || childQuantity <= 0) {
    throw new DomainError(400, "Enter a cut shorter than the remaining piece length.");
  }
  return { childQuantity, remainingLength, remainingQuantity };
}

export function pieceReturnQuantity(piece: Pick<PhysicalPiece, "widthInches" | "lengthInches" | "quantity">, lengthInches: number) {
  const quantity = lengthInches === piece.lengthInches ? piece.quantity : pieceArea(piece.widthInches, lengthInches);
  if (lengthInches > piece.lengthInches || quantity <= 0 || quantity > piece.quantity) {
    throw new DomainError(400, "The returned length must fit within the piece issued to the job.");
  }
  return quantity;
}

type Location = { warehouseId: string; binId: string | null };
type PieceEvent = typeof physicalPieceEventsTable.$inferInsert;
type PieceResult = { piece: PhysicalPiece; child?: PhysicalPiece };
type RequestIdentity = Pick<PieceEvent, "requestKey" | "requestHash" | "actorUserId">;

async function requireReconciledDestination(tx: StockTransaction, location: Location & { productId: string }) {
  const balances = await binBalances(tx, location);
  const existing = balances.find((row) => row.binId === location.binId)?.onHand ?? 0;
  if (roundStock(existing) < 0) throw new DomainError(409, "Reconcile the destination bin's negative stock before placing a labeled piece there.");
}

async function findPiece(tx: StockTransaction, id: string) {
  const [piece] = await tx.select().from(physicalPiecesTable).where(eq(physicalPiecesTable.id, id));
  if (!piece) throw new DomainError(404, "Stock piece not found.");
  return piece;
}

async function savePiece(tx: StockTransaction, value: typeof physicalPiecesTable.$inferInsert) {
  const [piece] = await tx.insert(physicalPiecesTable).values(value).onConflictDoNothing().returning();
  if (!piece) throw new DomainError(409, "This label is already in use. Enter a unique label.");
  return piece;
}

function identity(key: string, actorUserId: string, payload: unknown): RequestIdentity {
  return {
    actorUserId,
    requestKey: `physical:${key}`,
    requestHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

async function previousResult(tx: StockTransaction, request: RequestIdentity): Promise<PieceResult | undefined> {
  const [event] = await tx.select().from(physicalPieceEventsTable).where(eq(physicalPieceEventsTable.requestKey, request.requestKey));
  if (!event) return;
  if (event.requestHash !== request.requestHash || event.actorUserId !== request.actorUserId) {
    throw new DomainError(409, "This request key was used for another stock piece change.");
  }
  const piece = await findPiece(tx, event.pieceId);
  return event.childId ? { piece, child: await findPiece(tx, event.childId) } : { piece };
}

async function recordEvent(tx: StockTransaction, event: Omit<PieceEvent, "id">) {
  await tx.insert(physicalPieceEventsTable).values({ id: randomUUID(), ...event });
}

export async function registerPiece(tx: StockTransaction, input: Location & {
  productId: string; label: string; kind: PhysicalPiece["kind"]; lot: string;
  widthInches: number; lengthInches: number; note: string; idempotencyKey: string;
}, actorUserId: string): Promise<PieceResult> {
  const { note, idempotencyKey, ...value } = input;
  const request = identity(idempotencyKey, actorUserId, ["registered", value, note]);
  await lockStockProduct(tx, value.productId);
  const prior = await previousResult(tx, request);
  if (prior) return prior;
  const [product] = await tx.select({ unit: productsTable.unit, active: productsTable.active, inventoryType: productsTable.inventoryType })
    .from(productsTable).where(eq(productsTable.id, value.productId));
  if (!product?.active || product.inventoryType !== "Inventory" || product.unit !== "sqft") {
    throw new DomainError(400, "Choose an active stocked product measured in square feet.");
  }
  await verifyWarehouse(tx, value.warehouseId);
  await verifyBin(tx, value.warehouseId, value.binId);
  const quantity = pieceArea(value.widthInches, value.lengthInches);
  if (quantity <= 0) throw new DomainError(400, "Enter dimensions for a piece with measurable area.");
  await assertBinWithdrawal(tx, value.productId, value.warehouseId, value.binId, quantity, true);
  const now = new Date().toISOString();
  const piece = await savePiece(tx, { ...value, id: randomUUID(), quantity, createdAt: now, updatedAt: now });
  await recordEvent(tx, {
    ...request, pieceId: piece.id, action: "registered", createdAt: now,
    details: { ...value, quantity, note },
  });
  return { piece };
}

type Change = { revision: number; idempotencyKey: string; note: string };

export async function bindPieceCosts(tx: StockTransaction, pieceId: string, input: Change & { sourceLayerId?: string; reviewedUnitCost?: string }, actorUserId: string) {
  const request = identity(input.idempotencyKey, actorUserId, ["cost_bound", pieceId, input]);
  const initial = await findPiece(tx, pieceId);
  await lockStockProduct(tx, initial.productId);
  const prior = await previousResult(tx, request);
  if (prior) return prior;
  const current = await findPiece(tx, pieceId);
  assertRevision(current.revision, input.revision);
  if (current.issuedMovementId || current.costAllocations) throw new DomainError(409, "Only an available, unbound piece can have its cost reviewed.");
  if (!input.note.trim() || Boolean(input.sourceLayerId) === (input.reviewedUnitCost !== undefined)) throw new DomainError(400, "Record a review note and choose one receipt source or an actual opening-stock unit cost.");
  const location = { productId: current.productId, warehouseId: current.warehouseId, binId: current.binId };
  const available = await stockCostAvailability(tx, location, current.id);
  const now = new Date().toISOString();
  let costs;
  if (input.sourceLayerId) {
    const source = available.layers.find((layer) => layer.layerId === input.sourceLayerId);
    if (!source || roundStock(source.quantity) < current.quantity) throw new DomainError(409, "The selected source does not have enough unbound quantity for this piece. Review another receipt.");
    costs = [{ ...source, quantity: current.quantity }];
  } else {
    if (!inventoryUnitCostPattern.test(input.reviewedUnitCost!)) throw new DomainError(400, "Enter a valid nonnegative actual opening-stock unit cost.");
    if (available.untracked < current.quantity) throw new DomainError(409, "This quantity already has recorded acquisition costs. Choose its actual receipt source instead.");
    const movementId = randomUUID();
    costs = [{ ...acquisitionCostSlice(movementId, current.quantity, normalizeInventoryUnitCost(input.reviewedUnitCost!), now, "reviewed_opening"), layerId: `${movementId}:0` }];
    // Explicit owner review values previously unpriced opening stock. The zero
    // quantity entry changes cost provenance without adding or removing stock.
    await tx.insert(inventoryMovementsTable).values({ id: movementId, ...location, quantity: 0, kind: "adjustment", costAllocations: costs,
      reason: `Owner-reviewed opening acquisition cost for ${current.label}: ${input.note}`, actorUserId,
      idempotencyKey: `piece-cost:${createHash("sha256").update(request.requestKey).digest("hex")}`, createdAt: now });
  }
  verifiedPieceCosts({ quantity: current.quantity, costAllocations: costs });
  const [piece] = await tx.update(physicalPiecesTable).set({ costAllocations: costs, costReviewedBy: actorUserId, costReviewedAt: now, revision: current.revision + 1, updatedAt: now })
    .where(eq(physicalPiecesTable.id, current.id)).returning();
  await recordEvent(tx, { ...request, pieceId: piece.id, action: "cost_bound", createdAt: now,
    details: { note: input.note, quantity: piece.quantity, costAllocations: costs, sourceLayerId: input.sourceLayerId ?? null } });
  return { piece };
}

async function changeAvailablePiece(tx: StockTransaction, pieceId: string, actorUserId: string, action: "cut" | "moved", input: Change, work: (current: PhysicalPiece, now: string, request: RequestIdentity) => Promise<PieceResult>) {
  const request = identity(input.idempotencyKey, actorUserId, [action, pieceId, input]);
  const initial = await findPiece(tx, pieceId);
  await lockStockProduct(tx, initial.productId);
  const prior = await previousResult(tx, request);
  if (prior) return prior;
  const current = await findPiece(tx, pieceId);
  assertRevision(current.revision, input.revision);
  if (current.issuedMovementId) throw new DomainError(409, "Return the piece from its job before cutting or moving it.");
  verifiedPieceCosts(current);
  return work(current, new Date().toISOString(), request);
}

export function cutPiece(tx: StockTransaction, pieceId: string, input: Change & { label: string; lengthInches: number }, actorUserId: string) {
  return changeAvailablePiece(tx, pieceId, actorUserId, "cut", input, async (current, now, request) => {
    const { childQuantity, remainingLength, remainingQuantity } = pieceCut(current, input.lengthInches);
    const costs = verifiedPieceCosts(current);
    const child = await savePiece(tx, {
      id: randomUUID(), parentId: current.id, productId: current.productId, label: input.label, lot: current.lot,
      kind: "Remnant", widthInches: current.widthInches, lengthInches: input.lengthInches, quantity: childQuantity,
      warehouseId: current.warehouseId, binId: current.binId, createdAt: now, updatedAt: now,
      costAllocations: sliceCostLayers(costs, 0, childQuantity), costReviewedBy: current.costReviewedBy, costReviewedAt: current.costReviewedAt,
    });
    const [piece] = await tx.update(physicalPiecesTable).set({
      lengthInches: remainingLength, quantity: remainingQuantity, revision: current.revision + 1, updatedAt: now,
      costAllocations: sliceCostLayers(costs, childQuantity, current.quantity),
    }).where(eq(physicalPiecesTable.id, current.id)).returning();
    await recordEvent(tx, {
      ...request, pieceId: piece.id, childId: child.id, action: "cut", createdAt: now,
      details: { note: input.note, childLabel: child.label, childLengthInches: child.lengthInches, childQuantity, remainingLength, remainingQuantity },
    });
    return { piece, child };
  });
}

async function assertTransferAvailability(tx: StockTransaction, piece: PhysicalPiece) {
  const location = { productId: piece.productId, warehouseId: piece.warehouseId };
  const balances = await binBalances(tx, location);
  const [reserved] = await tx.select({ quantity: sql<number>`coalesce(sum(${inventoryReservationsTable.quantity}), 0)::double precision` })
    .from(inventoryReservationsTable).where(and(
      eq(inventoryReservationsTable.productId, location.productId),
      eq(inventoryReservationsTable.warehouseId, location.warehouseId),
      eq(inventoryReservationsTable.status, "Active"),
    ));
  const available = roundStock(balances.reduce((sum, balance) => sum + balance.onHand, 0) - reserved.quantity);
  if (available < piece.quantity) throw new DomainError(409, "Moving this piece would leave an active reservation short at its current warehouse.");
}

export function movePiece(tx: StockTransaction, pieceId: string, input: Change & { binId: string | null; destinationWarehouseId?: string; confirmedAtDestination?: true }, actorUserId: string) {
  return changeAvailablePiece(tx, pieceId, actorUserId, "moved", input, async (current, now, request) => {
    const from = { productId: current.productId, warehouseId: current.warehouseId, binId: current.binId };
    const to = { productId: current.productId, warehouseId: input.destinationWarehouseId ?? current.warehouseId, binId: input.binId };
    const changesWarehouse = from.warehouseId !== to.warehouseId;
    if (!changesWarehouse && from.binId === to.binId) throw new DomainError(400, "Choose a different warehouse or bin.");
    if (changesWarehouse && !input.confirmedAtDestination) throw new DomainError(400, "Confirm the piece has arrived before recording the warehouse move.");
    await verifyWarehouse(tx, to.warehouseId);
    await verifyBin(tx, to.warehouseId, to.binId);
    await assertBinWithdrawal(tx, from.productId, from.warehouseId, from.binId, current.quantity, true, current.id);
    await requireReconciledDestination(tx, to);
    if (changesWarehouse) await assertTransferAvailability(tx, current);
    const outId = randomUUID();
    const inId = randomUUID();
    const { slices } = await withdrawStockCosts(tx, from, current.quantity, current.id);
    const incoming = await placeStockCosts(tx, to, inId, current.quantity, slices);
    const movementKey = createHash("sha256").update(request.requestKey).digest("hex");
    const movementIdempotency = `piece-move:${movementKey}`;
    const reason = `${current.label}: ${input.note || "Move labeled stock piece"}`;
    const transferId = changesWarehouse ? randomUUID() : null;
    if (transferId) await tx.insert(inventoryTransfersTable).values({
      id: transferId, productId: current.productId, sourceWarehouseId: from.warehouseId, sourceBinId: from.binId,
      destinationWarehouseId: to.warehouseId, destinationBinId: to.binId, quantity: current.quantity, reason,
      status: "Received", dispatchedBy: actorUserId, receivedBy: actorUserId, receivedAt: now,
      idempotencyKey: movementIdempotency, createdAt: now, updatedAt: now,
    });
    const common = { actorUserId, createdAt: now, reason, transferId };
    await tx.insert(inventoryMovementsTable).values([
      { ...common, ...from, id: outId, kind: changesWarehouse ? "transfer_out" : "bin_out", idempotencyKey: `${movementIdempotency}:out`, quantity: -current.quantity, costAllocations: slices.length ? slices : null },
      { ...common, ...to, id: inId, kind: changesWarehouse ? "transfer_in" : "bin_in", idempotencyKey: `${movementIdempotency}:in`, quantity: current.quantity, costAllocations: incoming?.length ? incoming : null },
    ]);
    const [piece] = await tx.update(physicalPiecesTable).set({ warehouseId: to.warehouseId, binId: to.binId, costAllocations: incoming, revision: current.revision + 1, updatedAt: now })
      .where(eq(physicalPiecesTable.id, current.id)).returning();
    await recordEvent(tx, {
      ...request, pieceId: piece.id, movementId: inId, action: "moved", createdAt: now,
      details: { note: input.note, sourceWarehouseId: from.warehouseId, sourceBinId: from.binId, destinationWarehouseId: to.warehouseId,
        destinationBinId: to.binId, quantity: piece.quantity, outMovementId: outId, transferId },
    });
    return { piece };
  });
}

type PieceMovement = {
  physicalPieceId?: string; pieceRevision?: number; returnLengthInches?: number; returnOfMovementId?: string;
  kind: string; productId: string; jobId?: string; warehouseId: string | null; binId: string | null; quantity: number; reason: string;
};

export async function pieceForMovement(tx: StockTransaction, input: PieceMovement) {
  if (!input.physicalPieceId) {
    if (input.returnOfMovementId) {
      const [issued] = await tx.select({ id: physicalPieceEventsTable.id }).from(physicalPieceEventsTable)
        .where(and(eq(physicalPieceEventsTable.movementId, input.returnOfMovementId), eq(physicalPieceEventsTable.action, "issued")));
      if (issued) throw new DomainError(409, "Return this labeled piece from Rolls & remnants.");
    }
    return null;
  }
  const piece = await findPiece(tx, input.physicalPieceId);
  if (piece.productId !== input.productId || !input.jobId || !input.warehouseId || input.pieceRevision === undefined) {
    throw new DomainError(400, "Select the matching stock piece, job and warehouse.");
  }
  assertRevision(piece.revision, input.pieceRevision);
  if (input.kind === "consume") {
    if (piece.issuedMovementId || piece.warehouseId !== input.warehouseId || piece.binId !== input.binId || piece.quantity !== input.quantity) {
      throw new DomainError(409, "Choose the piece's current bin and issue the whole piece. Cut a new labeled piece first if needed.");
    }
    verifiedPieceCosts(piece);
  } else if (input.kind === "return") {
    if (!piece.issuedMovementId || input.returnOfMovementId !== piece.issuedMovementId || !input.returnLengthInches || pieceReturnQuantity(piece, input.returnLengthInches) !== input.quantity) {
      throw new DomainError(409, "Choose the piece's original issue and enter the measured returned length.");
    }
    await requireReconciledDestination(tx, { productId: input.productId, warehouseId: input.warehouseId, binId: input.binId });
  } else {
    throw new DomainError(400, "Stock pieces are linked only to job issues and job returns.");
  }
  return piece;
}

export async function checkPieceMovementRetry(tx: StockTransaction, movementId: string, input: PieceMovement, actorUserId: string) {
  const [existing] = await tx.select().from(physicalPieceEventsTable).where(eq(physicalPieceEventsTable.movementId, movementId));
  if (existing?.pieceId !== input.physicalPieceId || (existing && (
    existing.actorUserId !== actorUserId || existing.details.returnLengthInches !== (input.returnLengthInches ?? null) ||
    existing.details.pieceRevision !== input.pieceRevision || existing.details.note !== input.reason
  ))) {
    throw new DomainError(409, "This request key was already used for a different stock piece change.");
  }
}

export async function savePieceMovement(tx: StockTransaction, piece: PhysicalPiece, movement: typeof inventoryMovementsTable.$inferSelect, input: PieceMovement, actorUserId: string) {
  const issue = movement.kind === "consume";
  const returnedLength = input.returnLengthInches ?? null;
  await tx.update(physicalPiecesTable).set({
    issuedMovementId: issue ? movement.id : null,
    warehouseId: movement.warehouseId!,
    binId: movement.binId,
    lengthInches: returnedLength ?? piece.lengthInches,
    quantity: issue ? piece.quantity : movement.quantity,
    kind: returnedLength !== null && returnedLength < piece.lengthInches ? "Remnant" : piece.kind,
    // A legacy issue can still return at its recorded original job cost. Its
    // unreviewed piece stays unbound until an owner reviews that source.
    ...(!issue && piece.costAllocations ? { costAllocations: movement.costAllocations } : {}),
    revision: piece.revision + 1,
    updatedAt: movement.createdAt,
  }).where(eq(physicalPiecesTable.id, piece.id));
  const request = identity(`ledger:${movement.id}`, actorUserId, input);
  await recordEvent(tx, {
    ...request, pieceId: piece.id, movementId: movement.id, action: issue ? "issued" : "returned", createdAt: movement.createdAt,
    details: { pieceRevision: input.pieceRevision, previousLengthInches: piece.lengthInches, returnLengthInches: returnedLength, quantity: Math.abs(movement.quantity),
      warehouseId: movement.warehouseId, binId: movement.binId, jobId: movement.jobId, note: movement.reason },
  });
}
