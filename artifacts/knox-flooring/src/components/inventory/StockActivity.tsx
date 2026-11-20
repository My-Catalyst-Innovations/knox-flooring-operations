import { useUnsavedForm } from "@/hooks/use-unsaved-changes";
import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/auth";
import { useStore } from "@/hooks/use-store";
import {
  useOperation,
  operation,
  useRefreshOperations,
  quantity,
} from "@/lib/operations";
import {
  inventoryRoles,
  warehouseName,
  type Warehouse,
  type WarehouseReservation,
  type WarehouseStockMovement,
  type WarehouseStockSummary,
} from "@/lib/warehouse-inventory";
import { binName, binStockQuery, purchaseQuantity, warehouseBinsPath, type BinStock, type WarehouseBin } from "@/lib/purchasing";
import type { Product } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WarehouseTransfers } from "./WarehouseTransfers";
import { WarehouseBinSelect } from "./WarehouseBinSelect";

const selectStyle = "h-11 w-full rounded-lg border bg-background px-3 text-sm";
export function StockActivity({
  product,
  onClose,
}: {
  product: Product;
  onClose(): void;
}) {
  const { user } = useAuth();
  const { jobs, queryState } = useStore();
  const summaries = useOperation<WarehouseStockSummary[]>(
    "/inventory/summary",
    inventoryRoles,
  );
  const warehouseQuery = useOperation<Warehouse[]>(
    "/inventory/warehouses",
    inventoryRoles,
  );
  const warehouses = warehouseQuery.isError ? [] : (warehouseQuery.data ?? []);
  const warehouseBins = useOperation<WarehouseBin[]>(warehouseBinsPath, inventoryRoles);
  const binStock = useOperation<BinStock[]>(binStockQuery({ productId: product.id }), inventoryRoles);
  const bins = warehouseBins.data ?? [];
  const movements = useOperation<WarehouseStockMovement[]>(
    `/inventory/movements?productId=${encodeURIComponent(product.id)}`,
    inventoryRoles,
  );
  const reservations = useOperation<WarehouseReservation[]>(
    `/inventory/reservations?productId=${encodeURIComponent(product.id)}`,
    inventoryRoles,
  );
  const summary = summaries.isError
    ? undefined
    : summaries.data?.find((s) => s.productId === product.id);
  const refresh = useRefreshOperations();
  const [kind, setKind] = useState("receipt");
  const [amount, setAmount] = useState("");
  const [jobId, setJobId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [binId, setBinId] = useState("");
  const [reservationBins, setReservationBins] = useState<Record<string, string>>({});
  const [returnOfMovementId, setReturnOfMovementId] = useState("");
  const [labelCode, setLabelCode] = useState("");
  const [labelCheck, setLabelCheck] = useState<{
    code: string;
    error?: string;
  }>();
  const [checkingLabel, setCheckingLabel] = useState(false);
  const [reason, setReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [requestKey, setRequestKey] = useState<string>(() =>
    crypto.randomUUID(),
  );
  const canWrite = user?.role === "owner" || user?.role === "operations";
  const changes = useUnsavedForm(
    canWrite && product.inventoryType === "Inventory",
    {
      kind,
      amount,
      jobId,
      warehouseId,
      binId,
      returnOfMovementId,
      labelCode,
      reason,
      overrideReason,
    },
  );
  const jobIssues =
    movements.data?.filter(
      (movement) => movement.kind === "consume" && movement.jobId === jobId,
    ) ?? [];
  const activeReservations =
    reservations.data?.filter((r) => r.status === "Active") ?? [];
  const checkedLabel =
    labelCheck?.code === labelCode.trim() ? labelCheck : undefined;
  const close = () => {
    if (!busy && !transferBusy && !checkingLabel && changes.confirmDiscard())
      onClose();
  };
  const change = () => {
    setRequestKey(crypto.randomUUID());
    setMessage("");
  };
  const clearLabel = () => {
    setLabelCode("");
    setLabelCheck(undefined);
  };
  const checkLabel = async () => {
    const code = labelCode.trim();
    if (!code || busy || checkingLabel || transferBusy) return;
    setCheckingLabel(true);
    setLabelCheck(undefined);
    try {
      await operation("/inventory/verify-product-label", "POST", {
        productId: product.id,
        labelCode: code,
      });
      setLabelCheck({ code });
    } catch (failure) {
      setLabelCheck({
        code,
        error:
          failure instanceof Error
            ? failure.message
            : "Could not check this product label.",
      });
    } finally {
      setCheckingLabel(false);
    }
  };
  const submit = async () => {
    if (busy || checkingLabel || (kind === "consume" && checkedLabel?.error))
      return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (
        !Number.isFinite(Number(amount)) ||
        amount === "" ||
        (kind !== "adjustment" && Number(amount) <= 0)
      )
        throw new Error("Enter a valid quantity in the product's stock unit.");
      if (kind === "reserve" && !jobId)
        throw new Error("Choose the job receiving this reservation.");
      if (kind === "return" && jobId && !returnOfMovementId)
        throw new Error("Choose the original stock issue for this job return.");
      if (kind !== "reserve" && !reason.trim())
        throw new Error("Explain the receipt, usage, return or adjustment.");
      await operation(
        kind === "reserve" ? "/inventory/reservations" : "/inventory/movements",
        "POST",
        {
          productId: product.id,
          jobId: jobId || undefined,
          warehouseId: warehouseId || null,
          ...(warehouseId && kind !== "reserve" ? { binId: binId || null } : {}),
          returnOfMovementId:
            kind === "return" ? returnOfMovementId || undefined : undefined,
          labelCode:
            kind === "consume" ? labelCode.trim() || undefined : undefined,
          quantity: Number(amount),
          kind,
          reason,
          overrideReason: overrideReason || undefined,
          idempotencyKey: requestKey,
        },
      );
      await refresh();
      changes.reset({
        kind,
        amount: "",
        jobId,
        warehouseId,
        binId,
        returnOfMovementId: "",
        labelCode: kind === "consume" ? "" : labelCode,
        reason: "",
        overrideReason: "",
      });
      setAmount("");
      setReason("");
      setOverrideReason("");
      setReturnOfMovementId("");
      if (kind === "consume") clearLabel();
      setRequestKey(crypto.randomUUID());
      setMessage("Stock activity recorded.");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to record stock activity.",
      );
    } finally {
      setBusy(false);
    }
  };
  const updateReservation = async (
    r: WarehouseReservation,
    status: "Released" | "Consumed",
  ) => {
    if (busy || checkingLabel || (status === "Consumed" && checkedLabel?.error))
      return;
    setBusy(true);
    setError("");
    try {
      await operation(`/inventory/reservations/${r.id}`, "PATCH", {
        revision: r.revision,
        status,
        ...(status === "Consumed" && r.warehouseId ? { binId: reservationBins[r.id] || null } : {}),
        labelCode:
          status === "Consumed" ? labelCode.trim() || undefined : undefined,
      });
      await refresh();
      if (status === "Consumed") clearLabel();
      setMessage(
        status === "Consumed"
          ? "Reserved stock recorded as used."
          : "Reservation released.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reservation update failed.");
    } finally {
      setBusy(false);
    }
  };
  if (!summaries.allowed)
    return (
      <Dialog open onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stock activity unavailable</DialogTitle>
            <DialogDescription>
              Inventory activity is available to owner and operations roles.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{product.name}</DialogTitle>
          <DialogDescription>
            Stock activity · {product.sku || product.category} · quantities in{" "}
            {product.unit}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-3 rounded-lg bg-muted/50 p-4">
          {[
            ["On hand", summary?.onHand],
            ["Reserved", summary?.reserved],
            ["Available", summary?.available],
          ].map(([label, value]) => (
            <div key={label}>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-1 text-xl font-semibold">
                {typeof value === "number" ? quantity(value) : "—"}
              </p>
            </div>
          ))}
        </div>
        {summary?.locations?.map((location) => (
          <div
            key={location.warehouseId ?? "unassigned"}
            className="flex flex-wrap justify-between gap-1 border-b pb-2 text-sm"
          >
            <span className="font-medium">
              {warehouseName(warehouses, location.warehouseId)}
            </span>
            <span className="text-muted-foreground">
              {quantity(location.onHand)} on hand ·{" "}
              {quantity(location.reserved)} reserved ·{" "}
              {quantity(location.available)} available
            </span>
          </div>
        ))}
        {product.inventoryType === "Inventory" && <section className="space-y-2 border-t pt-3" aria-label="Product bin stock">
          <h3 className="font-semibold">Bin stock</h3>
          {(binStock.isLoading || warehouseBins.isLoading) && <p role="status" className="text-sm text-muted-foreground">Loading bin locations…</p>}
          {(binStock.isError || warehouseBins.isError) && <p role="alert" className="text-sm text-destructive">Bin locations could not load. <button className="underline" onClick={() => void refresh()}>Retry</button></p>}
          {binStock.data?.length === 0 && <p className="text-sm text-muted-foreground">No balances in named warehouses.</p>}
          {!!binStock.data?.length && <ul className="space-y-1 text-sm">
            {binStock.data.map((row) => <li key={`${row.warehouseId}:${row.binId ?? "unbinned"}`} className="flex flex-wrap justify-between gap-1">
              <Link className="underline-offset-4 hover:underline" href={`${warehouseBinsPath}?${new URLSearchParams({ warehouse: row.warehouseId, bin: row.binId ?? "unbinned" })}`}>{warehouseName(warehouses, row.warehouseId)} · {binName(bins, row.binId)}</Link>
              <span className="text-muted-foreground">{purchaseQuantity(row.onHand)} {product.unit} on hand</span>
            </li>)}
          </ul>}
        </section>}
        {(summaries.isError ||
          movements.isError ||
          reservations.isError ||
          warehouseQuery.isError) && (
          <p role="alert" className="text-sm text-destructive">
            Stock records could not load.{" "}
            <button className="underline" onClick={() => refresh()}>
              Retry
            </button>
          </p>
        )}
        {queryState.jobs.error && (
          <p role="alert" className="text-sm text-destructive">
            Job details could not load.{" "}
            <button className="underline" onClick={() => refresh()}>
              Retry
            </button>
          </p>
        )}
        {canWrite && (kind === "consume" || activeReservations.length > 0) && (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-40 flex-1 space-y-1 text-sm font-medium">
                Product label (optional)
                <Input
                  value={labelCode}
                  maxLength={512}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="Scan or type a product code"
                  disabled={busy || transferBusy || checkingLabel}
                  onChange={(event) => {
                    setLabelCode(event.target.value);
                    setLabelCheck(undefined);
                    setError("");
                    change();
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void checkLabel();
                  }}
                />
              </label>
              <Button
                type="button"
                variant="outline"
                disabled={
                  !labelCode.trim() || busy || transferBusy || checkingLabel
                }
                onClick={() => void checkLabel()}
              >
                {checkingLabel ? "Checking…" : "Check label"}
              </Button>
            </div>
            {checkedLabel &&
              (checkedLabel.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {checkedLabel.error}
                </p>
              ) : (
                <p role="status" className="text-sm text-emerald-800">
                  Label matches {product.name}.
                </p>
              ))}
          </div>
        )}
        {canWrite && product.inventoryType === "Inventory" && (
          <fieldset
            disabled={
              busy ||
              transferBusy ||
              warehouseQuery.isLoading ||
              warehouseQuery.isError
            }
            className="space-y-3 rounded-lg border p-4"
          >
            <h3 className="font-semibold">Record activity</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                Action
                <select
                  className={selectStyle}
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    setReturnOfMovementId("");
                    change();
                  }}
                >
                  <option value="receipt">Receive stock</option>
                  <option value="reserve">Reserve for a job</option>
                  <option value="consume">Record unreserved usage</option>
                  <option value="return">Return stock</option>
                  <option value="adjustment">Adjust stock (+ / −)</option>
                </select>
              </label>
              <label className="space-y-1 text-sm">
                Warehouse
                <select
                  className={selectStyle}
                  value={warehouseId}
                  onChange={(event) => {
                    setWarehouseId(event.target.value);
                    setBinId("");
                    change();
                  }}
                >
                  <option value="">Unassigned</option>
                  {warehouses.map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.name}
                    </option>
                  ))}
                </select>
              </label>
              {warehouseId && kind !== "reserve" && (
                <WarehouseBinSelect warehouseId={warehouseId} bins={bins} stock={binStock.data} value={binId} onChange={(id) => { setBinId(id); change(); }} disabled={warehouseBins.isLoading || warehouseBins.isError} />
              )}
              <label className="space-y-1 text-sm">
                Quantity ({product.unit})
                <Input
                  type="number"
                  step="any"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    change();
                  }}
                />
              </label>
              <label className="space-y-1 text-sm">
                Related job
                <select
                  disabled={
                    queryState.jobs.isLoading || !!queryState.jobs.error
                  }
                  className={selectStyle}
                  value={jobId}
                  onChange={(e) => {
                    setJobId(e.target.value);
                    setReturnOfMovementId("");
                    change();
                  }}
                >
                  <option value="">Select a job</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.jobNumber} · {j.customerName}
                    </option>
                  ))}
                </select>
              </label>
              {kind === "return" && jobId && (
                <label className="space-y-1 text-sm">
                  Original stock issue
                  <select
                    className={selectStyle}
                    value={returnOfMovementId}
                    onChange={(event) => {
                      setReturnOfMovementId(event.target.value);
                      change();
                    }}
                  >
                    <option value="">
                      {jobIssues.length
                        ? "Choose an issue"
                        : "No stock issues recorded for this job"}
                    </option>
                    {jobIssues.map((issue) => (
                      <option key={issue.id} value={issue.id}>
                        {new Date(issue.createdAt).toLocaleDateString()} ·{" "}
                        {quantity(-issue.quantity)} {product.unit} ·{" "}
                        {warehouseName(warehouses, issue.warehouseId)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="space-y-1 text-sm">
                Reason
                <Input
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    change();
                  }}
                  placeholder="Delivery reference, usage, return, count correction…"
                />
              </label>
            </div>
            {user?.role === "owner" && (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Owner shortage override
                </summary>
                <label className="mt-2 block space-y-1 text-xs">
                  Recorded reason for allowing a shortage
                  <Input
                    value={overrideReason}
                    onChange={(e) => {
                      setOverrideReason(e.target.value);
                      change();
                    }}
                  />
                </label>
              </details>
            )}
            <Button
              onClick={submit}
              disabled={
                checkingLabel || (kind === "consume" && !!checkedLabel?.error)
                || Boolean(warehouseId && kind !== "reserve" && (warehouseBins.isLoading || warehouseBins.isError))
              }
            >
              {busy ? "Recording…" : "Record activity"}
            </Button>
          </fieldset>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-red-50 p-3 text-sm text-red-900"
          >
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-emerald-800">
            {message}
          </p>
        )}
        {canWrite && product.inventoryType === "Inventory" && (
          <WarehouseTransfers
            product={product}
            warehouses={warehouses}
            bins={bins}
            binStock={binStock.data}
            binsUnavailable={warehouseBins.isLoading || warehouseBins.isError}
            disabled={
              busy || warehouseQuery.isLoading || warehouseQuery.isError
            }
            onSavingChange={setTransferBusy}
          />
        )}
        <section className="space-y-2">
          <h3 className="font-semibold">Active reservations</h3>
          {reservations.isLoading && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading reservations…
            </p>
          )}
          {activeReservations.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
            >
              <p className="text-sm">
                {jobs.find((j) => j.id === r.jobId)?.jobNumber ?? r.jobId} ·{" "}
                {quantity(r.quantity)} {product.unit} ·{" "}
                {warehouseName(warehouses, r.warehouseId)}
              </p>
              {canWrite && (
                <div className="flex flex-wrap items-end gap-2">
                  {r.warehouseId && <WarehouseBinSelect label={`Issue bin for ${jobs.find((job) => job.id === r.jobId)?.jobNumber ?? r.jobId}`} warehouseId={r.warehouseId} bins={bins} stock={binStock.data} value={reservationBins[r.id] ?? ""} onChange={(id) => setReservationBins((current) => ({ ...current, [r.id]: id }))} disabled={busy || transferBusy || warehouseBins.isLoading || warehouseBins.isError} />}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || transferBusy}
                    onClick={() => updateReservation(r, "Released")}
                  >
                    Release
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      transferBusy ||
                      checkingLabel ||
                      Boolean(r.warehouseId && (warehouseBins.isLoading || warehouseBins.isError)) ||
                      !!checkedLabel?.error
                    }
                    onClick={() => updateReservation(r, "Consumed")}
                  >
                    Record used
                  </Button>
                </div>
              )}
            </div>
          ))}
          {!reservations.isError &&
            reservations.data?.every((r) => r.status !== "Active") && (
              <p className="text-sm text-muted-foreground">
                No active reservations.
              </p>
            )}
        </section>
        <section className="space-y-2">
          <h3 className="font-semibold">Movement history</h3>
          {movements.isLoading && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading movements…
            </p>
          )}
          {movements.data?.map((m) => (
            <div
              key={m.id}
              className="flex items-start justify-between gap-4 border-t py-3 text-sm"
            >
              <div>
                <p className="font-medium capitalize">
                  {m.kind.replaceAll("_", " ")}
                </p>
                <p className="text-muted-foreground">{m.reason}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {new Date(m.createdAt).toLocaleString()} ·{" "}
                  {warehouseName(warehouses, m.warehouseId)}
                  {m.warehouseId && ` · ${binName(bins, m.binId ?? null)}`}
                  {m.jobId &&
                    ` · ${jobs.find((j) => j.id === m.jobId)?.jobNumber ?? m.jobId}`}
                </p>
              </div>
              <strong className="whitespace-nowrap tabular-nums">
                {m.quantity > 0 ? "+" : ""}
                {quantity(m.quantity)} {product.unit}
              </strong>
            </div>
          ))}
          {!movements.isError && movements.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No recorded stock movements.
            </p>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
