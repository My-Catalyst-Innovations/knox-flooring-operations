import { useOperation } from "@/lib/operations";
import { binsInWarehouse, binStockQuery, inventorySelect, purchaseQuantity, warehouseBinsPath, type BinStock, type WarehouseBin } from "@/lib/purchasing";
import { inventoryRoles } from "@/lib/warehouse-inventory";

type Selection = {
  warehouseId: string;
  value: string;
  onChange(value: string): void;
  label?: string;
  disabled?: boolean;
};

export function WarehouseBinSelect({ warehouseId, bins, stock, value, onChange, label = "Bin", disabled }: Selection & {
  bins: readonly WarehouseBin[];
  stock?: readonly BinStock[];
}) {
  const balance = (id: string | null) => stock && purchaseQuantity(stock.find((row) => row.warehouseId === warehouseId && row.binId === id)?.onHand ?? 0);
  const unbinned = balance(null);
  return (
    <label className="space-y-1 text-sm font-medium">
      {label}
      <select className={inventorySelect} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">Unbinned{unbinned !== undefined && ` · ${unbinned} on hand`}</option>
        {binsInWarehouse(bins, warehouseId).map((bin) => {
          const count = balance(bin.id);
          return <option key={bin.id} value={bin.id}>{bin.code}{count !== undefined && ` · ${count} on hand`}</option>;
        })}
      </select>
    </label>
  );
}

export function useWarehouseBins() {
  return useOperation<WarehouseBin[]>(warehouseBinsPath, inventoryRoles);
}

export function ProductBinSelect({ productId, bins, ...selection }: Selection & { productId: string; bins: readonly WarehouseBin[] }) {
  const stock = useOperation<BinStock[]>(binStockQuery({ warehouseId: selection.warehouseId, productId }), inventoryRoles);
  return <WarehouseBinSelect {...selection} bins={bins} stock={stock.isError ? undefined : stock.data} />;
}
