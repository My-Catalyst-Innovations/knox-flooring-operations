import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useUnsavedForm } from "@/hooks/use-unsaved-changes";
import { operation } from "@/lib/operations";
import { binName, binsInWarehouse, inventorySelect, useInventoryRequestKey, type BinStock, type WarehouseBin } from "@/lib/purchasing";
import { warehouseName, type Warehouse, type WarehouseReservation } from "@/lib/warehouse-inventory";

export function StageReservationDialog({ reservation, unit, warehouses, bins, stock, stockStatus, onClose, onSaved }: {
  reservation: WarehouseReservation;
  unit: string;
  warehouses: readonly Warehouse[];
  bins: readonly WarehouseBin[];
  stock: readonly BinStock[];
  stockStatus?: "loading" | "unavailable";
  onClose(): void;
  onSaved(): void;
}) {
  const source = reservation.warehouseId ?? "";
  const sourceStock = stock.filter((row) => row.warehouseId === source && row.onHand > 0);
  const [form, setForm] = useState({
    sourceBinId: sourceStock.length === 1 ? sourceStock[0].binId ?? "unbinned" : "",
    destinationWarehouseId: source,
    destinationBinId: "",
    quantity: String(reservation.quantity),
    labelCode: "",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const key = useInventoryRequestKey();
  const changes = useUnsavedForm(true, form);

  function close() {
    if (!inFlight.current && changes.confirmDiscard()) onClose();
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    const body = {
      revision: reservation.revision,
      quantity: Number(form.quantity),
      sourceBinId: form.sourceBinId === "unbinned" ? null : form.sourceBinId,
      destinationWarehouseId: form.destinationWarehouseId,
      destinationBinId: form.destinationBinId,
      labelCode: form.labelCode.trim(),
    };
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      await operation(`/inventory/reservations/${encodeURIComponent(reservation.id)}/stage`, "POST", {
        ...body, idempotencyKey: key.forBody(body),
      });
      changes.reset(form);
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to stage the pick.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pick and stage reserved stock</DialogTitle>
          <DialogDescription>Record the move after the reserved stock has arrived in its staging bin or truck.</DialogDescription>
        </DialogHeader>
        {stockStatus && <p role="status" className="text-sm text-muted-foreground">{stockStatus === "loading" ? "Loading stock at the source warehouse…" : "Stock at the source warehouse could not be loaded. Close and try again."}</p>}
        <form className="space-y-3" onSubmit={save}>
          <fieldset disabled={saving || !!stockStatus} className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm font-medium">
              Source bin at {warehouseName(warehouses, source)}
              <select required className={inventorySelect} value={form.sourceBinId} onChange={(event) => setForm({ ...form, sourceBinId: event.target.value })}>
                <option value="">Choose source</option>
                {sourceStock.map((row) => <option key={row.binId ?? "unbinned"} value={row.binId ?? "unbinned"}>{binName(bins, row.binId)} · {row.onHand} {unit}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium">
              Pick quantity ({unit})
              <Input required type="number" inputMode="decimal" min="0.000001" max={reservation.quantity} step="0.000001" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
            </label>
            <label className="space-y-1 text-sm font-medium">
              Destination warehouse or truck
              <select required className={inventorySelect} value={form.destinationWarehouseId} onChange={(event) => setForm({ ...form, destinationWarehouseId: event.target.value, destinationBinId: "" })}>
                {warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium">
              Destination bin
              <select required className={inventorySelect} value={form.destinationBinId} onChange={(event) => setForm({ ...form, destinationBinId: event.target.value })}>
                <option value="">Choose bin</option>
                {binsInWarehouse(bins, form.destinationWarehouseId)
                  .filter((bin) => bin.id !== form.sourceBinId)
                  .map((bin) => <option key={bin.id} value={bin.id}>{bin.code}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium sm:col-span-2">
              Scan or type product label
              <Input required maxLength={512} value={form.labelCode} onChange={(event) => setForm({ ...form, labelCode: event.target.value })} />
            </label>
          </fieldset>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={close}>Cancel</Button>
            <Button disabled={saving || !!stockStatus || !sourceStock.length || !form.labelCode.trim()}>{saving ? "Recording…" : "Record pick"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
