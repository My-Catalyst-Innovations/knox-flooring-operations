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
import { operation, useOperation } from "@/lib/operations";
import { billLineFields, billLineLimit, validBillTotal, validateBillLine, type VendorBillLine } from "@/lib/vendor-bill-intake";
import { VendorBillLineIntake } from "./VendorBillLineIntake";
import type { SandboxAccount } from "./SandboxStockItems";
import { inventorySelect } from "@/lib/purchasing";

type Mode = "review" | "simulated" | "sandbox" | "production";
const productCodeLabels = {
  supplier_sku: "Supplier SKU",
  manufacturer_part_number: "Manufacturer part number",
  internal_sku: "Internal SKU",
};
type ProductCodeType = keyof typeof productCodeLabels;
const chargeLabels = { freight: "Freight", supplier_tax: "Supplier tax", fee: "Fee" };
type Charge = { kind: keyof typeof chargeLabels; description: string; amount: string; accountId: string };
const blankCharge: Charge = { kind: "freight", description: "", amount: "", accountId: "" };
type ReviewedLine = {
  supplierSku: string;
  internalSku: string;
  productName: string;
  unit: string;
  quantity: string;
  billedUnitCost: string;
  expectedUnitCost: string;
  priceEffectiveOn: string;
  priceSource: string;
  priceDiffers: boolean;
  sourceCode?: { type: ProductCodeType; value: string };
  quickBooksItemId?: string;
  stockLine?: { unit: string; quantity: string; unitCost: string };
};
type Prepared = {
  fingerprint: string;
  supplier: string;
  totalCents: number;
  lines: ReviewedLine[];
  charges?: Array<Omit<Charge, "accountId"> & { accountId?: string; totalCents: number }>;
  chargeAccounts?: Array<{ id: string; name: string; type: string }>;
  priceDiffers: boolean;
} & (
  | { mode: "review"; billNumber: string; billDate: string }
  | ({
      quickBooksBill: {
        DocNumber: string;
        TxnDate: string;
        VendorRef: { value: string };
      };
      postedId?: string;
      reconciledExisting?: boolean;
    } & (
      | { mode: "simulated" | "sandbox" }
      | { mode: "production"; quickBooksTarget: { vendorName: string } }
    ))
);
type Bill = {
  id: string;
  status: string;
  payload: Prepared;
  lastError?: string;
  startedAt?: string;
};
export type SandboxVendor = { Id: string; DisplayName?: string };

const path = "/quickbooks/vendor-bills";
const titles: Record<Mode, string> = {
  review: "Supplier bills · local review",
  sandbox: "Supplier bills · QuickBooks sandbox",
  simulated: "Supplier bills · simulation",
  production: "Supplier bills · QuickBooks Online",
};
const approvalLabels: Record<Mode, string> = {
  review: "Record owner review",
  sandbox: "Approve and post to sandbox",
  simulated: "Approve simulated bill",
  production: "Approve and post to QuickBooks Online",
};
const approvalMessages: Record<Mode, string> = {
  review: "Supplier bill review recorded.",
  sandbox: "Supplier bill verified in the QuickBooks sandbox.",
  simulated: "Supplier bill simulated.",
  production: "Supplier bill verified in QuickBooks Online.",
};
const blankLine: VendorBillLine = {
  supplierSku: "",
  unit: "box",
  quantity: "",
  unitCost: "",
};
const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

function billNumberFor(bill: Prepared) {
  return bill.mode === "review"
    ? bill.billNumber
    : bill.quickBooksBill.DocNumber;
}

function ReviewedCharges({ bill }: { bill: Prepared }) {
  if (!bill.charges?.length) return null;
  return <ul className="divide-y text-sm">{bill.charges.map((charge, index) => {
    const account = bill.chargeAccounts?.find(({ id }) => id === charge.accountId);
    return <li className="py-2" key={index}>
      <p className="font-medium">{chargeLabels[charge.kind]} · {charge.description} · {dollars(charge.totalCents)}</p>
      {account && <p className="text-muted-foreground">{account.name} ({account.id}) · {account.type}</p>}
    </li>;
  })}</ul>;
}

function ReviewedLines({
  lines,
  showQuickBooksItem = false,
}: {
  lines: ReviewedLine[];
  showQuickBooksItem?: boolean;
}) {
  return (
    <ul className="divide-y text-sm">
      {lines.map((line, index) => (
        <li key={index} className="py-2">
          <span className="font-medium">
            {line.supplierSku} → {line.internalSku} · {line.productName}
          </span>
          {line.sourceCode && <p>
            {productCodeLabels[line.sourceCode.type]} {line.sourceCode.value} → Supplier SKU {line.supplierSku}
          </p>}
          <p>
            Quantity {line.quantity} · Approved {line.expectedUnitCost} /{" "}
            {line.unit} · billed {line.billedUnitCost} / {line.unit}
            {line.priceDiffers && " · Price differs"}
          </p>
          {line.stockLine && <p className="text-muted-foreground">
            Stock equivalent {line.stockLine.quantity} {line.stockLine.unit} · {line.stockLine.unitCost} USD / {line.stockLine.unit}
          </p>}
          <p className="text-muted-foreground">
            {line.priceEffectiveOn} · {line.priceSource}
            {showQuickBooksItem &&
              line.quickBooksItemId &&
              ` · QuickBooks item ${line.quickBooksItemId}`}
          </p>
        </li>
      ))}
    </ul>
  );
}

type BillCapabilities = {
  productionEnabled: boolean;
  companyName: string | null;
  companyId: string | null;
};

export function ProductionVendorBills({
  vendors,
  realmId,
  accounts,
}: {
  vendors: SandboxVendor[];
  realmId?: string;
  accounts?: SandboxAccount[];
}) {
  const capabilities = useOperation<BillCapabilities>(`${path}/capabilities`, [
    "owner",
  ]);
  const company = capabilities.data;
  if (
    capabilities.isError ||
    !company?.productionEnabled ||
    !company.companyId ||
    company.companyId !== realmId
  )
    return null;
  return (
    <VendorBillSandbox
      mode="production"
      vendors={vendors}
      accounts={accounts}
      company={company.companyName || `Company ${company.companyId}`}
    />
  );
}

export function VendorBillSandbox({
  mode,
  vendors,
  company,
  accounts = [],
}: {
  mode: Mode;
  vendors: SandboxVendor[];
  company?: string;
  accounts?: SandboxAccount[];
}) {
  const [supplier, setSupplier] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [billDate, setBillDate] = useState("");
  const [billTotal, setBillTotal] = useState("");
  const [productCodeType, setProductCodeType] = useState<ProductCodeType>("supplier_sku");
  const [lines, setLines] = useState<VendorBillLine[]>([blankLine]);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [preview, setPreview] = useState<Prepared>();
  const [bills, setBills] = useState<Bill[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState<{
    id: string;
    fingerprint: string;
  } | null>(null);
  const historyPath = `${path}?mode=${mode}`;
  const usesQuickBooksVendor = mode === "sandbox" || mode === "production";
  const chargeAccounts = accounts.filter((account) => account.Active === true && ["Expense", "Other Expense", "Cost of Goods Sold"].includes(account.AccountType ?? ""));

  useEffect(() => {
    let disposed = false;
    operation<Bill[]>(historyPath)
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
  }, [historyPath]);

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

  function editCharge(index: number, update: Partial<Charge>) {
    edit(() => setCharges((current) => current.map((charge, position) => position === index ? { ...charge, ...update } : charge)));
  }

  const merchandise = charges.length && lines.length === 1 && billLineFields.every(([field]) => lines[0][field] === blankLine[field]) ? [] : lines;
  const input = {
    mode,
    supplier,
    vendorId: usesQuickBooksVendor ? vendorId : undefined,
    billNumber,
    billDate,
    billTotal,
    ...(productCodeType === "supplier_sku" ? {} : { productCodeType }),
    lines: merchandise,
    ...(charges.length ? { charges: charges.map((charge) => ({ ...charge, accountId: charge.accountId || undefined })) } : {}),
  };
  const lineIssues = lines.map(validateBillLine);
  const totalProblem = billTotal.trim() && !validBillTotal(billTotal);
  const canPreview =
    supplier.trim() &&
    (!usesQuickBooksVendor || /^\d+$/.test(vendorId)) &&
    billNumber.trim() &&
    billDate &&
    validBillTotal(billTotal) &&
    merchandise.length + charges.length > 0 &&
    merchandise.length + charges.length <= billLineLimit &&
    merchandise.every((line) => Object.keys(validateBillLine(line)).length === 0) &&
    charges.every((charge) => charge.description.trim() && validBillTotal(charge.amount) && (!usesQuickBooksVendor || chargeAccounts.some(({ Id }) => Id === charge.accountId)));
  const visibleBills = bills.filter((bill) => bill.payload.mode === mode);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{titles[mode]}</CardTitle>
        <CardDescription>
          Review purchase lines against approved supplier SKUs and the price
          effective on the bill date.
          {mode === "review" &&
            " Owner reviews are recorded in Catalyst Works."}
          {mode === "production" &&
            ` Approved bills post to ${company || "the connected QuickBooks company"}. Enter USD merchandise and charges from the supplier bill.`}
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
              <div className="space-y-1 text-sm font-medium">
                <label htmlFor={`vendor-bill-${mode}-total`}>Source bill total (USD)</label>
                <Input
                  id={`vendor-bill-${mode}-total`}
                  value={billTotal}
                  inputMode="decimal"
                  aria-invalid={!!totalProblem || undefined}
                  aria-describedby={totalProblem ? `vendor-bill-${mode}-total-error` : undefined}
                  onChange={(event) =>
                    edit(() => setBillTotal(event.target.value))
                  }
                />
                {totalProblem && <p id={`vendor-bill-${mode}-total-error`} className="text-xs text-destructive">Enter the positive bill total with up to two decimal places and no currency symbol or separators.</p>}
              </div>
            </div>
            <label className="block max-w-sm space-y-1 text-sm font-medium">
              Product codes on this bill
              <select className={inventorySelect} value={productCodeType}
                onChange={(event) => edit(() => setProductCodeType(event.target.value as ProductCodeType))}>
                {Object.entries(productCodeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <p className="text-sm text-muted-foreground">
              Choose the code shown on the supplier document. This applies to every imported or entered line.
              The preview matches your approved supplier list; ambiguous matches require review.
            </p>
            {usesQuickBooksVendor && (
              <label className="block max-w-xs space-y-1 text-sm font-medium">
                {mode === "production"
                  ? "QuickBooks vendor ID"
                  : "Sandbox vendor ID"}
                <Input
                  value={vendorId}
                  list={`vendor-bill-options-${mode}`}
                  inputMode="numeric"
                  onChange={(event) =>
                    edit(() => setVendorId(event.target.value))
                  }
                />
                <datalist id={`vendor-bill-options-${mode}`}>
                  {vendors.map((vendor) => (
                    <option key={vendor.Id} value={vendor.Id}>
                      {vendor.DisplayName}
                    </option>
                  ))}
                </datalist>
              </label>
            )}
            <VendorBillLineIntake onApply={(imported) => {
              edit(() => setLines(imported));
              setMessage(`Imported ${imported.length} ${imported.length === 1 ? "line" : "lines"}.`);
            }} />
            {lines.map((line, index) => (
              <div
                className="grid gap-2 rounded-md border p-2 sm:grid-cols-2 xl:grid-cols-5"
                key={index}
              >
                {billLineFields.map(([field, label]) => {
                  const problem = line[field].trim() ? lineIssues[index][field] : undefined;
                  const fieldId = `vendor-bill-${mode}-${index}-${field}`;
                  return (
                    <div className="space-y-1 text-sm font-medium" key={field}>
                      <label htmlFor={fieldId}>{field === "supplierSku" ? productCodeLabels[productCodeType] : label}</label>
                      <Input
                        id={fieldId}
                        value={line[field]}
                        aria-invalid={!!problem || undefined}
                        aria-describedby={problem ? `${fieldId}-error` : undefined}
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
                      {problem && <p id={`${fieldId}-error`} className="text-xs text-destructive">{problem}</p>}
                    </div>
                  );
                })}
                {(lines.length > 1 || charges.length > 0) && (
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
            {charges.map((charge, index) => <div key={index} className="grid gap-2 rounded-md border p-2 sm:grid-cols-2 xl:grid-cols-5">
              <label className="space-y-1 text-sm font-medium">Charge type
                <select className={inventorySelect} value={charge.kind} onChange={(event) => editCharge(index, { kind: event.target.value as Charge["kind"] })}>
                  {Object.entries(chargeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-sm font-medium">Description
                <Input maxLength={200} value={charge.description} onChange={(event) => editCharge(index, { description: event.target.value })} />
              </label>
              <label className="space-y-1 text-sm font-medium">Charge amount (USD)
                <Input value={charge.amount} inputMode="decimal" aria-invalid={!!charge.amount && !validBillTotal(charge.amount)} onChange={(event) => editCharge(index, { amount: event.target.value })} />
              </label>
              {usesQuickBooksVendor && <label className="space-y-1 text-sm font-medium">QuickBooks expense account
                <select className={inventorySelect} value={charge.accountId} onChange={(event) => editCharge(index, { accountId: event.target.value })}>
                  <option value="">Choose an account</option>
                  {chargeAccounts.map((account) => <option key={account.Id} value={account.Id}>{account.Name || account.Id} · {account.AccountType}</option>)}
                </select>
              </label>}
              <Button type="button" variant="ghost" className="self-end" onClick={() => edit(() => setCharges((current) => current.filter((_, position) => position !== index)))}>Remove charge {index + 1}</Button>
            </div>)}
            {charges.length > 0 && usesQuickBooksVendor && !chargeAccounts.length && <p className="text-sm text-muted-foreground">Use Import & reconcile to load active QuickBooks expense accounts.</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                type="button"
                onClick={() =>
                  edit(() => setLines((current) => [...current, blankLine]))
                }
                disabled={lines.length + charges.length >= billLineLimit}
              >
                Add line
              </Button>
              {mode !== "simulated" && <Button variant="outline" type="button" onClick={() => edit(() => setCharges((current) => [...current, blankCharge]))} disabled={charges.length >= 20 || merchandise.length + charges.length >= billLineLimit}>Add account charge</Button>}
              <Button type="submit" disabled={!canPreview || busy}>
                Preview supplier bill
              </Button>
            </div>
          </fieldset>
        </form>
        {preview && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="font-medium">
              Bill {billNumberFor(preview)} · {dollars(preview.totalCents)}
            </p>
            {preview.mode === "sandbox" && (
              <p className="text-sm text-muted-foreground">
                QuickBooks vendor ID {preview.quickBooksBill.VendorRef.value}
              </p>
            )}
            {preview.mode === "production" && (
              <p className="text-sm text-muted-foreground">
                QuickBooks vendor {preview.quickBooksTarget.vendorName} · ID{" "}
                {preview.quickBooksBill.VendorRef.value}
              </p>
            )}
            <ReviewedLines
              lines={preview.lines}
              showQuickBooksItem={preview.mode === "production"}
            />
            <ReviewedCharges bill={preview} />
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
                    draft.status === "reviewed"
                      ? `Bill ${billNumberFor(draft.payload)} has already been reviewed.`
                      : `Bill ${billNumberFor(draft.payload)} is in the approval list.`,
                  );
                })
              }
            >
              {mode === "review" ? "Queue for review" : "Queue for approval"}
            </Button>
          </div>
        )}
        {visibleBills.length > 0 && (
          <ul className="space-y-2">
            {visibleBills.map((bill) => {
              const reviewing =
                bill.status === "pending_approval" ||
                (mode !== "review" &&
                  (bill.status === "failed" ||
                    (bill.status === "processing" &&
                      !!bill.startedAt &&
                      Date.parse(bill.startedAt) < Date.now() - 300_000)));
              const confirmed =
                confirmation?.id === bill.id &&
                confirmation.fingerprint === bill.payload.fingerprint;
              return (
                <li className="rounded-md border p-3" key={bill.id}>
                  <p className="font-medium">
                    {bill.payload.supplier} · {billNumberFor(bill.payload)} ·{" "}
                    {dollars(bill.payload.totalCents)}
                  </p>
                  {bill.payload.priceDiffers && (
                    <p className="text-sm text-amber-700">
                      Billed price differs from the approved purchase price.
                    </p>
                  )}
                  {bill.payload.mode === "review" && (
                    <details className="my-1 text-sm">
                      <summary className="cursor-pointer">Bill details</summary>
                      <p className="mt-2 text-muted-foreground">
                        Bill date {bill.payload.billDate}
                      </p>
                      <ReviewedLines lines={bill.payload.lines} />
                      <ReviewedCharges bill={bill.payload} />
                    </details>
                  )}
                  {bill.payload.mode === "production" && (
                    <div className="my-2 space-y-2 text-sm">
                      <p>
                        QuickBooks vendor{" "}
                        {bill.payload.quickBooksTarget.vendorName} · ID{" "}
                        {bill.payload.quickBooksBill.VendorRef.value} ·{" "}
                        {bill.payload.quickBooksBill.TxnDate}
                      </p>
                      <ReviewedLines
                        lines={bill.payload.lines}
                        showQuickBooksItem
                      />
                      <ReviewedCharges bill={bill.payload} />
                      {reviewing && (
                        <label className="flex items-start gap-2 font-medium">
                          <input
                            type="checkbox"
                            className="mt-1 accent-primary"
                            checked={confirmed}
                            disabled={busy}
                            onChange={(event) =>
                              setConfirmation(
                                event.target.checked
                                  ? {
                                      id: bill.id,
                                      fingerprint: bill.payload.fingerprint,
                                    }
                                  : null,
                              )
                            }
                          />
                          I approve this vendor, these lines, and this amount
                          for posting to {company || "QuickBooks Online"}.
                        </label>
                      )}
                    </div>
                  )}
                  {bill.payload.mode === "sandbox" && <ReviewedCharges bill={bill.payload} />}
                  {bill.status === "reviewed" && (
                    <p className="text-sm text-muted-foreground">
                      Reviewed in Catalyst Works
                    </p>
                  )}
                  {bill.payload.mode !== "review" && bill.payload.postedId && (
                    <p className="text-sm text-muted-foreground">
                      {mode === "simulated"
                        ? "Simulated bill"
                        : bill.payload.reconciledExisting
                          ? `Reconciled existing ${mode === "production" ? "QuickBooks" : "sandbox"} bill`
                          : `Verified ${mode === "production" ? "QuickBooks" : "sandbox"} bill`}{" "}
                      {bill.payload.postedId}
                    </p>
                  )}
                  {bill.lastError && (
                    <p className="text-sm text-destructive">{bill.lastError}</p>
                  )}
                  {reviewing && (
                    <Button
                      className="mt-2"
                      size="sm"
                      disabled={busy || (mode === "production" && !confirmed)}
                      onClick={() =>
                        void run(async () => {
                          try {
                            const approvePath = `${path}/${bill.id}/approve`;
                            const completed =
                              mode === "production"
                                ? await operation<Bill>(approvePath, "POST", {
                                    confirmedFingerprint:
                                      bill.payload.fingerprint,
                                  })
                                : await operation<Bill>(approvePath, "POST");
                            setBills((current) =>
                              current.map((item) =>
                                item.id === completed.id ? completed : item,
                              ),
                            );
                            setMessage(approvalMessages[mode]);
                          } catch (failure) {
                            const rows = await operation<Bill[]>(
                              historyPath,
                            ).catch(() => undefined);
                            if (rows) setBills(rows);
                            throw failure;
                          } finally {
                            setConfirmation(null);
                          }
                        })
                      }
                    >
                      {bill.status !== "pending_approval"
                        ? "Retry bill"
                        : approvalLabels[mode]}
                    </Button>
                  )}
                  {bill.status === "processing" && (
                    <p className="text-sm text-muted-foreground">
                      Processing supplier bill.
                    </p>
                  )}
                </li>
              );
            })}
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
