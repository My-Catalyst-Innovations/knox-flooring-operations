import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/contexts/auth";
import { useUnsavedForm } from "@/hooks/use-unsaved-changes";
import { useUrlState } from "@/hooks/use-url-state";
import { operation, useOperation, useRefreshOperations } from "@/lib/operations";
import { binName, inventorySelect, purchaseQuantity, useInventoryRequestKey, type WarehouseBin } from "@/lib/purchasing";
import type { Job, Product } from "@/lib/types";
import { inventoryRoles, type Warehouse } from "@/lib/warehouse-inventory";

const path = "/inventory/stock-counts";
const reasons = { count: "Physical count", damage: "Damage", waste: "Waste" };
type Reason = keyof typeof reasons;
type Location = { productId: string; warehouseId: string; binId: string | null };
type CountSnapshot = Location & { snapshotKey: string; unit: string; bookedQuantity: number };
type Count = Location & {
  id: string; sku: string; productName: string; unit: string; bookedQuantity: number;
  countedQuantity: number; variance: number; reason: Reason; note: string;
  status: "Pending" | "Reconciled" | "Dismissed";
  counterName: string; createdAt: string; reviewerName: string | null;
  resolvedAt: string | null; resolutionNote: string | null;
};

function CountForm({ warehouse, bins, products, onClose, onDone }: {
  warehouse: Warehouse; bins: readonly WarehouseBin[]; products: readonly Product[];
  onClose(): void; onDone(): void;
}) {
  const [form, setForm] = useState({ productId: "", binId: "", counted: "", reason: "count" as Reason, note: "" });
  const [snapshot, setSnapshot] = useState<CountSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const requestKey = useInventoryRequestKey();
  const changes = useUnsavedForm(true, form);
  const observed = form.counted === "" ? null : Number(form.counted);
  const variance = snapshot && observed !== null ? Number((observed - snapshot.bookedQuantity).toFixed(6)) : null;
  const valid = observed !== null && observed >= 0 && observed <= 1_000_000 && Number(observed.toFixed(6)) === observed &&
    variance !== null && (variance === 0 || form.note.trim().length > 0) && (form.reason === "count" || variance < 0);
  const close = () => { if (!inFlight.current && changes.confirmDiscard()) onClose(); };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !form.productId) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (!snapshot) {
        const query = new URLSearchParams({ productId: form.productId, warehouseId: warehouse.id });
        if (form.binId) query.set("binId", form.binId);
        setSnapshot(await operation<CountSnapshot>(`${path}/snapshot?${query}`));
        return;
      }
      if (observed === null || !valid) return;
      const { productId, warehouseId, binId, snapshotKey } = snapshot;
      const draft = { productId, warehouseId, binId, snapshotKey, countedQuantity: observed, reason: form.reason, note: form.note.trim() };
      await operation<Count>(path, "POST", { ...draft, idempotencyKey: requestKey.forBody(draft) });
      changes.reset(form);
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this count.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Record a stock count</DialogTitle>
        <DialogDescription>Count a product at one location in {warehouse.name}. An owner reviews it before the stock balance changes.</DialogDescription>
      </DialogHeader>
      <form onSubmit={save} className="space-y-3">
        <fieldset disabled={busy} className="space-y-3">
          <label className="block space-y-1 text-sm font-medium">Count product
            <select className={inventorySelect} value={form.productId} required disabled={!!snapshot} onChange={(event) => setForm({ ...form, productId: event.target.value })}>
              <option value="">Select a product</option>
              {products.map((product) => <option key={product.id} value={product.id}>{product.sku} · {product.name}</option>)}
            </select>
          </label>
          <label className="block space-y-1 text-sm font-medium">Count location
            <select className={inventorySelect} value={form.binId} disabled={!!snapshot} onChange={(event) => setForm({ ...form, binId: event.target.value })}>
              <option value="">Unbinned</option>
              {bins.map((bin) => <option key={bin.id} value={bin.id}>{bin.code}</option>)}
            </select>
          </label>
          {snapshot && <>
            <p className="rounded-md bg-muted/50 p-3 text-sm">Booked at start <strong>{purchaseQuantity(snapshot.bookedQuantity)} {snapshot.unit}</strong></p>
            <label className="block space-y-1 text-sm font-medium">Physical count ({snapshot.unit})
              <Input autoFocus type="number" inputMode="decimal" min="0" max="1000000" step="0.000001" required value={form.counted} onChange={(event) => setForm({ ...form, counted: event.target.value })} />
            </label>
            <label className="block space-y-1 text-sm font-medium">Count reason
              <select className={inventorySelect} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value as Reason })}>
                {Object.entries(reasons).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            {variance !== null && <p className="text-sm">Difference <strong>{variance > 0 ? "+" : ""}{purchaseQuantity(variance)} {snapshot.unit}</strong></p>}
            {variance !== null && variance >= 0 && form.reason !== "count" && <p className="text-sm text-destructive">Damage and waste must reduce booked stock.</p>}
            <label className="block space-y-1 text-sm font-medium">Count note{variance === null || variance === 0 ? " (optional)" : ""}
              <Textarea maxLength={500} rows={2} required={variance !== null && variance !== 0} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
            </label>
          </>}
        </fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button>
          {snapshot && <Button type="button" variant="outline" disabled={busy} onClick={() => {
            setSnapshot(undefined);
            setForm({ ...form, counted: "", reason: "count", note: "" });
            setError("");
          }}>Start over</Button>}
          <Button type="submit" disabled={busy || !form.productId || (!!snapshot && !valid)}>{snapshot ? "Submit for review" : "Start counting"}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

function ReviewCount({ count, bins, jobs, onClose, onDone }: {
  count: Count; bins: readonly WarehouseBin[]; jobs: readonly Job[]; onClose(): void; onDone(action: "reconcile" | "dismiss"): void;
}) {
  const [action, setAction] = useState<"reconcile" | "dismiss">("reconcile");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState("");
  const [crewId, setCrewId] = useState("");
  const crews = useOperation<{ id: string; name: string }[]>(`${path}/waste-crews?jobId=${encodeURIComponent(jobId)}`, count.reason === "waste" && jobId ? ["owner"] : []);
  const inFlight = useRef(false);

  async function resolve(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || (action === "dismiss" && !note.trim())) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await operation(`${path}/${encodeURIComponent(count.id)}/${action}`, "POST", action === "dismiss" ? { note: note.trim() } : {
        ...(count.reason === "waste" && jobId ? { jobId, ...(crewId ? { crewId } : {}) } : {}),
      });
      onDone(action);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not resolve this count.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !inFlight.current) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Review {count.sku} count</DialogTitle>
        <DialogDescription>{count.productName} · {binName(bins, count.binId)} · counted by {count.counterName}</DialogDescription>
      </DialogHeader>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        {[['Booked', count.bookedQuantity], ['Counted', count.countedQuantity], ['Difference', count.variance]].map(([label, amount]) => <div key={label} className="rounded-md bg-muted/50 p-2">
          <dt className="text-muted-foreground">{label}</dt><dd className="font-semibold">{purchaseQuantity(Number(amount))} {count.unit}</dd>
        </div>)}
      </dl>
      <p className="text-sm">{reasons[count.reason]}{count.note && ` · ${count.note}`}</p>
      <form onSubmit={resolve} className="space-y-3">
        {action === "reconcile" && count.reason === "waste" && jobs.length > 0 && <fieldset disabled={busy} className="space-y-3">
          <label className="block space-y-1 text-sm font-medium">Waste job (optional)
            <select className={inventorySelect} value={jobId} onChange={(event) => { setJobId(event.target.value); setCrewId(""); }}>
              <option value="">Unassigned job</option>
              {jobs.map((job) => <option key={job.id} value={job.id}>{job.jobNumber} · {job.customerName}</option>)}
            </select>
          </label>
          {jobId && <label className="block space-y-1 text-sm font-medium">Waste crew (optional)
            <select className={inventorySelect} value={crewId} disabled={crews.isLoading || crews.isError} onChange={(event) => setCrewId(event.target.value)}>
              <option value="">Unassigned crew</option>
              {(crews.data ?? []).map((crew) => <option key={crew.id} value={crew.id}>{crew.name}</option>)}
            </select>
          </label>}
          {jobId && crews.isError && <p role="alert" className="text-sm text-destructive">Could not load crews for this job. <button type="button" className="underline" onClick={() => void crews.refetch()}>Retry</button></p>}
        </fieldset>}
        {action === "dismiss" && <label className="block space-y-1 text-sm font-medium">Dismissal reason
          <Textarea required maxLength={500} rows={2} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} />
        </label>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Close</Button>
          {action === "reconcile" && <Button type="button" variant="outline" disabled={busy} onClick={() => { setAction("dismiss"); setError(""); }}>Dismiss instead</Button>}
          <Button type="submit" disabled={busy || (action === "dismiss" && !note.trim())}>
            {action === "dismiss" ? "Dismiss count" : count.variance === 0 ? "Confirm count" : "Post adjustment"}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

type CountHistoryProps = {
  warehouse: Warehouse; bins: readonly WarehouseBin[]; products: readonly Product[]; productsUnavailable: boolean; jobs?: readonly Job[];
};

function CountHistory({ warehouse, bins, products, productsUnavailable, jobs = [], countId, onShowRecent }: CountHistoryProps & {
  countId: string;
  onShowRecent: () => void;
}) {
  const { user } = useAuth();
  const search = new URLSearchParams({ warehouseId: warehouse.id });
  if (countId) search.set("countId", countId);
  const query = useOperation<Count[]>(`${path}?${search}`, inventoryRoles);
  const refresh = useRefreshOperations();
  const [recording, setRecording] = useState(false);
  const [reviewing, setReviewing] = useState<Count>();
  const [notice, setNotice] = useState("");
  const stocked = products.filter((product) => product.inventoryType === "Inventory");
  return <div className="space-y-3 border-t pt-3">
    {countId ? <Button variant="outline" onClick={onShowRecent}>Show recent counts</Button> :
      <Button variant="outline" disabled={productsUnavailable || !stocked.length} onClick={() => { setNotice(""); setRecording(true); }}>Record count</Button>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    {query.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading stock counts…</p>}
    {query.isError && <p role="alert" className="text-sm text-destructive">Could not load stock counts. <button className="underline" onClick={() => void query.refetch()}>Retry</button></p>}
    {query.data?.length === 0 && <p className="text-sm text-muted-foreground">{countId ? "This count was not found at the selected warehouse." : "No counts recorded at this warehouse."}</p>}
    {!!query.data?.length && <ul className="divide-y rounded-md border" aria-label={countId ? "Selected stock count" : "Recent stock counts"}>
      {query.data.map((count) => <li key={count.id} className="flex flex-wrap items-start justify-between gap-3 p-3 text-sm">
        <div className="space-y-1">
          <p className="font-medium">{count.sku} · {count.productName} · {binName(bins, count.binId)}</p>
          <p>{count.status === "Pending" ? "Awaiting review" : count.status} · Booked {purchaseQuantity(count.bookedQuantity)} · Counted {purchaseQuantity(count.countedQuantity)} {count.unit}</p>
          <p className="text-muted-foreground">{reasons[count.reason]} · {count.counterName} · {new Date(count.createdAt).toLocaleString()}</p>
          {count.note && <p>{count.note}</p>}
          {count.resolvedAt && <p className="text-muted-foreground">{count.reviewerName} · {new Date(count.resolvedAt).toLocaleString()}{count.resolutionNote && ` · ${count.resolutionNote}`}</p>}
        </div>
        {count.status === "Pending" && user?.role === "owner" && !user.previewRole && <Button variant="outline" size="sm" onClick={() => { setNotice(""); setReviewing(count); }}>Review {count.sku}</Button>}
      </li>)}
    </ul>}
    {recording && <CountForm warehouse={warehouse} bins={bins} products={stocked} onClose={() => setRecording(false)} onDone={() => {
      setRecording(false); setNotice("Count recorded for owner review."); void refresh();
    }} />}
    {reviewing && <ReviewCount count={reviewing} bins={bins} jobs={jobs} onClose={() => setReviewing(undefined)} onDone={(action) => {
      setReviewing(undefined); setNotice(action === "dismiss" ? "Count dismissed." : "Stock count reconciled."); void refresh();
    }} />}
  </div>;
}

export function StockCounts(props: CountHistoryProps) {
  const [countId, setCountId] = useUrlState<string>("count", "");
  const [open, setOpen] = useState(false);
  const section = useRef<HTMLElement>(null);
  const expanded = open || Boolean(countId);
  useEffect(() => {
    if (countId) section.current?.scrollIntoView?.({ block: "start" });
  }, [countId]);
  return <section ref={section} aria-label="Stock counts" className="scroll-mt-4 space-y-3 rounded-lg border bg-card p-4">
    <Button variant="ghost" className="px-0" aria-expanded={expanded} onClick={() => {
      if (countId) setCountId("");
      setOpen(!expanded);
    }}>Stock counts</Button>
    {expanded && <CountHistory {...props} countId={countId} onShowRecent={() => { setCountId(""); setOpen(true); }} />}
  </section>;
}
