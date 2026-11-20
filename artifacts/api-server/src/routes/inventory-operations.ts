import { Router } from "express";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  productsTable,
  jobsTable,
  inventoryMovementsTable,
  inventoryReservationsTable,
  inventoryTransfersTable,
  materialUsageTable,
  warehousesTable,
} from "@workspace/db";
import { validateCallback } from "../lib/entry-references";
import { requireRole } from "../middlewares/auth";
import { domainRoute, parse, revision, id } from "../lib/domain-http";
import {
  assertRevision,
  DomainError,
  movementDelta,
  stockAvailability,
} from "../lib/operations-rules";

const router = Router();
router.use("/inventory", requireRole("owner", "operations"));

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type StockProduct = typeof productsTable.$inferSelect;
const warehouseIdInput = z.string().min(1).nullable().optional();
const requestKey = z.string().min(8).max(200);
const roundStock = (quantity: number) => Math.round(quantity * 1e6) / 1e6;

function namedBalances(tx: Transaction, productId?: string) {
  return tx
    .select({
      productId: inventoryMovementsTable.productId,
      warehouseId: inventoryMovementsTable.warehouseId,
      onHand: sql<number>`sum(${inventoryMovementsTable.quantity}::double precision)`,
    })
    .from(inventoryMovementsTable)
    .where(
      and(
        isNotNull(inventoryMovementsTable.warehouseId),
        productId
          ? eq(inventoryMovementsTable.productId, productId)
          : undefined,
      ),
    )
    .groupBy(
      inventoryMovementsTable.productId,
      inventoryMovementsTable.warehouseId,
    );
}

async function locationAvailability(
  tx: Transaction,
  product: StockProduct,
  warehouseId: string | null,
) {
  const [balances, reservations] = await Promise.all([
    namedBalances(tx, product.id),
    tx
      .select()
      .from(inventoryReservationsTable)
      .where(
        and(
          eq(inventoryReservationsTable.productId, product.id),
          warehouseId === null
            ? isNull(inventoryReservationsTable.warehouseId)
            : eq(inventoryReservationsTable.warehouseId, warehouseId),
        ),
      ),
  ]);
  const onHand =
    warehouseId === null
      ? product.quantityOnHand -
        balances.reduce((sum, balance) => sum + balance.onHand, 0)
      : (balances.find((balance) => balance.warehouseId === warehouseId)
          ?.onHand ?? 0);
  return stockAvailability(roundStock(onHand), reservations);
}

async function verifyWarehouse(tx: Transaction, warehouseId: string | null) {
  if (!warehouseId) return;
  const [warehouse] = await tx
    .select({ id: warehousesTable.id })
    .from(warehousesTable)
    .where(eq(warehousesTable.id, warehouseId));
  if (!warehouse) throw new DomainError(404, "Warehouse not found.");
}

async function ensureOpeningMovement(
  tx: Transaction,
  product: StockProduct,
  now: string,
) {
  const [existing] = await tx
    .select({ id: inventoryMovementsTable.id })
    .from(inventoryMovementsTable)
    .where(eq(inventoryMovementsTable.productId, product.id))
    .limit(1);
  if (existing) return;
  await tx
    .insert(inventoryMovementsTable)
    .values({
      id: randomUUID(),
      productId: product.id,
      quantity: product.quantityOnHand,
      kind: "opening",
      reason: "Legacy opening balance",
      idempotencyKey: `opening:${product.id}`,
      createdAt: now,
    })
    .onConflictDoNothing();
}

async function updateStockTotal(
  tx: Transaction,
  product: StockProduct,
  delta: number,
  now: string,
) {
  await tx
    .update(productsTable)
    .set({
      quantityOnHand: roundStock(product.quantityOnHand + delta),
      revision: product.revision + 1,
      updatedAt: now,
    })
    .where(eq(productsTable.id, product.id));
}

router.get(
  "/inventory/warehouses",
  domainRoute(async (_req, res) => {
    res.json(
      await db
        .select()
        .from(warehousesTable)
        .orderBy(asc(warehousesTable.name)),
    );
  }),
);

router.post(
  "/inventory/warehouses",
  domainRoute(async (req, res) => {
    const { name } = parse(
      z.object({ name: z.string().trim().min(1).max(120) }),
      req.body,
    );
    if (name.toLowerCase() === "unassigned") {
      throw new DomainError(
        400,
        "Choose a different name. Unassigned is used for stock without a confirmed location.",
      );
    }
    const now = new Date().toISOString();
    const [warehouse] = await db
      .insert(warehousesTable)
      .values({
        id: randomUUID(),
        name,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    res.status(201).json(warehouse);
  }),
);

router.get(
  "/inventory/summary",
  domainRoute(async (_req, res) => {
    const [products, reservations, balances] = await db.transaction(
      (tx) =>
        Promise.all([
          tx.select().from(productsTable),
          tx.select().from(inventoryReservationsTable),
          namedBalances(tx),
        ]),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    res.json(
      products.map((p) => {
        const productReservations = reservations.filter(
          (r) => r.productId === p.id,
        );
        const stock = stockAvailability(p.quantityOnHand, productReservations);
        const productBalances = balances.filter(
          (balance) => balance.productId === p.id,
        );
        const unassigned =
          p.quantityOnHand -
          productBalances.reduce((sum, balance) => sum + balance.onHand, 0);
        const locationIds = new Set([
          null,
          ...productBalances.map((balance) => balance.warehouseId),
          ...productReservations.map((reservation) => reservation.warehouseId),
        ]);
        const locations = Array.from(locationIds, (warehouseId) => {
          const onHand =
            warehouseId === null
              ? unassigned
              : (productBalances.find(
                  (balance) => balance.warehouseId === warehouseId,
                )?.onHand ?? 0);
          return {
            warehouseId,
            ...stockAvailability(
              roundStock(onHand),
              productReservations.filter((r) => r.warehouseId === warehouseId),
            ),
          };
        });
        return {
          productId: p.id,
          ...stock,
          locations,
          reorderPoint: p.reorderPoint,
          status:
            p.inventoryType !== "Inventory"
              ? p.inventoryType
              : stock.available <= 0
                ? "Out of Stock"
                : p.reorderPoint === null
                  ? "Threshold not configured"
                  : stock.available <= p.reorderPoint
                    ? "Low Stock"
                    : "In Stock",
        };
      }),
    );
  }),
);
router.get(
  "/inventory/movements",
  domainRoute(async (req, res) => {
    const rows = await db.select().from(inventoryMovementsTable);
    res.json(
      rows
        .filter(
          (r) => !req.query.productId || r.productId === req.query.productId,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }),
);
router.get(
  "/inventory/reservations",
  domainRoute(async (req, res) => {
    const rows = await db.select().from(inventoryReservationsTable);
    res.json(
      rows.filter(
        (r) => !req.query.productId || r.productId === req.query.productId,
      ),
    );
  }),
);
router.post(
  "/inventory/movements",
  domainRoute(async (req, res) => {
    const data = parse(
      z.object({
        productId: z.string().min(1),
        jobId: z.string().min(1).optional(),
        warehouseId: warehouseIdInput,
        returnOfMovementId: z.string().min(1).optional(),
        callbackId: z.string().min(1).optional(),
        kind: z.enum(["receipt", "return", "consume", "adjustment"]),
        quantity: z.number().finite(),
        reason: z.string().trim().min(1).max(2000),
        idempotencyKey: requestKey,
        overrideReason: z.string().trim().min(1).optional(),
      }),
      req.body,
    );
    const warehouseId = data.warehouseId ?? null;
    if (data.returnOfMovementId && (data.kind !== "return" || !data.jobId)) {
      throw new DomainError(
        400,
        "Select the issuing job before linking a return to it.",
      );
    }
    if (
      data.kind === "return" &&
      data.jobId &&
      data.warehouseId !== undefined &&
      !data.returnOfMovementId
    ) {
      throw new DomainError(
        400,
        "Choose the original stock issue for this job return.",
      );
    }
    if (data.callbackId && (!data.jobId || data.kind !== "consume"))
      throw new DomainError(
        400,
        "Callback costs require consumption for a job.",
      );
    if (
      data.overrideReason &&
      (req.auth!.actualRole !== "owner" || req.auth!.previewRole)
    )
      throw new DomainError(
        403,
        "Only the owner outside role preview can record a stock override.",
      );
    if (data.jobId) await validateCallback(data.jobId, data.callbackId);
    const delta = movementDelta(data.kind, data.quantity);
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"inventory:" + data.productId}))`,
      );
      const [duplicate] = await tx
        .select()
        .from(inventoryMovementsTable)
        .where(eq(inventoryMovementsTable.idempotencyKey, data.idempotencyKey));
      if (duplicate) {
        if (
          duplicate.productId !== data.productId ||
          Math.fround(duplicate.quantity) !== Math.fround(delta) ||
          duplicate.kind !== data.kind ||
          duplicate.jobId !== (data.jobId ?? null) ||
          duplicate.warehouseId !== warehouseId ||
          duplicate.returnOfMovementId !== (data.returnOfMovementId ?? null)
        )
          throw new DomainError(
            409,
            "This request key was already used for a different movement.",
          );
        if (data.kind === "consume" && data.jobId) {
          const [usage] = await tx
            .select()
            .from(materialUsageTable)
            .where(eq(materialUsageTable.movementId, duplicate.id));
          if (
            !usage ||
            (usage.callbackId ?? null) !== (data.callbackId ?? null)
          )
            throw new DomainError(
              409,
              "This movement already recorded a different callback cost. Review the saved usage instead of retrying with changed details.",
            );
        }
        return duplicate;
      }
      const [product] = await tx
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, data.productId))
        .for("update");
      if (!product || product.inventoryType !== "Inventory")
        throw new DomainError(400, "Choose a stocked inventory product.");
      await verifyWarehouse(tx, warehouseId);
      if (
        data.jobId &&
        !(
          await tx.select().from(jobsTable).where(eq(jobsTable.id, data.jobId))
        )[0]
      )
        throw new DomainError(404, "Job not found");
      if (data.returnOfMovementId) {
        const [issue] = await tx
          .select()
          .from(inventoryMovementsTable)
          .where(eq(inventoryMovementsTable.id, data.returnOfMovementId));
        if (
          !issue ||
          issue.kind !== "consume" ||
          issue.productId !== product.id ||
          issue.jobId !== data.jobId
        ) {
          throw new DomainError(
            409,
            "The original issue must match the selected SKU and job.",
          );
        }
        const [prior] = await tx
          .select({
            quantity: sql<number>`coalesce(sum(${inventoryMovementsTable.quantity}::double precision), 0)`,
          })
          .from(inventoryMovementsTable)
          .where(eq(inventoryMovementsTable.returnOfMovementId, issue.id));
        if (data.quantity > -issue.quantity - prior.quantity + 0.000001) {
          throw new DomainError(
            409,
            "The return exceeds the remaining quantity from that issue.",
          );
        }
      }
      const { available } = await locationAvailability(
        tx,
        product,
        warehouseId,
      );
      if (
        delta < 0 &&
        available + delta < -0.000001 &&
        !(
          req.auth!.actualRole === "owner" &&
          !req.auth!.previewRole &&
          data.overrideReason
        )
      )
        throw new DomainError(
          409,
          "This movement exceeds unreserved stock at the selected location. Consume a job reservation or choose another location.",
          { available },
        );
      const now = new Date().toISOString();
      await ensureOpeningMovement(tx, product, now);
      const [row] = await tx
        .insert(inventoryMovementsTable)
        .values({
          id: randomUUID(),
          productId: product.id,
          jobId: data.jobId,
          warehouseId,
          returnOfMovementId: data.returnOfMovementId,
          quantity: delta,
          kind: data.kind,
          reason: data.overrideReason
            ? `${data.reason}\nOwner override: ${data.overrideReason}`
            : data.reason,
          actorUserId: req.auth!.userId,
          idempotencyKey: data.idempotencyKey,
          createdAt: now,
        })
        .returning();
      if (data.kind === "consume" && data.jobId)
        await tx.insert(materialUsageTable).values({
          id: randomUUID(),
          jobId: data.jobId,
          productId: product.id,
          movementId: row.id,
          callbackId: data.callbackId,
          material: product.name,
          quantity: data.quantity,
          cost: Math.round(data.quantity * product.cost * 100) / 100,
          notes: data.reason,
          createdAt: now,
        });
      await updateStockTotal(tx, product, delta, now);
      return row;
    });
    res.status(201).json(result);
  }),
);
router.post(
  "/inventory/reservations",
  domainRoute(async (req, res) => {
    const data = parse(
      z.object({
        productId: z.string().min(1),
        jobId: z.string().min(1),
        warehouseId: warehouseIdInput,
        quantity: z.number().finite().positive(),
        idempotencyKey: requestKey,
      }),
      req.body,
    );
    const warehouseId = data.warehouseId ?? null;
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"inventory:" + data.productId}))`,
      );
      const [duplicate] = await tx
        .select()
        .from(inventoryReservationsTable)
        .where(
          eq(inventoryReservationsTable.idempotencyKey, data.idempotencyKey),
        );
      if (duplicate) {
        if (
          duplicate.productId !== data.productId ||
          duplicate.jobId !== data.jobId ||
          Math.fround(duplicate.quantity) !== Math.fround(data.quantity) ||
          duplicate.warehouseId !== warehouseId
        )
          throw new DomainError(
            409,
            "Request key already used for another reservation.",
          );
        return duplicate;
      }
      const [product] = await tx
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, data.productId))
        .for("update");
      if (!product || product.inventoryType !== "Inventory")
        throw new DomainError(400, "Choose a stocked product.");
      await verifyWarehouse(tx, warehouseId);
      if (
        !(
          await tx.select().from(jobsTable).where(eq(jobsTable.id, data.jobId))
        )[0]
      )
        throw new DomainError(404, "Job not found");
      const stock = await locationAvailability(tx, product, warehouseId);
      if (data.quantity > stock.available + 0.000001)
        throw new DomainError(
          409,
          "There is not enough available stock at the selected location.",
          stock,
        );
      const now = new Date().toISOString();
      const [row] = await tx
        .insert(inventoryReservationsTable)
        .values({
          id: randomUUID(),
          ...data,
          warehouseId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return row;
    });
    res.status(201).json(result);
  }),
);
router.patch(
  "/inventory/reservations/:id",
  domainRoute(async (req, res) => {
    const data = parse(
      z.object({
        revision,
        status: z.enum(["Released", "Consumed"]),
        callbackId: z.string().min(1).optional(),
      }),
      req.body,
    );
    if (data.callbackId && data.status !== "Consumed")
      throw new DomainError(
        400,
        "Callback costs apply only when reserved stock is consumed.",
      );
    const result = await db.transaction(async (tx) => {
      const [initial] = await tx
        .select()
        .from(inventoryReservationsTable)
        .where(eq(inventoryReservationsTable.id, id(req)));
      if (!initial) throw new DomainError(404, "Reservation not found");
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"inventory:" + initial.productId}))`,
      );
      const [current] = await tx
        .select()
        .from(inventoryReservationsTable)
        .where(eq(inventoryReservationsTable.id, id(req)))
        .for("update");
      if (current.status === data.status) {
        if (data.status === "Consumed") {
          const [movement] = await tx
            .select()
            .from(inventoryMovementsTable)
            .where(
              eq(
                inventoryMovementsTable.idempotencyKey,
                "reservation:" + current.id,
              ),
            );
          const [usage] = movement
            ? await tx
                .select()
                .from(materialUsageTable)
                .where(eq(materialUsageTable.movementId, movement.id))
            : [];
          if (
            !usage ||
            (usage.callbackId ?? null) !== (data.callbackId ?? null)
          )
            throw new DomainError(
              409,
              "This reservation already recorded a different callback cost. Review the saved usage instead of retrying with changed details.",
            );
        }
        return current;
      }
      assertRevision(current.revision, data.revision);
      if (current.status !== "Active")
        throw new DomainError(409, "This reservation has already been closed.");
      const now = new Date().toISOString();
      if (data.status === "Consumed") {
        await validateCallback(current.jobId, data.callbackId);
        const [product] = await tx
          .select()
          .from(productsTable)
          .where(eq(productsTable.id, current.productId))
          .for("update");
        if (
          !product ||
          (await locationAvailability(tx, product, current.warehouseId))
            .onHand +
            0.000001 <
            current.quantity
        )
          throw new DomainError(
            409,
            "Reserved material is no longer on hand; reconcile stock first.",
          );
        await ensureOpeningMovement(tx, product, now);
        const [movement] = await tx
          .insert(inventoryMovementsTable)
          .values({
            id: randomUUID(),
            productId: product.id,
            jobId: current.jobId,
            warehouseId: current.warehouseId,
            quantity: -current.quantity,
            kind: "consume",
            reason: "Consumed job reservation",
            actorUserId: req.auth!.userId,
            idempotencyKey: "reservation:" + current.id,
            createdAt: now,
          })
          .returning();
        await tx.insert(materialUsageTable).values({
          id: randomUUID(),
          jobId: current.jobId,
          productId: product.id,
          movementId: movement.id,
          callbackId: data.callbackId,
          material: product.name,
          quantity: current.quantity,
          cost: Math.round(current.quantity * product.cost * 100) / 100,
          notes: "Consumed reserved stock",
          createdAt: now,
        });
        await updateStockTotal(tx, product, -current.quantity, now);
      }
      const [row] = await tx
        .update(inventoryReservationsTable)
        .set({
          status: data.status,
          revision: current.revision + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(inventoryReservationsTable.id, current.id),
            eq(inventoryReservationsTable.status, "Active"),
          ),
        )
        .returning();
      return row;
    });
    res.json(result);
  }),
);

router.get(
  "/inventory/transfers",
  domainRoute(async (req, res) => {
    const { productId } = parse(
      z.object({ productId: z.string().min(1) }),
      req.query,
    );
    const transfers = await db
      .select()
      .from(inventoryTransfersTable)
      .where(eq(inventoryTransfersTable.productId, productId))
      .orderBy(desc(inventoryTransfersTable.createdAt));
    res.json(transfers);
  }),
);

type Transfer = typeof inventoryTransfersTable.$inferSelect;

async function recordTransferMovement(
  tx: Transaction,
  transfer: Transfer,
  kind: "transfer_out" | "transfer_in",
  actorUserId: string,
  now: string,
) {
  const dispatch = kind === "transfer_out";
  await tx.insert(inventoryMovementsTable).values({
    id: randomUUID(),
    productId: transfer.productId,
    warehouseId: dispatch
      ? transfer.sourceWarehouseId
      : transfer.destinationWarehouseId,
    transferId: transfer.id,
    quantity: dispatch ? -transfer.quantity : transfer.quantity,
    kind,
    reason: transfer.reason,
    actorUserId,
    idempotencyKey: `transfer:${transfer.id}:${kind}`,
    createdAt: now,
  });
}

router.post(
  "/inventory/transfers",
  domainRoute(async (req, res) => {
    const data = parse(
      z.object({
        productId: z.string().min(1),
        sourceWarehouseId: z.string().min(1).nullable(),
        destinationWarehouseId: z.string().min(1),
        quantity: z
          .number()
          .min(0.000001)
          .refine((value) => Number.isFinite(Math.fround(value))),
        reason: z.string().trim().min(1).max(2000),
        idempotencyKey: requestKey,
      }),
      req.body,
    );
    if (data.sourceWarehouseId === data.destinationWarehouseId) {
      throw new DomainError(400, "Choose two different warehouses.");
    }
    const actor = req.auth!.userId;
    const transfer = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"inventory:" + data.productId}))`,
      );
      const [prior] = await tx
        .select()
        .from(inventoryTransfersTable)
        .where(eq(inventoryTransfersTable.idempotencyKey, data.idempotencyKey));
      if (prior) {
        if (
          prior.productId !== data.productId ||
          prior.sourceWarehouseId !== data.sourceWarehouseId ||
          prior.destinationWarehouseId !== data.destinationWarehouseId ||
          Math.fround(prior.quantity) !== Math.fround(data.quantity) ||
          prior.reason !== data.reason
        ) {
          throw new DomainError(
            409,
            "This request key was already used for a different transfer.",
          );
        }
        return prior;
      }
      const [product] = await tx
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, data.productId))
        .for("update");
      if (!product || product.inventoryType !== "Inventory") {
        throw new DomainError(400, "Choose a stocked inventory product.");
      }
      await verifyWarehouse(tx, data.sourceWarehouseId);
      await verifyWarehouse(tx, data.destinationWarehouseId);
      const stock = await locationAvailability(
        tx,
        product,
        data.sourceWarehouseId,
      );
      if (data.quantity > stock.available + 0.000001) {
        throw new DomainError(
          409,
          "There is not enough unreserved stock at the source location.",
          stock,
        );
      }
      // Assigning a counted legacy balance changes its location without moving goods.
      const assignment = data.sourceWarehouseId === null;
      const now = new Date().toISOString();
      await ensureOpeningMovement(tx, product, now);
      const [row] = await tx
        .insert(inventoryTransfersTable)
        .values({
          id: randomUUID(),
          ...data,
          status: assignment ? "Received" : "In transit",
          dispatchedBy: actor,
          receivedBy: assignment ? actor : null,
          receivedAt: assignment ? now : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await recordTransferMovement(tx, row, "transfer_out", actor, now);
      if (assignment)
        await recordTransferMovement(tx, row, "transfer_in", actor, now);
      await updateStockTotal(tx, product, assignment ? 0 : -row.quantity, now);
      return row;
    });
    res.status(201).json(transfer);
  }),
);

router.post(
  "/inventory/transfers/:id/receive",
  domainRoute(async (req, res) => {
    const actor = req.auth!.userId;
    const transfer = await db.transaction(async (tx) => {
      const [initial] = await tx
        .select()
        .from(inventoryTransfersTable)
        .where(eq(inventoryTransfersTable.id, id(req)));
      if (!initial) throw new DomainError(404, "Transfer not found.");
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"inventory:" + initial.productId}))`,
      );
      const [current] = await tx
        .select()
        .from(inventoryTransfersTable)
        .where(eq(inventoryTransfersTable.id, initial.id))
        .for("update");
      if (current.status === "Received") return current;
      const [product] = await tx
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, current.productId))
        .for("update");
      const now = new Date().toISOString();
      await recordTransferMovement(tx, current, "transfer_in", actor, now);
      await updateStockTotal(tx, product, current.quantity, now);
      const [row] = await tx
        .update(inventoryTransfersTable)
        .set({
          status: "Received",
          receivedBy: actor,
          receivedAt: now,
          updatedAt: now,
        })
        .where(eq(inventoryTransfersTable.id, current.id))
        .returning();
      return row;
    });
    res.json(transfer);
  }),
);

export default router;
