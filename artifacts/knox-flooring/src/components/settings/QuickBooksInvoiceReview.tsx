import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { operation } from "@/lib/operations";
import { inventorySelect } from "@/lib/purchasing";
import type { SandboxAccount } from "./SandboxStockItems";

type Source = {
  invoiceNumber: string;
  company: string;
  tax: number;
  discount: number;
  deposit: number;
  paid: number;
  lines: Array<{ id: string; description: string }>;
};
type Preview = {
  fingerprint: string;
  realmId: string;
  discount: number;
  tax: number;
  deposit: number;
  total: number;
  balance: number;
  attempt: {
    document: {
      Line: Array<{
        DetailType: string;
        Amount: number;
        Description?: string;
        SalesItemLineDetail?: {
          ItemRef: { value: string };
          TaxCodeRef?: { value: string };
        };
      }>;
    };
  };
  evidence: {
    customer: { Id: string; DisplayName: string };
    discountAccount?: { id: string; name: string };
    tax?: { id: string; name: string; percent: number };
    reconciliation?: {
      invoiceId: string;
      depositAccount?: { Id: string; Name: string };
    };
  };
};
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function QuickBooksInvoiceReview({
  jobId,
  onApproved,
  accounts = [],
}: {
  jobId: string;
  onApproved: () => Promise<void>;
  accounts?: SandboxAccount[];
}) {
  const [source, setSource] = useState<Source>();
  const [existingId, setExistingId] = useState("");
  const [taxCodeId, setTaxCodeId] = useState("");
  const [discountAccountId, setDiscountAccountId] = useState("");
  const [taxableLineIds, setTaxableLineIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = `/quickbooks/queue/${jobId}/accounting`;
  const needsExisting = (source?.deposit ?? 0) > 0 || (source?.paid ?? 0) > 0;
  const needsTaxCode = (source?.tax ?? 0) > 0 && !existingId && !needsExisting;
  const needsDiscountAccount =
    (source?.discount ?? 0) > 0 && !existingId && !needsExisting;
  const discountAccounts = accounts.filter(
    (account) =>
      account.Active === true &&
      account.AccountType === "Income" &&
      account.AccountSubType === "DiscountsRefundsGiven",
  );
  const request = {
    existingInvoiceId: existingId || undefined,
    discountAccountId: needsDiscountAccount ? discountAccountId : undefined,
    taxCodeId: needsTaxCode ? taxCodeId : undefined,
    taxableLineIds: needsTaxCode ? taxableLineIds : [],
  };
  const validId = (id: string) => /^\d{1,30}$/.test(id);
  const ready =
    (existingId ? validId(existingId) : !needsExisting) &&
    (!needsDiscountAccount || validId(discountAccountId)) &&
    (!needsTaxCode || (validId(taxCodeId) && taxableLineIds.length > 0));

  function clearReview() {
    setError("");
    setPreview(undefined);
    setConfirmed(false);
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "QuickBooks invoice review failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {!source ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(async () => setSource(await operation<Source>(path)))
          }
        >
          Review invoice accounting
        </Button>
      ) : (
        <fieldset disabled={busy} className="space-y-3 text-sm">
          <p className="font-medium">
            Invoice {source.invoiceNumber} · {source.company}
          </p>
          <label className="block max-w-64 space-y-1">
            Existing QuickBooks invoice ID{!needsExisting && " (optional)"}
            <Input
              inputMode="numeric"
              value={existingId}
              onChange={(event) => {
                setExistingId(event.target.value.trim());
                clearReview();
              }}
            />
          </label>
          {needsExisting && (
            <p className="text-muted-foreground">
              Enter the QuickBooks invoice that already records this deposit or
              payment.
            </p>
          )}
          {needsDiscountAccount && (
            <label className="block max-w-80 space-y-1">
              QuickBooks sales discount account
              {discountAccounts.length ? (
                <select
                  className={inventorySelect}
                  value={discountAccountId}
                  onChange={(event) => {
                    setDiscountAccountId(event.target.value);
                    clearReview();
                  }}
                >
                  <option value="">Choose an account</option>
                  {discountAccounts.map((account) => (
                    <option value={account.Id} key={account.Id}>
                      {account.Name || account.Id}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  inputMode="numeric"
                  placeholder="Sales discount account ID"
                  value={discountAccountId}
                  onChange={(event) => {
                    setDiscountAccountId(event.target.value.trim());
                    clearReview();
                  }}
                />
              )}
            </label>
          )}
          {needsTaxCode && (
            <>
              <label className="block max-w-64 space-y-1">
                QuickBooks sales-tax code ID
                <Input
                  inputMode="numeric"
                  value={taxCodeId}
                  onChange={(event) => {
                    setTaxCodeId(event.target.value.trim());
                    clearReview();
                  }}
                />
              </label>
              <p className="text-muted-foreground">
                Select the taxable sales lines. For Automated Sales Tax, enter
                the existing QuickBooks invoice ID.
              </p>
              {source.lines.map((line) => (
                <label className="flex items-center gap-2" key={line.id}>
                  <input
                    type="checkbox"
                    checked={taxableLineIds.includes(line.id)}
                    onChange={(event) => {
                      setTaxableLineIds((current) =>
                        event.target.checked
                          ? [...current, line.id]
                          : current.filter((id) => id !== line.id),
                      );
                      clearReview();
                    }}
                  />
                  {line.description}
                </label>
              ))}
            </>
          )}
          {!preview && (
            <Button
              type="button"
              size="sm"
              disabled={!ready}
              onClick={() =>
                void run(async () =>
                  setPreview(
                    await operation<Preview>(
                      `${path}/preview`,
                      "POST",
                      request,
                    ),
                  ),
                )
              }
            >
              Preview accounting
            </Button>
          )}
          {preview && (
            <div className="space-y-2 rounded-md bg-muted/50 p-3">
              <p className="font-medium">
                {source.company} · company {preview.realmId}
              </p>
              <p>
                Customer {preview.evidence.customer.DisplayName} (
                {preview.evidence.customer.Id})
              </p>
              <p>
                Discount {dollars.format(preview.discount)} · tax{" "}
                {dollars.format(preview.tax)} · deposit{" "}
                {dollars.format(preview.deposit)}
              </p>
              <p>
                Total {dollars.format(preview.total)} · open balance{" "}
                {dollars.format(preview.balance)}
              </p>
              {preview.evidence.discountAccount && (
                <p>
                  Sales discount account {preview.evidence.discountAccount.name}{" "}
                  ({preview.evidence.discountAccount.id})
                </p>
              )}
              {preview.evidence.tax && (
                <p>
                  Sales-tax code {preview.evidence.tax.name} (
                  {preview.evidence.tax.id}) · {preview.evidence.tax.percent}%
                </p>
              )}
              {preview.evidence.reconciliation && (
                <p>
                  Existing QuickBooks invoice{" "}
                  {preview.evidence.reconciliation.invoiceId}
                  {preview.evidence.reconciliation.depositAccount &&
                    ` · deposit account ${preview.evidence.reconciliation.depositAccount.Name} (${preview.evidence.reconciliation.depositAccount.Id})`}
                </p>
              )}
              <ul className="divide-y">
                {preview.attempt.document.Line.filter(
                  (line) => line.SalesItemLineDetail,
                ).map((line, index) => (
                  <li key={index} className="py-1">
                    {line.Description} · item{" "}
                    {line.SalesItemLineDetail?.ItemRef.value} ·{" "}
                    {dollars.format(line.Amount)}
                    {line.SalesItemLineDetail?.TaxCodeRef &&
                      ` · ${line.SalesItemLineDetail.TaxCodeRef.value === "TAX" ? "taxable" : "nontaxable"}`}
                  </li>
                ))}
              </ul>
              <label className="flex items-start gap-2 font-medium">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                {existingId
                  ? "I approve linking this existing QuickBooks invoice."
                  : "I approve creating this invoice in QuickBooks Online."}
              </label>
              <Button
                type="button"
                size="sm"
                disabled={!confirmed}
                onClick={() =>
                  void run(async () => {
                    await operation(`${path}/approve`, "POST", {
                      request,
                      fingerprint: preview.fingerprint,
                    });
                    await onApproved();
                  })
                }
              >
                {existingId ? "Approve invoice link" : "Approve invoice export"}
              </Button>
            </div>
          )}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
