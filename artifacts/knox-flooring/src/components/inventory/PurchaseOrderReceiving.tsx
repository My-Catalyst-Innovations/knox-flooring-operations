import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useUnsavedForm } from "@/hooks/use-unsaved-changes";
import { operation } from "@/lib/operations";
import {
  binsInWarehouse,
  inventorySelect,
  purchaseOrdersPath,
  purchaseQuantity,
  useInventoryRequestKey,
  type PurchaseOrder,
  type PurchaseReceipt,
  type WarehouseBin,
} from "@/lib/purchasing";

type ReceiptRow = { key: number; lineId: string; quantity: string; binId: string };
const balance = (quantity: number, received: number) => Number((quantity - received).toFixed(6));

export function PurchaseOrderReceiving({ order, warehouse, bins, binsUnavailable, onClose, onReceived }: {
  order: PurchaseOrder;
  warehouse: string;
  bins: readonly WarehouseBin[];
  binsUnavailable: boolean;
  onClose(): void;
  onReceived(result: { order: PurchaseOrder; receipt: PurchaseReceipt }): void;
}) {
  const outstanding = order.lines.filter((line) => balance(line.quantity, line.receivedQuantity) > 0);
  const [rows, setRows] = useState<ReceiptRow[]>(() => outstanding.map((line, key) => ({ key, lineId: line.id, quantity: "", binId: "" })));
  const [revision] = useState(order.revision);
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const nextKey = useRef(rows.length);
  const requestKey = useInventoryRequestKey();
  const changes = useUnsavedForm(true, { rows, reference });
  const options = binsInWarehouse(bins, order.warehouseId);

  function changeRow(key: number, changed: Partial<ReceiptRow>) {
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...changed } : row));
  }

  function close() {
    if (!inFlight.current && changes.confirmDiscard()) onClose();
  }

  async function receive(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || binsUnavailable) return;
    setError("");
    const lines = rows.filter((row) => row.quantity.trim()).map(({ lineId, quantity, binId }) => ({
      lineId,
      quantity: Number(quantity),
      binId: binId || null,
    }));
    if (!lines.length) return;
    for (const line of outstanding) {
      const received = lines.filter((row) => row.lineId === line.id);
      const total = received.reduce((sum, row) => sum + row.quantity, 0);
      if (Number(total.toFixed(6)) > balance(line.quantity, line.receivedQuantity)) {
        setError(`${line.sku || line.productName} exceeds the quantity remaining on the order.`);
        return;
      }
      if (new Set(received.map((row) => row.binId)).size < received.length) {
        setError(`Combine quantities going into the same bin for ${line.sku || line.productName}.`);
        return;
      }
    }
    const data = { revision, reference: reference.trim(), lines };
    inFlight.current = true;
    setSaving(true);
    try {
      const response = await operation<{ order: PurchaseOrder; receipt: PurchaseReceipt }>(
        `${purchaseOrdersPath}/${encodeURIComponent(order.id)}/receive`,
        "POST",
        { ...data, idempotencyKey: requestKey.forBody(data) },
      );
      changes.reset({ rows, reference });
      onReceived(response);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not record the receipt.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Receive {order.orderNumber}</DialogTitle>
          <DialogDescription>Record the quantities delivered to {warehouse}. Leave quantities blank for items that did not arrive.</DialogDescription>
        </DialogHeader>
        <form onSubmit={receive} className="space-y-4">
          <fieldset disabled={saving || binsUnavailable} className="space-y-3">
            <label className="block space-y-1 text-sm font-medium">
              Packing slip or reference (optional)
              <Input maxLength={200} value={reference} onChange={(event) => setReference(event.target.value)} />
            </label>
            {outstanding.map((line) => {
              const lineRows = rows.filter((row) => row.lineId === line.id);
              const remaining = balance(line.quantity, line.receivedQuantity);
              return (
                <fieldset key={line.id} className="space-y-2 rounded-lg border p-3">
                  <legend className="px-1 text-sm font-semibold">{line.productName} · {line.sku}</legend>
                  <p className="text-sm text-muted-foreground">{purchaseQuantity(remaining)} {line.unit} remaining</p>
                  {lineRows.map((row, index) => (
                    <div key={row.key} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                      <label className="space-y-1 text-sm font-medium">
                        Received quantity {index + 1}
                        <Input type="number" min="0.000001" max={remaining} step="0.000001" inputMode="decimal" value={row.quantity} onChange={(event) => changeRow(row.key, { quantity: event.target.value })} />
                      </label>
                      <label className="space-y-1 text-sm font-medium">
                        Destination bin {index + 1}
                        <select className={inventorySelect} value={row.binId} onChange={(event) => changeRow(row.key, { binId: event.target.value })}>
                          <option value="">Unbinned</option>
                          {options.map((bin) => <option key={bin.id} value={bin.id}>{bin.code}</option>)}
                        </select>
                      </label>
                      {lineRows.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}>Remove split</Button>}
                    </div>
                  ))}
                  {options.length > 0 && lineRows.length <= options.length && rows.length < 200 && (
                    <Button type="button" variant="outline" size="sm" onClick={() => {
                      const key = nextKey.current++;
                      setRows((current) => [...current, { key, lineId: line.id, quantity: "", binId: "" }]);
                    }}>Split across bins</Button>
                  )}
                </fieldset>
              );
            })}
          </fieldset>
          {binsUnavailable && <p role="alert" className="text-sm text-destructive">Warehouse bins are unavailable. Close this window and reload purchasing to try again.</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" disabled={saving} onClick={close}>Cancel</Button>
            <Button type="submit" disabled={saving || binsUnavailable || !rows.some((row) => Number(row.quantity) > 0)}>{saving ? "Recording…" : "Record receipt"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
