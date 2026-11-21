import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { operation, useOperation } from "@/lib/operations";
import { inventorySelect } from "@/lib/purchasing";
import type { Product } from "@/lib/types";

export type SandboxAccount = {
  Id: string;
  Name?: string;
  Active?: boolean;
  AccountType?: string;
  AccountSubType?: string;
};
const groups = [
  {
    field: "incomeAccountId",
    label: "Sales income account",
    type: "Income",
    subtype: "SalesOfProductIncome",
  },
  {
    field: "cogsAccountId",
    label: "Cost of goods sold account",
    type: "Cost of Goods Sold",
    subtype: undefined,
  },
  {
    field: "assetAccountId",
    label: "Inventory asset account",
    type: "Other Current Asset",
    subtype: "Inventory",
  },
] as const;
type Preview = {
  fingerprint: string;
  existingItemId: string | null;
  document: {
    Name: string;
    Sku: string;
    InvStartDate: string;
    QtyOnHand: number;
  };
  accounts: Array<{ id: string; name: string; label: string }>;
};
const base = "/quickbooks/sandbox-stock-items";

export function SandboxStockItems({
  connectionId,
  accounts,
}: {
  connectionId: string;
  accounts: SandboxAccount[];
}) {
  const products = useOperation<Product[]>("/products", ["owner"]);
  const [form, setForm] = useState({
    productId: "",
    incomeAccountId: "",
    cogsAccountId: "",
    assetAccountId: "",
    inventoryStartDate: "",
  });
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const stocked =
    products.data?.filter(
      (product) =>
        product.active &&
        product.inventoryType === "Inventory" &&
        product.sku.trim(),
    ) ?? [];

  function edit(field: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setPreview(undefined);
    setError("");
    setMessage("");
  }

  async function act(event: FormEvent) {
    event.preventDefault();
    if (busy || !Object.values(form).every(Boolean)) return;
    setBusy(true);
    setError("");
    setMessage("");
    const input = { ...form, connectionId };
    try {
      if (!preview) {
        setPreview(await operation<Preview>(`${base}/preview`, "POST", input));
      } else {
        const result = await operation<{
          itemId: string;
          sku: string;
          reconciledExisting: boolean;
        }>(`${base}/approve`, "POST", {
          ...input,
          fingerprint: preview.fingerprint,
        });
        setPreview(undefined);
        setMessage(
          `${result.sku} linked to ${result.reconciledExisting ? "existing" : "new"} sandbox item ${result.itemId}.`,
        );
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Sandbox item review failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sandbox inventory items</CardTitle>
        <CardDescription>
          Review a stocked product and the accounts for creating it in this
          sandbox. Opening quantity is zero.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={act}>
          <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm font-medium">
              Stocked product
              <select
                required
                className={inventorySelect}
                value={form.productId}
                onChange={(event) => edit("productId", event.target.value)}
              >
                <option value="">Choose a product</option>
                {stocked.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} · {product.name}
                  </option>
                ))}
              </select>
            </label>
            {groups.map(({ field, label, type, subtype }) => (
              <label key={field} className="space-y-1 text-sm font-medium">
                {label}
                <select
                  required
                  className={inventorySelect}
                  value={form[field]}
                  onChange={(event) => edit(field, event.target.value)}
                >
                  <option value="">Choose an account</option>
                  {accounts
                    .filter(
                      (account) =>
                        account.Active === true &&
                        account.AccountType === type &&
                        (!subtype || account.AccountSubType === subtype),
                    )
                    .map((account) => (
                      <option value={account.Id} key={account.Id}>
                        {account.Name || account.Id}
                      </option>
                    ))}
                </select>
              </label>
            ))}
            <label className="space-y-1 text-sm font-medium">
              Inventory accounting start date
              <Input
                required
                type="date"
                value={form.inventoryStartDate}
                onChange={(event) =>
                  edit("inventoryStartDate", event.target.value)
                }
              />
            </label>
          </fieldset>
          {products.isError && (
            <p role="alert" className="text-sm text-destructive">
              Could not load products.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => void products.refetch()}
              >
                Retry
              </button>
            </p>
          )}
          {preview && (
            <div className="space-y-1 rounded-md border p-3 text-sm">
              <p className="font-semibold">
                {preview.document.Sku} · {preview.document.Name}
              </p>
              <p>
                Inventory start {preview.document.InvStartDate} ·{" "}
                {preview.document.QtyOnHand} opening units
              </p>
              {preview.accounts.map((account) => (
                <p key={account.id}>
                  {account.label} · {account.name} ({account.id})
                </p>
              ))}
              {preview.existingItemId && (
                <p>Matching sandbox item {preview.existingItemId}</p>
              )}
            </div>
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
          <Button
            type="submit"
            disabled={busy || !Object.values(form).every(Boolean)}
          >
            {preview
              ? preview.existingItemId
                ? "Approve existing sandbox link"
                : "Approve sandbox item creation"
              : "Preview sandbox item"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
