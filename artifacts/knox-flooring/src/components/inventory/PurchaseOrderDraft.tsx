import { useRef, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedForm } from "@/hooks/use-unsaved-changes";
import { currency, operation, useOperation } from "@/lib/operations";
import { inventorySelect, purchaseOrdersPath, useInventoryRequestKey, type PurchaseOrder } from "@/lib/purchasing";
import { businessDate } from "@/lib/reporting";
import type { SupplierCrosswalkAlias } from "@/lib/supplier-import";
import type { Product } from "@/lib/types";
import { inventoryRoles, type Warehouse } from "@/lib/warehouse-inventory";

type DraftLine = { key: string; productId: string; quantity: string; unitCost: string | null };
const emptyLine = (key: string): DraftLine => ({ key, productId: "", quantity: "", unitCost: null });
const costPattern = /^\d{1,12}(?:\.\d{1,6})?$/;
const normalize = (value: string) => value.trim().toLowerCase();

export function PurchaseOrderDraft({
  order, products, warehouses, onClose, onSaved,
}: {
  order?: PurchaseOrder;
  products: readonly Product[];
  warehouses: readonly Warehouse[];
  onClose(): void;
  onSaved(order: PurchaseOrder): void;
}) {
  const stocked = products.filter((product) => product.active && product.inventoryType === "Inventory");
  const [asOf] = useState(() => businessDate());
  const supplierPrices = useOperation<SupplierCrosswalkAlias[]>(`/inventory/supplier-crosswalk?asOf=${asOf}`, inventoryRoles);
  const [form, setForm] = useState(() => ({
    supplier: order?.supplier ?? "",
    warehouseId: order?.warehouseId ?? (warehouses.length === 1 ? warehouses[0].id : ""),
    notes: order?.notes ?? "",
    lines: order?.lines.map((line) => ({
      key: line.id,
      productId: line.productId,
      quantity: String(line.quantity),
      unitCost: line.unitCost,
    })) ?? [emptyLine("new-0")],
  }));
  const [revision] = useState(order?.revision);
  const nextLine = useRef(1);
  const inFlight = useRef(false);
  const requestKey = useInventoryRequestKey();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const changes = useUnsavedForm(true, form);
  const supplierKey = normalize(form.supplier);
  const lines = form.lines.map((line) => {
    const product = stocked.find((item) => item.id === line.productId);
    const candidates = (supplierPrices.data ?? []).filter((alias) =>
      product && alias.productId === product.id && normalize(alias.supplier) === supplierKey &&
      alias.latestPrice && normalize(alias.latestPrice.unit) === normalize(product.unit),
    );
    const approved = candidates.length === 1 ? candidates[0] : undefined;
    const defaultCost = supplierPrices.isSuccess && candidates.length === 0 && product ? String(product.cost) : "";
    const cost = line.unitCost ?? approved?.latestPrice?.unitCost ?? defaultCost;
    return { line, product, approved, ambiguous: candidates.length > 1, cost };
  });
  const total = lines.reduce((sum, { line, cost }) => sum + Number(line.quantity) * Number(cost), 0);

  function changeLine(key: string, update: Partial<DraftLine>) {
    setForm((current) => ({
      ...current,
      lines: current.lines.map((line) => line.key === key ? { ...line, ...update } : line),
    }));
  }

  function close() {
    if (!inFlight.current && changes.confirmDiscard()) onClose();
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setError("");
    if (new Set(form.lines.map((line) => line.productId)).size < form.lines.length) {
      setError("Use one order line per product.");
      return;
    }
    if (lines.some(({ cost }) => !costPattern.test(cost.trim()))) {
      setError("Enter a unit cost with up to six decimal places for each line.");
      return;
    }
    const data = {
      supplier: form.supplier.trim(),
      warehouseId: form.warehouseId,
      notes: form.notes.trim(),
      lines: lines.map(({ line, cost }) => ({
        productId: line.productId,
        quantity: Number(line.quantity),
        unitCost: cost.trim(),
      })),
    };
    inFlight.current = true;
    setSaving(true);
    try {
      const saved = order
        ? await operation<PurchaseOrder>(`${purchaseOrdersPath}/${encodeURIComponent(order.id)}`, "PATCH", { ...data, revision })
        : await operation<PurchaseOrder>(purchaseOrdersPath, "POST", { ...data, idempotencyKey: requestKey.forBody(data) });
      changes.reset(form);
      onSaved(saved);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the purchase order.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{order ? `Edit ${order.orderNumber}` : "New purchase order"}</DialogTitle>
          <DialogDescription>Choose the receiving warehouse and add the supplier’s products and unit costs.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <fieldset disabled={saving} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm font-medium">
                Supplier
                <Input required maxLength={200} value={form.supplier} onChange={(event) => setForm({ ...form, supplier: event.target.value })} />
              </label>
              <label className="space-y-1 text-sm font-medium">
                Receiving warehouse
                <select required className={inventorySelect} value={form.warehouseId} onChange={(event) => setForm({ ...form, warehouseId: event.target.value })}>
                  <option value="">Select warehouse</option>
                  {warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}
                </select>
              </label>
            </div>
            <label className="block space-y-1 text-sm font-medium">
              Order notes (optional)
              <Textarea maxLength={4000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
            </label>
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Order lines</h3>
              {lines.map(({ line, product, approved, ambiguous, cost }, index) => {
                const priceDescription = line.unitCost !== null || !product ? null
                  : approved ? `Approved supplier price · ${approved.supplierSku}`
                  : ambiguous ? "Multiple supplier codes match. Enter the agreed unit cost."
                  : supplierPrices.isSuccess ? "Catalog cost · confirm with supplier"
                  : supplierPrices.isError ? "Supplier prices unavailable. Enter the agreed unit cost."
                  : "Checking approved supplier prices…";
                return (
                  <div key={line.key} className="grid items-end gap-2 rounded-md border p-3 md:grid-cols-[minmax(0,1fr)_7rem_8rem_auto]">
                    <label className="space-y-1 text-sm font-medium">
                      Product {index + 1}
                      <select required className={inventorySelect} value={line.productId} onChange={(event) => changeLine(line.key, { productId: event.target.value, unitCost: null })}>
                        <option value="">Select product</option>
                        {line.productId && !product && <option value={line.productId} disabled>{order?.lines.find((item) => item.productId === line.productId)?.productName ?? "Unavailable product"}</option>}
                        {stocked.map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.name}</option>)}
                      </select>
                    </label>
                    <label className="space-y-1 text-sm font-medium">
                      Quantity {index + 1}{product && <span className="text-muted-foreground"> ({product.unit})</span>}
                      <Input required type="number" inputMode="decimal" min="0.000001" max="1000000" step="0.000001" value={line.quantity} onChange={(event) => changeLine(line.key, { quantity: event.target.value })} />
                    </label>
                    <label className="space-y-1 text-sm font-medium">
                      Unit cost {index + 1}
                      <Input required inputMode="decimal" maxLength={19} value={cost} onChange={(event) => changeLine(line.key, { unitCost: event.target.value })} aria-describedby={priceDescription ? `price-${line.key}` : undefined} />
                    </label>
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${index + 1}`} disabled={form.lines.length === 1} onClick={() => setForm((current) => ({ ...current, lines: current.lines.filter((item) => item.key !== line.key) }))}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                    {priceDescription && <p id={`price-${line.key}`} className="text-xs text-muted-foreground md:col-span-4">{priceDescription}</p>}
                  </div>
                );
              })}
              <Button type="button" variant="outline" size="sm" disabled={form.lines.length >= 100} onClick={() => {
                const line = emptyLine(`new-${nextLine.current++}`);
                setForm((current) => ({ ...current, lines: [...current.lines, line] }));
              }}>
                <Plus className="mr-2 h-4 w-4" aria-hidden />Add line
              </Button>
            </div>
          </fieldset>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="text-sm text-muted-foreground">Merchandise total <strong className="ml-1 text-foreground">{Number.isFinite(total) ? currency(total) : "—"}</strong></p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={saving} onClick={close}>Cancel</Button>
              <Button type="submit" disabled={saving || !form.supplier.trim() || !form.warehouseId || form.lines.some((line) => !stocked.some((item) => item.id === line.productId))}>{saving ? "Saving…" : "Save draft"}</Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
