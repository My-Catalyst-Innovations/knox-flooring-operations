import { and, eq, isNull, sql } from "drizzle-orm";
import { physicalPiecesTable, type InventoryCostSlice, type PhysicalPiece } from "@workspace/db";
import { roundStock, type StockTransaction } from "./inventory-stock";
import { DomainError } from "./operations-rules";

type Location = { productId: string; warehouseId: string | null; binId: string | null };

export const inventoryUnitCostPattern = /^\d{1,12}(?:\.\d{1,6})?$/;

export function normalizeInventoryUnitCost(value: string) {
  const [whole, decimal = ""] = value.split(".");
  return `${whole.replace(/^0+(?=\d)/, "")}.${decimal.padEnd(6, "0")}`;
}

function locationFilter(location: Location) {
  return sql`stock.product_id = ${location.productId}
    AND stock.warehouse_id IS NOT DISTINCT FROM ${location.warehouseId}::text
    AND stock.bin_id IS NOT DISTINCT FROM ${location.binId}::text`;
}

async function quantityAt(tx: StockTransaction, location: Location) {
  const { rows } = await tx.execute<{ quantity: number }>(sql`
    SELECT coalesce(sum(stock.quantity), 0)::double precision AS quantity
    FROM inventory_movements AS stock WHERE ${locationFilter(location)}
  `);
  return roundStock(rows[0].quantity);
}

export function acquisitionCostSlice(
  movementId: string,
  quantity: number,
  unitCost: string,
  acquiredAt: string,
  source: InventoryCostSlice["source"],
): InventoryCostSlice {
  return { layerId: null, sourceMovementId: movementId, quantity, unitCost, acquiredAt, source };
}

export async function inventoryAcquisitionValue(tx: StockTransaction) {
  const { rows } = await tx.execute<{
    productId: string;
    warehouseId: string | null;
    trackedQuantity: number;
    trackedValue: number;
    receiptValue: number;
  }>(sql`
    SELECT stock.product_id AS "productId", stock.warehouse_id AS "warehouseId",
      sum((CASE WHEN stock.quantity < 0 THEN -1 ELSE 1 END) * layer.quantity)::double precision AS "trackedQuantity",
      sum((CASE WHEN stock.quantity < 0 THEN -1 ELSE 1 END) * layer.quantity * layer."unitCost")::double precision AS "trackedValue",
      coalesce(sum((CASE WHEN stock.quantity < 0 THEN -1 ELSE 1 END) * layer.quantity * layer."unitCost")
        FILTER (WHERE layer.source IN ('purchase_order', 'stock_receipt')), 0)::double precision AS "receiptValue"
    FROM inventory_movements AS stock
    CROSS JOIN LATERAL jsonb_to_recordset(stock.cost_allocations) AS layer("layerId" text, quantity numeric, "unitCost" numeric, source text)
    WHERE layer."layerId" IS NOT NULL
    GROUP BY stock.product_id, stock.warehouse_id
  `);
  return rows;
}

async function remainingCostLayers(tx: StockTransaction, location: Location) {
  const { rows } = await tx.execute<InventoryCostSlice>(sql`
    SELECT layer."layerId", layer."sourceMovementId", layer.source, layer."acquiredAt", layer."unitCost",
      sum(CASE WHEN stock.quantity < 0 THEN -layer.quantity ELSE layer.quantity END)::double precision AS quantity
    FROM inventory_movements AS stock
    CROSS JOIN LATERAL jsonb_to_recordset(stock.cost_allocations) AS layer(
      "layerId" text, "sourceMovementId" text, source text, "acquiredAt" text, "unitCost" text, quantity numeric
    )
    WHERE ${locationFilter(location)} AND layer."layerId" IS NOT NULL
    GROUP BY layer."layerId", layer."sourceMovementId", layer.source, layer."acquiredAt", layer."unitCost"
    HAVING sum(CASE WHEN stock.quantity < 0 THEN -layer.quantity ELSE layer.quantity END) > 0
    ORDER BY layer."acquiredAt", layer."sourceMovementId", layer."layerId"
  `);
  return rows;
}

export function verifiedPieceCosts(piece: Pick<PhysicalPiece, "quantity" | "costAllocations">) {
  const costs = piece.costAllocations;
  if (!costs?.length || costs.some((slice) => !slice.layerId || !slice.sourceMovementId || !Number.isFinite(slice.quantity) || slice.quantity <= 0 || !inventoryUnitCostPattern.test(slice.unitCost)) ||
    roundStock(costs.reduce((sum, slice) => sum + slice.quantity, 0)) !== roundStock(piece.quantity))
    throw new DomainError(409, "Review and bind this roll or remnant's acquisition costs before cutting, moving or issuing it.");
  return costs;
}

/** Caller holds the product advisory lock. Piece bindings reserve cost segments,
 * while inventory_movements remains the sole quantity and valuation ledger. */
export async function stockCostAvailability(tx: StockTransaction, location: Location, excludedPieceId?: string) {
  const rows = await remainingCostLayers(tx, location);
  const onHand = await quantityAt(tx, location);
  const tracked = roundStock(rows.reduce((sum, layer) => sum + layer.quantity, 0));
  if (tracked > Math.max(0, onHand) + 0.000001)
    throw new DomainError(409, "This location's purchase costs exceed its stock count. Review the stock movement history.");
  const pieces = await tx.select().from(physicalPiecesTable).where(and(
    eq(physicalPiecesTable.productId, location.productId),
    sql`${physicalPiecesTable.warehouseId} IS NOT DISTINCT FROM ${location.warehouseId}::text`,
    sql`${physicalPiecesTable.binId} IS NOT DISTINCT FROM ${location.binId}::text`,
    isNull(physicalPiecesTable.issuedMovementId),
  ));
  const available = rows.map((row) => ({ ...row }));
  for (const piece of pieces) {
    if (piece.id === excludedPieceId || !piece.costAllocations) continue;
    for (const binding of verifiedPieceCosts(piece)) {
      const layer = available.find((row) => row.layerId === binding.layerId && row.sourceMovementId === binding.sourceMovementId && row.unitCost === binding.unitCost && row.source === binding.source);
      if (!layer || roundStock(layer.quantity - binding.quantity) < 0)
        throw new DomainError(409, "A labeled piece's cost source no longer reconciles with stock. Review its cost binding.");
      layer.quantity = roundStock(layer.quantity - binding.quantity);
    }
  }
  return { layers: available.filter((row) => row.quantity > 0), untracked: Math.max(0, roundStock(onHand - tracked)),
    unboundPieces: pieces.filter((piece) => piece.id !== excludedPieceId && !piece.costAllocations).map((piece) => piece.label),
    selectedPiece: excludedPieceId ? pieces.find((piece) => piece.id === excludedPieceId) : undefined };
}

export async function withdrawStockCosts(tx: StockTransaction, location: Location, quantity: number, selectedPieceId?: string) {
  const available = await stockCostAvailability(tx, location, selectedPieceId);
  if (selectedPieceId) {
    const piece = available.selectedPiece;
    if (!piece || roundStock(piece.quantity) !== roundStock(quantity)) throw new DomainError(409, "Issue the selected piece's entire quantity.");
    const slices = verifiedPieceCosts(piece);
    const remaining = available.layers.map((row) => ({ ...row }));
    for (const slice of slices) {
      const layer = remaining.find((row) => row.layerId === slice.layerId && row.sourceMovementId === slice.sourceMovementId && row.unitCost === slice.unitCost && row.source === slice.source);
      if (!layer || roundStock(layer.quantity - slice.quantity) < 0) throw new DomainError(409, "The selected piece's acquisition cost is no longer available. Review its source.");
      layer.quantity = roundStock(layer.quantity - slice.quantity);
    }
    return { slices: [...slices], untracked: 0 };
  }
  if (available.unboundPieces.length) throw new DomainError(409, "Review unbound rolls or remnants in this bin before withdrawing other stock; their cost sources are not yet identified.");

  // Opening stock and unpriced receipts have no reliable rate. Consume that stock before dated lots.
  const untracked = Math.min(quantity, available.untracked);
  const slices = sliceCostLayers(available.layers, 0, quantity - untracked);
  return { slices, untracked: roundStock(quantity - slices.reduce((sum, slice) => sum + slice.quantity, 0)) };
}

export function sliceCostLayers(
  layers: readonly InventoryCostSlice[],
  start: number,
  end: number,
  latestFirst = false,
): InventoryCostSlice[] {
  let position = 0;
  const ordered = latestFirst ? [...layers].reverse() : layers;
  return ordered.flatMap((layer) => {
    const next = roundStock(position + layer.quantity);
    const quantity = roundStock(Math.min(end, next) - Math.max(start, position));
    position = next;
    return quantity > 0 ? [{ ...layer, quantity }] : [];
  });
}

export async function placeStockCosts(
  tx: StockTransaction,
  location: Location,
  movementId: string,
  quantity: number,
  slices: readonly InventoryCostSlice[],
) {
  if (!slices.length) return null;
  const tracked = roundStock(slices.reduce((sum, slice) => sum + slice.quantity, 0));
  const untracked = roundStock(quantity - tracked);
  const previousBalance = await quantityAt(tx, location);
  const deficit = Math.max(0, -previousBalance - untracked);
  return sliceCostLayers(slices, deficit, tracked).map((slice, index) => ({
    ...slice, layerId: `${movementId}:${index}`,
  }));
}
