import { Router } from "express";
import { checkPieceMovementRetry, pieceForMovement, savePieceMovement } from "../lib/physical-pieces";
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
  supplierProductAliasesTable,
  warehousesTable,
  type InventoryCostSlice,
} from "@workspace/db";
import { validateCallback } from "../lib/entry-references";
import {
  allocatedIssueCents,
  allocatedIssueUnitCost,
  returnCreditCents,
} from "../lib/inventory-issue-cost";
import {
  acquisitionCostSlice,
  inventoryAcquisitionValue,
  inventoryUnitCostPattern,
  normalizeInventoryUnitCost,
  placeStockCosts,
  sliceCostLayers,
  withdrawStockCosts,
} from "../lib/inventory-costing";
import { requireRole } from "../middlewares/auth";
import {
  assertBinWithdrawal,
  ensureOpeningMovement,
  lockStockProduct,
  roundStock,
  updateStockTotal,
  verifyBin,
  verifyWarehouse,
  type StockProduct,
  type StockTransaction as Transaction,
} from "../lib/inventory-stock";
import { domainRoute, parse, revision, id } from "../lib/domain-http";
import {
  assertRevision,
  DomainError,
  movementDelta,
  stockAvailability,
} from "../lib/operations-rules";

const router = Router();
router.use("/inventory", requireRole("owner", "operations"));

const warehouseIdInput = z.string().min(1).nullable().optional();
const binIdInput = z.string().min(1).max(200).nullable().optional();
const requestKey = z.string().min(8).max(200);
const productLabelCode = z.string().trim().min(1).max(512);
const finiteStockRange = (quantity: number) => Number.isFinite(Math.fround(quantity));

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

async function verifyProductLabel(
  reader: Pick<typeof db, "execute">,
  productId: string,
  labelCode: string,
) {
  const normalized = labelCode.toLowerCase();
  const { rows } = await reader.execute<{ productId: string }>(sql`
    SELECT ${productsTable.id} AS "productId"
    FROM ${productsTable}
    WHERE lower(btrim(${productsTable.sku})) = ${normalized}
    UNION
    SELECT ${supplierProductAliasesTable.productId}
    FROM ${supplierProductAliasesTable}
    WHERE ${supplierProductAliasesTable.supplierSkuKey} = ${normalized}
      OR lower(btrim(${supplierProductAliasesTable.manufacturerPartNumber})) = ${normalized}
    LIMIT 2
  `);
  if (rows.length > 1)
    throw new DomainError(
      409,
      "This label matches multiple products. Use the unique internal SKU or correct the catalog mapping.",
    );
  if (!rows.length)
    throw new DomainError(
      409,
      "This label has no catalog match. Check the code and supplier mapping.",
    );
  if (rows[0].productId !== productId)
    throw new DomainError(
      409,
      "This label belongs to a different product. Check the stock before recording the issue.",
    );
}

function issueUnitCostFor(product: StockProduct) {
  if (!Number.isFinite(product.cost) || product.cost < 0) {
    throw new DomainError(
      409,
      "Set a valid catalog cost before issuing this product to a job.",
    );
  }
  return String(product.cost);
}

function priceJobIssue(product: StockProduct, movementId: string, quantity: number, now: string, costs: Awaited<ReturnType<typeof withdrawStockCosts>>) {
  const allocations = [...costs.slices];
  if (costs.untracked > 0)
    allocations.unshift(acquisitionCostSlice(movementId, costs.untracked, issueUnitCostFor(product), now, "catalog"));
  const cents = allocatedIssueCents(allocations);
  if (!Number.isSafeInteger(cents)) {
    throw new DomainError(
      409,
      "This material charge exceeds the supported amount.",
    );
  }
  return { allocations, cost: cents / 100, unitCost: allocatedIssueUnitCost(allocations, quantity) };
}

async function calculateReturnCredit(
  tx: Transaction,
  issue: typeof inventoryMovementsTable.$inferSelect,
  quantity: number,
) {
  const issuedQuantity = -issue.quantity;
  const matchingCharges = await tx
    .select()
    .from(materialUsageTable)
    .where(eq(materialUsageTable.movementId, issue.id))
    .limit(2);
  const [charge] = matchingCharges;
  const postedCents = Math.round((charge?.cost ?? NaN) * 100);
  if (
    matchingCharges.length !== 1 ||
    !charge ||
    charge.jobId !== issue.jobId ||
    charge.productId !== issue.productId ||
    issuedQuantity <= 0 ||
    !Number.isFinite(issuedQuantity) ||
    charge.quantity !== issuedQuantity ||
    !Number.isSafeInteger(postedCents) ||
    postedCents < 0
  ) {
    throw new DomainError(
      409,
      "The original issue has no verifiable material charge. Review its stock and job history before returning it.",
    );
  }

  const earlierReturns = await tx
    .select({
      id: inventoryMovementsTable.id,
      quantity: inventoryMovementsTable.quantity,
      usage: materialUsageTable,
    })
    .from(inventoryMovementsTable)
    .leftJoin(
      materialUsageTable,
      eq(materialUsageTable.movementId, inventoryMovementsTable.id),
    )
    .where(eq(inventoryMovementsTable.returnOfMovementId, issue.id));
  if (
    new Set(earlierReturns.map((row) => row.id)).size !== earlierReturns.length
  ) {
    throw new DomainError(
      409,
      "A prior return has more than one material credit. Review its history before adding another.",
    );
  }
  const earlierQuantity = earlierReturns.reduce(
    (sum, row) => sum + row.quantity,
    0,
  );
  const remainingQuantity = roundStock(issuedQuantity - earlierQuantity);
  if (issue.costAllocations ? roundStock(quantity) > remainingQuantity : quantity > remainingQuantity + 0.000001) {
    throw new DomainError(
      409,
      "The return exceeds the remaining quantity from that issue.",
    );
  }

  let creditedQuantity = 0;
  let creditedCents = 0;
  for (const row of earlierReturns) {
    // Returns written before costing was enabled already restored stock. Their job costs remain as recorded.
    if (!row.usage) continue;
    const cents = Math.round(-row.usage.cost * 100);
    if (
      row.usage.jobId !== charge.jobId ||
      row.usage.productId !== charge.productId ||
      row.usage.quantity !== -row.quantity ||
      !Number.isSafeInteger(cents) ||
      cents < 0
    ) {
      throw new DomainError(
        409,
        "A prior return has an unverifiable material credit. Review its history before adding another.",
      );
    }
    creditedQuantity += row.quantity;
    creditedCents += cents;
  }
  if (creditedCents > postedCents) {
    throw new DomainError(
      409,
      "Previous returns already exceed the original material charge.",
    );
  }

  const nextQuantity = roundStock(creditedQuantity + quantity);
  if (issue.costAllocations) {
    // Partial returns relieve the most recently issued lots first. Full returns reverse the posted cents exactly.
    const restored = sliceCostLayers(issue.costAllocations, earlierQuantity, earlierQuantity + quantity, true);
    const target = nextQuantity >= roundStock(issuedQuantity)
      ? postedCents
      : allocatedIssueCents(sliceCostLayers(issue.costAllocations, 0, nextQuantity, true));
    return { charge, allocations: restored, amount: Math.max(0, Math.min(postedCents, target) - creditedCents) / 100 };
  }
  const rate = issue.issueUnitCost ?? String(postedCents / 100 / issuedQuantity);
  const allocations = [acquisitionCostSlice(issue.id, quantity, rate, issue.createdAt, "historical_issue")];
  const amount = returnCreditCents({ issuedQuantity, postedCents, issueUnitCost: issue.issueUnitCost, creditedQuantity: nextQuantity, creditedCents }) / 100;
  return { charge, allocations, amount };
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
    const [products, reservations, balances, valuation] = await db.transaction(
      (tx) =>
        Promise.all([
          tx.select().from(productsTable),
          tx.select().from(inventoryReservationsTable),
          namedBalances(tx),
          inventoryAcquisitionValue(tx),
        ]),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    const acquisitionByLocation = new Map(valuation.map((entry) => [JSON.stringify([entry.productId, entry.warehouseId]), entry]));
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
          const acquisition = acquisitionByLocation.get(JSON.stringify([p.id, warehouseId]));
          const trackedQuantity = roundStock(acquisition?.trackedQuantity ?? 0);
          const unpricedQuantity = Math.max(0, roundStock(onHand - trackedQuantity));
          const cents = Math.round(((acquisition?.trackedValue ?? 0) + unpricedQuantity * p.cost) * 100);
          return {
            warehouseId,
            stockValue: p.inventoryType === "Inventory" && trackedQuantity >= 0 && trackedQuantity <= Math.max(0, roundStock(onHand)) && cents >= 0 && Number.isSafeInteger(cents) ? cents / 100 : null,
            valueEstimated: unpricedQuantity > 0,
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
          stockValue: locations.every((location) => location.stockValue !== null)
            ? Math.round(locations.reduce((sum, location) => sum + (location.stockValue ?? 0), 0) * 100) / 100
            : null,
          valueEstimated: locations.some((location) => location.valueEstimated),
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
    const { productId, jobId } = parse(z.object({
      productId: z.string().min(1).max(200).optional(),
      jobId: z.string().min(1).max(200).optional(),
    }), req.query);
    res.json(await db.select().from(inventoryReservationsTable).where(and(
      productId ? eq(inventoryReservationsTable.productId, productId) : undefined,
      jobId ? eq(inventoryReservationsTable.jobId, jobId) : undefined,
    )));
  }),
);
router.post(
  "/inventory/verify-product-label",
  domainRoute(async (req, res) => {
    const { productId, labelCode } = parse(
      z.object({ productId: z.string().min(1), labelCode: productLabelCode }),
      req.body,
    );
    await verifyProductLabel(db, productId, labelCode);
    res.json({ matched: true });
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
        binId: binIdInput,
        returnOfMovementId: z.string().min(1).optional(),
        callbackId: z.string().min(1).optional(),
        labelCode: productLabelCode.optional(),
        physicalPieceId: z.string().min(1).max(200).optional(),
        pieceRevision: z.number().int().positive().optional(),
        returnLengthInches: z.number().min(0.001).max(120000)
          .refine((value) => Math.round(value * 1000) / 1000 === value).optional(),
        kind: z.enum(["receipt", "return", "consume", "adjustment"]),
        quantity: z.number().finite().refine(finiteStockRange),
        unitCost: z.string().trim().regex(inventoryUnitCostPattern).transform(normalizeInventoryUnitCost).optional(),
        reason: z.string().trim().min(1).max(2000),
        idempotencyKey: requestKey,
        overrideReason: z.string().trim().min(1).optional(),
      }),
      req.body,
    );
    const warehouseId = data.warehouseId ?? null;
    const binId = data.binId ?? null;
    if ((data.pieceRevision !== undefined || data.returnLengthInches !== undefined) && !data.physicalPieceId)
      throw new DomainError(400, "Choose the stock piece for these measurements.");
    if (data.returnLengthInches !== undefined && data.kind !== "return")
      throw new DomainError(400, "A measured return length is valid only for returns.");
    if (data.physicalPieceId && data.overrideReason)
      throw new DomainError(400, "Reconcile reserved stock before issuing a labeled piece.");
    const pieceInput = { ...data, warehouseId, binId };
    if (data.unitCost !== undefined && data.kind !== "receipt")
      throw new DomainError(400, "An acquisition cost applies only to a stock receipt.");
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
    if (data.labelCode && data.kind !== "consume")
      throw new DomainError(400, "Label verification applies to stock issues.");
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
      await lockStockProduct(tx, data.productId);
      if (data.labelCode)
        await verifyProductLabel(tx, data.productId, data.labelCode);
      const [duplicate] = await tx
        .select()
        .from(inventoryMovementsTable)
        .where(eq(inventoryMovementsTable.idempotencyKey, data.idempotencyKey));
      if (duplicate) {
        if (
          duplicate.productId !== data.productId ||
          duplicate.quantity !== delta ||
          duplicate.kind !== data.kind ||
          duplicate.jobId !== (data.jobId ?? null) ||
          duplicate.warehouseId !== warehouseId ||
          duplicate.binId !== binId ||
          duplicate.acquisitionUnitCost !== (data.unitCost ?? null) ||
          duplicate.returnOfMovementId !== (data.returnOfMovementId ?? null)
        )
          throw new DomainError(
            409,
            "This request key was already used for a different movement.",
          );
        await checkPieceMovementRetry(tx, duplicate.id, pieceInput, req.auth!.userId);
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
      await verifyBin(tx, warehouseId, binId);
      if (
        data.jobId &&
        !(
          await tx.select().from(jobsTable).where(eq(jobsTable.id, data.jobId))
        )[0]
      )
        throw new DomainError(404, "Job not found");
      const piece = await pieceForMovement(tx, pieceInput);
      let returnCredit:
        | Awaited<ReturnType<typeof calculateReturnCredit>>
        | undefined;
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
        returnCredit = await calculateReturnCredit(tx, issue, data.quantity);
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
      if (delta < 0) await assertBinWithdrawal(tx, product.id, warehouseId, binId, -delta, !!piece, piece?.id);
      const issuingJob = data.kind === "consume" ? data.jobId : undefined;
      await ensureOpeningMovement(tx, product, now);
      const movementId = randomUUID();
      const location = { productId: product.id, warehouseId, binId };
      let allocations: InventoryCostSlice[] | null = null;
      let jobCost: ReturnType<typeof priceJobIssue> | undefined;
      if (delta < 0) {
        const costs = await withdrawStockCosts(tx, location, -delta);
        if (issuingJob) jobCost = priceJobIssue(product, movementId, -delta, now, costs);
        allocations = jobCost?.allocations ?? costs.slices;
      } else if (returnCredit || data.unitCost !== undefined) {
        const incoming = returnCredit?.allocations ?? [acquisitionCostSlice(movementId, delta, data.unitCost!, now, "stock_receipt")];
        allocations = await placeStockCosts(tx, location, movementId, delta, incoming);
      }
      const [row] = await tx
        .insert(inventoryMovementsTable)
        .values({
          id: movementId,
          productId: product.id,
          jobId: data.jobId,
          warehouseId,
          binId,
          returnOfMovementId: data.returnOfMovementId,
          issueUnitCost: jobCost?.unitCost,
          acquisitionUnitCost: data.unitCost,
          costAllocations: allocations?.length ? allocations : null,
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
      if (issuingJob && jobCost)
        await tx.insert(materialUsageTable).values({
          id: randomUUID(),
          jobId: issuingJob,
          productId: product.id,
          movementId: row.id,
          callbackId: data.callbackId,
          material: product.name,
          quantity: -row.quantity,
          cost: jobCost.cost,
          notes: data.reason,
          createdAt: now,
        });
      if (returnCredit) {
        await tx.insert(materialUsageTable).values({
          id: randomUUID(),
          jobId: returnCredit.charge.jobId,
          productId: product.id,
          movementId: row.id,
          callbackId: returnCredit.charge.callbackId,
          material: returnCredit.charge.material,
          quantity: -row.quantity,
          cost: -returnCredit.amount,
          notes: data.reason,
          createdAt: now,
        });
      }
      await updateStockTotal(tx, product, delta, now);
      if (piece) await savePieceMovement(tx, piece, row, pieceInput, req.auth!.userId);
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
        quantity: z.number().finite().positive().refine(finiteStockRange),
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
          duplicate.quantity !== data.quantity ||
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
        binId: binIdInput,
        callbackId: z.string().min(1).optional(),
        labelCode: productLabelCode.optional(),
        physicalPieceId: z.string().min(1).max(200).optional(),
        pieceRevision: z.number().int().positive().optional(),
      }),
      req.body,
    );
    if ((data.physicalPieceId !== undefined || data.pieceRevision !== undefined) &&
      (data.status !== "Consumed" || !data.physicalPieceId || data.pieceRevision === undefined))
      throw new DomainError(400, "Select the stock piece when issuing this reservation.");
    if (data.callbackId && data.status !== "Consumed")
      throw new DomainError(
        400,
        "Callback costs apply only when reserved stock is consumed.",
      );
    if (data.labelCode && data.status !== "Consumed")
      throw new DomainError(
        400,
        "Label verification applies to reservation issues.",
      );
    if (data.binId && data.status !== "Consumed")
      throw new DomainError(400, "Choose a bin only when issuing reserved stock.");
    const result = await db.transaction(async (tx) => {
      const [initial] = await tx
        .select()
        .from(inventoryReservationsTable)
        .where(eq(inventoryReservationsTable.id, id(req)));
      if (!initial) throw new DomainError(404, "Reservation not found");
      await lockStockProduct(tx, initial.productId);
      const [current] = await tx
        .select()
        .from(inventoryReservationsTable)
        .where(eq(inventoryReservationsTable.id, id(req)))
        .for("update");
      if (data.status === "Consumed" && current.stagedBinId && data.binId && data.binId !== current.stagedBinId)
        throw new DomainError(409, "Issue this reservation from its staged bin.");
      const binId = current.stagedBinId ?? data.binId ?? null;
      const pieceInput = {
        physicalPieceId: data.physicalPieceId, pieceRevision: data.pieceRevision, kind: "consume",
        productId: current.productId, jobId: current.jobId, warehouseId: current.warehouseId, binId, quantity: current.quantity,
        reason: "Consumed job reservation",
      };
      if (data.labelCode)
        await verifyProductLabel(tx, current.productId, data.labelCode);
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
          if (movement?.binId !== binId) throw new DomainError(409, "This reservation was already issued from a different bin.");
          await checkPieceMovementRetry(tx, movement.id, pieceInput, req.auth!.userId);
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
        await verifyBin(tx, current.warehouseId, binId);
        const piece = await pieceForMovement(tx, pieceInput);
        await assertBinWithdrawal(tx, product.id, current.warehouseId, binId, current.quantity, !!piece || !!current.stagedBinId, piece?.id, current.id);
        await ensureOpeningMovement(tx, product, now);
        const movementId = randomUUID();
        const location = { productId: product.id, warehouseId: current.warehouseId, binId };
        const costs = await withdrawStockCosts(tx, location, current.quantity);
        const jobCost = priceJobIssue(product, movementId, current.quantity, now, costs);
        const [movement] = await tx
          .insert(inventoryMovementsTable)
          .values({
            id: movementId,
            productId: product.id,
            jobId: current.jobId,
            warehouseId: current.warehouseId,
            binId,
            issueUnitCost: jobCost.unitCost,
            costAllocations: jobCost.allocations,
            quantity: -current.quantity,
            kind: "consume",
            reason: pieceInput.reason,
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
          cost: jobCost.cost,
          notes: "Consumed reserved stock",
          createdAt: now,
        });
        await updateStockTotal(tx, product, -current.quantity, now);
        if (piece) await savePieceMovement(tx, piece, movement, pieceInput, req.auth!.userId);
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
  const movementId = randomUUID();
  const location = {
    productId: transfer.productId,
    warehouseId: dispatch ? transfer.sourceWarehouseId : transfer.destinationWarehouseId,
    binId: dispatch ? transfer.sourceBinId : transfer.destinationBinId,
  };
  let costAllocations: InventoryCostSlice[] | null;
  if (dispatch) {
    costAllocations = (await withdrawStockCosts(tx, location, transfer.quantity)).slices;
  } else {
    const [outgoing] = await tx.select({ allocations: inventoryMovementsTable.costAllocations })
      .from(inventoryMovementsTable).where(eq(inventoryMovementsTable.idempotencyKey, `transfer:${transfer.id}:transfer_out`));
    costAllocations = await placeStockCosts(tx, location, movementId, transfer.quantity, outgoing?.allocations ?? []);
  }
  await tx.insert(inventoryMovementsTable).values({
    id: movementId,
    ...location,
    costAllocations: costAllocations?.length ? costAllocations : null,
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
  "/inventory/reservations/:id/stage",
  domainRoute(async (req, res) => {
    const input = parse(z.object({
      revision,
      sourceBinId: binIdInput,
      destinationWarehouseId: z.string().min(1).max(200),
      destinationBinId: z.string().min(1).max(200),
      quantity: z.number().min(0.000001).max(1_000_000).refine((amount) => roundStock(amount) === amount),
      labelCode: productLabelCode,
      idempotencyKey: requestKey,
    }).strict(), req.body);
    const sourceId = id(req);
    const sourceBinId = input.sourceBinId ?? null;
    const requestId = `stage:${input.idempotencyKey}`;
    const result = await db.transaction(async (tx) => {
      const [initial] = await tx.select({ productId: inventoryReservationsTable.productId })
        .from(inventoryReservationsTable).where(eq(inventoryReservationsTable.id, sourceId));
      if (!initial) throw new DomainError(404, "Reservation not found.");
      await lockStockProduct(tx, initial.productId);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestId}))`);
      const [source] = await tx.select().from(inventoryReservationsTable)
        .where(eq(inventoryReservationsTable.id, sourceId)).for("update");
      const [prior] = await tx.select().from(inventoryTransfersTable)
        .where(eq(inventoryTransfersTable.idempotencyKey, requestId));
      if (prior) {
        const [staged] = await tx.select().from(inventoryReservationsTable)
          .where(eq(inventoryReservationsTable.stagedTransferId, prior.id));
        if (staged?.sourceReservationId !== sourceId || prior.sourceBinId !== sourceBinId ||
          prior.destinationWarehouseId !== input.destinationWarehouseId ||
          prior.destinationBinId !== input.destinationBinId || prior.quantity !== input.quantity)
          throw new DomainError(409, "This request key was used for a different pick.");
        return { source, staged };
      }

      assertRevision(source.revision, input.revision);
      if (source.status !== "Active" || source.stagedBinId || !source.warehouseId)
        throw new DomainError(409, "Choose an active, unstaged reservation in a warehouse.");
      if (input.quantity > source.quantity)
        throw new DomainError(409, "The pick exceeds the remaining reserved quantity.");
      if (source.warehouseId === input.destinationWarehouseId && sourceBinId === input.destinationBinId)
        throw new DomainError(400, "Choose a different bin for staging.");

      await verifyProductLabel(tx, source.productId, input.labelCode);
      await verifyBin(tx, source.warehouseId, sourceBinId);
      await verifyBin(tx, input.destinationWarehouseId, input.destinationBinId);
      await assertBinWithdrawal(tx, source.productId, source.warehouseId, sourceBinId, input.quantity, true);
      const actor = req.auth!.userId;
      const now = new Date().toISOString();
      const [transfer] = await tx.insert(inventoryTransfersTable).values({
        id: randomUUID(),
        productId: source.productId,
        sourceWarehouseId: source.warehouseId,
        sourceBinId,
        destinationWarehouseId: input.destinationWarehouseId,
        destinationBinId: input.destinationBinId,
        quantity: input.quantity,
        reason: "Picked and staged for a job",
        status: "Received",
        idempotencyKey: requestId,
        dispatchedBy: actor,
        receivedBy: actor,
        receivedAt: now,
        createdAt: now,
        updatedAt: now,
      }).returning();
      await recordTransferMovement(tx, transfer, "transfer_out", actor, now);
      await recordTransferMovement(tx, transfer, "transfer_in", actor, now);

      const remaining = roundStock(source.quantity - input.quantity);
      const [updated] = await tx.update(inventoryReservationsTable).set({
        ...(remaining === 0 ? { status: "Released" } : { quantity: remaining }),
        revision: source.revision + 1,
        updatedAt: now,
      }).where(eq(inventoryReservationsTable.id, sourceId)).returning();
      const [staged] = await tx.insert(inventoryReservationsTable).values({
        id: randomUUID(),
        productId: source.productId,
        jobId: source.jobId,
        warehouseId: input.destinationWarehouseId,
        stagedBinId: input.destinationBinId,
        sourceReservationId: sourceId,
        stagedTransferId: transfer.id,
        quantity: input.quantity,
        idempotencyKey: requestId,
        createdAt: now,
        updatedAt: now,
      }).returning();
      return { source: updated, staged };
    });
    res.status(201).json(result);
  }),
);

router.post(
  "/inventory/transfers",
  domainRoute(async (req, res) => {
    const data = parse(
      z.object({
        productId: z.string().min(1),
        sourceWarehouseId: z.string().min(1).nullable(),
        destinationWarehouseId: z.string().min(1),
        sourceBinId: binIdInput,
        quantity: z
          .number()
          .min(0.000001)
          .refine(finiteStockRange),
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
      await lockStockProduct(tx, data.productId);
      const [prior] = await tx
        .select()
        .from(inventoryTransfersTable)
        .where(eq(inventoryTransfersTable.idempotencyKey, data.idempotencyKey));
      if (prior) {
        if (
          prior.productId !== data.productId ||
          prior.sourceWarehouseId !== data.sourceWarehouseId ||
          prior.sourceBinId !== (data.sourceBinId ?? null) ||
          prior.destinationWarehouseId !== data.destinationWarehouseId ||
          prior.quantity !== data.quantity ||
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
      await verifyBin(tx, data.sourceWarehouseId, data.sourceBinId ?? null);
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
      await assertBinWithdrawal(tx, product.id, data.sourceWarehouseId, data.sourceBinId ?? null, data.quantity);
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
    const { destinationBinId } = parse(z.object({ destinationBinId: binIdInput }), req.body ?? {});
    const actor = req.auth!.userId;
    const transfer = await db.transaction(async (tx) => {
      const [initial] = await tx
        .select()
        .from(inventoryTransfersTable)
        .where(eq(inventoryTransfersTable.id, id(req)));
      if (!initial) throw new DomainError(404, "Transfer not found.");
      await lockStockProduct(tx, initial.productId);
      const [current] = await tx
        .select()
        .from(inventoryTransfersTable)
        .where(eq(inventoryTransfersTable.id, initial.id))
        .for("update");
      if (current.status === "Received") {
        if (destinationBinId !== undefined && destinationBinId !== current.destinationBinId) {
          throw new DomainError(409, "This transfer was already received into a different bin.");
        }
        return current;
      }
      const [product] = await tx
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, current.productId))
        .for("update");
      const now = new Date().toISOString();
      const binId = destinationBinId ?? null;
      await verifyBin(tx, current.destinationWarehouseId, binId);
      await recordTransferMovement(tx, { ...current, destinationBinId: binId }, "transfer_in", actor, now);
      await updateStockTotal(tx, product, current.quantity, now);
      const [row] = await tx
        .update(inventoryTransfersTable)
        .set({
          status: "Received",
          destinationBinId: binId,
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
