import { useRef, useState, type FormEvent } from "react";
import { ArrowLeftRight, Plus, Printer } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { StockCounts } from "@/components/inventory/StockCounts";
import { StockPieceLabel } from "@/components/inventory/StockPieceLabel";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useStore } from "@/hooks/use-store";
import { useUnsavedForm } from "@/hooks/use-unsaved-changes";
import { useQueryControls, useUrlState } from "@/hooks/use-url-state";
import { operation, useOperation, useRefreshOperations } from "@/lib/operations";
import {
  binName,
  binsInWarehouse,
  binStockQuery,
  inventorySelect,
  purchaseQuantity,
  useInventoryRequestKey,
  warehouseBinsPath,
  type BinStock,
  type WarehouseBin,
} from "@/lib/purchasing";
import type { Product } from "@/lib/types";
import { inventoryRoles, type Warehouse } from "@/lib/warehouse-inventory";
import { locationBarcode, readLocationBarcode } from "@/lib/warehouse-labels";

const unbinned = "unbinned";
const keyFor = (id: string | null) => id ?? unbinned;
const idFor = (key: string) => key === unbinned ? null : key;

function AddBin({ warehouse, onClose, onSaved }: {
  warehouse: Warehouse;
  onClose(): void;
  onSaved(bin: WarehouseBin): void;
}) {
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const changes = useUnsavedForm(true, code);
  const close = () => { if (!inFlight.current && changes.confirmDiscard()) onClose(); };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !code.trim()) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const bin = await operation<WarehouseBin>(warehouseBinsPath, "POST", { warehouseId: warehouse.id, code: code.trim() });
      changes.reset(code);
      onSaved(bin);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not add this bin.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add bin to {warehouse.name}</DialogTitle>
          <DialogDescription>Use the code printed on the shelf or floor location.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-3">
          <label className="block space-y-1 text-sm font-medium">Bin code
            <Input required maxLength={64} placeholder="A-03-02" value={code} disabled={saving} onChange={(event) => setCode(event.target.value)} />
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" type="button" disabled={saving} onClick={close}>Cancel</Button>
            <Button type="submit" disabled={saving || !code.trim()}>{saving ? "Adding…" : "Add bin"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MoveBinStock({ warehouse, bins, stock, products, initialProduct, initialSource, onClose, onSaved }: {
  warehouse: Warehouse;
  bins: readonly WarehouseBin[];
  stock: readonly BinStock[];
  products: readonly Product[];
  initialProduct?: string;
  initialSource?: string;
  onClose(): void;
  onSaved(): void;
}) {
  const [form, setForm] = useState({ productId: initialProduct ?? "", from: initialSource ?? "", to: "", quantity: "", reason: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const requestKey = useInventoryRequestKey();
  const changes = useUnsavedForm(true, form);
  const inStockProducts = products.filter((product) => stock.some((row) => row.productId === product.id && row.onHand > 0));
  const locations = stock.filter((row) => row.productId === form.productId && row.onHand > 0);
  const source = locations.find((row) => keyFor(row.binId) === form.from);
  const unit = products.find((product) => product.id === form.productId)?.unit;
  const close = () => { if (!inFlight.current && changes.confirmDiscard()) onClose(); };

  async function move(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !source || !form.to || form.from === form.to || !form.reason.trim()) return;
    const data = {
      warehouseId: warehouse.id,
      productId: form.productId,
      fromBinId: source.binId,
      toBinId: idFor(form.to),
      quantity: Number(form.quantity),
      reason: form.reason.trim(),
    };
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      await operation("/inventory/bin-moves", "POST", { ...data, idempotencyKey: requestKey.forBody(data) });
      changes.reset(form);
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not move stock between bins.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move stock between bins</DialogTitle>
          <DialogDescription>Record a move within {warehouse.name}.</DialogDescription>
        </DialogHeader>
        <form onSubmit={move} className="space-y-3">
          <fieldset disabled={saving} className="space-y-3">
            <label className="block space-y-1 text-sm font-medium">Product
              <select className={inventorySelect} required value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value, from: "", to: "", quantity: "" })}>
                <option value="">Select product</option>
                {inStockProducts.map((product) => <option key={product.id} value={product.id}>{product.sku} · {product.name}</option>)}
              </select>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm font-medium">From bin
                <select className={inventorySelect} required disabled={!form.productId} value={form.from} onChange={(event) => setForm({ ...form, from: event.target.value, to: "", quantity: "" })}>
                  <option value="">Select source</option>
                  {locations.map((row) => <option key={keyFor(row.binId)} value={keyFor(row.binId)}>{binName(bins, row.binId)} · {purchaseQuantity(row.onHand)} {unit}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-sm font-medium">To bin
                <select className={inventorySelect} required disabled={!source} value={form.to} onChange={(event) => setForm({ ...form, to: event.target.value })}>
                  <option value="">Select destination</option>
                  {form.from !== unbinned && <option value={unbinned}>Unbinned</option>}
                  {bins.filter((bin) => bin.id !== form.from).map((bin) => <option key={bin.id} value={bin.id}>{bin.code}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-sm font-medium">Quantity{unit && ` (${unit})`}
                <Input type="number" required min="0.000001" step="0.000001" max={source && Math.min(source.onHand, 1_000_000)} value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
              </label>
              <label className="space-y-1 text-sm font-medium">Reason
                <Input required maxLength={2000} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
              </label>
            </div>
          </fieldset>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={close}>Cancel</Button>
            <Button type="submit" disabled={saving || !source || !form.to || !form.reason.trim() || !(Number(form.quantity) > 0)}>{saving ? "Moving…" : "Move stock"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BinContents({ warehouse, bins, products, productsUnavailable, productsFailed }: {
  warehouse: Warehouse;
  bins: readonly WarehouseBin[];
  products: readonly Product[];
  productsUnavailable: boolean;
  productsFailed: boolean;
}) {
  const stock = useOperation<BinStock[]>(binStockQuery({ warehouseId: warehouse.id }), inventoryRoles);
  const refresh = useRefreshOperations();
  const [binFilter, setBinFilter] = useUrlState<string>("bin", "all");
  const [search, setSearch] = useUrlState<string>("q", "");
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<{ product?: string; source?: string }>();
  const [printing, setPrinting] = useState(false);
  const [notice, setNotice] = useState("");
  const term = search.trim().toLowerCase();
  const rows = stock.data ?? [];
  const visible = rows.map((row) => ({ row, product: products.find((item) => item.id === row.productId) })).filter(({ row, product }) =>
    (binFilter === "all" || binFilter === keyFor(row.binId)) &&
    (!term || [product?.sku, product?.name, binName(bins, row.binId)].some((label) => label?.toLowerCase().includes(term))),
  );
  const canMove = bins.length > 0 && rows.some((row) => row.onHand > 0) && !productsUnavailable && !stock.isError;
  const selectedBin = bins.find((bin) => bin.id === binFilter);

  return (
    <section aria-label={`${warehouse.name} bin stock`} className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 space-y-1 text-sm font-medium">Bin
          <select className={inventorySelect} value={binFilter} onChange={(event) => setBinFilter(event.target.value)}>
            <option value="all">All bins</option>
            <option value={unbinned}>Unbinned</option>
            {bins.map((bin) => <option key={bin.id} value={bin.id}>{bin.code}</option>)}
          </select>
        </label>
        <label className="min-w-44 flex-1 space-y-1 text-sm font-medium">Find a SKU or bin
          <Input className="h-10" placeholder="Search SKU, product, or bin code…" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <Button variant="outline" onClick={() => { setNotice(""); setAdding(true); }}><Plus className="mr-2 h-4 w-4" aria-hidden />Add bin</Button>
        <Button variant="outline" disabled={!canMove} onClick={() => { setNotice(""); setMoving({}); }}><ArrowLeftRight className="mr-2 h-4 w-4" aria-hidden />Move stock</Button>
        <Button variant="outline" onClick={() => setPrinting(true)}><Printer className="mr-2 h-4 w-4" aria-hidden />{selectedBin ? "Print bin label" : "Print warehouse label"}</Button>
      </div>
      {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
      {stock.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading bin stock…</p>}
      {stock.isError && <p role="alert" className="text-sm text-destructive">Could not load bin stock. <button className="underline" onClick={() => void stock.refetch()}>Retry</button></p>}
      {productsUnavailable && !productsFailed && <p role="status" className="text-sm text-muted-foreground">Loading the product catalog…</p>}
      {productsFailed && <p role="alert" className="text-sm text-destructive">Could not load the product catalog. <button className="underline" onClick={() => void refresh()}>Retry</button></p>}
      {stock.data && visible.length === 0 && <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">{term ? "No stock matches this search." : "No stock recorded at this location."}</p>}
      {visible.length > 0 && <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-left text-sm" aria-label="Stock by bin">
          <thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th scope="col" className="p-3">Bin</th><th scope="col" className="p-3">SKU / product</th><th scope="col" className="p-3">On hand</th><th scope="col" className="p-3"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{visible.map(({ row, product }) => <tr className="border-t" key={`${keyFor(row.binId)}:${row.productId}`}>
            <td className="p-3 font-semibold">{binName(bins, row.binId)}</td>
            <td className="p-3">{product ? <Link href={`/inventory?q=${encodeURIComponent(product.sku)}${product.active ? "" : "&state=archived"}`} className="font-medium underline-offset-4 hover:underline">{product.sku}<span className="block text-xs text-muted-foreground">{product.name}</span></Link> : "Product details unavailable"}</td>
            <td className="p-3 tabular-nums">{purchaseQuantity(row.onHand)} {product?.unit}</td>
            <td className="p-3 text-right">{canMove && product && row.onHand > 0 && <Button variant="ghost" size="sm" aria-label={`Move ${product.sku} from ${binName(bins, row.binId)}`} onClick={() => { setNotice(""); setMoving({ product: row.productId, source: keyFor(row.binId) }); }}>Move</Button>}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {adding && <AddBin warehouse={warehouse} onClose={() => setAdding(false)} onSaved={(bin) => { setAdding(false); setNotice(`${bin.code} added to ${warehouse.name}.`); void refresh(); }} />}
      {moving && <MoveBinStock warehouse={warehouse} bins={bins} stock={rows} products={products} initialProduct={moving.product} initialSource={moving.source} onClose={() => setMoving(undefined)} onSaved={() => { setMoving(undefined); setNotice("Stock move recorded."); void refresh(); }} />}
      {printing && <StockPieceLabel title={selectedBin ? "Bin label" : "Warehouse label"} label={selectedBin?.code ?? warehouse.name}
        code={locationBarcode(selectedBin ? { kind: "bin", id: selectedBin.id } : { kind: "warehouse", id: warehouse.id })}
        fields={selectedBin ? [["Warehouse", warehouse.name]] : []} onClose={() => setPrinting(false)} />}
    </section>
  );
}

export default function WarehouseBins() {
  const warehouses = useOperation<Warehouse[]>("/inventory/warehouses", inventoryRoles);
  const bins = useOperation<WarehouseBin[]>(warehouseBinsPath, inventoryRoles);
  const { products, jobs, queryState } = useStore();
  const { update } = useQueryControls();
  const [warehouseId] = useUrlState("warehouse", "");
  const [scan, setScan] = useState("");
  const [scanError, setScanError] = useState("");
  const selected = warehouseId ? warehouses.data?.find((warehouse) => warehouse.id === warehouseId) : warehouses.data?.[0];
  function openScannedLocation(event: FormEvent) {
    event.preventDefault();
    const label = readLocationBarcode(scan);
    const candidate = label?.kind === "bin" ? bins.data?.find(({ id }) => id === label.id) : undefined;
    const nextWarehouse = label?.kind === "warehouse" ? label.id : candidate?.warehouseId;
    if (!nextWarehouse || !warehouses.data?.some(({ id }) => id === nextWarehouse)) {
      setScanError("No warehouse or bin matches this label.");
      return;
    }
    update({ warehouse: nextWarehouse, bin: candidate?.id ?? null, q: null, count: null });
    setScan("");
    setScanError("");
  }
  if (!warehouses.allowed) return <p>Warehouse bins are available to owner and operations roles.</p>;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Warehouse bins</h1>
        <p className="mt-1 text-sm text-muted-foreground">Look up where products are stored and record moves within a warehouse.</p>
      </header>
      {(warehouses.isLoading || bins.isLoading) && <p role="status" className="text-sm text-muted-foreground">Loading warehouse locations…</p>}
      {(warehouses.isError || bins.isError) && <p role="alert" className="text-sm text-destructive">Could not load warehouse locations. <button className="underline" onClick={() => { void warehouses.refetch(); void bins.refetch(); }}>Retry</button></p>}
      {warehouses.data?.length === 0 && <p className="text-sm text-muted-foreground">Add a warehouse from <Link href="/inventory" className="underline">Inventory</Link> to start tracking bins.</p>}
      {!!warehouses.data?.length && <label className="block max-w-sm space-y-1 text-sm font-medium">Warehouse
        <select className={inventorySelect} value={selected?.id ?? ""} onChange={(event) => update({ warehouse: event.target.value, bin: null, count: null })}>
          {!selected && <option value="" disabled>Choose a warehouse</option>}
          {warehouses.data?.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}
        </select>
      </label>}
      {!!warehouses.data?.length && bins.data && <form onSubmit={openScannedLocation} className="flex flex-wrap items-end gap-2">
        <label className="w-full max-w-sm space-y-1 text-sm font-medium">Scan a location label
          <Input maxLength={100} value={scan} onChange={(event) => { setScan(event.target.value); setScanError(""); }} placeholder="Scan or enter a warehouse or bin code" />
        </label>
        <Button type="submit" variant="outline" disabled={!scan.trim()}>Open location</Button>
        {scanError && <p role="alert" className="w-full text-sm text-destructive">{scanError}</p>}
      </form>}
      {selected && bins.data && !bins.isError && <BinContents key={selected.id} warehouse={selected} bins={binsInWarehouse(bins.data, selected.id)} products={products} productsUnavailable={queryState.products.isLoading || !!queryState.products.error} productsFailed={!!queryState.products.error} />}
      {selected && bins.data && !bins.isError && <StockCounts key={`counts:${selected.id}`} warehouse={selected} bins={binsInWarehouse(bins.data, selected.id)} products={products} jobs={jobs} productsUnavailable={queryState.products.isLoading || !!queryState.products.error} />}
    </div>
  );
}
