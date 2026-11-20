import { useRef } from "react";

export const purchaseOrdersPath = "/inventory/purchase-orders";
export const warehouseBinsPath = "/inventory/bins";
export const binStockPath = "/inventory/bin-stock";

export const purchaseOrderStatuses = [
  "Draft",
  "Ordered",
  "Partially received",
  "Received",
  "Cancelled",
] as const;

export type PurchaseOrderStatus = (typeof purchaseOrderStatuses)[number];

export interface PurchaseOrderLine {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  unit: string;
  quantity: number;
  receivedQuantity: number;
  unitCost: string;
}

export interface PurchaseOrder {
  id: string;
  orderNumber: string;
  supplier: string;
  warehouseId: string;
  notes: string | null;
  status: PurchaseOrderStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lines: PurchaseOrderLine[];
}

export interface PurchaseReceipt {
  id: string;
  reference: string | null;
  receivedAt: string;
  lines: {
    id?: string;
    lineId: string;
    productId: string;
    binId: string | null;
    quantity: number;
    movementId: string | null;
    unitCost?: string | null;
    damagedQuantity?: number;
    damageNote?: string | null;
  }[];
}

export interface WarehouseBin {
  id: string;
  warehouseId: string;
  code: string;
}

export interface BinStock {
  warehouseId: string;
  binId: string | null;
  productId: string;
  onHand: number;
}

export function binStockQuery(filters: { warehouseId?: string; productId?: string }) {
  const params = new URLSearchParams();
  if (filters.warehouseId) params.set("warehouseId", filters.warehouseId);
  if (filters.productId) params.set("productId", filters.productId);
  return params.size ? `${binStockPath}?${params}` : binStockPath;
}

export function binName(bins: readonly WarehouseBin[], id: string | null) {
  return id ? (bins.find((bin) => bin.id === id)?.code ?? "Unknown bin") : "Unbinned";
}

export function binsInWarehouse(bins: readonly WarehouseBin[], warehouseId: string) {
  return bins.filter((bin) => bin.warehouseId === warehouseId)
    .sort((left, right) => left.code.localeCompare(right.code, undefined, { numeric: true }));
}

export function useInventoryRequestKey() {
  const request = useRef<{ body: string; key: string } | undefined>(undefined);
  return {
    forBody(data: object) {
      const body = JSON.stringify(data);
      if (request.current?.body !== body) {
        request.current = { body, key: crypto.randomUUID() };
      }
      return request.current.key;
    },
  };
}

export const purchaseQuantity = (amount: number) =>
  amount.toLocaleString("en-US", { maximumFractionDigits: 6 });
export const purchaseUnitCostPattern = /^\d{1,12}(?:\.\d{1,6})?$/;

export const inventorySelect = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
