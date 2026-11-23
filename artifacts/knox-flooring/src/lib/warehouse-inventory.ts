import type { Reservation, StockMovement, StockSummary } from "./operations";

export const inventoryRoles = ["owner", "operations"];
export const unassignedLocation = "unassigned";

export interface Warehouse {
  id: string;
  name: string;
}

export interface StockLocation {
  warehouseId: string | null;
  onHand: number;
  reserved: number;
  available: number;
  stockValue?: number | null;
  valueEstimated?: boolean;
}

export interface WarehouseStockSummary extends StockSummary {
  locations: StockLocation[];
  stockValue?: number | null;
  valueEstimated?: boolean;
}

export interface WarehouseStockMovement extends StockMovement {
  warehouseId?: string | null;
  binId?: string | null;
  transferId?: string | null;
  returnOfMovementId?: string | null;
  acquisitionUnitCost?: string | null;
  issueUnitCost?: string | null;
  costAllocations?: { quantity: number; source: "purchase_order" | "stock_receipt" | "catalog" | "historical_issue" | "reviewed_opening"; unitCost: string }[] | null;
}

export interface WarehouseReservation extends Reservation {
  warehouseId?: string | null;
  stagedBinId?: string | null;
  sourceReservationId?: string | null;
  stagedTransferId?: string | null;
}

export interface WarehouseTransfer {
  id: string;
  sourceWarehouseId: string | null;
  destinationWarehouseId: string;
  sourceBinId?: string | null;
  destinationBinId?: string | null;
  quantity: number;
  reason: string;
  status: "In transit" | "Received";
}

export function warehouseName(
  warehouses: readonly Warehouse[],
  id?: string | null,
) {
  if (!id) return "Unassigned";
  return (
    warehouses.find((warehouse) => warehouse.id === id)?.name ??
    "Unknown warehouse"
  );
}
