import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { operation } from "@/lib/operations";

type Mode = "simulated" | "sandbox";
type Line = {
  supplierSku: string;
  unit: string;
  quantity: string;
  unitCost: string;
};
type ReviewedLine = {
  supplierSku: string;
  internalSku: string;
  productName: string;
  unit: string;
  billedUnitCost: string;
  expectedUnitCost: string;
  priceEffectiveOn: string;
  priceSource: string;
  priceDiffers: boolean;
};
type Prepared = {
  fingerprint: string;
  mode: Mode;
  supplier: string;
  totalCents: number;
  lines: ReviewedLine[];
  priceDiffers: boolean;
  quickBooksBill: { DocNumber: string; VendorRef: { value: string } };
  postedId?: string;
  reconciledExisting?: boolean;
};
type Bill = {
  id: string;
  status: string;
  payload: Prepared;
  lastError?: string;
  startedAt?: string;
};
export type SandboxVendor = { Id: string; DisplayName?: string };

const path = "/quickbooks/vendor-bills";
const blankLine: Line = {
  supplierSku: "",
  unit: "box",
  quantity: "",
  unitCost: "",
};
const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

export function VendorBillSandbox({
  mode,
  vendors,
}: {
  mode: Mode;
  vendors: SandboxVendor[];
}) {
  const [supplier, setSupplier] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [billDate, setBillDate] = useState("");
  const [billTotal, setBillTotal] = useState("");
  const [lines, setLines] = useState<Line[]>([blankLine]);
  const [preview, setPreview] = useState<Prepared>();
  const [bills, setBills] = useState<Bill[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let disposed = false;
    operation<Bill[]>(path)
      .then((rows) => {
        if (!disposed) setBills(rows);
      })
      .catch(() => {
        if (!disposed)
          setError("Could not load supplier bills. Reopen Settings to retry.");
      });
    return () => {
      disposed = true;
    };
  }, []);

  function edit(update: () => void) {
    update();
    setPreview(undefined);
    setError("");
    setMessage("");
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Supplier bill request failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const input = {
    mode,
    supplier,
    vendorId: mode === "sandbox" ? vendorId : undefined,
    billNumber,
    billDate,
    billTotal,
    lines,
  };
  const canPreview =
    supplier.trim() &&
    (mode === "simulated" || /^\d+$/.test(vendorId)) &&
    billNumber.trim() &&
    billDate &&
    billTotal.trim() &&
    lines.every((line) => Object.values(line).every((value) => value.trim()));
  const visibleBills = bills.filter((bill) => bill.payload.mode === mode);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {mode === "sandbox"
            ? "Supplier bills · QuickBooks sandbox"
            : "Supplier bills · simulation"}
        </CardTitle>
        <CardDescription>
          Review purchase lines against approved supplier SKUs and the price
          effective on the bill date.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              setPreview(
                await operation<Prepared>(`${path}/preview`, "POST", input),
              );
            });
          }}
        >
          <fieldset disabled={busy} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <label className="space-y-1 text-sm font-medium">
                Supplier
                <Input
                  value={supplier}
                  onChange={(event) =>
                    edit(() => setSupplier(event.target.value))
                  }
                />
              </label>
              <label className="space-y-1 text-sm font-medium">
                Bill number
                <Input
                  value={billNumber}
                  maxLength={21}
                  onChange={(event) =>
                    edit(() => setBillNumber(event.target.value))
                  }
                />
              </label>
              <label className="space-y-1 text-sm font-medium">
                Bill date
                <Input
                  value={billDate}
                  type="date"
                  onChange={(event) =>
                    edit(() => setBillDate(event.target.value))
                  }
                />
              </label>
              <label className="space-y-1 text-sm font-medium">
                Source bill total (USD)
                <Input
                  value={billTotal}
                  inputMode="decimal"
                  onChange={(event) =>
                    edit(() => setBillTotal(event.target.value))
                  }
                />
              </label>
            </div>
            {mode === "sandbox" && (
              <label className="block max-w-xs space-y-1 text-sm font-medium">
                Sandbox vendor ID
                <Input
                  value={vendorId}
                  list="vendor-bill-options"
                  inputMode="numeric"
                  onChange={(event) =>
                    edit(() => setVendorId(event.target.value))
                  }
                />
                <datalist id="vendor-bill-options">
                  {vendors.map((vendor) => (
                    <option key={vendor.Id} value={vendor.Id}>
                      {vendor.DisplayName}
                    </option>
                  ))}
                </datalist>
              </label>
            )}
            {lines.map((line, index) => (
              <div
                className="grid gap-2 rounded-md border p-2 sm:grid-cols-2 xl:grid-cols-5"
                key={index}
              >
                {(
                  [
                    ["supplierSku", "Supplier SKU"],
                    ["unit", "Unit"],
                    ["quantity", "Quantity"],
                    ["unitCost", "Billed unit cost"],
                  ] as const
                ).map(([field, label]) => (
                  <label className="space-y-1 text-sm font-medium" key={field}>
                    {label}
                    <Input
                      value={line[field]}
                      inputMode={
                        field === "quantity" || field === "unitCost"
                          ? "decimal"
                          : "text"
                      }
                      onChange={(event) =>
                        edit(() =>
                          setLines((current) =>
                            current.map((item, key) =>
                              key === index
                                ? { ...item, [field]: event.target.value }
                                : item,
                            ),
                          ),
                        )
                      }
                    />
                  </label>
                ))}
                {lines.length > 1 && (
                  <Button
                    variant="ghost"
                    className="self-end"
                    type="button"
                    onClick={() =>
                      edit(() =>
                        setLines((current) =>
                          current.filter((_line, key) => key !== index),
                        ),
                      )
                    }
                  >
                    Remove line {index + 1}
                  </Button>
                )}
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                type="button"
                onClick={() =>
                  edit(() => setLines((current) => [...current, blankLine]))
                }
                disabled={lines.length >= 50}
              >
                Add line
              </Button>
              <Button type="submit" disabled={!canPreview || busy}>
                Preview supplier bill
              </Button>
            </div>
          </fieldset>
        </form>
        {preview && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="font-medium">
              Bill {preview.quickBooksBill.DocNumber} ·{" "}
              {dollars(preview.totalCents)}
            </p>
            {mode === "sandbox" && (
              <p className="text-sm text-muted-foreground">
                QuickBooks vendor ID {preview.quickBooksBill.VendorRef.value}
              </p>
            )}
            <ul className="divide-y text-sm">
              {preview.lines.map((line, index) => (
                <li key={index} className="py-2">
                  <span className="font-medium">
                    {line.supplierSku} → {line.internalSku} · {line.productName}
                  </span>
                  <p>
                    Approved {line.expectedUnitCost} / {line.unit} · billed{" "}
                    {line.billedUnitCost} / {line.unit}
                    {line.priceDiffers && " · Price differs"}
                  </p>
                  <p className="text-muted-foreground">
                    {line.priceEffectiveOn} · {line.priceSource}
                  </p>
                </li>
              ))}
            </ul>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const draft = await operation<Bill>(path, "POST", {
                    ...input,
                    fingerprint: preview.fingerprint,
                  });
                  setBills((current) => [
                    draft,
                    ...current.filter((bill) => bill.id !== draft.id),
                  ]);
                  setPreview(undefined);
                  setMessage(
                    `Bill ${draft.payload.quickBooksBill.DocNumber} is in the approval list.`,
                  );
                })
              }
            >
              Queue for approval
            </Button>
          </div>
        )}
        {visibleBills.length > 0 && (
          <ul className="space-y-2">
            {visibleBills.map((bill) => (
              <li className="rounded-md border p-3" key={bill.id}>
                <p className="font-medium">
                  {bill.payload.supplier} ·{" "}
                  {bill.payload.quickBooksBill.DocNumber} ·{" "}
                  {dollars(bill.payload.totalCents)}
                </p>
                {bill.payload.priceDiffers && (
                  <p className="text-sm text-amber-700">
                    Billed price differs from the approved purchase price.
                  </p>
                )}
                {bill.payload.postedId && (
                  <p className="text-sm text-muted-foreground">
                    {mode === "simulated"
                      ? "Simulated bill"
                      : bill.payload.reconciledExisting
                        ? "Reconciled existing sandbox bill"
                        : "Verified sandbox bill"}{" "}
                    {bill.payload.postedId}
                  </p>
                )}
                {bill.lastError && (
                  <p className="text-sm text-destructive">{bill.lastError}</p>
                )}
                {(bill.status === "pending_approval" ||
                  bill.status === "failed" ||
                  (bill.status === "processing" &&
                    !!bill.startedAt &&
                    Date.parse(bill.startedAt) < Date.now() - 300_000)) && (
                  <Button
                    className="mt-2"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        try {
                          const completed = await operation<Bill>(
                            `${path}/${bill.id}/approve`,
                            "POST",
                          );
                          setBills((current) =>
                            current.map((item) =>
                              item.id === completed.id ? completed : item,
                            ),
                          );
                          setMessage(
                            mode === "simulated"
                              ? "Supplier bill simulated."
                              : "Supplier bill verified in the QuickBooks sandbox.",
                          );
                        } catch (failure) {
                          const rows = await operation<Bill[]>(path).catch(
                            () => undefined,
                          );
                          if (rows) setBills(rows);
                          throw failure;
                        }
                      })
                    }
                  >
                    {bill.status !== "pending_approval"
                      ? "Retry bill"
                      : mode === "simulated"
                        ? "Approve simulated bill"
                        : "Approve and post to sandbox"}
                  </Button>
                )}
                {bill.status === "processing" && (
                  <p className="text-sm text-muted-foreground">
                    Processing supplier bill.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-emerald-700">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
