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
}

export interface WarehouseStockSummary extends StockSummary {
  locations: StockLocation[];
}

export interface WarehouseStockMovement extends StockMovement {
  warehouseId?: string | null;
  transferId?: string | null;
  returnOfMovementId?: string | null;
}

export interface WarehouseReservation extends Reservation {
  warehouseId?: string | null;
}

export interface WarehouseTransfer {
  id: string;
  sourceWarehouseId: string | null;
  destinationWarehouseId: string;
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
