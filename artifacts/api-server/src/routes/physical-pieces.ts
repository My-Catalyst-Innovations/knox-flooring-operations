import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";
import { db, inventoryMovementsTable, physicalPieceEventsTable, physicalPiecesTable, productsTable } from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { domainRoute, id, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { cutPiece, movePiece, registerPiece } from "../lib/physical-pieces";

const router = Router();
const stockAccess = requireRole("owner", "operations");
const identifier = z.string().min(1).max(200);
const dimension = (max: number) => z.number().min(0.001).max(max)
  .refine((value) => Math.round(value * 1000) / 1000 === value, "Enter inches to at most three decimals.");
const label = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._/-]{0,79}$/);
const note = z.string().trim().max(500).default("");
const requestKey = z.string().min(8).max(180);
const path = "/inventory/physical-pieces";
const change = z.object({ revision: z.number().int().positive(), idempotencyKey: requestKey, note });
const pieces = physicalPiecesTable;
const parent = alias(physicalPiecesTable, "physical_parent");

router.get(path, stockAccess, domainRoute(async (req, res) => {
  const filters = parse(z.object({
    productId: identifier.optional(),
    warehouseId: identifier.optional(),
    q: z.string().trim().max(100).optional(),
    status: z.enum(["available", "issued", "all"]).default("all"),
  }), req.query);
  const query = filters.q?.toLowerCase();
  const exactLabel = query?.startsWith("piece:") ? query.slice("piece:".length) : undefined;
  const rows = await db.select({
    piece: pieces,
    productName: productsTable.name,
    sku: productsTable.sku,
    parentLabel: parent.label,
    issuedJobId: inventoryMovementsTable.jobId,
  }).from(pieces)
    .innerJoin(productsTable, eq(pieces.productId, productsTable.id))
    .leftJoin(parent, eq(pieces.parentId, parent.id))
    .leftJoin(inventoryMovementsTable, eq(pieces.issuedMovementId, inventoryMovementsTable.id))
    .where(and(
      filters.productId ? eq(pieces.productId, filters.productId) : undefined,
      filters.warehouseId ? eq(pieces.warehouseId, filters.warehouseId) : undefined,
      filters.status === "available" ? isNull(pieces.issuedMovementId) : filters.status === "issued" ? isNotNull(pieces.issuedMovementId) : undefined,
      exactLabel !== undefined ? sql`lower(${pieces.label}) = ${exactLabel}` : query ? or(
        sql`strpos(lower(${pieces.label}), ${query}) > 0`,
        sql`strpos(lower(${pieces.lot}), ${query}) > 0`,
        sql`strpos(lower(${productsTable.sku}), ${query}) > 0`,
        sql`strpos(lower(${productsTable.name}), ${query}) > 0`,
      ) : undefined,
    )).orderBy(sql`${pieces.issuedMovementId} IS NOT NULL`, asc(pieces.label)).limit(101);
  res.json({
    pieces: rows.slice(0, 100).map(({ piece, ...metadata }) => ({ ...piece, ...metadata })),
    hasMore: rows.length > 100,
  });
}));

router.get(`${path}/:id/history`, stockAccess, domainRoute(async (req, res) => {
  const pieceId = id(req);
  const [found] = await db.select({ id: pieces.id }).from(pieces).where(eq(pieces.id, pieceId));
  if (!found) throw new DomainError(404, "Stock piece not found.");
  const events = await db.select({
    id: physicalPieceEventsTable.id,
    action: physicalPieceEventsTable.action,
    details: physicalPieceEventsTable.details,
    actorUserId: physicalPieceEventsTable.actorUserId,
    createdAt: physicalPieceEventsTable.createdAt,
    childId: physicalPieceEventsTable.childId,
    pieceId: physicalPieceEventsTable.pieceId,
    movementId: inventoryMovementsTable.id,
    costAllocations: inventoryMovementsTable.costAllocations,
  }).from(physicalPieceEventsTable)
    .leftJoin(inventoryMovementsTable, eq(physicalPieceEventsTable.movementId, inventoryMovementsTable.id))
    .where(or(eq(physicalPieceEventsTable.pieceId, pieceId), eq(physicalPieceEventsTable.childId, pieceId)))
    .orderBy(desc(physicalPieceEventsTable.createdAt), desc(physicalPieceEventsTable.id)).limit(100);
  res.json(events);
}));

router.post(path, stockAccess, domainRoute(async (req, res) => {
  const data = parse(z.object({
    productId: identifier, label, note, idempotencyKey: requestKey,
    warehouseId: identifier, binId: identifier.nullable(),
    kind: z.enum(["Roll", "Remnant"]), lot: z.string().trim().max(100).default(""),
    widthInches: dimension(1200), lengthInches: dimension(120000),
  }), req.body);
  const result = await db.transaction(tx => registerPiece(tx, { ...data, lot: data.lot ?? "", note: data.note ?? "" }, req.auth!.userId));
  res.status(201).json(result);
}));

router.post(`${path}/:id/cut`, stockAccess, domainRoute(async (req, res) => {
  const data = parse(change.extend({ label, lengthInches: dimension(120000) }), req.body);
  const result = await db.transaction(tx => cutPiece(tx, id(req), { ...data, note: data.note ?? "" }, req.auth!.userId));
  res.status(201).json(result);
}));

router.post(`${path}/:id/move`, stockAccess, domainRoute(async (req, res) => {
  const data = parse(change.extend({
    binId: identifier.nullable(), destinationWarehouseId: identifier.optional(), confirmedAtDestination: z.literal(true).optional(),
  }), req.body);
  const result = await db.transaction(tx => movePiece(tx, id(req), { ...data, note: data.note ?? "" }, req.auth!.userId));
  res.json(result);
}));

export default router;
