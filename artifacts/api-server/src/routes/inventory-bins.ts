import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  inventoryMovementsTable,
  productsTable,
  warehouseBinsTable,
} from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { domainRoute, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { placeStockCosts, withdrawStockCosts } from "../lib/inventory-costing";
import {
  assertBinWithdrawal,
  binBalances,
  lockStockProduct,
  roundStock,
  verifyBin,
  verifyWarehouse,
} from "../lib/inventory-stock";

const router = Router();
const inventoryWrite = requireRole("owner", "operations");
const identifier = z.string().min(1).max(200);
const binCode = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !/[\p{Cc}]/u.test(value));
const moveRequest = z.object({
  warehouseId: identifier,
  productId: identifier,
  fromBinId: identifier.nullable(),
  toBinId: identifier.nullable(),
  quantity: z.number().min(0.000001).max(1_000_000),
  reason: z.string().trim().min(1).max(2000),
  idempotencyKey: z.string().min(8).max(200),
});

router.get(
  "/inventory/bins",
  inventoryWrite,
  domainRoute(async (req, res) => {
    const { warehouseId } = parse(
      z.object({ warehouseId: identifier.optional() }),
      req.query,
    );
    const bins = await db
      .select({
        id: warehouseBinsTable.id,
        warehouseId: warehouseBinsTable.warehouseId,
        code: warehouseBinsTable.code,
      })
      .from(warehouseBinsTable)
      .where(
        warehouseId
          ? eq(warehouseBinsTable.warehouseId, warehouseId)
          : undefined,
      )
      .orderBy(
        asc(warehouseBinsTable.warehouseId),
        asc(warehouseBinsTable.code),
      );
    res.json(bins);
  }),
);

router.post(
  "/inventory/bins",
  inventoryWrite,
  domainRoute(async (req, res) => {
    const data = parse(
      z.object({ warehouseId: identifier, code: binCode }),
      req.body,
    );
    const now = new Date().toISOString();
    const bin = await db.transaction(async (tx) => {
      await verifyWarehouse(tx, data.warehouseId);
      const [row] = await tx
        .insert(warehouseBinsTable)
        .values({ id: randomUUID(), ...data, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning({
          id: warehouseBinsTable.id,
          warehouseId: warehouseBinsTable.warehouseId,
          code: warehouseBinsTable.code,
        });
      if (!row)
        throw new DomainError(
          409,
          "This bin code is already in use at the warehouse.",
        );
      return row;
    });
    res.status(201).json(bin);
  }),
);

router.get(
  "/inventory/bin-stock",
  inventoryWrite,
  domainRoute(async (req, res) => {
    const filters = parse(
      z.object({
        warehouseId: identifier.optional(),
        productId: identifier.optional(),
      }),
      req.query,
    );
    if (!filters.warehouseId && !filters.productId)
      throw new DomainError(
        400,
        "Choose a warehouse or product to look up bin stock.",
      );
    const balances = await binBalances(db, filters);
    res.json(
      balances
        .map((row) => ({ ...row, onHand: roundStock(row.onHand) }))
        .filter((row) => row.onHand !== 0),
    );
  }),
);

router.post(
  "/inventory/bin-moves",
  inventoryWrite,
  domainRoute(async (req, res) => {
    const data = parse(moveRequest, req.body);
    if (data.fromBinId === data.toBinId)
      throw new DomainError(400, "Choose two different bin locations.");
    const key = createHash("sha256").update(data.idempotencyKey).digest("hex");
    const outKey = `bin-move:${key}:out`;
    const inKey = `bin-move:${key}:in`;
    const result = await db.transaction(async (tx) => {
      await lockStockProduct(tx, data.productId);
      const existing = await tx
        .select()
        .from(inventoryMovementsTable)
        .where(
          inArray(inventoryMovementsTable.idempotencyKey, [outKey, inKey]),
        );
      if (existing.length) {
        const out = existing.find((row) => row.idempotencyKey === outKey);
        const into = existing.find((row) => row.idempotencyKey === inKey);
        if (
          out?.kind !== "bin_out" ||
          into?.kind !== "bin_in" ||
          out.productId !== data.productId ||
          out.warehouseId !== data.warehouseId ||
          out.binId !== data.fromBinId ||
          into.binId !== data.toBinId ||
          -out.quantity !== data.quantity ||
          out.reason !== data.reason
        ) {
          throw new DomainError(
            409,
            "This request key was already used for a different bin move.",
          );
        }
        return { id: out.id };
      }
      const [product] = await tx
        .select({ inventoryType: productsTable.inventoryType })
        .from(productsTable)
        .where(eq(productsTable.id, data.productId))
        .for("update");
      if (product?.inventoryType !== "Inventory")
        throw new DomainError(400, "Choose a stocked inventory product.");
      await verifyWarehouse(tx, data.warehouseId);
      await verifyBin(tx, data.warehouseId, data.fromBinId);
      await verifyBin(tx, data.warehouseId, data.toBinId);
      await assertBinWithdrawal(
        tx,
        data.productId,
        data.warehouseId,
        data.fromBinId,
        data.quantity,
        true,
      );
      const common = {
        productId: data.productId,
        warehouseId: data.warehouseId,
        reason: data.reason,
        actorUserId: req.auth!.userId,
        createdAt: new Date().toISOString(),
      };
      const moveId = randomUUID();
      const incomingId = randomUUID();
      const location = { productId: data.productId, warehouseId: data.warehouseId };
      const costs = await withdrawStockCosts(tx, { ...location, binId: data.fromBinId }, data.quantity);
      const incoming = await placeStockCosts(tx, { ...location, binId: data.toBinId }, incomingId, data.quantity, costs.slices);
      await tx.insert(inventoryMovementsTable).values([
        {
          ...common,
          id: moveId,
          binId: data.fromBinId,
          quantity: -data.quantity,
          costAllocations: costs.slices.length ? costs.slices : null,
          kind: "bin_out",
          idempotencyKey: outKey,
        },
        {
          ...common,
          id: incomingId,
          binId: data.toBinId,
          quantity: data.quantity,
          costAllocations: incoming?.length ? incoming : null,
          kind: "bin_in",
          idempotencyKey: inKey,
        },
      ]);
      return { id: moveId };
    });
    res.status(201).json(result);
  }),
);

export default router;
