import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  inventoryMovementsTable,
  inventoryReservationsTable,
  physicalPiecesTable,
  productsTable,
  warehouseBinsTable,
  warehousesTable,
} from "@workspace/db";
import { DomainError } from "./operations-rules";

export type StockTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];
export type StockProduct = typeof productsTable.$inferSelect;
export const roundStock = (quantity: number) =>
  Math.round(quantity * 1e6) / 1e6;

export async function lockStockProduct(
  tx: StockTransaction,
  productId: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"inventory:" + productId}))`,
  );
}

export async function verifyWarehouse(
  tx: StockTransaction,
  warehouseId: string | null,
) {
  if (!warehouseId) return;
  const [warehouse] = await tx
    .select({ id: warehousesTable.id })
    .from(warehousesTable)
    .where(eq(warehousesTable.id, warehouseId));
  if (!warehouse) throw new DomainError(404, "Warehouse not found.");
}

export async function verifyBin(
  tx: StockTransaction,
  warehouseId: string | null,
  binId: string | null,
) {
  if (!binId) return;
  const [bin] = await tx
    .select({
      id: warehouseBinsTable.id,
      warehouseId: warehouseBinsTable.warehouseId,
    })
    .from(warehouseBinsTable)
    .where(eq(warehouseBinsTable.id, binId));
  if (!bin || bin.warehouseId !== warehouseId) {
    throw new DomainError(409, "Choose a bin in the selected warehouse.");
  }
}

export function binBalances(
  reader: Pick<typeof db, "select">,
  filters: { warehouseId?: string; productId?: string },
) {
  const movement = inventoryMovementsTable;
  return reader
    .select({
      productId: movement.productId,
      warehouseId: movement.warehouseId,
      binId: movement.binId,
      onHand: sql<number>`sum(${movement.quantity}::double precision)`,
    })
    .from(movement)
    .where(
      and(
        filters.warehouseId
          ? eq(movement.warehouseId, filters.warehouseId)
          : isNotNull(movement.warehouseId),
        filters.productId
          ? eq(movement.productId, filters.productId)
          : undefined,
      ),
    )
    .groupBy(movement.productId, movement.warehouseId, movement.binId);
}

export async function assertBinWithdrawal(
  tx: StockTransaction,
  productId: string,
  warehouseId: string | null,
  binId: string | null,
  quantity: number,
  strict = false,
  selectedPieceId?: string,
  issuedReservationId?: string,
) {
  if (!warehouseId) return;
  const balances = await binBalances(tx, { productId, warehouseId });
  const onHand = balances.find((row) => row.binId === binId)?.onHand ?? 0;
  const hasBinnedStock = balances.some(
    (row) => row.binId && roundStock(row.onHand) > 0,
  );
  const [pieces] = await tx.select({
    quantity: sql<number>`coalesce(sum(${physicalPiecesTable.quantity}), 0)::double precision`,
  }).from(physicalPiecesTable).where(and(
    eq(physicalPiecesTable.productId, productId),
    eq(physicalPiecesTable.warehouseId, warehouseId),
    sql`${physicalPiecesTable.binId} IS NOT DISTINCT FROM ${binId}::text`,
    sql`${physicalPiecesTable.issuedMovementId} IS NULL`,
    selectedPieceId ? sql`${physicalPiecesTable.id} <> ${selectedPieceId}` : undefined,
  ));
  const [staging] = binId ? await tx.select({
    quantity: sql<number>`coalesce(sum(${inventoryReservationsTable.quantity}), 0)::double precision`,
  }).from(inventoryReservationsTable).where(and(
    eq(inventoryReservationsTable.productId, productId),
    eq(inventoryReservationsTable.stagedBinId, binId),
    eq(inventoryReservationsTable.status, "Active"),
    issuedReservationId ? sql`${inventoryReservationsTable.id} <> ${issuedReservationId}` : undefined,
  )) : [{ quantity: 0 }];
  const protectedQuantity = pieces.quantity + staging.quantity;
  if (protectedQuantity > 0 && roundStock(onHand - protectedQuantity) < quantity) {
    throw new DomainError(409, staging.quantity > 0
      ? "Some stock in this bin is staged for a job. Issue the matching staged reservation or pick from another bin."
      : "Some stock at this location is labeled by piece. Choose the roll or remnant to use from Rolls & remnants.", {
      looseOnHand: roundStock(onHand - protectedQuantity),
    });
  }
  if (
    (strict || binId || hasBinnedStock) &&
    roundStock(onHand) < quantity
  ) {
    throw new DomainError(
      409,
      binId
        ? "This bin does not have enough stock."
        : "Choose a bin with enough stock or use unbinned stock.",
      { onHand: roundStock(onHand) },
    );
  }
}

export async function ensureOpeningMovement(
  tx: StockTransaction,
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

export async function updateStockTotal(
  tx: StockTransaction,
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
