import { useRef, useState } from "react";
import { ClipboardList, Plus, Search } from "lucide-react";
import { Link } from "wouter";
import { PurchaseOrderDraft } from "@/components/inventory/PurchaseOrderDraft";
import { PurchaseOrderReceiving } from "@/components/inventory/PurchaseOrderReceiving";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useStore } from "@/hooks/use-store";
import { useUrlState } from "@/hooks/use-url-state";
import { currency, operation, useOperation, useRefreshOperations } from "@/lib/operations";
import {
  binName,
  inventorySelect,
  purchaseOrdersPath,
  purchaseOrderStatuses,
  purchaseQuantity,
  warehouseBinsPath,
  type PurchaseOrder,
  type PurchaseReceipt,
  type WarehouseBin,
} from "@/lib/purchasing";
import { inventoryRoles, warehouseName, type Warehouse } from "@/lib/warehouse-inventory";

function ReceiptHistory({ order, bins }: { order: PurchaseOrder; bins: readonly WarehouseBin[] }) {
  const receipts = useOperation<PurchaseReceipt[]>(`${purchaseOrdersPath}/${encodeURIComponent(order.id)}/receipts`, inventoryRoles);
  return (
    <section className="space-y-2 border-t pt-4" aria-label="Receipt history">
      <h3 className="font-semibold">Receipt history</h3>
      {receipts.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading receipts…</p>}
      {receipts.isError && <p role="alert" className="text-sm text-destructive">Could not load receipts. <button className="underline" onClick={() => void receipts.refetch()}>Retry</button></p>}
      {receipts.data?.length === 0 && <p className="text-sm text-muted-foreground">No receipts recorded.</p>}
      {receipts.data && receipts.data.length > 0 && (
        <ul className="divide-y rounded-lg border text-sm">
          {receipts.data.map((receipt) => (
            <li key={receipt.id} className="space-y-1 p-3">
              <p className="font-medium">{receipt.reference || "Receipt"} · {new Date(receipt.receivedAt).toLocaleString()}</p>
              <ul className="space-y-1 text-muted-foreground">
                {receipt.lines.map((item) => {
                  const line = order.lines.find((candidate) => candidate.id === item.lineId);
                  return <li key={item.id ?? item.movementId}>
                    {line?.sku || line?.productName || "Product"}
                    {item.quantity > 0 && ` · ${purchaseQuantity(item.quantity)} ${line?.unit} · ${binName(bins, item.binId)}`}
                    {item.unitCost != null && ` · $${purchaseQuantity(Number(item.unitCost))} per ${line?.unit || "unit"}`}
                    {!!item.damagedQuantity && ` · ${purchaseQuantity(item.damagedQuantity)} ${line?.unit ?? "units"} damaged`}
                    {item.damageNote && <p className="pl-2">{item.damageNote}</p>}
                  </li>;
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function PurchaseOrders() {
  const { jobs = [], products, queryState } = useStore();
  const orders = useOperation<PurchaseOrder[]>(purchaseOrdersPath, inventoryRoles);
  const locations = useOperation<Warehouse[]>("/inventory/warehouses", inventoryRoles);
  const warehouseBins = useOperation<WarehouseBin[]>(warehouseBinsPath, inventoryRoles);
  const warehouses = locations.data ?? [];
  const bins = warehouseBins.data ?? [];
  const refresh = useRefreshOperations();
  const [search, setSearch] = useUrlState<string>("q", "");
  const [status, setStatus] = useUrlState<string>("status", "All");
  const [selectedId, setSelectedId] = useUrlState<string>("order", "");
  const [jobId, setJobId] = useUrlState<string>("job", "");
  const [draft, setDraft] = useState<PurchaseOrder | "new">();
  const [receiving, setReceiving] = useState<PurchaseOrder>();
  const [cancelling, setCancelling] = useState<PurchaseOrder>();
  const [delivery, setDelivery] = useState<{ order: PurchaseOrder; date: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const term = search.trim().toLowerCase();
  const visible = (orders.data ?? []).filter((order) =>
    (!jobId || order.jobId === jobId) &&
    (status === "All" || status === order.status) &&
    (!term || [order.orderNumber, order.supplier, warehouseName(warehouses, order.warehouseId), jobs.find((job) => job.id === order.jobId)?.jobNumber ?? "", ...order.lines.map((line) => `${line.sku} ${line.productName}`)]
      .some((value) => value.toLowerCase().includes(term))),
  );
  const selected = orders.data?.find((order) => order.id === selectedId);
  const selectedJob = jobs.find((job) => job.id === selected?.jobId);
  const filteredJob = jobs.find((job) => job.id === jobId);
  const canStart = Boolean(warehouses.length && products.some((product) => product.active && product.inventoryType === "Inventory") && !queryState.products.error && !locations.isError);

  function announce(message: string) {
    setError("");
    setNotice(message);
  }

  async function changeStatus(order: PurchaseOrder, next: "Ordered" | "Cancelled") {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    announce("");
    try {
      const saved = await operation<PurchaseOrder>(`${purchaseOrdersPath}/${encodeURIComponent(order.id)}`, "PATCH", { revision: order.revision, status: next });
      setCancelling(undefined);
      announce(next === "Ordered" ? `${saved.orderNumber} marked ordered.` : `${saved.orderNumber} cancelled.`);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not update the purchase order.");
      void orders.refetch();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function saveDelivery() {
    if (!delivery || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    announce("");
    try {
      const { order, date } = delivery;
      await operation(`${purchaseOrdersPath}/${encodeURIComponent(order.id)}`, "PATCH", {
        revision: order.revision, expectedOn: date || null,
      });
      setDelivery(undefined);
      announce(`Delivery date updated for ${order.orderNumber}.`);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the delivery date.");
      void orders.refetch();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (!orders.allowed) return <p>Purchase orders are available to owner and operations roles.</p>;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Purchase orders</h1>
          <p className="mt-1 text-sm text-muted-foreground">Track supplier orders, outstanding quantities, and warehouse receipts.</p>
        </div>
        <Button disabled={!canStart} onClick={() => { announce(""); setDraft("new"); }}><Plus className="mr-2 h-4 w-4" aria-hidden />New purchase order</Button>
      </header>
      {(locations.isError || queryState.products.error) && <p role="alert" className="text-sm text-destructive">The warehouse or product catalog could not load. <button className="underline" onClick={() => void refresh()}>Retry</button></p>}
      {!locations.isLoading && !locations.isError && !warehouses.length && <p className="text-sm text-muted-foreground">Add a warehouse from <Link className="underline" href="/inventory">Inventory</Link> to start a purchase order.</p>}
      {!queryState.products.isLoading && !queryState.products.error && !products.some((product) => product.active && product.inventoryType === "Inventory") && <p className="text-sm text-muted-foreground">Add an active stocked product from <Link className="underline" href="/inventory">Inventory</Link>.</p>}
      {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
      {error && !cancelling && !delivery && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="grid gap-4 xl:grid-cols-[minmax(18rem,1fr)_minmax(0,2fr)]">
        <section className="min-w-0 space-y-3" aria-label="Purchase order list">
          <div className="flex flex-wrap gap-2">
            <label className="relative min-w-36 flex-1">
              <span className="sr-only">Search purchase orders</span>
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
              <Input className="h-10 pl-9" placeholder="Search orders…" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <select aria-label="Order status" className={`${inventorySelect} w-auto`} value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="All">All statuses</option>
              {purchaseOrderStatuses.map((value) => <option key={value}>{value}</option>)}
            </select>
          </div>
          {jobId && (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>{filteredJob ? `${filteredJob.jobNumber} · ${filteredJob.customerName}` : "Linked job"}</span>
              <Button size="sm" variant="ghost" onClick={() => setJobId("")}>Show all jobs</Button>
            </div>
          )}
          {orders.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading purchase orders…</p>}
          {orders.isError && <p role="alert" className="text-sm text-destructive">Could not load purchase orders. <button className="underline" onClick={() => void orders.refetch()}>Retry</button></p>}
          {orders.data && !visible.length && <p className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">{term || jobId || status !== "All" ? "No purchase orders match these filters." : "No purchase orders have been created."}</p>}
          {visible.length > 0 && (
            <ul className="overflow-hidden rounded-lg border bg-card">
              {visible.map((order) => (
                <li key={order.id} className="border-b last:border-b-0">
                  <button type="button" aria-pressed={selectedId === order.id} className="w-full space-y-1 p-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-muted" onClick={() => { announce(""); setSelectedId(order.id); }}>
                    <span className="flex flex-wrap items-center justify-between gap-1 font-semibold">{order.orderNumber}<Badge variant={order.status === "Received" ? "default" : "secondary"}>{order.status}</Badge></span>
                    <span className="block text-muted-foreground">{order.supplier} · {warehouseName(warehouses, order.warehouseId)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {selected ? (
          <section className="min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5" aria-label="Selected purchase order">
            <div className="flex flex-wrap justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">{selected.orderNumber}</h2>
                <p className="text-sm text-muted-foreground">{selected.supplier} · {warehouseName(warehouses, selected.warehouseId)}</p>
              </div>
              <Badge variant={selected.status === "Received" ? "default" : "secondary"} className="self-start">{selected.status}</Badge>
            </div>
            {(selected.jobId || selected.expectedOn) && (
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
                {selected.jobId && <Link className="underline" href={`/jobs/${encodeURIComponent(selected.jobId)}`}>{selectedJob ? `${selectedJob.jobNumber} · ${selectedJob.customerName}` : "View linked job"}</Link>}
                {selected.expectedOn && <span>Expected {selected.expectedOn}</span>}
              </p>
            )}
            {selected.notes && <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-sm">{selected.notes}</p>}
            <div className="overflow-x-auto rounded-lg border">
              <table aria-label="Order lines" className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground"><tr>
                  <th scope="col" className="p-2.5">Product</th><th scope="col" className="p-2.5">Ordered</th><th scope="col" className="p-2.5">Received</th><th scope="col" className="p-2.5">Unit cost</th>
                </tr></thead>
                <tbody>{selected.lines.map((line) => <tr key={line.id} className="border-t">
                  <td className="p-2.5 font-medium">{line.productName}<span className="block text-xs text-muted-foreground">{line.sku}</span></td>
                  <td className="p-2.5 tabular-nums">{purchaseQuantity(line.quantity)} {line.unit}</td>
                  <td className="p-2.5 tabular-nums">{purchaseQuantity(line.receivedQuantity)} {line.unit}</td>
                  <td className="p-2.5 tabular-nums">${purchaseQuantity(Number(line.unitCost))}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <p className="text-right text-sm text-muted-foreground">Merchandise total <strong className="ml-1 text-foreground">{currency(selected.lines.reduce((sum, line) => sum + line.quantity * Number(line.unitCost), 0))}</strong></p>
            <div className="flex flex-wrap gap-2">
              {selected.status === "Draft" && <>
                <Button variant="outline" disabled={busy || !canStart} onClick={() => { announce(""); setDraft(selected); }}>Edit draft</Button>
                <Button disabled={busy} onClick={() => void changeStatus(selected, "Ordered")}>Mark ordered</Button>
              </>}
              {(selected.status === "Ordered" || selected.status === "Partially received") && <>
                <Button disabled={busy || warehouseBins.isLoading || warehouseBins.isError} onClick={() => { announce(""); setReceiving(selected); }}>Receive shipment</Button>
                <Button variant="outline" disabled={busy} onClick={() => { announce(""); setDelivery({ order: selected, date: selected.expectedOn ?? "" }); }}>Update delivery date</Button>
              </>}
              {selected.status !== "Received" && selected.status !== "Cancelled" && <Button variant="outline" disabled={busy} onClick={() => { announce(""); setCancelling(selected); }}>{selected.status === "Partially received" ? "Cancel remainder" : "Cancel order"}</Button>}
            </div>
            {warehouseBins.isError && <p role="alert" className="text-sm text-destructive">Warehouse bins could not load. <button className="underline" onClick={() => void warehouseBins.refetch()}>Retry</button></p>}
            <ReceiptHistory order={selected} bins={bins} />
          </section>
        ) : (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            <ClipboardList className="mx-auto mb-2 h-6 w-6" aria-hidden />
            {selectedId && orders.data && !orders.isFetching ? "This purchase order could not be found." : "Select a purchase order to view its lines and receipts."}
          </div>
        )}
      </div>
      {draft && <PurchaseOrderDraft order={draft === "new" ? undefined : draft} products={products} warehouses={warehouses} jobs={jobs} initialJobId={jobId} onClose={() => setDraft(undefined)} onSaved={(saved) => {
        setDraft(undefined);
        announce(`${saved.orderNumber} draft saved.`);
        void refresh().finally(() => setSelectedId(saved.id));
      }} />}
      {delivery && <Dialog open onOpenChange={(open) => { if (!open && !busy) { setDelivery(undefined); setError(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update delivery date for {delivery.order.orderNumber}</DialogTitle>
            <DialogDescription>Use the supplier's latest estimate for the outstanding quantities.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void saveDelivery(); }}>
            <label className="block space-y-1 text-sm font-medium">
              Expected delivery
              <Input type="date" disabled={busy} value={delivery.date} onChange={(event) => setDelivery({ ...delivery, date: event.target.value })} />
            </label>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end">
              <Button disabled={busy} type="submit">{busy ? "Saving…" : "Save date"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>}
      {receiving && <PurchaseOrderReceiving order={receiving} warehouse={warehouseName(warehouses, receiving.warehouseId)} bins={bins} binsUnavailable={warehouseBins.isError} onClose={() => setReceiving(undefined)} onReceived={({ order }) => {
        setReceiving(undefined);
        announce(`Receipt recorded for ${order.orderNumber}.`);
        void refresh();
      }} />}
      {cancelling && <Dialog open onOpenChange={(open) => { if (!open && !busy) { setCancelling(undefined); setError(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel {cancelling.orderNumber}?</DialogTitle>
            <DialogDescription>{cancelling.status === "Partially received" ? "The remaining order quantities will be cancelled. Previously received stock stays in inventory." : "Cancel this order when the supplier will not ship it."}</DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => { setCancelling(undefined); setError(""); }}>Keep order</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void changeStatus(cancelling, "Cancelled")}>{cancelling.status === "Partially received" ? "Cancel remaining quantities" : "Cancel purchase order"}</Button>
          </div>
        </DialogContent>
      </Dialog>}
    </div>
  );
}
