import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, exists, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import {
  auditEventsTable, crewBookingsTable, crewsTable, db, inventoryMovementsTable, inventoryReservationsTable, inventoryStockCountsTable,
  jobsTable, laborEntriesTable, productsTable, type InventoryStockCount,
} from "@workspace/db";
import { requireOwner, requireRole } from "../middlewares/auth";
import { domainRoute, id, parse } from "../lib/domain-http";
import { withdrawStockCosts } from "../lib/inventory-costing";
import {
  assertBinWithdrawal, ensureOpeningMovement, lockStockProduct, roundStock,
  updateStockTotal, verifyBin, verifyWarehouse, type StockTransaction,
} from "../lib/inventory-stock";
import { DomainError } from "../lib/operations-rules";
import { audit } from "../lib/auth";

const router = Router();
const path = "/inventory/stock-counts";
router.use(path, requireRole("owner", "operations"));
const identifier = z.string().trim().min(1).max(200);
const location = z.object({ productId: identifier, warehouseId: identifier, binId: identifier.nullable() });
const submit = location.extend({
  snapshotKey: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(8).max(200),
  countedQuantity: z.number().min(0).max(1_000_000).refine((value) => roundStock(value) === value, "Use at most six quantity decimals."),
  reason: z.enum(["count", "damage", "waste"]),
  note: z.string().trim().max(500),
}).strict();
const dismiss = z.object({ note: z.string().trim().min(1).max(500) }).strict();
const reconcile = z.object({ jobId: identifier.optional(), crewId: identifier.optional() }).strict();
const wasteAttributionAction = "inventory.waste_attributed";
type Location = z.infer<typeof location>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function presentCount({ requestHash: _hash, requestKey: _request, snapshotKey: _snapshot, ...row }: InventoryStockCount) {
  return { ...row, variance: roundStock(row.countedQuantity - row.bookedQuantity) };
}

function wasteCrews(reader: Pick<StockTransaction, "select">, jobId: string) {
  const crew = crewsTable;
  const booking = crewBookingsTable;
  const labor = laborEntriesTable;
  return reader.select({ id: crew.id, name: crew.name }).from(crew).where(or(
    exists(reader.select({ id: booking.id }).from(booking).where(and(eq(booking.jobId, jobId), eq(booking.crewId, crew.id), eq(booking.status, "Confirmed")))),
    exists(reader.select({ id: labor.id }).from(labor).where(and(eq(labor.jobId, jobId), eq(labor.crewId, crew.id)))),
  )).orderBy(asc(crew.name), asc(crew.id));
}

router.get(`${path}/waste-crews`, requireOwner, domainRoute(async (req, res) => {
  const { jobId } = parse(z.object({ jobId: identifier }), req.query);
  res.json(await wasteCrews(db, jobId));
}));

async function snapshot(tx: StockTransaction, subject: Location) {
  const [product] = await tx.select().from(productsTable).where(eq(productsTable.id, subject.productId)).for("update");
  if (!product || product.inventoryType !== "Inventory") throw new DomainError(400, "Choose a stocked product.");
  await verifyWarehouse(tx, subject.warehouseId);
  await verifyBin(tx, subject.warehouseId, subject.binId);
  const movement = inventoryMovementsTable;
  const [balance] = await tx.select({
    onHand: sql<number>`coalesce(sum(${movement.quantity}), 0)::double precision`,
    entries: sql<string>`count(*)::text`,
  }).from(movement).where(and(
    eq(movement.productId, subject.productId), eq(movement.warehouseId, subject.warehouseId),
    sql`${movement.binId} IS NOT DISTINCT FROM ${subject.binId}::text`,
  ));
  const bookedQuantity = roundStock(balance.onHand);
  // Movements are append-only. The entry count catches intervening moves that cancel out in quantity.
  const snapshotKey = hash([subject.productId, subject.warehouseId, subject.binId, product.unit, bookedQuantity, balance.entries]);
  return { product, bookedQuantity, snapshotKey };
}

async function assertWarehouseReservations(tx: StockTransaction, subject: Location, withdrawing: number) {
  const movement = inventoryMovementsTable;
  const [warehouse] = await tx.select({ total: sql<number>`coalesce(sum(${movement.quantity}), 0)::double precision` })
    .from(movement).where(and(eq(movement.productId, subject.productId), eq(movement.warehouseId, subject.warehouseId)));
  const reservations = inventoryReservationsTable;
  const [reserved] = await tx.select({ total: sql<number>`coalesce(sum(${reservations.quantity}), 0)::double precision` })
    .from(reservations).where(and(
      eq(reservations.productId, subject.productId), eq(reservations.warehouseId, subject.warehouseId), eq(reservations.status, "Active"),
    ));
  if (reserved.total > 0 && roundStock(warehouse.total - withdrawing) < roundStock(reserved.total))
    throw new DomainError(409, "This adjustment would leave less stock than active warehouse reservations. Review those reservations before posting.");
}

router.get(path, domainRoute(async (req, res) => {
  const { warehouseId, countId } = parse(z.object({ warehouseId: identifier, countId: identifier.optional() }), req.query);
  const table = inventoryStockCountsTable;
  const rows = await db.select().from(table).where(and(eq(table.warehouseId, warehouseId), countId ? eq(table.id, countId) : undefined))
    .orderBy(sql`CASE WHEN ${table.status} = 'Pending' THEN 0 ELSE 1 END`, desc(table.createdAt), desc(table.id)).limit(100);
  res.json(rows.map(presentCount));
}));

router.get(`${path}/snapshot`, domainRoute(async (req, res) => {
  const subject = parse(location, { ...req.query, binId: req.query.binId ?? null });
  const { product, bookedQuantity, snapshotKey } = await db.transaction(async (tx) => {
    await lockStockProduct(tx, subject.productId);
    return snapshot(tx, subject);
  });
  res.json({ ...subject, sku: product.sku, productName: product.name, unit: product.unit, bookedQuantity, snapshotKey });
}));

router.post(path, domainRoute(async (req, res) => {
  const { idempotencyKey, ...input } = parse(submit, req.body);
  const table = inventoryStockCountsTable;
  const actor = req.auth!;
  const requestHash = hash(input);
  const row = await db.transaction(async (tx) => {
    await lockStockProduct(tx, input.productId);
    const [prior] = await tx.select().from(table).where(eq(table.requestKey, idempotencyKey));
    if (prior) {
      if (prior.requestHash !== requestHash || prior.countedBy !== actor.userId)
        throw new DomainError(409, "This request key was already used for a different count.");
      return prior;
    }
    const current = await snapshot(tx, input);
    if (input.snapshotKey !== current.snapshotKey)
      throw new DomainError(409, "Stock moved while this count was in progress. Start a fresh count with the current snapshot.");
    if (input.countedQuantity !== current.bookedQuantity && !input.note)
      throw new DomainError(400, "Explain why the physical quantity differs from the booked quantity.");
    if (input.reason !== "count" && input.countedQuantity >= current.bookedQuantity)
      throw new DomainError(400, "Damage and waste must reduce the booked stock quantity.");
    const [record] = await tx.insert(table).values({
      ...input, id: randomUUID(), requestKey: idempotencyKey, requestHash,
      sku: current.product.sku, productName: current.product.name, unit: current.product.unit,
      bookedQuantity: current.bookedQuantity, createdAt: new Date().toISOString(), countedBy: actor.userId, counterName: actor.name,
    }).returning();
    return record;
  });
  res.status(201).json(presentCount(row));
}));

router.post(`${path}/:id/reconcile`, requireOwner, domainRoute(async (req, res) => {
  const { jobId, crewId } = parse(reconcile, req.body ?? {});
  if (crewId && !jobId) throw new DomainError(400, "Choose a job before attributing waste to a crew.");
  const table = inventoryStockCountsTable;
  const actor = req.auth!;
  const row = await db.transaction(async (tx) => {
    const [count] = await tx.select().from(table).where(eq(table.id, id(req))).for("update");
    if (!count) throw new DomainError(404, "Stock count not found.");
    if (jobId && count.reason !== "waste") throw new DomainError(400, "Only waste adjustments can be attributed to a job.");
    if (count.status === "Reconciled") {
      if (jobId) {
        const [previous] = await tx.select({ details: auditEventsTable.details }).from(auditEventsTable).where(and(
          eq(auditEventsTable.entityId, count.id), eq(auditEventsTable.action, wasteAttributionAction),
        )).limit(1);
        if (previous?.details.jobId !== jobId || previous?.details.crewId !== (crewId ?? null))
          throw new DomainError(409, "This waste adjustment has already been posted with different attribution.");
      }
      return count;
    }
    if (count.status !== "Pending") throw new DomainError(409, "This count was dismissed. Record a new count to adjust stock.");
    const [job] = jobId ? await tx.select({ id: jobsTable.id, jobNumber: jobsTable.jobNumber }).from(jobsTable).where(eq(jobsTable.id, jobId)).for("key share") : [];
    if (jobId && !job) throw new DomainError(404, "The waste job was not found.");
    const crew = jobId && crewId ? (await wasteCrews(tx, jobId)).find(({ id }) => id === crewId) : undefined;
    if (crewId && !crew) throw new DomainError(400, "Choose a crew with a confirmed booking or recorded labor for this job.");
    await lockStockProduct(tx, count.productId);
    const current = await snapshot(tx, count);
    if (count.snapshotKey !== current.snapshotKey)
      throw new DomainError(409, "Stock moved after this count was submitted. Dismiss it and record a fresh count.");

    const delta = roundStock(count.countedQuantity - count.bookedQuantity);
    const now = new Date().toISOString();
    let movementId: string | null = null;
    if (delta !== 0) {
      let costAllocations = null;
      if (delta < 0) {
        await assertBinWithdrawal(tx, count.productId, count.warehouseId, count.binId, -delta, true);
        await assertWarehouseReservations(tx, count, -delta);
        const { slices } = await withdrawStockCosts(tx, count, -delta);
        costAllocations = slices.length ? slices : null;
      }
      movementId = randomUUID();
      await ensureOpeningMovement(tx, current.product, now);
      await tx.insert(inventoryMovementsTable).values({
        id: movementId, productId: count.productId, warehouseId: count.warehouseId, binId: count.binId, jobId: job?.id,
        quantity: delta, kind: "adjustment", reason: `Stock count (${count.reason}) · ${count.note}`,
        costAllocations, actorUserId: actor.userId, idempotencyKey: `stock-count:${count.id}`, createdAt: now,
      });
      await updateStockTotal(tx, current.product, delta, now);
      if (job) await audit(wasteAttributionAction, {
        userId: actor.userId, entityType: "stock_count", entityId: count.id, ip: req.ip,
        details: { jobId: job.id, jobNumber: job.jobNumber, crewId: crew?.id ?? null, crewName: crew?.name ?? null },
      }, tx);
    }
    const [saved] = await tx.update(table).set({
      status: "Reconciled", movementId, resolvedAt: now, resolvedBy: actor.userId, reviewerName: actor.name,
    }).where(eq(table.id, count.id)).returning();
    return saved;
  });
  res.json(presentCount(row));
}));

router.post(`${path}/:id/dismiss`, requireOwner, domainRoute(async (req, res) => {
  const { note } = parse(dismiss, req.body);
  const table = inventoryStockCountsTable;
  const actor = req.auth!;
  const row = await db.transaction(async (tx) => {
    const [count] = await tx.select().from(table).where(eq(table.id, id(req))).for("update");
    if (!count) throw new DomainError(404, "Stock count not found.");
    if (count.status === "Dismissed" && count.resolutionNote === note) return count;
    if (count.status !== "Pending") throw new DomainError(409, "This count has already been resolved.");
    const [saved] = await tx.update(table).set({
      status: "Dismissed", resolvedBy: actor.userId, reviewerName: actor.name,
      resolvedAt: new Date().toISOString(), resolutionNote: note,
    }).where(eq(table.id, count.id)).returning();
    return saved;
  });
  res.json(presentCount(row));
}));

export default router;
