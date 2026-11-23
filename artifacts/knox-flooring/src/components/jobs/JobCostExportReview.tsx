import { useState } from "react";
import { Button } from "@/components/ui/button";
import { operation, currency } from "@/lib/operations";
import { inventorySelect } from "@/lib/purchasing";
import {
  expenseReceiptHref,
  jobExportLabel,
  type AccountingLabor,
  type JobExpense,
  type JobAccountingOptions,
  type JobCostPreview,
  type JobCostSelection,
} from "@/lib/job-accounting";

export function JobCostExportReview({
  kind,
  source,
  options,
  onChanged,
}: {
  kind: "labor" | "expense";
  source: AccountingLabor | JobExpense;
  options: JobAccountingOptions;
  onChanged: () => Promise<unknown>;
}) {
  const [projectMode, setProjectMode] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [paymentType, setPaymentType] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [treatmentConfirmed, setTreatmentConfirmed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<JobCostPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const company = options.company;
  const originalRealmMatches =
    !source.export?.connectionId ||
    Boolean(
      company &&
      source.export.realmId === company.realmId &&
      source.export.environment === company.environment,
    );
  const expense = kind === "expense" ? (source as JobExpense) : null;
  const labor = kind === "labor" ? (source as AccountingLabor) : null;
  const funding =
    paymentType === "CreditCard"
      ? options.creditCardAccounts
      : options.bankAccounts;
  const validChoice = (rows: { id: string }[], id: string) =>
    rows.some((row) => row.id === id);
  const valid =
    options.enabled &&
    company &&
    projectMode &&
    treatmentConfirmed &&
    (expense
      ? validChoice(options.vendors, vendorId) &&
        validChoice(options.expenseAccounts, expenseAccountId) &&
        (expense.kind === "contractor_bill" ||
          Boolean(paymentType && validChoice(funding, paymentAccountId)))
      : labor?.costReviewed && labor.singleWorkerConfirmed);
  const path = `/quickbooks/job-costs/${kind}/${encodeURIComponent(source.id)}`;
  const reviewValid =
    preview &&
    company &&
    preview.sourceId === source.id &&
    preview.sourceRevision === source.revision &&
    preview.company.connectionId === company.connectionId &&
    preview.company.realmId === company.realmId &&
    preview.company.environment === company.environment;
  const locked = !["unreviewed", "rejected", "cancelled"].includes(
    source.exportState,
  );
  const selection = (): JobCostSelection => ({
    connectionId: company!.connectionId,
    sourceRevision: source.revision,
    projectMode: projectMode as "customer" | "project",
    billableStatus: "NotBillable",
    taxTreatment: "included_in_cost",
    ...(expense
      ? {
          vendorId,
          expenseAccountId,
          ...(expense.kind === "paid_purchase"
            ? {
                paymentType: paymentType as "Cash" | "Check" | "CreditCard",
                paymentAccountId,
              }
            : {}),
        }
      : {}),
  });
  function clear() {
    setPreview(undefined);
    setConfirmed(false);
    setError("");
    setMessage("");
  }
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The export could not be reviewed.",
      );
      await onChanged();
    } finally {
      setBusy(false);
    }
  }
  const select = (
    label: string,
    value: string,
    rows: { id: string; name: string }[],
    change: (value: string) => void,
  ) => (
    <label className="block space-y-1 text-sm">
      {label}
      <select
        className={inventorySelect}
        value={value}
        onChange={(event) => {
          change(event.target.value);
          clear();
        }}
      >
        <option value="">Choose a verified record</option>
        {rows.map((row) => (
          <option key={row.id} value={row.id}>
            {row.name} · {row.id}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="space-y-3 rounded-md border p-3 text-sm">
      <p className="font-medium">
        QuickBooks{" "}
        {kind === "labor"
          ? "time record"
          : expense?.kind === "contractor_bill"
            ? "contractor bill"
            : "paid expense"}{" "}
        · {jobExportLabel(source.exportState)}
      </p>
      {company ? (
        <p>
          {company.name} · {company.environment} · Company {company.realmId}
        </p>
      ) : (
        <p>Connect QuickBooks in Settings to review this export.</p>
      )}
      {source.export?.remoteId && (
        <p>Verified QuickBooks record: {source.export.remoteId}</p>
      )}
      {source.export?.realmId && (
        <p>
          Original export company: {source.export.realmId} ·{" "}
          {source.export.environment}.
        </p>
      )}
      {locked && !originalRealmMatches && (
        <p role="status">
          Restore the original QuickBooks company before reconciling this
          export.
        </p>
      )}
      {source.export?.lastError && (
        <p role="alert">{source.export.lastError}</p>
      )}
      {locked && source.export && (
        <>
          {source.exportState === "prepared" && (
            <Button
              variant="outline"
              disabled={busy || !company || !originalRealmMatches}
              onClick={() =>
                void run(async () => {
                  await operation(
                    `/quickbooks/job-costs/exports/${encodeURIComponent(source.export!.id)}/cancel`,
                    "POST",
                    { connectionId: company!.connectionId },
                  );
                  await onChanged();
                  setMessage(
                    "Unsubmitted approval cancelled. Review the source before approving again.",
                  );
                })
              }
            >
              Cancel unsubmitted approval
            </Button>
          )}
          {["unknown", "submitting"].includes(source.exportState) && (
            <>
              <p>
                The original submission must be reconciled. This action checks
                for the original record and does not create another one.
              </p>
              <Button
                variant="outline"
                disabled={busy || !company || !originalRealmMatches}
                onClick={() =>
                  void run(async () => {
                    const result = await operation<{
                      outcome: "confirmed" | "unresolved";
                      warning?: string;
                    }>(
                      `/quickbooks/job-costs/exports/${encodeURIComponent(source.export!.id)}/reconcile`,
                      "POST",
                      { connectionId: company!.connectionId },
                    );
                    await onChanged();
                    setMessage(
                      (result.outcome === "confirmed"
                        ? "The original QuickBooks record is confirmed."
                        : "The result remains unresolved. Keep the source paused for accounting review.") +
                        (result.warning ? ` ${result.warning}` : ""),
                    );
                  })
                }
              >
                Reconcile original submission
              </Button>
            </>
          )}
        </>
      )}
      {!locked && (
        <fieldset
          disabled={busy || !options.enabled || !company}
          className="space-y-3"
        >
          <label className="block space-y-1">
            Job attribution
            <select
              className={inventorySelect}
              value={projectMode}
              onChange={(event) => {
                setProjectMode(event.target.value);
                clear();
              }}
            >
              <option value="">Choose customer or verified Project</option>
              <option value="customer">Mapped customer only</option>
              <option value="project">
                Verified linked QuickBooks Project
              </option>
            </select>
          </label>
          {expense && (
            <>
              {select(
                "QuickBooks vendor",
                vendorId,
                options.vendors,
                setVendorId,
              )}
              {select(
                "Expense account",
                expenseAccountId,
                options.expenseAccounts,
                setExpenseAccountId,
              )}
              {expense.kind === "paid_purchase" && (
                <>
                  <label className="block space-y-1">
                    Payment type
                    <select
                      className={inventorySelect}
                      value={paymentType}
                      onChange={(event) => {
                        setPaymentType(event.target.value);
                        setPaymentAccountId("");
                        clear();
                      }}
                    >
                      <option value="">Choose receipt payment type</option>
                      <option value="Cash">Cash</option>
                      <option value="Check">Check</option>
                      <option value="CreditCard">Credit card</option>
                    </select>
                  </label>
                  {select(
                    "Payment account",
                    paymentAccountId,
                    funding,
                    setPaymentAccountId,
                  )}
                </>
              )}
              <p>
                Receipt amount:{" "}
                <strong>{currency(expense.amountCents / 100)} USD</strong>,
                including {currency(expense.taxCents / 100)} receipt tax.
                Reference {expense.reference} · {expense.transactionDate}
                {expense.dueDate ? ` · Due ${expense.dueDate}` : ""}.
              </p>
              {expenseReceiptHref(expense.receiptUrl) && (
                <a
                  href={expenseReceiptHref(expense.receiptUrl)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Open receipt · {expense.receiptName}
                </a>
              )}
            </>
          )}
          {labor && (
            <p>
              {labor.workerName} · {labor.hours} individual hours · {labor.date}{" "}
              · Local hourly cost {currency(labor.hourlyCost ?? 0)}. This
              creates a nonbillable time record.
            </p>
          )}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={treatmentConfirmed}
              onChange={(event) => {
                setTreatmentConfirmed(event.target.checked);
                clear();
              }}
            />
            {expense
              ? "I reviewed the receipt and approve the gross amount, including receipt tax, as job cost without a separate tax-recovery claim."
              : "I confirm this individual's time is nonbillable and the local hourly cost is reviewed."}
          </label>
          <Button
            variant="outline"
            disabled={!valid}
            onClick={() =>
              void run(async () => {
                setPreview(
                  await operation<JobCostPreview>(
                    `${path}/review`,
                    "POST",
                    selection(),
                  ),
                );
                setConfirmed(false);
              })
            }
          >
            Prepare exact accounting review
          </Button>
          {reviewValid && preview && (
            <div className="space-y-3 rounded-md bg-muted/40 p-3">
              <p className="font-medium">
                Frozen review · {preview.company.name} ·{" "}
                {preview.company.environment} · Company{" "}
                {preview.company.realmId}
              </p>
              {preview.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
              <details>
                <summary className="cursor-pointer">
                  Review exact QuickBooks transaction fields
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(preview.document, null, 2)}
                </pre>
              </details>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I approve this exact source, accounting choices and QuickBooks
                company.
              </label>
              <Button
                disabled={!confirmed}
                onClick={() =>
                  void run(async () => {
                    const result = await operation<{
                      export: { state: string; remoteId: string | null };
                    }>(`${path}/approve`, "POST", {
                      ...preview.selection,
                      fingerprint: preview.fingerprint,
                    });
                    clear();
                    await onChanged();
                    setMessage(
                      result.export.state === "confirmed"
                        ? `Confirmed in QuickBooks${result.export.remoteId ? ` · ${result.export.remoteId}` : ""}.`
                        : "Owner approval saved. Check the export status for its confirmed result.",
                    );
                  })
                }
              >
                Approve frozen export
              </Button>
            </div>
          )}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
