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
  purchaseUnitCostPattern,
  useInventoryRequestKey,
  type PurchaseOrder,
  type PurchaseReceipt,
  type WarehouseBin,
} from "@/lib/purchasing";

type ReceiptRow = { key: number; lineId: string; quantity: string; binId: string; unitCost: string };
type ReceiptDamage = { quantity: string; note: string };
type ReceiptLine = { lineId: string; quantity: number; binId: string | null; unitCost?: string; damagedQuantity?: number; damageNote?: string };
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
  const [rows, setRows] = useState<ReceiptRow[]>(() => outstanding.map((line, key) => ({ key, lineId: line.id, quantity: "", binId: "", unitCost: "" })));
  const [damage, setDamage] = useState<Record<string, ReceiptDamage>>({});
  const [revision] = useState(order.revision);
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const nextKey = useRef(rows.length);
  const requestKey = useInventoryRequestKey();
  const changes = useUnsavedForm(true, { rows, reference, damage });
  const options = binsInWarehouse(bins, order.warehouseId);
  const hasDelivery = rows.some((row) => Number(row.quantity) > 0) || Object.values(damage).some((row) => Number(row.quantity) > 0);

  function changeRow(key: number, changed: Partial<ReceiptRow>) {
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...changed } : row));
  }

  function close() {
    if (!inFlight.current && changes.confirmDiscard()) onClose();
  }

  function changeDamage(lineId: string, changed: Partial<ReceiptDamage>) {
    setDamage((current) => ({ ...current, [lineId]: { ...(current[lineId] ?? { quantity: "", note: "" }), ...changed } }));
  }

  async function receive(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || binsUnavailable) return;
    setError("");
    const lines: ReceiptLine[] = rows.filter((row) => Number(row.quantity) > 0).map(({ lineId, quantity, binId, unitCost }) => ({
      lineId,
      quantity: Number(quantity),
      binId: binId || null,
      ...(unitCost.trim() ? { unitCost: unitCost.trim() } : {}),
    }));
    if (lines.some((line) => line.unitCost !== undefined && !purchaseUnitCostPattern.test(line.unitCost))) {
      setError("Enter a nonnegative unit cost with up to six decimal places.");
      return;
    }
    for (const line of outstanding) {
      const received = lines.filter((row) => row.lineId === line.id);
      const damagedQuantity = Number(damage[line.id]?.quantity || 0);
      const total = received.reduce((sum, row) => sum + row.quantity, damagedQuantity);
      if (Number(total.toFixed(6)) > balance(line.quantity, line.receivedQuantity)) {
        setError(`${line.sku || line.productName} exceeds the quantity remaining on the order.`);
        return;
      }
      if (new Set(received.map((row) => row.binId)).size < received.length) {
        setError(`Combine quantities going into the same bin for ${line.sku || line.productName}.`);
        return;
      }
      if (damagedQuantity > 0) {
        const damageNote = damage[line.id]?.note.trim();
        const damageFields = { damagedQuantity, ...(damageNote ? { damageNote } : {}) };
        if (received.length) Object.assign(received[0], damageFields);
        else lines.push({ lineId: line.id, quantity: 0, binId: null, ...damageFields });
      }
    }
    if (!lines.length) return;
    const data = { revision, reference: reference.trim(), lines };
    inFlight.current = true;
    setSaving(true);
    try {
      const response = await operation<{ order: PurchaseOrder; receipt: PurchaseReceipt }>(
        `${purchaseOrdersPath}/${encodeURIComponent(order.id)}/receive`,
        "POST",
        { ...data, idempotencyKey: requestKey.forBody(data) },
      );
      changes.reset({ rows, reference, damage });
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
          <DialogDescription>Record deliveries to {warehouse}. Damaged quantities stay open for replacement. Enter the actual unit cost if it differs from the purchase order.</DialogDescription>
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
                    <div key={row.key} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                      <label className="space-y-1 text-sm font-medium">
                        Received quantity {index + 1}
                        <Input type="number" min="0" max={remaining} step="0.000001" inputMode="decimal" value={row.quantity} onChange={(event) => changeRow(row.key, { quantity: event.target.value })} />
                      </label>
                      <label className="space-y-1 text-sm font-medium">
                        Destination bin {index + 1}
                        <select className={inventorySelect} value={row.binId} onChange={(event) => changeRow(row.key, { binId: event.target.value })}>
                          <option value="">Unbinned</option>
                          {options.map((bin) => <option key={bin.id} value={bin.id}>{bin.code}</option>)}
                        </select>
                      </label>
                      <label className="space-y-1 text-sm font-medium">
                        Actual unit cost {index + 1}
                        <Input inputMode="decimal" maxLength={19} value={row.unitCost} placeholder={`Order $${purchaseQuantity(Number(line.unitCost))}`} onChange={(event) => changeRow(row.key, { unitCost: event.target.value })} />
                      </label>
                      {lineRows.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}>Remove split</Button>}
                    </div>
                  ))}
                  {options.length > 0 && lineRows.length <= options.length && rows.length < 200 && (
                    <Button type="button" variant="outline" size="sm" onClick={() => {
                      const key = nextKey.current++;
                      setRows((current) => [...current, { key, lineId: line.id, quantity: "", binId: "", unitCost: "" }]);
                    }}>Split across bins</Button>
                  )}
                  <div className="grid gap-2 border-t pt-2 sm:grid-cols-2">
                    <label className="space-y-1 text-sm font-medium">
                      Damaged quantity
                      <Input type="number" min="0" max={remaining} step="0.000001" inputMode="decimal" value={damage[line.id]?.quantity ?? ""} onChange={(event) => changeDamage(line.id, { quantity: event.target.value })} />
                    </label>
                    {Number(damage[line.id]?.quantity) > 0 && <label className="space-y-1 text-sm font-medium">
                      Damage note (optional)
                      <Input maxLength={240} value={damage[line.id]?.note ?? ""} onChange={(event) => changeDamage(line.id, { note: event.target.value })} />
                    </label>}
                  </div>
                </fieldset>
              );
            })}
          </fieldset>
          {binsUnavailable && <p role="alert" className="text-sm text-destructive">Warehouse bins are unavailable. Close this window and reload purchasing to try again.</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" disabled={saving} onClick={close}>Cancel</Button>
            <Button type="submit" disabled={saving || binsUnavailable || !hasDelivery}>{saving ? "Recording…" : "Record receipt"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
