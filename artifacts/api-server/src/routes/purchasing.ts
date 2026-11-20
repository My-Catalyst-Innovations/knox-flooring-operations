import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  inventoryMovementsTable,
  productsTable,
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  purchaseReceiptsTable,
  purchaseReceiptLinesTable,
  warehouseBinsTable,
} from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { domainRoute, id, parse, revision } from "../lib/domain-http";
import { assertRevision, DomainError } from "../lib/operations-rules";
import {
  ensureOpeningMovement,
  lockStockProduct,
  roundStock,
  updateStockTotal,
  verifyWarehouse,
  type StockTransaction,
} from "../lib/inventory-stock";

const router = Router();
const path = "/inventory/purchase-orders";
router.use(path, requireRole("owner", "operations"));
type Order = typeof purchaseOrdersTable.$inferSelect;
type OrderLine = typeof purchaseOrderLinesTable.$inferSelect;
type Receipt = typeof purchaseReceiptsTable.$inferSelect;
type Reader = Pick<typeof db, "select">;

const identifier = z.string().min(1).max(200);
const requestKey = z.string().min(8).max(200);
const quantity = z
  .number()
  .min(0.000001)
  .max(1_000_000)
  .refine(
    (value) => roundStock(value) === value,
    "Use at most six quantity decimals.",
  );
const cost = z
  .string()
  .trim()
  .regex(
    /^\d{1,12}(?:\.\d{1,6})?$/,
    "Use a nonnegative unit cost with at most six decimals.",
  );
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const micros = (value: string | number) => Math.round(Number(value) * 1e6);
const formatOrderNumber = (number: number) =>
  `PO-${String(number).padStart(6, "0")}`;

const orderLine = z.object({ productId: identifier, quantity, unitCost: cost });
const orderFields = z.object({
  supplier: z.string().trim().min(1).max(200),
  warehouseId: identifier,
  notes: z.string().trim().max(4000).optional(),
  lines: z.array(orderLine).min(1).max(100),
});
const orderEdit = z.union([
  z.object({ revision, status: z.enum(["Ordered", "Cancelled"]) }).strict(),
  orderFields
    .partial()
    .extend({ revision })
    .strict()
    .refine(
      ({ supplier, warehouseId, notes, lines }) =>
        supplier !== undefined ||
        warehouseId !== undefined ||
        notes !== undefined ||
        lines !== undefined,
    ),
]);
const receiptInput = z.object({
  revision,
  idempotencyKey: requestKey,
  reference: z.string().trim().max(200).default(""),
  lines: z
    .array(
      z.object({ lineId: identifier, quantity, binId: identifier.nullable() }),
    )
    .min(1)
    .max(200),
});

async function orderLines(reader: Reader, orderIds: string[]) {
  if (!orderIds.length) return [];
  const line = purchaseOrderLinesTable;
  const receiptLine = purchaseReceiptLinesTable;
  return reader
    .select({
      line,
      received: sql<string>`coalesce(sum(${receiptLine.quantity}), 0)`,
    })
    .from(line)
    .leftJoin(receiptLine, eq(receiptLine.lineId, line.id))
    .where(inArray(line.orderId, orderIds))
    .groupBy(line.id)
    .orderBy(asc(line.position));
}

async function presentOrders(reader: Reader, orders: Order[]) {
  const lines = await orderLines(
    reader,
    orders.map((order) => order.id),
  );
  const byOrder = new Map<string, ReturnType<typeof presentLine>[]>();
  for (const { line, received } of lines) {
    const group = byOrder.get(line.orderId) ?? [];
    group.push(presentLine(line, received));
    byOrder.set(line.orderId, group);
  }
  return orders.map(
    ({
      number,
      requestKey: _requestKey,
      requestHash: _requestHash,
      ...order
    }) => ({
      ...order,
      orderNumber: formatOrderNumber(number),
      lines: byOrder.get(order.id) ?? [],
    }),
  );
}

function presentLine(
  { orderId: _orderId, position: _position, quantity, ...line }: OrderLine,
  received: string,
) {
  return {
    ...line,
    quantity: Number(quantity),
    receivedQuantity: Number(received),
  };
}

async function presentReceipts(reader: Reader, receipts: Receipt[]) {
  if (!receipts.length) return [];
  const line = purchaseReceiptLinesTable;
  const joined = await reader
    .select({
      receiptId: line.receiptId,
      lineId: line.lineId,
      quantity: line.quantity,
      movementId: line.movementId,
      productId: inventoryMovementsTable.productId,
      binId: inventoryMovementsTable.binId,
    })
    .from(line)
    .innerJoin(
      inventoryMovementsTable,
      eq(inventoryMovementsTable.id, line.movementId),
    )
    .where(
      inArray(
        line.receiptId,
        receipts.map((receipt) => receipt.id),
      ),
    )
    .orderBy(asc(line.lineId), asc(line.movementId));
  const byReceipt = new Map<
    string,
    Array<
      Omit<(typeof joined)[number], "receiptId" | "quantity"> & {
        quantity: number;
      }
    >
  >();
  for (const { receiptId, quantity, ...row } of joined) {
    const group = byReceipt.get(receiptId) ?? [];
    group.push({ ...row, quantity: Number(quantity) });
    byReceipt.set(receiptId, group);
  }
  return receipts.map(
    ({ requestKey: _requestKey, requestHash: _requestHash, ...receipt }) => ({
      ...receipt,
      lines: byReceipt.get(receipt.id) ?? [],
    }),
  );
}

async function draftLines(
  tx: StockTransaction,
  orderId: string,
  lines: z.infer<typeof orderLine>[],
) {
  const distinct = [...new Set(lines.map((item) => item.productId))];
  if (distinct.length !== lines.length)
    throw new DomainError(400, "Add each product once per purchase order.");
  const products = await tx
    .select()
    .from(productsTable)
    .where(inArray(productsTable.id, distinct));
  const byId = new Map(products.map((product) => [product.id, product]));
  return lines.map((line, position) => {
    const product = byId.get(line.productId);
    if (!product?.active || product.inventoryType !== "Inventory")
      throw new DomainError(
        400,
        "Choose an active, stocked catalog product for each line.",
      );
    return {
      id: randomUUID(),
      orderId,
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      unit: product.unit,
      position,
      quantity: line.quantity.toFixed(6),
      unitCost: line.unitCost,
    };
  });
}

router.get(
  path,
  domainRoute(async (_req, res) => {
    const orders = await db.transaction(
      async (tx) =>
        presentOrders(
          tx,
          await tx
            .select()
            .from(purchaseOrdersTable)
            .orderBy(desc(purchaseOrdersTable.number)),
        ),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    res.json(orders);
  }),
);

router.post(
  path,
  domainRoute(async (req, res) => {
    const {
      idempotencyKey,
      lines,
      notes = "",
      ...data
    } = parse(
      orderFields.extend({ idempotencyKey: requestKey.optional() }),
      req.body,
    );
    const hash = fingerprint([data, notes, lines]);
    const created = await db.transaction(async (tx) => {
      if (idempotencyKey) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${"purchase-order-create:" + idempotencyKey}))`,
        );
        const [prior] = await tx
          .select()
          .from(purchaseOrdersTable)
          .where(eq(purchaseOrdersTable.requestKey, idempotencyKey));
        if (prior) {
          if (prior.requestHash !== hash)
            throw new DomainError(
              409,
              "This request key was used for a different purchase order.",
            );
          return (await presentOrders(tx, [prior]))[0];
        }
      }
      const orderId = randomUUID();
      await verifyWarehouse(tx, data.warehouseId);
      const items = await draftLines(tx, orderId, lines);
      const now = new Date().toISOString();
      const [order] = await tx
        .insert(purchaseOrdersTable)
        .values({
          id: orderId,
          ...data,
          notes,
          requestKey: idempotencyKey,
          requestHash: idempotencyKey ? hash : undefined,
          createdBy: req.auth!.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await tx.insert(purchaseOrderLinesTable).values(items);
      return (await presentOrders(tx, [order]))[0];
    });
    res.status(201).json(created);
  }),
);

router.patch(
  `${path}/:id`,
  domainRoute(async (req, res) => {
    const { revision: expected, ...change } = parse(orderEdit, req.body);
    const order = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(purchaseOrdersTable)
        .where(eq(purchaseOrdersTable.id, id(req)))
        .for("update");
      if (!current) throw new DomainError(404, "Purchase order not found.");
      assertRevision(current.revision, expected);
      const metadata = {
        updatedAt: new Date().toISOString(),
        revision: current.revision + 1,
      };
      let updates: Partial<Order>;
      if ("status" in change) {
        const { status } = change;
        if (status === "Ordered" && current.status !== "Draft")
          throw new DomainError(409, "Only a draft can be marked ordered.");
        if (
          status === "Cancelled" &&
          !["Draft", "Ordered", "Partially received"].includes(current.status)
        ) {
          throw new DomainError(409, "This purchase order is already closed.");
        }
        updates = { status };
      } else {
        if (current.status !== "Draft")
          throw new DomainError(
            409,
            "Only a draft purchase order can be edited.",
          );
        const { lines, ...fields } = change;
        if (fields.warehouseId) await verifyWarehouse(tx, fields.warehouseId);
        if (lines) {
          const items = await draftLines(tx, current.id, lines);
          await tx
            .delete(purchaseOrderLinesTable)
            .where(eq(purchaseOrderLinesTable.orderId, current.id));
          await tx.insert(purchaseOrderLinesTable).values(items);
        }
        updates = fields;
      }
      const [saved] = await tx
        .update(purchaseOrdersTable)
        .set({ ...updates, ...metadata })
        .where(eq(purchaseOrdersTable.id, current.id))
        .returning();
      return (await presentOrders(tx, [saved]))[0];
    });
    res.json(order);
  }),
);

router.get(
  `${path}/:id/receipts`,
  domainRoute(async (req, res) => {
    res.json(
      await presentReceipts(
        db,
        await db
          .select()
          .from(purchaseReceiptsTable)
          .where(eq(purchaseReceiptsTable.orderId, id(req)))
          .orderBy(desc(purchaseReceiptsTable.receivedAt)),
      ),
    );
  }),
);

router.post(
  `${path}/:id/receive`,
  domainRoute(async (req, res) => {
    const { reference = "", ...input } = parse(receiptInput, req.body);
    const locationKey = (line: { lineId: string; binId: string | null }) =>
      JSON.stringify([line.lineId, line.binId]);
    const locations = input.lines.map(locationKey);
    if (new Set(locations).size !== locations.length)
      throw new DomainError(
        400,
        "Combine counts for the same purchase order line and bin.",
      );
    const hash = fingerprint([
      reference,
      [...input.lines].sort((a, b) =>
        locationKey(a) < locationKey(b) ? -1 : 1,
      ),
    ]);
    const actor = req.auth!.userId;
    const result = await db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(purchaseOrdersTable)
        .where(eq(purchaseOrdersTable.id, id(req)))
        .for("update");
      if (!order) throw new DomainError(404, "Purchase order not found.");
      const [prior] = await tx
        .select()
        .from(purchaseReceiptsTable)
        .where(eq(purchaseReceiptsTable.requestKey, input.idempotencyKey));
      if (prior) {
        if (prior.orderId !== order.id || prior.requestHash !== hash)
          throw new DomainError(
            409,
            "This request key was used for a different receipt.",
          );
        return {
          order: (await presentOrders(tx, [order]))[0],
          receipt: (await presentReceipts(tx, [prior]))[0],
        };
      }
      assertRevision(order.revision, input.revision);
      if (order.status !== "Ordered" && order.status !== "Partially received")
        throw new DomainError(
          409,
          "Mark the purchase order as ordered before receiving stock.",
        );
      const openLines = await orderLines(tx, [order.id]);
      const byLine = new Map(
        openLines.map(({ line, received }) => [
          line.id,
          { line, remaining: micros(line.quantity) - micros(received) },
        ]),
      );
      const binIds = [
        ...new Set(
          input.lines.flatMap((line) => (line.binId ? [line.binId] : [])),
        ),
      ];
      if (binIds.length) {
        const bins = await tx
          .select()
          .from(warehouseBinsTable)
          .where(inArray(warehouseBinsTable.id, binIds));
        if (
          bins.length !== binIds.length ||
          bins.some((bin) => bin.warehouseId !== order.warehouseId)
        ) {
          throw new DomainError(
            409,
            "Choose bins in the purchase order's warehouse.",
          );
        }
      }
      const now = new Date().toISOString();
      const receiptId = randomUUID();
      const stockByProduct = new Map<
        string,
        { quantity: number; unit: string }
      >();
      const receiptLines = input.lines.map((entry) => {
        const item = byLine.get(entry.lineId);
        if (!item)
          throw new DomainError(
            400,
            "A receipt line does not belong to this purchase order.",
          );
        const received = micros(entry.quantity);
        if (received > item.remaining)
          throw new DomainError(
            409,
            `The receipt exceeds the open quantity for ${item.line.productName}.`,
          );
        item.remaining -= received;
        const productId = item.line.productId;
        const affected = stockByProduct.get(productId) ?? {
          quantity: 0,
          unit: item.line.unit,
        };
        affected.quantity += received;
        stockByProduct.set(productId, affected);
        return { ...entry, productId, movementId: randomUUID() };
      });
      const productIds = [...stockByProduct.keys()].sort();
      for (const productId of productIds) await lockStockProduct(tx, productId);
      const products = await tx
        .select()
        .from(productsTable)
        .where(inArray(productsTable.id, productIds))
        .orderBy(asc(productsTable.id))
        .for("update");
      if (
        products.length !== productIds.length ||
        products.some(
          (product) =>
            product.inventoryType !== "Inventory" ||
            product.unit !== stockByProduct.get(product.id)?.unit,
        )
      ) {
        throw new DomainError(
          409,
          "A stocked product or its unit has changed. Reconcile the purchase order before receiving it.",
        );
      }
      for (const product of products)
        await ensureOpeningMovement(tx, product, now);
      const [receipt] = await tx
        .insert(purchaseReceiptsTable)
        .values({
          id: receiptId,
          orderId: order.id,
          reference,
          requestKey: input.idempotencyKey,
          requestHash: hash,
          receivedBy: actor,
          receivedAt: now,
        })
        .returning();
      await tx.insert(inventoryMovementsTable).values(
        receiptLines.map((line) => ({
          id: line.movementId,
          productId: line.productId,
          warehouseId: order.warehouseId,
          binId: line.binId,
          quantity: line.quantity,
          kind: "receipt",
          reason: `Received on ${formatOrderNumber(order.number)}`,
          actorUserId: actor,
          idempotencyKey: `purchase-receipt:${line.movementId}`,
          createdAt: now,
        })),
      );
      await tx.insert(purchaseReceiptLinesTable).values(
        receiptLines.map((line) => ({
          id: randomUUID(),
          receiptId,
          lineId: line.lineId,
          movementId: line.movementId,
          quantity: line.quantity.toFixed(6),
        })),
      );
      for (const product of products)
        await updateStockTotal(
          tx,
          product,
          stockByProduct.get(product.id)!.quantity / 1e6,
          now,
        );
      const status = [...byLine.values()].every((item) => item.remaining === 0)
        ? "Received"
        : "Partially received";
      const [saved] = await tx
        .update(purchaseOrdersTable)
        .set({ status, revision: order.revision + 1, updatedAt: now })
        .where(eq(purchaseOrdersTable.id, order.id))
        .returning();
      return {
        order: (await presentOrders(tx, [saved]))[0],
        receipt: (await presentReceipts(tx, [receipt]))[0],
      };
    });
    res.status(201).json(result);
  }),
);

export default router;
