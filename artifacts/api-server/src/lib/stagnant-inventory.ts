import {
  db,
  inventoryMovementsTable,
  productsTable,
  warehousesTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { inventoryAcquisitionValue } from "./inventory-costing";
import { roundStock } from "./inventory-stock";
import { movementWindows, reportBusinessDate } from "./report-metrics";

type Balance = {
  productId: string;
  warehouseId: string | null;
  warehouseName: string | null;
  onHand: number;
  lastMovement: string | null;
};
type Valuation = {
  productId: string;
  warehouseId: string | null;
  trackedQuantity: number;
  trackedValue: number;
  receiptValue: number;
};
type StockProduct = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  active: boolean;
  onHand: number;
  catalogCost: number;
};
type StagnantRecord = {
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  active: boolean;
  warehouseId: string | null;
  warehouseName: string | null;
  onHand: number;
  inactiveDays: number;
  lastMovedOn: string;
  receiptValue: number;
  estimatedValue: number;
  incompleteValue: boolean;
};

const dayMs = 86_400_000;
const locationKey = (productId: string, warehouseId: string | null) =>
  JSON.stringify([productId, warehouseId]);

export function summarizeStagnantInventory(
  products: readonly StockProduct[],
  balances: readonly Balance[],
  values: readonly Valuation[],
  now: Date,
) {
  const balancesByProduct = new Map<string, Balance[]>();
  for (const balance of balances) {
    const existing = balancesByProduct.get(balance.productId) ?? [];
    existing.push(balance);
    balancesByProduct.set(balance.productId, existing);
  }
  const lookup = new Map(
    values.map((value) => [
      locationKey(value.productId, value.warehouseId),
      value,
    ]),
  );
  const windows = movementWindows.map((days) => ({
    days,
    locations: 0,
    receiptCents: 0,
    estimateCents: 0,
    unvaluedLocations: 0,
  }));
  let unknownMovementLocations = 0;
  const records: StagnantRecord[] = [];
  for (const product of products) {
    const ledger = balancesByProduct.get(product.id) ?? [];
    const named = ledger.filter((row) => row.warehouseId !== null);
    const unassigned = {
      productId: product.id,
      warehouseId: null,
      warehouseName: null,
      onHand: roundStock(
        product.onHand - named.reduce((total, row) => total + row.onHand, 0),
      ),
      lastMovement:
        ledger.find((row) => row.warehouseId === null)?.lastMovement ?? null,
    };
    for (const location of [...named, unassigned]) {
      const onHand = roundStock(location.onHand);
      if (onHand <= 0) continue;
      const lastMovement = Date.parse(location.lastMovement ?? "");
      const age = (now.getTime() - lastMovement) / dayMs;
      if (!Number.isFinite(age) || age < 0) {
        unknownMovementLocations += 1;
        continue;
      }
      if (age < movementWindows[0]) continue;
      const recorded = lookup.get(
        locationKey(product.id, location.warehouseId),
      );
      const tracked = roundStock(recorded?.trackedQuantity ?? 0);
      const unpriced = Math.max(0, roundStock(onHand - tracked));
      const hasCatalogRate =
        Number.isFinite(product.catalogCost) && product.catalogCost > 0;
      const receipt = Math.round((recorded?.receiptValue ?? 0) * 100);
      const estimated = Math.round(
        ((recorded?.trackedValue ?? 0) -
          (recorded?.receiptValue ?? 0) +
          (hasCatalogRate ? unpriced * product.catalogCost : 0)) *
          100,
      );
      const valid =
        tracked >= 0 &&
        tracked <= onHand &&
        Number.isSafeInteger(receipt) &&
        receipt >= 0 &&
        Number.isSafeInteger(estimated) &&
        estimated >= 0;
      const incompleteValue = !valid || (!hasCatalogRate && unpriced > 0);
      records.push({
        productId: product.id,
        sku: product.sku,
        productName: product.name,
        unit: product.unit,
        active: product.active,
        warehouseId: location.warehouseId,
        warehouseName: location.warehouseName,
        onHand,
        inactiveDays: Math.floor(age),
        lastMovedOn: reportBusinessDate(new Date(lastMovement)),
        receiptValue: valid ? receipt / 100 : 0,
        estimatedValue: valid ? estimated / 100 : 0,
        incompleteValue,
      });
      for (const window of windows) {
        if (age < window.days) continue;
        window.locations += 1;
        if (incompleteValue) window.unvaluedLocations += 1;
        if (valid) {
          window.receiptCents += receipt;
          window.estimateCents += estimated;
        }
      }
    }
  }
  return {
    asOfDate: reportBusinessDate(now),
    unknownMovementLocations,
    records: records.sort(
      (a, b) =>
        b.inactiveDays - a.inactiveDays ||
        a.sku.localeCompare(b.sku) ||
        (a.warehouseName ?? "").localeCompare(b.warehouseName ?? ""),
    ),
    windows: windows.map(({ receiptCents, estimateCents, ...window }) => ({
      ...window,
      receiptValue: receiptCents / 100,
      estimatedValue: estimateCents / 100,
    })),
  };
}

export async function stagnantInventory(now = new Date()) {
  const movement = inventoryMovementsTable;
  const [products, balances, values] = await db.transaction(
    (tx) =>
      Promise.all([
        tx
          .select({
            id: productsTable.id,
            sku: productsTable.sku,
            name: productsTable.name,
            unit: productsTable.unit,
            active: productsTable.active,
            onHand: productsTable.quantityOnHand,
            catalogCost: productsTable.cost,
          })
          .from(productsTable)
          .where(eq(productsTable.inventoryType, "Inventory")),
        tx
          .select({
            productId: movement.productId,
            warehouseId: movement.warehouseId,
            warehouseName: warehousesTable.name,
            onHand: sql<number>`sum(${movement.quantity})`.mapWith(Number),
            lastMovement: sql<
              string | null
            >`max(${movement.createdAt}) filter (where ${movement.kind} not in ('bin_in', 'bin_out'))`,
          })
          .from(movement)
          .leftJoin(
            warehousesTable,
            eq(warehousesTable.id, movement.warehouseId),
          )
          .groupBy(
            movement.productId,
            movement.warehouseId,
            warehousesTable.name,
          ),
        inventoryAcquisitionValue(tx),
      ]),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  return summarizeStagnantInventory(products, balances, values, now);
}
