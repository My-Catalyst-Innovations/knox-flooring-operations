import { sql } from "drizzle-orm";
import type { InventoryCostSlice } from "@workspace/db";
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
  }>(sql`
    SELECT stock.product_id AS "productId", stock.warehouse_id AS "warehouseId",
      sum((CASE WHEN stock.quantity < 0 THEN -1 ELSE 1 END) * layer.quantity)::double precision AS "trackedQuantity",
      sum((CASE WHEN stock.quantity < 0 THEN -1 ELSE 1 END) * layer.quantity * layer."unitCost")::double precision AS "trackedValue"
    FROM inventory_movements AS stock
    CROSS JOIN LATERAL jsonb_to_recordset(stock.cost_allocations) AS layer("layerId" text, quantity numeric, "unitCost" numeric)
    WHERE layer."layerId" IS NOT NULL
    GROUP BY stock.product_id, stock.warehouse_id
  `);
  return rows;
}

export async function withdrawStockCosts(tx: StockTransaction, location: Location, quantity: number) {
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
  const onHand = await quantityAt(tx, location);
  const tracked = roundStock(rows.reduce((sum, layer) => sum + layer.quantity, 0));
  if (tracked > Math.max(0, onHand) + 0.000001)
    throw new DomainError(409, "This location's purchase costs exceed its stock count. Review the stock movement history.");

  // Opening stock and unpriced receipts have no reliable rate. Consume that stock before dated lots.
  const untracked = Math.min(quantity, Math.max(0, roundStock(onHand - tracked)));
  const slices = sliceCostLayers(rows, 0, quantity - untracked);
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
