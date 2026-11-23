import { useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { WarehouseBinSelect, useWarehouseBins } from "@/components/inventory/WarehouseBinSelect";
import { StockPieceLabel } from "@/components/inventory/StockPieceLabel";
import { CameraScanButton } from "@/components/inventory/CameraScanButton";
import { pieceBarcode } from "@/lib/warehouse-labels";
import { useStore } from "@/hooks/use-store";
import { useAuth } from "@/contexts/auth";
import { useUnsavedForm } from "@/hooks/use-unsaved-changes";
import { useQueryControls, useUrlState } from "@/hooks/use-url-state";
import { operation, useOperation, useRefreshOperations } from "@/lib/operations";
import { binName, inventorySelect, purchaseQuantity, useInventoryRequestKey, type WarehouseBin } from "@/lib/purchasing";
import type { Job, Product } from "@/lib/types";
import { inventoryRoles, warehouseName, type Warehouse, type WarehouseReservation } from "@/lib/warehouse-inventory";

const path = "/inventory/physical-pieces";
const labels = { register: "Label existing stock", cut: "Cut a piece", move: "Move piece", issue: "Issue to a job", return: "Return from job" };
const descriptions = {
  register: "Choose stock already counted at this location. Labeling it keeps the existing on-hand balance.",
  cut: "Enter the cut length and a unique new label. Both pieces stay at this location until moved or issued.",
  move: "Record the new location after the entire labeled piece arrives.",
  issue: "Issue the whole labeled piece. Use Cut a piece first when the job needs a shorter length.",
  return: "Measure the usable length that came back. Only that amount returns to stock and credits the original job.",
};
type Action = keyof typeof labels;
type PieceCost = { layerId: string; sourceMovementId: string; source: string; acquiredAt: string; quantity: number; unitCost: string };
type Piece = {
  id: string; label: string; sku: string; productId: string; productName: string; parentLabel: string | null;
  warehouseId: string; binId: string | null; widthInches: number; lengthInches: number; quantity: number;
  kind: "Roll" | "Remnant"; lot: string; revision: number; issuedMovementId: string | null; issuedJobId: string | null;
  costAllocations: PieceCost[] | null; costReviewedAt: string | null;
};
type HistoryEvent = {
  id: string; action: "registered" | "cost_bound" | "cut" | "moved" | "issued" | "returned"; createdAt: string;
  details: { note?: string; childLabel?: string; quantity?: number; sourceWarehouseId?: string; sourceBinId?: string | null; destinationWarehouseId?: string; destinationBinId?: string | null };
  costAllocations: { source: string; quantity: number; unitCost: string }[] | null;
};

const area = (width: number, length: number) => Math.round(width * length / 144 * 1_000_000) / 1_000_000;
const dimensions = (width: number, length: number) => `${purchaseQuantity(width)} × ${purchaseQuantity(length)} in`;
const withQuery = (value: Record<string, string>) => {
  const query = new URLSearchParams(Object.entries(value).filter(([, text]) => text));
  return query.size ? `${path}?${query}` : path;
};

function PieceEditor({ action, piece, products, jobs, warehouses, bins, defaultProductId, defaultWarehouseId, onClose, onSaved }: {
  action: Action; piece: Piece | null; products: Product[]; jobs: Job[]; warehouses: Warehouse[];
  bins: WarehouseBin[]; defaultProductId: string; defaultWarehouseId: string; onClose(): void; onSaved(message: string): void;
}) {
  const stockedProducts = products.filter((product) => product.active && product.inventoryType === "Inventory" && product.unit === "sqft");
  const [form, setForm] = useState({
    productId: piece?.productId ?? (stockedProducts.some(({ id }) => id === defaultProductId) ? defaultProductId : ""),
    warehouseId: piece?.warehouseId ?? (warehouses.some(({ id }) => id === defaultWarehouseId) ? defaultWarehouseId : ""),
    binId: piece?.binId ?? "",
    label: "", kind: "Roll", lot: "", width: "", length: "",
    jobId: "", reservationId: "", reason: "", confirmedAtDestination: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const requestKey = useInventoryRequestKey();
  const guard = useUnsavedForm(true, form);
  const reservations = useOperation<WarehouseReservation[]>(`/inventory/reservations?productId=${encodeURIComponent(piece?.productId ?? "")}`, action === "issue" ? inventoryRoles : []);
  const matches = piece ? (reservations.data ?? []).filter((reservation) => reservation.status === "Active" && reservation.jobId === form.jobId &&
    reservation.warehouseId === piece.warehouseId && reservation.quantity === piece.quantity) : [];
  const reservationId = form.reservationId || (matches.length === 1 ? matches[0].id : "unreserved");
  const chosenReservation = matches.find(({ id }) => id === reservationId);
  const job = jobs.find((candidate) => candidate.id === form.jobId);
  const closing = () => { if (!inFlight.current && guard.confirmDiscard()) onClose(); };
  const update = (changes: Partial<typeof form>) => { setForm((current) => ({ ...current, ...changes })); setError(""); };
  const enteredLength = Number(form.length);
  const expectedArea = piece && enteredLength === piece.lengthInches ? piece.quantity : area(piece?.widthInches ?? Number(form.width), enteredLength);
  const useLocation = action === "register" || action === "move" || action === "return";
  const movesWarehouse = action === "move" && piece?.warehouseId !== form.warehouseId;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || (!piece && action !== "register")) return;
    if (action === "move" && !movesWarehouse && (form.binId || null) === piece?.binId) {
      setError("Select a different warehouse or bin.");
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError("");
    const note = form.reason.trim();
    const request = async (endpoint: string, data: object) =>
      operation(endpoint, "POST", { ...data, idempotencyKey: requestKey.forBody(data) });
    try {
      if (action === "register") {
        await request(path, {
          productId: form.productId, warehouseId: form.warehouseId, binId: form.binId || null,
          widthInches: Number(form.width), lengthInches: enteredLength, kind: form.kind, label: form.label.trim(), lot: form.lot.trim(), note,
        });
      } else if (piece) {
        const endpoint = `${path}/${encodeURIComponent(piece.id)}`;
        if (action === "cut") await request(`${endpoint}/cut`, { revision: piece.revision, note, label: form.label.trim(), lengthInches: enteredLength });
        else if (action === "move") await request(`${endpoint}/move`, {
          revision: piece.revision, note, binId: form.binId || null, destinationWarehouseId: form.warehouseId,
          ...(movesWarehouse ? { confirmedAtDestination: form.confirmedAtDestination } : {}),
        });
        else {
          const identity = { physicalPieceId: piece.id, pieceRevision: piece.revision };
          if (action === "issue" && reservationId !== "unreserved") {
            if (!chosenReservation) throw new Error("The matching reservation changed. Reopen this form to review the job's stock.");
            await operation(`/inventory/reservations/${encodeURIComponent(chosenReservation.id)}`, "PATCH", {
              ...identity, status: "Consumed", revision: chosenReservation.revision, binId: piece.binId,
            });
          } else if (action === "issue") {
            if (!job) throw new Error("Choose the job receiving this piece.");
            await request("/inventory/movements", {
              ...identity, kind: "consume", productId: piece.productId, jobId: job.id, warehouseId: piece.warehouseId, binId: piece.binId,
              quantity: piece.quantity, reason: note || `Issued labeled piece ${piece.label}`,
            });
          } else {
            if (!piece.issuedMovementId || !piece.issuedJobId) throw new Error("The original job issue could not be found.");
            await request("/inventory/movements", {
              ...identity, kind: "return", productId: piece.productId, jobId: piece.issuedJobId, warehouseId: form.warehouseId, binId: form.binId || null,
              quantity: expectedArea, returnOfMovementId: piece.issuedMovementId, returnLengthInches: enteredLength,
              reason: note || `Returned labeled piece ${piece.label}`,
            });
          }
        }
      }
      guard.reset(form);
      const messages = {
        register: `${form.label.trim()} labeled. An owner must review its acquisition cost before use.`, cut: `${form.label.trim()} cut and labeled.`, move: `${piece?.label} moved.`,
        issue: `${piece?.label} issued.`, return: `${piece?.label} returned to stock.`,
      };
      onSaved(messages[action]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The stock piece could not be saved.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return <Dialog open onOpenChange={(open) => !open && closing()}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{labels[action]}{piece ? ` · ${piece.label}` : ""}</DialogTitle>
        <DialogDescription>{descriptions[action]}</DialogDescription>
      </DialogHeader>
      {piece && <p className="text-sm text-muted-foreground">{piece.sku} · {dimensions(piece.widthInches, piece.lengthInches)} · {purchaseQuantity(piece.quantity)} sq ft</p>}
      <form onSubmit={save} className="space-y-4">
        <fieldset disabled={saving} className="grid gap-3 sm:grid-cols-2">
          {action === "register" && <>
            <label className="space-y-1 text-sm font-medium sm:col-span-2">Stocked product
              <select required className={inventorySelect} value={form.productId} onChange={(event) => update({ productId: event.target.value })}>
                <option value="">Choose product</option>
                {stockedProducts.map((product) => <option key={product.id} value={product.id}>{product.sku} · {product.name}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium">Piece type
              <select className={inventorySelect} value={form.kind} onChange={(event) => update({ kind: event.target.value })}>
                <option>Roll</option><option>Remnant</option>
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium">Dye lot or batch
              <Input maxLength={100} value={form.lot} onChange={(event) => update({ lot: event.target.value })} />
            </label>
          </>}
          {(action === "register" || action === "cut") && <label className="space-y-1 text-sm font-medium sm:col-span-2">Unique piece label
            <Input required placeholder="ROLL-001" maxLength={80} pattern="[A-Za-z0-9][A-Za-z0-9 ._\\/\\-]{0,79}" value={form.label} onChange={(event) => update({ label: event.target.value })} />
          </label>}
          {action === "register" && <label className="space-y-1 text-sm font-medium">Width (inches)
            <Input required type="number" min=".001" max="1200" step=".001" value={form.width} onChange={(event) => update({ width: event.target.value })} />
          </label>}
          {(action === "register" || action === "cut" || action === "return") && <label className="space-y-1 text-sm font-medium">
            {action === "cut" ? "Cut length (inches)" : action === "return" ? "Returned length (inches)" : "Length (inches)"}
            <Input required type="number" min=".001" max={piece?.lengthInches ?? 120000} step=".001" value={form.length} onChange={(event) => update({ length: event.target.value })} />
          </label>}
          {useLocation && <label className="space-y-1 text-sm font-medium">{action === "move" ? "Destination warehouse" : "Warehouse"}
            <select required className={inventorySelect} value={form.warehouseId} onChange={(event) => update({ warehouseId: event.target.value, binId: "", confirmedAtDestination: false })}>
              <option value="">Choose warehouse</option>
              {warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}
            </select>
          </label>}
          {useLocation && <WarehouseBinSelect warehouseId={form.warehouseId} bins={bins} value={form.binId} label={action === "move" ? "Destination bin" : "Bin"} disabled={!form.warehouseId} onChange={(binId) => update({ binId, confirmedAtDestination: false })} />}
          {movesWarehouse && <label className="flex items-start gap-2 text-sm font-medium sm:col-span-2">
            <input type="checkbox" className="mt-1" required checked={form.confirmedAtDestination} onChange={(event) => update({ confirmedAtDestination: event.target.checked })} />
            The piece is already at the destination.
          </label>}
          {action === "issue" && <>
            <label className="space-y-1 text-sm font-medium sm:col-span-2">Job
              <select required className={inventorySelect} value={form.jobId} onChange={(event) => update({ jobId: event.target.value, reservationId: "" })}>
                <option value="">Choose job</option>
                {jobs.filter(({ status }) => status !== "Completed" && status !== "Invoiced")
                  .map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.jobNumber} · {candidate.customerName}</option>)}
              </select>
            </label>
            {!!matches.length && <label className="space-y-1 text-sm font-medium sm:col-span-2">Stock source
              <select className={inventorySelect} value={reservationId} onChange={(event) => update({ reservationId: event.target.value })}>
                <option value="unreserved">Use unreserved stock</option>
                {matches.map((match, index) => <option key={match.id} value={match.id}>Use matching reservation {matches.length > 1 ? index + 1 : ""} · {purchaseQuantity(match.quantity)} sq ft</option>)}
              </select>
            </label>}
            {reservations.isError && <p className="sm:col-span-2 text-sm text-muted-foreground">Matching reservations could not load. <button type="button" className="underline" onClick={() => void reservations.refetch()}>Retry</button></p>}
          </>}
          {action === "return" && piece?.issuedJobId && <p className="sm:col-span-2 text-sm">Original job <Link className="underline" href={`/jobs/${encodeURIComponent(piece.issuedJobId)}`}>{jobs.find(({ id }) => id === piece.issuedJobId)?.jobNumber ?? "Open job"}</Link></p>}
          {(!chosenReservation || action !== "issue") && <label className="space-y-1 text-sm font-medium sm:col-span-2">Note (optional)
            <Input maxLength={500} value={form.reason} onChange={(event) => update({ reason: event.target.value })} />
          </label>}
        </fieldset>
        {expectedArea > 0 && (action === "register" || action === "cut" || action === "return") && <p className="text-sm">{purchaseQuantity(expectedArea)} sq ft</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" type="button" disabled={saving} onClick={closing}>Cancel</Button>
          <Button type="submit" disabled={saving || (action === "issue" && reservations.isLoading)}>{saving ? "Saving…" : labels[action]}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

const costBasis: Record<string, string> = { purchase_order: "PO receipt", stock_receipt: "Stock receipt", catalog: "Catalog rate", historical_issue: "Original job issue", reviewed_opening: "Reviewed opening stock" };

function PieceCostReview({ piece, close, saved }: { piece: Piece; close(): void; saved(): void }) {
  const sources = useOperation<{ layers: PieceCost[]; unpricedQuantity: number }>(`${path}/${encodeURIComponent(piece.id)}/cost-sources`, ["owner"]);
  const [form, setForm] = useState({ sourceLayerId: "", reviewedUnitCost: "", note: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const requestKey = useInventoryRequestKey();
  const guard = useUnsavedForm(true, form);
  const eligible = (sources.data?.layers ?? []).filter((layer) => layer.quantity >= piece.quantity);
  const openingAllowed = (sources.data?.unpricedQuantity ?? 0) >= piece.quantity;
  const closing = () => { if (!inFlight.current && guard.confirmDiscard()) close(); };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true; setSaving(true); setError("");
    try {
      const data = { revision: piece.revision, note: form.note.trim(), ...(form.sourceLayerId === "opening" ? { reviewedUnitCost: form.reviewedUnitCost } : { sourceLayerId: form.sourceLayerId }) };
      await operation(`${path}/${encodeURIComponent(piece.id)}/bind-cost`, "POST", { ...data, idempotencyKey: requestKey.forBody(data) });
      guard.reset(form); saved();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The acquisition cost could not be saved."); }
    finally { inFlight.current = false; setSaving(false); }
  }
  return <Dialog open onOpenChange={(open) => !open && closing()}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader><DialogTitle>Review cost · {piece.label}</DialogTitle><DialogDescription>Identify the actual acquisition source for this physical piece. Its cuts, moves, job issues, and returns will retain this cost.</DialogDescription></DialogHeader>
      <p className="text-sm">{piece.sku} · {purchaseQuantity(piece.quantity)} sq ft</p>
      {sources.isLoading && <p role="status">Loading available cost sources…</p>}
      {sources.isError && <p role="alert">Cost sources could not load. <button className="underline" onClick={() => void sources.refetch()}>Retry</button></p>}
      <form className="space-y-4" onSubmit={save}>
        <fieldset disabled={saving || !sources.data} className="space-y-3">
          <label className="block space-y-1 text-sm font-medium">Actual acquisition source
            <select required className={inventorySelect} value={form.sourceLayerId} onChange={(event) => setForm({ ...form, sourceLayerId: event.target.value })}>
              <option value="">Choose the verified source</option>
              {eligible.map((layer) => <option key={layer.layerId} value={layer.layerId}>{costBasis[layer.source] ?? layer.source} · {new Date(layer.acquiredAt).toLocaleDateString()} · ${layer.unitCost}/sq ft · {purchaseQuantity(layer.quantity)} sq ft available · {layer.sourceMovementId}</option>)}
              {openingAllowed && <option value="opening">Previously unpriced stock — enter verified actual cost</option>}
            </select>
          </label>
          {form.sourceLayerId === "opening" && <label className="block space-y-1 text-sm font-medium">Verified acquisition cost per sq ft
            <Input required inputMode="decimal" pattern="[0-9]{1,12}(\.[0-9]{1,6})?" value={form.reviewedUnitCost} onChange={(event) => setForm({ ...form, reviewedUnitCost: event.target.value })} />
          </label>}
          <label className="block space-y-1 text-sm font-medium">Review note
            <Input required maxLength={500} placeholder="Invoice or receipt reference used to identify this roll" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
          </label>
          {sources.data && !eligible.length && !openingAllowed && <p className="text-sm">No single available acquisition source covers this piece. Reconcile its receipt quantities and physical labels before use.</p>}
        </fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={saving} onClick={closing}>Cancel</Button><Button type="submit" disabled={saving || !form.sourceLayerId || !form.note.trim()}>{saving ? "Saving…" : "Confirm reviewed cost"}</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}

function PieceHistory({ piece, warehouses, bins, close }: { piece: Piece; warehouses: Warehouse[]; bins: WarehouseBin[]; close: () => void }) {
  const history = useOperation<HistoryEvent[]>(`${path}/${encodeURIComponent(piece.id)}/history`, inventoryRoles);
  const eventLabels = { registered: "Labeled in stock", cost_bound: "Acquisition cost reviewed", cut: "Cut recorded", moved: "Location changed", issued: "Issued to job", returned: "Returned from job" };
  return <Dialog open onOpenChange={(open) => !open && close()}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>History · {piece.label}</DialogTitle><DialogDescription>Cut lineage, stock changes, and recorded cost sources.</DialogDescription></DialogHeader>
      {history.isLoading && <p role="status">Loading history…</p>}
      {history.isError && <p role="alert" className="text-sm text-destructive">History could not load. <button className="underline" onClick={() => void history.refetch()}>Retry</button></p>}
      <ol className="space-y-3">
        {history.data?.map((event) => <li key={event.id} className="rounded-md border p-3 text-sm">
          <p className="font-medium">{eventLabels[event.action]}{event.details.childLabel && ` · ${event.details.childLabel}`}</p>
          <time className="text-muted-foreground" dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
          {event.details.quantity !== undefined && <p>{purchaseQuantity(event.details.quantity)} sq ft</p>}
          {event.action === "moved" && event.details.sourceWarehouseId && event.details.destinationWarehouseId && <p>
            {warehouseName(warehouses, event.details.sourceWarehouseId)} · {binName(bins, event.details.sourceBinId ?? null)}
            {" → "}{warehouseName(warehouses, event.details.destinationWarehouseId)} · {binName(bins, event.details.destinationBinId ?? null)}
          </p>}
          {event.details.note && <p className="break-words">{event.details.note}</p>}
          {event.costAllocations?.map((slice, index) => <p className="text-muted-foreground" key={index}>{costBasis[slice.source] ?? slice.source} · {purchaseQuantity(slice.quantity)} sq ft at ${slice.unitCost} / sq ft</p>)}
        </li>)}
      </ol>
    </DialogContent>
  </Dialog>;
}

export default function PhysicalPieces() {
  const controls = useQueryControls();
  const [search, setSearch] = useUrlState<string>("q", "");
  const [warehouseId, setWarehouse] = useUrlState<string>("warehouseId", "");
  const [status, setStatus] = useUrlState<string>("status", "all");
  const [editor, setEditor] = useState<{ action: Action; piece: Piece | null } | null>(null);
  const [history, setHistory] = useState<Piece | null>(null);
  const [costReview, setCostReview] = useState<Piece | null>(null);
  const [printPiece, setPrintPiece] = useState<Piece | null>(null);
  const [notice, setNotice] = useState("");
  const { products, jobs } = useStore();
  const { user } = useAuth();
  const warehouses = useOperation<Warehouse[]>("/inventory/warehouses", inventoryRoles);
  const bins = useWarehouseBins();
  const stock = useOperation<{ pieces: Piece[]; hasMore: boolean }>(withQuery({
    q: search.trim(), productId: controls.params.get("productId") ?? "", warehouseId, status,
  }), inventoryRoles);
  const refresh = useRefreshOperations();
  const locationReady = !!warehouses.data?.length && !!bins.data;

  return <div className="space-y-4">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">Rolls &amp; remnants</h1><p className="mt-1 text-sm text-muted-foreground">Find a measured piece by its label, SKU, dye lot, or warehouse.</p></div>
      <Button disabled={!locationReady} onClick={() => { setNotice(""); setEditor({ action: "register", piece: null }); }}>{labels.register}</Button>
    </header>
    <div className="grid gap-3 rounded-lg border bg-card p-4 md:grid-cols-3">
      <div className="space-y-1 text-sm font-medium"><label htmlFor="piece-search">Search or scan a piece label</label>
        <Input id="piece-search" maxLength={100} placeholder="Label, SKU or dye lot" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && /^piece:/i.test(event.currentTarget.value.trim())) controls.update({ q: event.currentTarget.value.trim(), warehouseId: null, status: null, productId: null });
        }} />
        <CameraScanButton maxLength={100} onScan={(code) => { setSearch(code); controls.update({ q: code, warehouseId: null, status: null, productId: null }); }} />
      </div>
      <label className="space-y-1 text-sm font-medium">Warehouse
        <select className={inventorySelect} value={warehouseId} onChange={(event) => setWarehouse(event.target.value)}>
          <option value="">All warehouses</option>
          {warehouses.data?.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-sm font-medium">Availability
        <select className={inventorySelect} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">All pieces</option><option value="available">In stock</option><option value="issued">Issued to job</option>
        </select>
      </label>
      {controls.params.has("productId") && <Button variant="link" className="w-fit px-0" onClick={() => controls.update({ productId: null })}>Clear product filter</Button>}
    </div>
    {(stock.isLoading || warehouses.isLoading || bins.isLoading) && <p role="status" className="text-sm">Loading labeled stock…</p>}
    {(stock.isError || warehouses.isError || bins.isError) && <p role="alert" className="text-sm text-destructive">Some inventory data could not load. <button className="underline" onClick={() => void refresh()}>Retry</button></p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {stock.data?.hasMore && <p className="text-sm text-muted-foreground">Showing 100 pieces. Narrow your search to see more specific results.</p>}
    {stock.data?.pieces.length === 0 && <p className="rounded-lg border bg-card p-5 text-sm text-muted-foreground">No labeled pieces match this search.</p>}
    <ul className="grid gap-3 xl:grid-cols-2">
      {stock.data?.pieces.map((piece) => <li key={piece.id} className="space-y-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="min-w-0 break-all font-semibold">{piece.label}</h2>
          <Badge variant={piece.issuedMovementId ? "secondary" : "outline"}>{piece.issuedMovementId ? "Issued to job" : "In stock"}</Badge>
        </div>
        <p className="text-sm">{piece.sku} · {piece.productName}</p>
        <p className="text-sm">{piece.kind} · {dimensions(piece.widthInches, piece.lengthInches)} · {purchaseQuantity(piece.quantity)} sq ft</p>
        {!piece.costAllocations?.length && <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Cost review required{piece.issuedMovementId ? " after return" : " before cutting, moving, or issuing"}.</p>}
        {!!piece.costAllocations?.length && <p className="text-sm text-muted-foreground">Reviewed acquisition cost · {piece.costAllocations.map((slice) => `${purchaseQuantity(slice.quantity)} sq ft at $${slice.unitCost}`).join("; ")}</p>}
        <p className="text-sm text-muted-foreground">
          {piece.issuedJobId
            ? <Link className="underline" href={`/jobs/${encodeURIComponent(piece.issuedJobId)}`}>{jobs.find(({ id }) => id === piece.issuedJobId)?.jobNumber ?? "Open issuing job"}</Link>
            : <Link className="underline" href={`/inventory/bins?${new URLSearchParams({ warehouse: piece.warehouseId, bin: piece.binId ?? "unbinned" })}`}>{warehouseName(warehouses.data ?? [], piece.warehouseId)} · {binName(bins.data ?? [], piece.binId)}</Link>}
          {piece.lot && ` · Dye lot ${piece.lot}`}{piece.parentLabel && ` · Cut from ${piece.parentLabel}`}
        </p>
        <div className="flex flex-wrap gap-2">
          {(["cut", "move", "issue", "return"] as const).filter((action) => piece.issuedMovementId ? action === "return" : action !== "return").map((action) =>
            <Button key={action} size="sm" variant="outline" disabled={(action !== "return" && !piece.costAllocations?.length) || ((action === "move" || action === "return") && !locationReady)} onClick={() => { setNotice(""); setEditor({ action, piece }); }}>{labels[action]}</Button>)}
          {!piece.issuedMovementId && !piece.costAllocations?.length && user?.role === "owner" && <Button size="sm" onClick={() => setCostReview(piece)}>Review cost</Button>}
          <Button size="sm" variant="ghost" onClick={() => setHistory(piece)}>History</Button>
          <Button size="sm" variant="ghost" disabled={!locationReady} onClick={() => setPrintPiece(piece)}>Print label</Button>
        </div>
      </li>)}
    </ul>
    {editor && <PieceEditor {...editor} products={products} jobs={jobs} warehouses={warehouses.data ?? []} bins={bins.data ?? []}
      defaultProductId={controls.params.get("productId") ?? ""} defaultWarehouseId={warehouseId} onClose={() => setEditor(null)} onSaved={(message) => {
      setEditor(null); setNotice(message); void refresh();
    }} />}
    {history && <PieceHistory piece={history} warehouses={warehouses.data ?? []} bins={bins.data ?? []} close={() => setHistory(null)} />}
    {costReview && <PieceCostReview piece={costReview} close={() => setCostReview(null)} saved={() => { setCostReview(null); setNotice(`${costReview.label} acquisition cost reviewed.`); void refresh(); }} />}
    {printPiece && <StockPieceLabel label={printPiece.label} code={pieceBarcode(printPiece.label)} fields={[
      ["SKU", printPiece.sku], ["Piece ID", printPiece.id], ["Dimensions", dimensions(printPiece.widthInches, printPiece.lengthInches)],
      ["Quantity", `${purchaseQuantity(printPiece.quantity)} sq ft`],
      [printPiece.issuedMovementId ? "Last stock location" : "Location", `${warehouseName(warehouses.data ?? [], printPiece.warehouseId)} · ${binName(bins.data ?? [], printPiece.binId)}`],
      ...(printPiece.lot ? [["Dye lot", printPiece.lot] as const] : []),
    ]} onClose={() => setPrintPiece(null)} />}
  </div>;
}
