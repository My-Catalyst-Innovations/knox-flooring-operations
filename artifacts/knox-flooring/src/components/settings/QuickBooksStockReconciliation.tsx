import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
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
import {
  inventorySelect,
  purchaseQuantity as quantity,
} from "@/lib/purchasing";
import { businessDate } from "@/lib/reporting";
import { InventoryAccountingCases } from "./InventoryAccountingCases";

const path = "/quickbooks/stock-reconciliation";
const selectClass = `mt-1 ${inventorySelect}`;
const readPageSize = 50;

type StockRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  itemId: string | null;
  warehouseOnHand: number;
  inTransit: number;
  localOnHand: number;
  quickBooksOnHand: number | null;
  difference: number | null;
  status: "unmapped" | "unverified" | "matched" | "different";
};

type Comparison = {
  rows: StockRow[];
  connectionId: string;
  realmId: string;
  company: string;
  environment: string;
  adjustmentEnabled: boolean;
  observedAt: string;
};

type Choice = {
  productId: string;
  returnId: string;
  invoiceId: string;
  billId: string;
  accountId: string;
  date: string;
  connectionId: string;
};

type Approval = { choice: Choice; fingerprint: string };
type AdjustmentResult = {
  adjustmentId: string;
  recovered: boolean;
  observed: number | null;
  target: number;
  balanceMatches: boolean;
};
type Attempt = {
  status: string;
  lastError?: string | null;
  result?: AdjustmentResult | null;
  submitted: boolean;
  choice?: Choice | null;
  fingerprint?: string | null;
  reference?: string;
  knownAdjustmentId?: string | null;
};
type ReviewOptions = {
  returns: {
    id: string;
    jobId: string;
    quantity: number;
    reason: string;
    createdAt: string;
  }[];
  invoices: { id: string; jobId: string; number: string; jobNumber: string }[];
  bills: { id: string; number: string; supplier: string }[];
  accounts: { id: string; name: string; type: string }[];
  attempts: Attempt[];
};

type Preview = {
  approved: Approval & {
    before: number;
    target: number;
    document: {
      DocNumber: string;
      TxnDate: string;
      AdjustAccountRef: { value: string };
      Line: { ItemAdjustmentLineDetail: { QtyDiff: number } }[];
    };
  };
  evidence: {
    receiptId: string;
    receiptReference: string | null;
    orderNumber: string;
    received: number;
    billId: string;
    billNumber: string;
    invoiceId: string;
    invoiceNumber: string;
    jobNumber: string;
    issued: number;
    returned: number;
    returnReason: string;
    local: number;
    itemId: string;
    account: { Id: string; Name: string; AccountType: string };
    offering: string;
  };
};

const statuses: Record<StockRow["status"], string> = {
  matched: "Matched",
  different: "Difference",
  unmapped: "No mapped item",
  unverified: "Quantity unavailable",
};

const displayQuantity = (value: number | null) =>
  value === null ? "—" : quantity(value);
const displayDate = (value: string) =>
  Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : value;
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Could not complete the QuickBooks request.";

function AdjustmentOutcome({ result }: { result: AdjustmentResult }) {
  return (
    <div role="status" className="rounded-md border p-3 text-sm">
      <p className="font-medium">
        {result.recovered
          ? "Existing QuickBooks adjustment"
          : "QuickBooks adjustment"}{" "}
        {result.adjustmentId}
      </p>
      <p>
        {result.balanceMatches
          ? `Verified balance of ${quantity(result.target)} matches the approved quantity.`
          : `Approved target ${quantity(result.target)} · ${result.observed === null ? "Current QuickBooks balance unavailable" : `Current QuickBooks balance ${quantity(result.observed)}`}. Refresh the comparison before any further correction.`}
      </p>
    </div>
  );
}

function RecheckAdjustment({
  knownId,
  busy,
  onRecheck,
}: {
  knownId?: string;
  busy: boolean;
  onRecheck: (id?: string) => void;
}) {
  const [id, setId] = useState("");
  return (
    <div className="mt-2 space-y-2">
      {!knownId && (
        <label className="block max-w-xs">
          QuickBooks adjustment ID (optional)
          <Input
            className="mt-1"
            value={id}
            onChange={(event) => setId(event.target.value.trim())}
            inputMode="numeric"
            disabled={busy}
          />
        </label>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy || (id.length > 0 && !/^\d+$/.test(id))}
        onClick={() => onRecheck(id || undefined)}
      >
        Recheck prior submission
      </Button>
    </div>
  );
}

function ReturnReview({
  row,
  comparison,
  onClose,
}: {
  row: StockRow;
  comparison: Comparison;
  onClose: () => void;
}) {
  const detailPath = `${path}/${encodeURIComponent(row.productId)}`;
  const [options, setOptions] = useState<ReviewOptions>();
  const [choice, setChoice] = useState<Choice>({
    productId: row.productId,
    returnId: "",
    invoiceId: "",
    billId: "",
    accountId: "",
    date: businessDate(),
    connectionId: comparison.connectionId,
  });
  const [preview, setPreview] = useState<Preview>();
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<AdjustmentResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const pending = useRef(false);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: "start" });
    let mounted = true;
    operation<ReviewOptions>(detailPath)
      .then((data) => {
        if (mounted) setOptions(data);
      })
      .catch((failure) => {
        if (mounted) setError(errorText(failure));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [detailPath]);

  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const update = (values: Partial<Choice>) => {
    setChoice((current) => ({ ...current, ...values }));
    setPreview(undefined);
    setConfirm(false);
    setResult(undefined);
    setError("");
  };

  const previewReturn = () =>
    run(async () => {
      setResult(undefined);
      const reviewed = await operation<Preview>(
        `${path}/preview`,
        "POST",
        choice,
      );
      if (
        (Object.keys(choice) as (keyof Choice)[]).some(
          (field) => reviewed.approved.choice[field] !== choice[field],
        )
      ) {
        throw new Error(
          "The preview no longer matches the selected records. Refresh the comparison and review again.",
        );
      }
      setPreview(reviewed);
    });

  const approve = (proof: Approval, adjustmentId?: string) =>
    run(async () => {
      setPreview(undefined);
      setConfirm(false);
      setResult(undefined);
      try {
        setResult(
          await operation<AdjustmentResult>(`${path}/approve`, "POST", {
            choice: proof.choice,
            fingerprint: proof.fingerprint,
            ...(adjustmentId ? { adjustmentId } : {}),
          }),
        );
      } finally {
        try {
          setOptions(await operation<ReviewOptions>(detailPath));
        } catch {
          setOptions(undefined);
        }
      }
    });

  const returnEntry = options?.returns.find(({ id }) => id === choice.returnId);
  const invoices =
    options?.invoices.filter(({ jobId }) => jobId === returnEntry?.jobId) ?? [];
  const canReview = Boolean(
    choice.returnId &&
    choice.invoiceId &&
    choice.billId &&
    choice.accountId &&
    choice.date,
  );
  const nextDelta =
    preview?.approved.document.Line[0]?.ItemAdjustmentLineDetail.QtyDiff;

  return (
    <section
      ref={panel}
      className="scroll-mt-4 space-y-3 rounded-lg border p-4 text-sm"
      aria-label={`Review return for ${row.sku}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="font-semibold">Review returned stock for {row.sku}</h4>
          <p className="text-muted-foreground">
            {comparison.company} · {comparison.environment} · company{" "}
            {comparison.realmId}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onClose}
        >
          Close review
        </Button>
      </div>
      {loading && (
        <p role="status">Loading saved returns and QuickBooks evidence…</p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {result && <AdjustmentOutcome result={result} />}
      {!loading && !options && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(async () =>
              setOptions(await operation<ReviewOptions>(detailPath)),
            )
          }
        >
          Reload review records
        </Button>
      )}
      {options && (
        <>
          {options.attempts.length > 0 && (
            <div className="space-y-2">
              <p className="font-medium">Adjustment history</p>
              {options.attempts.map((attempt, index) => {
                const { choice: storedChoice, fingerprint } = attempt;
                const recheckable =
                  attempt.submitted &&
                  ["failed", "processing"].includes(attempt.status);
                const knownId =
                  attempt.knownAdjustmentId ?? attempt.result?.adjustmentId;
                return (
                  <div
                    className="rounded-md border p-2"
                    key={fingerprint ?? index}
                  >
                    <p>
                      {attempt.status.replaceAll("_", " ")}
                      {knownId && ` · QuickBooks adjustment ${knownId}`}
                    </p>
                    {attempt.reference && (
                      <p className="text-xs text-muted-foreground">
                        QuickBooks reference {attempt.reference}
                      </p>
                    )}
                    {attempt.lastError && (
                      <p className="text-xs text-muted-foreground">
                        {attempt.lastError}
                      </p>
                    )}
                    {recheckable && storedChoice && fingerprint && (
                      <RecheckAdjustment
                        knownId={knownId}
                        busy={busy}
                        onRecheck={(id) =>
                          void approve(
                            { choice: storedChoice, fingerprint },
                            id,
                          )
                        }
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!options.returns.length ? (
            <p className="text-muted-foreground">
              No recorded job returns are eligible for review.
            </p>
          ) : (
            <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
              <label>
                Recorded job return
                <select
                  className={selectClass}
                  value={choice.returnId}
                  onChange={(event) =>
                    update({ returnId: event.target.value, invoiceId: "" })
                  }
                >
                  <option value="">Choose a recorded return</option>
                  {options.returns.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {quantity(entry.quantity)} {row.unit} · {entry.reason} ·{" "}
                      {displayDate(entry.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Customer invoice
                <select
                  className={selectClass}
                  value={choice.invoiceId}
                  disabled={!returnEntry || !invoices.length}
                  onChange={(event) =>
                    update({ invoiceId: event.target.value })
                  }
                >
                  <option value="">
                    {returnEntry && !invoices.length
                      ? "No invoice for this job"
                      : "Choose a customer invoice"}
                  </option>
                  {invoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.number} · {invoice.jobNumber}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Supplier bill
                <select
                  className={selectClass}
                  value={choice.billId}
                  onChange={(event) => update({ billId: event.target.value })}
                >
                  <option value="">
                    {options.bills.length
                      ? "Choose a supplier bill"
                      : "No synced supplier bills"}
                  </option>
                  {options.bills.map((bill) => (
                    <option key={bill.id} value={bill.id}>
                      {bill.number} · {bill.supplier}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                QuickBooks adjustment account
                <select
                  className={selectClass}
                  value={choice.accountId}
                  onChange={(event) =>
                    update({ accountId: event.target.value })
                  }
                >
                  <option value="">
                    {options.accounts.length
                      ? "Choose an account"
                      : "No eligible adjustment accounts"}
                  </option>
                  {options.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} · {account.type}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Posting date
                <Input
                  className="mt-1"
                  type="date"
                  value={choice.date}
                  onChange={(event) => update({ date: event.target.value })}
                />
              </label>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canReview || busy}
                  onClick={() => void previewReturn()}
                >
                  Preview stock adjustment
                </Button>
              </div>
            </fieldset>
          )}
        </>
      )}
      {preview && nextDelta !== undefined && (
        <div className="space-y-3 rounded-md border bg-muted/40 p-3">
          <p className="font-medium">
            {preview.evidence.offering} · adjustment{" "}
            {preview.approved.document.DocNumber}
          </p>
          <dl className="grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">QuickBooks item</dt>
              <dd>
                {preview.evidence.itemId} · {row.sku}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Posting date</dt>
              <dd>{preview.approved.document.TxnDate}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">On hand</dt>
              <dd>
                {quantity(preview.approved.before)} →{" "}
                {quantity(preview.approved.target)} {row.unit} · Add{" "}
                {quantity(nextDelta)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Adjustment account</dt>
              <dd>
                {preview.evidence.account.Name} ·{" "}
                {preview.evidence.account.AccountType} ·{" "}
                {preview.evidence.account.Id}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Purchase and receipt</dt>
              <dd>
                {preview.evidence.orderNumber} ·{" "}
                {preview.evidence.receiptReference ||
                  preview.evidence.receiptId}{" "}
                · {quantity(preview.evidence.received)} {row.unit}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Supplier bill</dt>
              <dd>{preview.evidence.billNumber}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Customer invoice</dt>
              <dd>
                <Link
                  className="text-primary hover:underline"
                  href={`/invoices?invoice=${encodeURIComponent(preview.evidence.invoiceId)}`}
                >
                  {preview.evidence.invoiceNumber} ·{" "}
                  {preview.evidence.jobNumber}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Job quantities</dt>
              <dd>
                Issued {quantity(preview.evidence.issued)} · Returned{" "}
                {quantity(preview.evidence.returned)} · Current Catalyst stock{" "}
                {quantity(preview.evidence.local)} {row.unit}
              </dd>
            </div>
          </dl>
          <p>{preview.evidence.returnReason}</p>
          <label className="flex items-start gap-2">
            <input
              className="mt-1"
              type="checkbox"
              checked={confirm}
              disabled={busy}
              onChange={(event) => setConfirm(event.target.checked)}
            />
            I approve this quantity adjustment in the displayed QuickBooks
            company.
          </label>
          <Button
            type="button"
            disabled={!confirm || busy}
            onClick={() => void approve(preview.approved)}
          >
            Approve stock adjustment
          </Button>
        </div>
      )}
    </section>
  );
}

export function QuickBooksStockReconciliation({
  realmId,
  environment,
}: {
  realmId: string;
  environment: string;
}) {
  const [comparison, setComparison] = useState<Comparison>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(readPageSize);
  const [reviewing, setReviewing] = useState<string>();
  const [accountingReview, setAccountingReview] = useState<string>();
  const pending = useRef(false);

  const load = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setComparison(undefined);
    try {
      const data = await operation<Comparison>(path);
      if (data.realmId !== realmId || data.environment !== environment)
        throw new Error(
          "The connected QuickBooks company changed. Reopen QuickBooks settings and compare again.",
        );
      setComparison(data);
      setLimit(readPageSize);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const query = search.trim().toLowerCase();
  const rows =
    comparison?.rows.filter((row) =>
      [row.sku, row.name, row.itemId].some((value) =>
        value?.toLowerCase().includes(query),
      ),
    ) ?? [];
  const selected = comparison?.rows.find(
    ({ productId }) => productId === reviewing,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>QuickBooks stock reconciliation</CardTitle>
        <CardDescription>
          Compare stock across all warehouses and in transit with the mapped
          QuickBooks inventory item.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          type="button"
          variant="outline"
          disabled={busy || Boolean(selected) || Boolean(accountingReview)}
          onClick={() => void load()}
        >
          {busy
            ? "Reading QuickBooks…"
            : comparison
              ? "Refresh quantities"
              : "Compare stock"}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {comparison && (
          <>
            <p className="text-xs text-muted-foreground">
              {comparison.company} · {comparison.environment} · Checked{" "}
              {displayDate(comparison.observedAt)}. Difference is Catalyst total
              less QuickBooks on hand.
            </p>
            {!comparison.adjustmentEnabled && (
              <p className="text-xs text-muted-foreground">
                Return adjustments are disabled for this QuickBooks company.
              </p>
            )}
            <Input
              className="max-w-sm"
              aria-label="Search stock comparison"
              placeholder="Search SKU, product, or QuickBooks item"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(readPageSize);
              }}
            />
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No stocked products match this search.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[730px] text-sm">
                  <caption className="sr-only">
                    Catalyst and QuickBooks stock comparison
                  </caption>
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      {[
                        "SKU and product",
                        "In warehouses",
                        "In transit",
                        "Catalyst total",
                        "QuickBooks",
                        "Difference",
                        "Status",
                      ].map((heading, index) => (
                        <th
                          key={heading}
                          scope="col"
                          className={
                            index === 0 ? "p-2 text-left" : "p-2 text-right"
                          }
                        >
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, limit).map((row) => (
                      <tr key={row.productId} className="border-b tabular-nums">
                        <th
                          scope="row"
                          className="min-w-36 p-2 text-left font-medium"
                        >
                          {row.sku}
                          <span className="block text-xs font-normal text-muted-foreground">
                            {row.name} · {row.unit}
                            {row.itemId && ` · Item ${row.itemId}`}
                          </span>
                        </th>
                        {[
                          row.warehouseOnHand,
                          row.inTransit,
                          row.localOnHand,
                          row.quickBooksOnHand,
                          row.difference,
                        ].map((value, index) => (
                          <td key={index} className="p-2 text-right">
                            {displayQuantity(value)}
                          </td>
                        ))}
                        <td className="space-y-1 p-2 text-right">
                          <Badge
                            variant={
                              row.status === "matched" ? "secondary" : "outline"
                            }
                          >
                            {statuses[row.status]}
                          </Badge>
                          {comparison.adjustmentEnabled && row.itemId && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="ml-auto block"
                              aria-label={`Review returned stock for ${row.sku}`}
                              disabled={Boolean(selected) || Boolean(accountingReview)}
                              onClick={() => setReviewing(row.productId)}
                            >
                              Review return
                            </Button>
                          )}
                          <Button type="button" variant="ghost" size="sm" className="ml-auto block" disabled={Boolean(selected) || Boolean(accountingReview)} onClick={() => setAccountingReview(row.productId)} aria-label={`Accounting cases for ${row.sku}`}>Accounting cases</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rows.length > limit && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setLimit((current) => current + readPageSize)}
              >
                Show more products
              </Button>
            )}
            {selected && (
              <ReturnReview
                key={selected.productId}
                row={selected}
                comparison={comparison}
                onClose={() => setReviewing(undefined)}
              />
            )}
            {accountingReview && <div className="space-y-2"><Button type="button" variant="outline" onClick={() => setAccountingReview(undefined)}>Close accounting cases</Button><InventoryAccountingCases key={accountingReview} productId={accountingReview} /></div>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
