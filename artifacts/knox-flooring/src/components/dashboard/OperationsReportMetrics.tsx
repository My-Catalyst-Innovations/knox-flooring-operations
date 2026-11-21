import { Link } from "wouter";
import type { OperationalMetrics } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { currency } from "@/lib/operations";

const agingLabels = {
  current: "Current",
  pastDue1To30: "1–30 days overdue",
  pastDue31To60: "31–60 days overdue",
  pastDue61To90: "61–90 days overdue",
  pastDue91Plus: "91+ days overdue",
  unknown: "Due date unknown",
};

const activityRows = [
  ["movements", "All movement entries"],
  ["receipts", "Receipts"],
  ["issued", "Issues to jobs"],
  ["returns", "Returns"],
  ["transfers", "Warehouse transfer entries"],
  ["binMoves", "Bin transfer entries"],
  ["adjustments", "Adjustments"],
  ["other", "Other entries"],
] as const;

function CompletionRate({
  label,
  onTime,
  late,
}: {
  label: string;
  onTime: number;
  late: number;
}) {
  const total = onTime + late;
  return (
    <div className="flex items-start justify-between gap-3 border-b py-2">
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">
          {total ? `${onTime} on time · ${late} late` : "No comparable records"}
        </p>
      </div>
      <span className="whitespace-nowrap font-semibold tabular-nums">
        {total
          ? (onTime / total).toLocaleString("en-US", {
              style: "percent",
              maximumFractionDigits: 1,
            })
          : "—"}
      </span>
    </div>
  );
}

export function OperationsReportMetrics({
  metrics,
}: {
  metrics: Pick<
    OperationalMetrics,
    | "asOfDate"
    | "invoiceAging"
    | "inventoryActivity"
    | "completionTimeliness"
    | "missingCompletionDates"
    | "stockAudit"
    | "installationReadiness"
  >;
}) {
  const {
    asOfDate,
    invoiceAging,
    inventoryActivity,
    completionTimeliness,
    stockAudit,
    installationReadiness,
  } = metrics;
  const countAccuracy =
    stockAudit.checked > 0
      ? (stockAudit.matched / stockAudit.checked).toLocaleString("en-US", {
          style: "percent",
          maximumFractionDigits: 1,
        })
      : "—";
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoice aging</CardTitle>
          <p className="text-xs text-muted-foreground">
            Open balances by due date as of {asOfDate}.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <table className="w-full text-sm">
            <caption className="sr-only">Open invoices by due date</caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="pb-2 text-left">
                  Due date
                </th>
                <th scope="col" className="pb-2 text-right">
                  Count
                </th>
                <th scope="col" className="pb-2 text-right">
                  Balance
                </th>
              </tr>
            </thead>
            <tbody>
              {invoiceAging.map(({ band, invoiceCount, balance }) => (
                <tr key={band} className="border-t">
                  <th scope="row" className="py-2 pr-2 text-left font-normal">
                    {agingLabels[band]}
                  </th>
                  <td className="px-1 text-right tabular-nums">
                    {invoiceCount}
                  </td>
                  <td className="text-right tabular-nums">
                    {currency(balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Link
            href="/invoices"
            className="text-xs font-medium text-primary hover:underline"
          >
            Open invoices
          </Link>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Inventory activity</CardTitle>
          <p className="text-xs text-muted-foreground">
            Rolling windows through {asOfDate}. Transfer entries count each
            recorded leg.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Inventory movement entries by type and window
            </caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="pb-2 text-left">
                  Entry
                </th>
                {inventoryActivity.map(({ days }) => (
                  <th key={days} scope="col" className="pb-2 text-right">
                    {days}d
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activityRows.map(([key, label]) => (
                <tr key={key} className="border-t">
                  <th scope="row" className="py-2 pr-2 text-left font-normal">
                    {label}
                  </th>
                  {inventoryActivity.map((window) => (
                    <td
                      key={window.days}
                      className="px-1 text-right tabular-nums"
                    >
                      {window[key].toLocaleString()}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <Link
            href="/inventory"
            className="text-xs font-medium text-primary hover:underline"
          >
            Open inventory
          </Link>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">On-time completion</CardTitle>
          <p className="text-xs text-muted-foreground">
            Jobs completed in the selected report period.
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <CompletionRate
            label="Against committed dates"
            {...completionTimeliness.committed}
          />
          <CompletionRate
            label="Estimated date only"
            {...completionTimeliness.estimated}
          />
          <p>
            {completionTimeliness.unknown} without a usable completion target
          </p>
          {metrics.missingCompletionDates > 0 && (
            <p className="text-xs text-muted-foreground">
              {metrics.missingCompletionDates}{" "}
              {metrics.missingCompletionDates === 1
                ? "completed job has"
                : "completed jobs have"}{" "}
              no recorded completion date and cannot be assigned to a period.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Record customer commitments in Job Details before completion.
            Current estimates can change.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Installation readiness</CardTitle>
          <p className="text-xs text-muted-foreground">
            Upcoming installations and unconfirmed plans through{" "}
            {installationReadiness.through}.
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <dl className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <dt>Confirmed crew and usable materials</dt>
              <dd className="font-semibold tabular-nums">
                {installationReadiness.ready}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt>Materials need attention</dt>
              <dd className="font-semibold tabular-nums">
                {installationReadiness.materialsNeedAttention}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt>Crew needs confirmation</dt>
              <dd className="font-semibold tabular-nums">
                {installationReadiness.needsCrew}
              </dd>
            </div>
          </dl>
          <Link
            href="/calendar"
            className="text-xs font-medium text-primary hover:underline"
          >
            Open schedule
          </Link>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stock count accuracy</CardTitle>
          <p className="text-xs text-muted-foreground">
            Physical counts posted in the selected report period.
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-2xl font-semibold tabular-nums">{countAccuracy}</p>
          <p>
            {stockAudit.checked > 0
              ? `${stockAudit.matched} of ${stockAudit.checked} posted counts matched the book quantity.`
              : "No posted physical counts in this period."}
          </p>
          <Link
            href="/inventory"
            className="text-xs font-medium text-primary hover:underline"
          >
            Open inventory
          </Link>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reviewed product waste</CardTitle>
          <p className="text-xs text-muted-foreground">
            Waste posted in the selected report period, by stocked unit.
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {stockAudit.waste.length ? (
            <table className="w-full">
              <caption className="sr-only">
                Posted waste by product and unit
              </caption>
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="pb-2 text-left">
                    Product
                  </th>
                  <th scope="col" className="pb-2 text-right">
                    Quantity
                  </th>
                </tr>
              </thead>
              <tbody>
                {stockAudit.waste.map(
                  ({
                    productId,
                    sku,
                    productName,
                    unit,
                    quantity,
                    entries,
                  }) => (
                    <tr
                      key={JSON.stringify([productId, sku, productName, unit])}
                      className="border-t"
                    >
                      <th
                        scope="row"
                        className="py-2 pr-2 text-left font-normal"
                      >
                        <span className="block break-words">{productName}</span>
                        <span className="text-xs text-muted-foreground">
                          {[
                            sku,
                            `${entries} ${entries === 1 ? "entry" : "entries"}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </th>
                      <td className="text-right tabular-nums">
                        {quantity.toLocaleString("en-US", {
                          maximumFractionDigits: 6,
                        })}{" "}
                        {unit}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          ) : (
            <p>No posted waste in this period.</p>
          )}
          {stockAudit.wasteByJob.length > 0 && (
            <details className="border-t pt-2">
              <summary className="cursor-pointer font-medium text-primary">
                Waste by job and crew
              </summary>
              <table className="mt-2 w-full">
                <caption className="sr-only">
                  Reviewed waste attributed by job and crew
                </caption>
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="pb-2 text-left">
                      Job and crew
                    </th>
                    <th scope="col" className="pb-2 text-right">
                      Quantity
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stockAudit.wasteByJob.map((record) => (
                    <tr
                      key={JSON.stringify([
                        record.jobId,
                        record.crewId,
                        record.unit,
                      ])}
                      className="border-t"
                    >
                      <th
                        scope="row"
                        className="py-2 pr-2 text-left font-normal"
                      >
                        {record.jobId && record.jobNumber ? (
                          <Link
                            href={`/jobs/${encodeURIComponent(record.jobId)}`}
                            className="text-primary hover:underline"
                          >
                            {record.jobNumber}
                          </Link>
                        ) : (
                          "Unassigned job"
                        )}
                        <span className="block text-xs text-muted-foreground">
                          {record.crewName ?? "Unassigned crew"} ·{" "}
                          {record.entries}{" "}
                          {record.entries === 1 ? "entry" : "entries"}
                        </span>
                      </th>
                      <td className="text-right tabular-nums">
                        {record.quantity.toLocaleString("en-US", {
                          maximumFractionDigits: 6,
                        })}{" "}
                        {record.unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
