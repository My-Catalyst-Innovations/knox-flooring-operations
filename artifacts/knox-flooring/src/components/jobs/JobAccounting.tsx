import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  currency,
  operation,
  useOperation,
  useRefreshOperations,
} from "@/lib/operations";
import { inventorySelect } from "@/lib/purchasing";
import {
  expenseReceiptHref,
  jobExportLabel,
  moneyInputCents,
  type AccountingLabor,
  type JobExpense,
  type JobAccountingCosts,
  type JobAccountingOptions,
} from "@/lib/job-accounting";
import { JobCostExportReview } from "./JobCostExportReview";
import { JobQuickBooksProject } from "./JobQuickBooksProject";

const blankExpense = () => ({
  kind: "",
  description: "",
  category: "",
  vendorName: "",
  transactionDate: "",
  dueDate: "",
  relatedLaborEntryId: "",
  currency: "",
  amount: "",
  tax: "",
  receiptDocumentId: "",
  reference: "",
  notes: "",
});
const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "The job accounting change could not be saved.";
export function JobAccounting({ jobId }: { jobId: string }) {
  const costs = useOperation<JobAccountingCosts>(
    `/jobs/${jobId}/accounting-costs`,
    ["owner"],
  );
  const options = useOperation<JobAccountingOptions>(
    "/quickbooks/job-costs/options",
    ["owner"],
  );
  const refresh = useRefreshOperations();
  async function changed() {
    await costs.refetch();
    await refresh();
  }
  if (!costs.allowed) return null;
  return (
    <div className="space-y-6">
      <JobQuickBooksProject jobId={jobId} />
      <Card>
        <CardHeader>
          <CardTitle>Reviewed job costs</CardTitle>
          <CardDescription>
            Record individual labor cost and receipt-backed expenses before
            owner accounting approval.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            variant="outline"
            onClick={() => {
              void costs.refetch();
              void options.refetch();
            }}
          >
            Refresh accounting sources
          </Button>
          {costs.isLoading && <p role="status">Loading job costs…</p>}
          {costs.isError && (
            <p role="alert">
              Job costs could not be loaded. Refresh before entering or
              approving costs.
            </p>
          )}
          {options.isError && (
            <p role="alert">
              Verified QuickBooks choices could not be loaded. Refresh before
              mapping or exporting.
            </p>
          )}
          {costs.data && (
            <>
              <p className="text-sm">
                Reviewed labor:{" "}
                {costs.data.totals.trackedLaborCost === null
                  ? "Not priced"
                  : currency(costs.data.totals.trackedLaborCost)}{" "}
                · {costs.data.totals.unpricedLaborCount} unpriced entries.
                Receipt-backed expenses:{" "}
                {currency(costs.data.totals.trackedExpenseCost)}.
              </p>
              {costs.data.warnings.map((warning) => (
                <p key={warning} role="status" className="text-sm">
                  {warning}
                </p>
              ))}
              {costs.data.labor.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Log individual hours in Labor entries to review a worker and
                  hourly cost.
                </p>
              )}
              {costs.data.labor.map((entry) => (
                <LaborAccounting
                  key={`${entry.id}:${entry.revision}`}
                  entry={entry}
                  replacedBy={
                    costs.data!.expenses.find(
                      (expense) => expense.relatedLaborEntryId === entry.id,
                    )?.reference
                  }
                  options={options.data}
                  onChanged={changed}
                />
              ))}
            </>
          )}
        </CardContent>
      </Card>
      {costs.data && (
        <ExpenseSources
          jobId={jobId}
          expenses={costs.data.expenses}
          labor={costs.data.labor}
          options={options.data}
          onChanged={changed}
        />
      )}
    </div>
  );
}

function LaborAccounting({
  entry,
  replacedBy,
  options,
  onChanged,
}: {
  entry: AccountingLabor;
  replacedBy?: string;
  options?: JobAccountingOptions;
  onChanged: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [workerType, setWorkerType] = useState(
    entry.workerType === "unmapped" ? "" : entry.workerType,
  );
  const [workerId, setWorkerId] = useState(entry.workerExternalId ?? "");
  const [serviceId, setServiceId] = useState(entry.serviceItemExternalId ?? "");
  const [rate, setRate] = useState(
    entry.hourlyCost === null ? "" : String(entry.hourlyCost),
  );
  const [onePerson, setOnePerson] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const workers =
    workerType === "Employee"
      ? (options?.employees ?? [])
      : workerType === "Vendor"
        ? (options?.vendors ?? [])
        : [];
  const worker = workers.find((item) => item.id === workerId);
  const rateCents = moneyInputCents(rate);
  const unlocked =
    !replacedBy &&
    ["unreviewed", "rejected", "cancelled"].includes(entry.exportState);
  const save = async () => {
    if (busy || !worker || rateCents === null || !onePerson) return;
    setBusy(true);
    setError("");
    try {
      await operation(
        `/jobs/${entry.jobId}/labor/${entry.id}/accounting`,
        "PATCH",
        {
          revision: entry.revision,
          singleWorkerConfirmed: true,
          workerType,
          workerExternalId: worker.id,
          workerName: worker.name,
          serviceItemExternalId: serviceId,
          hourlyCost: rateCents / 100,
        },
      );
      await onChanged();
      setEditing(false);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-md border p-3 text-sm">
      <p className="font-medium">
        {entry.date} · {entry.hours} person-hours · {entry.crew}
      </p>
      <p>
        {entry.costReviewed
          ? `${entry.workerName} · Local cost ${currency(entry.hourlyCost ?? 0)} per hour`
          : "Worker and cost review required"}{" "}
        · {jobExportLabel(entry.exportState)}
      </p>
      {replacedBy && (
        <p>
          Its labor cost is represented by contractor bill {replacedBy}. Review
          that receipt expense instead of exporting the same work as time.
        </p>
      )}
      {unlocked && !editing && (
        <Button
          variant="outline"
          disabled={!options?.company}
          onClick={() => setEditing(true)}
        >
          Review individual worker and cost
        </Button>
      )}
      {editing && (
        <fieldset disabled={busy} className="space-y-3">
          <label className="block space-y-1">
            Worker type
            <select
              className={inventorySelect}
              value={workerType}
              onChange={(event) => {
                setWorkerType(event.target.value as typeof workerType);
                setWorkerId("");
              }}
            >
              <option value="">Choose employee or vendor</option>
              <option value="Employee">Employee</option>
              <option value="Vendor">Vendor</option>
            </select>
          </label>
          <label className="block space-y-1">
            Verified worker
            <select
              className={inventorySelect}
              value={workerId}
              onChange={(event) => setWorkerId(event.target.value)}
            >
              <option value="">Select one individual worker</option>
              {workers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.id}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            Service item
            <select
              className={inventorySelect}
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
            >
              <option value="">Select a verified service</option>
              {options?.serviceItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.id}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            Local hourly cost (USD)
            <Input
              inputMode="decimal"
              value={rate}
              onChange={(event) => setRate(event.target.value)}
            />
          </label>
          <p>
            This cost prices the work in this job. It is separate from a
            customer billing rate.
          </p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={onePerson}
              onChange={(event) => setOnePerson(event.target.checked)}
            />
            This entry records one person's actual hours. I have split any crew
            total into individual entries and reviewed this cost.
          </label>
          <div className="flex gap-2">
            <Button
              disabled={
                !worker ||
                !options?.serviceItems.some((item) => item.id === serviceId) ||
                rateCents === null ||
                !onePerson
              }
              onClick={() => void save()}
            >
              Save reviewed labor cost
            </Button>
            <Button variant="outline" onClick={() => setEditing(false)}>
              Cancel worker review
            </Button>
          </div>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {entry.costReviewed && options && !replacedBy && (
        <JobCostExportReview
          kind="labor"
          source={entry}
          options={options}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

function ExpenseSources({
  jobId,
  expenses,
  labor,
  options,
  onChanged,
}: {
  jobId: string;
  expenses: JobExpense[];
  labor: AccountingLabor[];
  options?: JobAccountingOptions;
  onChanged: () => Promise<unknown>;
}) {
  const files = useOperation<{ documents: { id: string; name: string }[] }>(
    `/jobs/${jobId}/files`,
    ["owner"],
  );
  const [form, setForm] = useState(blankExpense);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<JobExpense>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestKey = useRef(crypto.randomUUID());
  const amountCents = moneyInputCents(form.amount),
    taxCents = moneyInputCents(form.tax);
  const valid =
    ["paid_purchase", "contractor_bill"].includes(form.kind) &&
    ["materials", "labor", "other"].includes(form.category) &&
    form.description.trim() &&
    form.vendorName.trim() &&
    form.transactionDate &&
    form.currency === "USD" &&
    form.reference.trim() &&
    amountCents !== null &&
    amountCents > 0 &&
    taxCents !== null &&
    taxCents <= amountCents &&
    files.data?.documents.some((doc) => doc.id === form.receiptDocumentId) &&
    (form.kind !== "contractor_bill" ||
      (form.dueDate && form.relatedLaborEntryId));
  function close() {
    setOpen(false);
    setEditing(undefined);
    setForm(blankExpense());
    requestKey.current = crypto.randomUUID();
    setError("");
  }
  function edit(expense: JobExpense) {
    setEditing(expense);
    setForm({
      kind: expense.kind,
      description: expense.description,
      category: expense.category,
      vendorName: expense.vendorName,
      transactionDate: expense.transactionDate,
      dueDate: expense.dueDate ?? "",
      relatedLaborEntryId:
        expense.relatedLaborEntryId ??
        (expense.kind === "contractor_bill" ? "additional" : ""),
      currency: expense.currency,
      amount: (expense.amountCents / 100).toFixed(2),
      tax: (expense.taxCents / 100).toFixed(2),
      receiptDocumentId: expense.receiptDocumentId,
      reference: expense.reference,
      notes: expense.notes ?? "",
    });
    setError("");
    setOpen(true);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !valid) return;
    setBusy(true);
    setError("");
    const body = {
      kind: form.kind,
      description: form.description.trim(),
      category: form.category,
      vendorName: form.vendorName.trim(),
      transactionDate: form.transactionDate,
      dueDate: form.kind === "contractor_bill" ? form.dueDate : null,
      relatedLaborEntryId:
        form.kind === "contractor_bill" &&
        form.relatedLaborEntryId !== "additional"
          ? form.relatedLaborEntryId
          : null,
      currency: form.currency,
      amountCents,
      taxCents,
      receiptDocumentId: form.receiptDocumentId,
      reference: form.reference.trim(),
      notes: form.notes.trim(),
    };
    try {
      await operation(
        `/jobs/${jobId}/expenses${editing ? `/${editing.id}` : ""}`,
        editing ? "PATCH" : "POST",
        {
          ...body,
          ...(editing
            ? { revision: editing.revision }
            : { requestKey: requestKey.current }),
        },
      );
      await onChanged();
      close();
    } catch (cause) {
      setError(message(cause));
      await onChanged();
    } finally {
      setBusy(false);
    }
  }
  const field = (label: string, key: keyof typeof form, type = "text") => (
    <label className="block space-y-1 text-sm">
      {label}
      <Input
        type={type}
        value={form[key]}
        onChange={(event) => setForm({ ...form, [key]: event.target.value })}
        {...(key === "reference" ? { maxLength: 21 } : {})}
      />
    </label>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Receipt-backed expenses</CardTitle>
        <CardDescription>
          These costs are added once to job actuals, separately from stock
          issues and manual miscellaneous cost. Use a receipt that has not
          already been recorded in materials or another expense.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!open && (
          <Button
            variant="outline"
            onClick={() => {
              setForm(blankExpense());
              setEditing(undefined);
              setOpen(true);
              void files.refetch();
            }}
          >
            Record receipt-backed expense
          </Button>
        )}
        {open && (
          <form
            onSubmit={(event) => void save(event)}
            className="space-y-3 rounded-md border p-3"
          >
            <fieldset disabled={busy} className="space-y-3">
              <label className="block space-y-1 text-sm">
                Expense type
                <select
                  className={inventorySelect}
                  value={form.kind}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      kind: event.target.value,
                      category:
                        event.target.value === "contractor_bill" ? "labor" : "",
                      dueDate: "",
                    })
                  }
                >
                  <option value="">
                    Choose paid purchase or unpaid contractor bill
                  </option>
                  <option value="paid_purchase">Already paid purchase</option>
                  <option value="contractor_bill">
                    Unpaid contractor labor bill
                  </option>
                </select>
              </label>
              {field("Description", "description")}
              {field("Vendor on receipt", "vendorName")}
              <label className="block space-y-1 text-sm">
                Cost category
                <select
                  className={inventorySelect}
                  value={form.category}
                  onChange={(event) =>
                    setForm({ ...form, category: event.target.value })
                  }
                >
                  {form.kind !== "contractor_bill" && (
                    <>
                      <option value="">Choose the recorded job cost</option>
                      <option value="other">Other job expense</option>
                      <option value="materials">Non-stock materials</option>
                    </>
                  )}
                  <option value="labor">Contract labor</option>
                </select>
              </label>
              {field("Transaction date", "transactionDate", "date")}
              {form.kind === "contractor_bill" &&
                field("Bill due date", "dueDate", "date")}
              {form.kind === "contractor_bill" && (
                <label className="block space-y-1 text-sm">
                  Relationship to recorded labor
                  <select
                    className={inventorySelect}
                    value={form.relatedLaborEntryId}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        relatedLaborEntryId: event.target.value,
                      })
                    }
                  >
                    <option value="">
                      Choose how this bill affects recorded labor
                    </option>
                    <option value="additional">
                      Additional cost, separate from every recorded time entry
                    </option>
                    {labor
                      .filter(
                        (entry) =>
                          entry.workerType === "Vendor" &&
                          entry.singleWorkerConfirmed &&
                          entry.workerName === form.vendorName.trim() &&
                          ["unreviewed", "rejected", "cancelled"].includes(
                            entry.exportState,
                          ),
                      )
                      .map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          Replace {entry.workerName} · {entry.date} ·{" "}
                          {entry.hours} hours
                        </option>
                      ))}
                  </select>
                  <span className="block text-xs text-muted-foreground">
                    A linked contractor bill replaces that entry's local hourly
                    cost so it is counted once. Only individually confirmed time
                    for the same vendor is eligible.
                  </span>
                </label>
              )}
              <label className="block space-y-1 text-sm">
                Receipt currency
                <select
                  className={inventorySelect}
                  value={form.currency}
                  onChange={(event) =>
                    setForm({ ...form, currency: event.target.value })
                  }
                >
                  <option value="">Confirm receipt currency</option>
                  <option value="USD">USD — US dollar</option>
                </select>
              </label>
              {field("Gross receipt amount (USD)", "amount")}
              {field(
                "Tax included in receipt amount (USD; enter 0 if none)",
                "tax",
              )}
              {field("Receipt or bill reference", "reference")}
              <label className="block space-y-1 text-sm">
                Receipt document
                <select
                  className={inventorySelect}
                  value={form.receiptDocumentId}
                  onChange={(event) =>
                    setForm({ ...form, receiptDocumentId: event.target.value })
                  }
                >
                  <option value="">Select a document from this job</option>
                  {files.data?.documents.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-muted-foreground">
                Upload the receipt in Job files first, then refresh documents.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void files.refetch()}
              >
                Refresh receipt documents
              </Button>
              {files.isError && (
                <p role="alert">
                  Receipt documents could not load. Refresh before saving.
                </p>
              )}
              {field("Expense notes", "notes")}
              <div className="flex gap-2">
                <Button type="submit" disabled={!valid || files.isError}>
                  {busy
                    ? "Saving…"
                    : editing
                      ? "Save expense changes"
                      : "Save receipt expense"}
                </Button>
                <Button type="button" variant="outline" onClick={close}>
                  Cancel expense
                </Button>
              </div>
            </fieldset>
          </form>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {expenses.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No receipt-backed expenses recorded.
          </p>
        )}
        {expenses.map((expense) => (
          <div
            key={`${expense.id}:${expense.revision}`}
            className="space-y-3 rounded-md border p-3 text-sm"
          >
            <p className="font-medium">
              {expense.description} · {currency(expense.amountCents / 100)} USD
            </p>
            <p>
              {expense.vendorName} · {expense.transactionDate} ·{" "}
              {expense.kind === "paid_purchase"
                ? "Already paid"
                : "Unpaid bill"}{" "}
              · {jobExportLabel(expense.exportState)}
            </p>
            {expenseReceiptHref(expense.receiptUrl) && (
              <a
                className="underline"
                href={expenseReceiptHref(expense.receiptUrl)!}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open receipt · {expense.receiptName}
              </a>
            )}
            {["unreviewed", "rejected", "cancelled"].includes(
              expense.exportState,
            ) && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => edit(expense)}
              >
                Edit receipt expense
              </Button>
            )}
            {options && (
              <JobCostExportReview
                kind="expense"
                source={expense}
                options={options}
                onChanged={onChanged}
              />
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
