import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { operation, useRefreshOperations } from "@/lib/operations";
import type { Warehouse } from "@/lib/warehouse-inventory";

export function WarehouseSetup({
  warehouses,
}: {
  warehouses: readonly Warehouse[];
}) {
  const refresh = useRefreshOperations();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function addWarehouse(event: FormEvent) {
    event.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    setError("");
    try {
      await operation("/inventory/warehouses", "POST", { name });
      await refresh();
      setName("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Warehouse could not be added.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Warehouses</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Warehouses</DialogTitle>
          <DialogDescription>
            Set up the named locations your team uses. Assign counted stock from
            Unassigned in Stock activity.
          </DialogDescription>
        </DialogHeader>
        {warehouses.length > 0 ? (
          <ul className="divide-y rounded-md border">
            {warehouses.map((warehouse) => (
              <li key={warehouse.id} className="px-3 py-2">
                {warehouse.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No warehouses have been added.
          </p>
        )}
        <form className="space-y-3" onSubmit={addWarehouse}>
          <label className="block space-y-1 text-sm">
            Warehouse name
            <Input
              maxLength={120}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button disabled={saving || !name.trim()} type="submit">
            Add warehouse
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
