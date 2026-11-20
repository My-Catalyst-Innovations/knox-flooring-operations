import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  operation,
  quantity,
  useOperation,
  useRefreshOperations,
} from "@/lib/operations";
import {
  inventoryRoles,
  warehouseName,
  type Warehouse,
  type WarehouseTransfer,
} from "@/lib/warehouse-inventory";
import type { Product } from "@/lib/types";

const selectClass = "h-10 w-full rounded-md border bg-background px-3 text-sm";

export function WarehouseTransfers({
  product,
  warehouses,
  disabled,
  onSavingChange,
}: {
  product: Product;
  warehouses: readonly Warehouse[];
  disabled: boolean;
  onSavingChange(saving: boolean): void;
}) {
  const transfers = useOperation<WarehouseTransfer[]>(
    `/inventory/transfers?productId=${encodeURIComponent(product.id)}`,
    inventoryRoles,
  );
  const refresh = useRefreshOperations();
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const request = useRef({ payload: "", key: "" });

  async function save(action: () => Promise<string>) {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    onSavingChange(true);
    setError("");
    setMessage("");
    try {
      setMessage(await action());
      await refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Transfer could not be saved.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
      onSavingChange(false);
    }
  }

  function dispatch(event: FormEvent) {
    event.preventDefault();
    void save(async () => {
      const data = {
        productId: product.id,
        sourceWarehouseId: source || null,
        destinationWarehouseId: destination,
        quantity: Number(amount),
        reason: reason.trim(),
      };
      const payload = JSON.stringify(data);
      if (request.current.payload !== payload)
        request.current = { payload, key: crypto.randomUUID() };
      await operation("/inventory/transfers", "POST", {
        ...data,
        idempotencyKey: request.current.key,
      });
      request.current = { payload: "", key: "" };
      setAmount("");
      setReason("");
      return source
        ? "Stock dispatched. Receive it when it arrives."
        : "Counted stock assigned to the warehouse.";
    });
  }

  return (
    <section
      className="space-y-3 border-t pt-4"
      aria-label="Warehouse transfers"
    >
      <h3 className="font-semibold">Warehouse transfers</h3>
      {warehouses.length > 0 && (
        <form onSubmit={dispatch} className="space-y-3">
          <fieldset
            disabled={busy || disabled}
            className="grid gap-3 sm:grid-cols-2"
          >
            <label className="space-y-1 text-sm">
              From
              <select
                className={selectClass}
                value={source}
                onChange={(event) => setSource(event.target.value)}
              >
                <option value="">Unassigned</option>
                {warehouses.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              To
              <select
                className={selectClass}
                required
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
              >
                <option value="">Choose a warehouse</option>
                {warehouses.map((warehouse) => (
                  <option
                    key={warehouse.id}
                    value={warehouse.id}
                    disabled={warehouse.id === source}
                  >
                    {warehouse.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              Transfer quantity ({product.unit})
              <Input
                type="number"
                min="0.000001"
                step="any"
                required
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm">
              Count or transfer reference
              <Input
                required
                maxLength={2000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          </fieldset>
          <Button
            disabled={
              busy ||
              disabled ||
              !destination ||
              source === destination ||
              !reason.trim()
            }
            type="submit"
          >
            {source ? "Dispatch stock" : "Assign counted stock"}
          </Button>
        </form>
      )}
      {transfers.isLoading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading transfers…
        </p>
      )}
      {transfers.isError && (
        <p role="alert" className="text-sm text-destructive">
          Transfer history could not load.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-emerald-800">
          {message}
        </p>
      )}
      {transfers.data?.map((transfer) => (
        <article
          key={transfer.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
        >
          <div>
            <p className="font-medium">
              {warehouseName(warehouses, transfer.sourceWarehouseId)} →{" "}
              {warehouseName(warehouses, transfer.destinationWarehouseId)}
            </p>
            <p>
              {quantity(transfer.quantity)} {product.unit} · {transfer.status}
            </p>
            <p className="text-muted-foreground">{transfer.reason}</p>
          </div>
          {transfer.status === "In transit" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || disabled}
              onClick={() =>
                void save(async () => {
                  await operation(
                    `/inventory/transfers/${encodeURIComponent(transfer.id)}/receive`,
                    "POST",
                  );
                  return "Stock received into the destination warehouse.";
                })
              }
            >
              Receive transfer
            </Button>
          )}
        </article>
      ))}
    </section>
  );
}
