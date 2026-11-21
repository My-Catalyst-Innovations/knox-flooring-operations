import { useRef, useState } from "react";
import { ProductBinSelect, useWarehouseBins } from "@/components/inventory/WarehouseBinSelect";
import { StageReservationDialog } from "@/components/inventory/StageReservationDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth";
import {
  operation,
  useOperation,
  useRefreshOperations,
  quantity,
  type StockSummary,
} from "@/lib/operations";
import {
  inventoryRoles,
  warehouseName,
  type Warehouse,
  type WarehouseReservation,
} from "@/lib/warehouse-inventory";
import type { JobMaterial, Product } from "@/lib/types";
import type { JobEntryContext } from "@workspace/api-client-react";
import { binName, binStockQuery, type BinStock } from "@/lib/purchasing";

const empty = () => ({ name: "", quantity: "", unit: "", productId: "" });
const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
export function MaterialsNeeded({ jobId }: { jobId: string }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const refresh = useRefreshOperations();
  const materialsQuery = useOperation<JobMaterial[]>(
    `/jobs/${jobId}/materials`,
  );
  const productsQuery = useOperation<Product[]>("/products", [
    "owner",
    "operations",
    "sales",
  ]);
  const stockQuery = useOperation<StockSummary[]>("/inventory/summary", [
    "owner",
    "operations",
  ]);
  const warehouseQuery = useOperation<Warehouse[]>(
    "/inventory/warehouses",
    inventoryRoles,
  );
  const warehouses = warehouseQuery.data ?? [];
  const bins = useWarehouseBins();
  const reservationsQuery = useOperation<WarehouseReservation[]>(
    `/inventory/reservations?jobId=${encodeURIComponent(jobId)}`,
    inventoryRoles,
  );
  const context = useOperation<JobEntryContext>(`/jobs/${jobId}/entry-context`);
  const canStock = user?.role === "owner" || user?.role === "operations";
  const materials = materialsQuery.data ?? [];
  const products = productsQuery.data ?? [];
  const reservations = reservationsQuery.data ?? [];
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reserve, setReserve] = useState<JobMaterial | null>(null);
  const [reserveQuantity, setReserveQuantity] = useState("");
  const [reserveWarehouseId, setReserveWarehouseId] = useState("");
  const [consume, setConsume] = useState<WarehouseReservation | null>(null);
  const [picking, setPicking] = useState<WarehouseReservation>();
  const pickStock = useOperation<BinStock[]>(
    binStockQuery({ productId: picking?.productId, warehouseId: picking?.warehouseId ?? undefined }),
    picking ? inventoryRoles : [],
  );
  const [consumeBinId, setConsumeBinId] = useState("");
  const [callbackId, setCallbackId] = useState("");
  const requestKey = useRef({ payload: "", key: "" });
  const run = async (action: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      toast({ title: message });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The change could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const edit = (material?: JobMaterial) => {
    setError("");
    setEditingId(material?.id ?? null);
    setForm(
      material
        ? {
            name: material.name,
            quantity: String(material.quantity),
            unit: material.unit,
            productId: material.productId ?? "",
          }
        : empty(),
    );
    setOpen(true);
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void run(
      async () => {
        await operation(
          `/jobs/${jobId}/materials${editingId ? `/${editingId}` : ""}`,
          editingId ? "PATCH" : "POST",
          {
            name: form.name.trim(),
            quantity: Number(form.quantity),
            unit: form.unit.trim(),
            productId: form.productId || null,
          },
        );
        setOpen(false);
      },
      editingId ? "Requirement updated" : "Requirement added",
    );
  };
  const reserveStock = (event: React.FormEvent) => {
    event.preventDefault();
    if (!reserve?.productId) return;
    void run(async () => {
      if (warehouseQuery.isLoading || warehouseQuery.isError) {
        throw new Error(
          "Warehouse locations could not load. Try again before reserving stock.",
        );
      }
      const data = {
        productId: reserve.productId,
        jobId,
        warehouseId: reserveWarehouseId || null,
        quantity: Number(reserveQuantity),
      };
      const payload = JSON.stringify(data);
      if (requestKey.current.payload !== payload)
        requestKey.current = { payload, key: crypto.randomUUID() };
      await operation("/inventory/reservations", "POST", {
        ...data,
        idempotencyKey: requestKey.current.key,
      });
      requestKey.current = { payload: "", key: "" };
      setReserveWarehouseId("");
      setReserve(null);
    }, "Stock reserved for this job");
  };
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Materials needed</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Requirements, available stock, and job reservations.
          </p>
        </div>
        <Button size="sm" onClick={() => edit()}>
          <Plus className="mr-2 h-4 w-4" />
          Add material
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && !open && !reserve && !consume && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {materialsQuery.error && (
          <p role="alert" className="text-sm text-destructive">
            Requirements could not be loaded.{" "}
            <Button variant="link" onClick={() => void refresh()}>
              Retry
            </Button>
          </p>
        )}
        {materialsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">Loading requirements…</p>
        ) : !materials.length ? (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            Add required products and quantities to plan this job’s materials.
          </p>
        ) : (
          <div className="divide-y rounded-lg border">
            {materials.map((material) => {
              const product = products.find((p) => p.id === material.productId);
              const stock = stockQuery.data?.find(
                (s) => s.productId === material.productId,
              );
              const reserved = reservations
                .filter(
                  (r) =>
                    r.productId === material.productId && r.status === "Active",
                )
                .reduce((sum, r) => sum + r.quantity, 0);
              return (
                <div
                  key={material.id}
                  className="flex flex-wrap items-start justify-between gap-3 p-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-words">{material.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {quantity(material.quantity)} {material.unit} required
                      {product?.sku ? ` · SKU ${product.sku}` : ""}
                    </p>
                    {!material.productId && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Not linked to a catalog product
                      </p>
                    )}
                    {canStock && product?.inventoryType === "Inventory" && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {stock
                          ? `${quantity(stock.available)} available · ${quantity(reserved)} reserved for this job`
                          : "Stock availability unavailable"}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {canStock && product?.inventoryType === "Inventory" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !stock || !!reservationsQuery.error}
                        onClick={() => {
                          setError("");
                          setReserve(material);
                          setReserveQuantity(
                            String(Math.max(0, material.quantity - reserved)),
                          );
                        }}
                      >
                        Reserve
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      aria-label={`Edit ${material.name}`}
                      onClick={() => edit(material)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      aria-label={`Delete ${material.name} requirement`}
                      onClick={() =>
                        void run(
                          () =>
                            operation(
                              `/jobs/${jobId}/materials/${material.id}`,
                              "DELETE",
                            ),
                          "Requirement removed; stock reservations retained",
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {canStock && (
          <div className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-semibold">Reserved stock</h3>
            {(stockQuery.error || reservationsQuery.error) && (
              <p role="alert" className="text-sm text-destructive">
                Stock records could not be loaded.{" "}
                <Button variant="link" onClick={() => void refresh()}>
                  Retry
                </Button>
              </p>
            )}
            {reservationsQuery.isPending ? (
              <p className="text-sm text-muted-foreground">
                Loading reservations…
              </p>
            ) : !reservations.length ? (
              <p className="text-sm text-muted-foreground">
                No stock reserved for this job.
              </p>
            ) : (
              reservations.map((reservation) => (
                <div
                  key={reservation.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {products.find((p) => p.id === reservation.productId)
                        ?.name ?? "Linked product"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {quantity(reservation.quantity)}{" "}
                      {products.find((p) => p.id === reservation.productId)
                        ?.unit ?? "units"}{" "}
                      · {warehouseName(warehouses, reservation.warehouseId)} ·{" "}
                      {reservation.stagedBinId ? `Staged in ${binName(bins.data ?? [], reservation.stagedBinId)} · ${reservation.status}` : reservation.status}
                    </p>
                  </div>
                  {reservation.status === "Active" && (
                    <div className="flex flex-wrap gap-2">
                      {reservation.warehouseId && !reservation.stagedBinId && (
                        <Button size="sm" variant="outline" disabled={busy || !bins.isSuccess || !warehouseQuery.isSuccess} onClick={() => setPicking(reservation)}>
                          Pick and stage
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              operation(
                                `/inventory/reservations/${reservation.id}`,
                                "PATCH",
                                {
                                  revision: reservation.revision,
                                  status: "Released",
                                },
                              ),
                            "Reservation released",
                          )
                        }
                      >
                        Release
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy || !!context.error}
                        onClick={() => {
                          setError("");
                          setConsume(reservation);
                          setConsumeBinId("");
                          setCallbackId("");
                        }}
                      >
                        Consume
                      </Button>
                    </div>
                  )}
                </div>
              ))
            )}
            <p className="text-xs text-muted-foreground">
              Consuming stock records material usage and cost once. Changing a
              requirement does not release stock.
            </p>
          </div>
        )}
      </CardContent>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId
                ? "Edit material requirement"
                : "Add material requirement"}
            </DialogTitle>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submit}>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {productsQuery.allowed && (
              <div className="space-y-2">
                <Label htmlFor="requirement-product">Catalog product</Label>
                <select
                  id="requirement-product"
                  className={selectClass}
                  value={form.productId}
                  onChange={(e) => {
                    const product = products.find(
                      (p) => p.id === e.target.value,
                    );
                    setForm({
                      ...form,
                      productId: e.target.value,
                      name: product?.name ?? form.name,
                      unit: product?.unit ?? form.unit,
                    });
                  }}
                >
                  <option value="">Unlinked requirement</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name} · {product.sku || product.unit}
                    </option>
                  ))}
                </select>
                {productsQuery.error && (
                  <p className="text-sm text-destructive">
                    Catalog could not be loaded.
                  </p>
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="requirement-name">Material name</Label>
              <Input
                id="requirement-name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="requirement-quantity">Quantity</Label>
                <Input
                  id="requirement-quantity"
                  type="number"
                  required
                  min="0.000001"
                  step="any"
                  value={form.quantity}
                  onChange={(e) =>
                    setForm({ ...form, quantity: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="requirement-unit">Unit</Label>
                <Input
                  id="requirement-unit"
                  required
                  disabled={!!form.productId}
                  value={form.unit}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button disabled={busy} type="submit">
                {busy ? "Saving…" : "Save requirement"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!reserve}
        onOpenChange={(v) => {
          if (!v && !busy) {
            setReserve(null);
            setReserveWarehouseId("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reserve {reserve?.name}</DialogTitle>
          </DialogHeader>
          <form className="space-y-4" onSubmit={reserveStock}>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Reserving sets stock aside for this job without recording
              consumption.
            </p>
            <Label htmlFor="reserve-warehouse">Reserve at warehouse</Label>
            <select
              id="reserve-warehouse"
              className={selectClass}
              disabled={warehouseQuery.isLoading || warehouseQuery.isError}
              value={reserveWarehouseId}
              onChange={(event) => setReserveWarehouseId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name}
                </option>
              ))}
            </select>
            <Label htmlFor="reserve-quantity">Quantity ({reserve?.unit})</Label>
            <Input
              id="reserve-quantity"
              type="number"
              min="0.000001"
              step="any"
              required
              value={reserveQuantity}
              onChange={(e) => setReserveQuantity(e.target.value)}
            />
            <DialogFooter>
              <Button disabled={busy} type="submit">
                {busy ? "Reserving…" : "Reserve stock"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!consume}
        onOpenChange={(v) => {
          if (!v && !busy) setConsume(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Consume reserved stock</DialogTitle>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Record {consume?.quantity}{" "}
            {products.find((p) => p.id === consume?.productId)?.unit ?? "units"}{" "}
            as used. Inventory and job material cost update together.
          </p>
          {consume?.stagedBinId && <p className="text-sm">Issue from staged bin {binName(bins.data ?? [], consume.stagedBinId)}.</p>}
          {consume?.warehouseId && !consume.stagedBinId && <ProductBinSelect label="Issue from bin" productId={consume.productId} warehouseId={consume.warehouseId} bins={bins.data ?? []} value={consumeBinId} onChange={setConsumeBinId} disabled={busy || bins.isLoading || bins.isError} />}
          {consume?.warehouseId && bins.isError && <p role="alert" className="text-sm text-destructive">Could not load warehouse bins. <button type="button" className="underline" onClick={() => void bins.refetch()}>Retry</button></p>}
          <Label htmlFor="consume-callback">Work category</Label>
          <select
            id="consume-callback"
            className={selectClass}
            value={callbackId}
            onChange={(e) => setCallbackId(e.target.value)}
          >
            <option value="">Original installation</option>
            {context.data?.callbacks.map((c) => (
              <option key={c.id} value={c.id}>
                Callback · {c.reason}
              </option>
            ))}
          </select>
          <DialogFooter>
            <Button
              disabled={busy || !consume || Boolean(consume.warehouseId && (bins.isLoading || bins.isError))}
              onClick={() => {
                if (consume)
                  void run(async () => {
                    await operation(
                      `/inventory/reservations/${consume.id}`,
                      "PATCH",
                      {
                        revision: consume.revision,
                        status: "Consumed",
                        ...(consume.warehouseId ? { binId: consume.stagedBinId || consumeBinId || null } : {}),
                        callbackId: callbackId || undefined,
                      },
                    );
                    setConsume(null);
                  }, "Reserved stock consumed and cost recorded");
              }}
            >
              {busy ? "Recording…" : "Consume & record cost"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {picking && (
        <StageReservationDialog reservation={picking}
          unit={products.find((product) => product.id === picking.productId)?.unit ?? "units"}
          warehouses={warehouses} bins={bins.data ?? []} stock={pickStock.data ?? []}
          stockStatus={pickStock.isError ? "unavailable" : pickStock.isLoading ? "loading" : undefined}
          onClose={() => setPicking(undefined)}
          onSaved={() => {
            setPicking(undefined);
            toast({ title: "Reserved stock staged for the job" });
            void refresh();
          }} />
      )}
    </Card>
  );
}
