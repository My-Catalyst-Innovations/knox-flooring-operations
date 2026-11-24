import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { actualProfitEligible, computeCosting, fmtPercent, jobCostingGaps } from "@/lib/costing";
import { recordedJobDate } from "@/lib/reporting";
import type { Job, Proposal } from "@/lib/types";

const percent = (value: number) => `${value.toFixed(1)}%`;

export function ClosedJobMargins({
  jobs,
  proposals,
}: {
  jobs: readonly Job[];
  proposals: readonly Proposal[];
}) {
  const acceptedByJob = new Map<string, Proposal[]>();
  for (const quote of proposals) {
    const jobId = quote.convertedJobId ?? quote.jobId;
    if (!jobId || quote.status !== "Accepted" || !quote.acceptedAt) continue;
    const prior = acceptedByJob.get(jobId) ?? [];
    prior.push(quote);
    acceptedByJob.set(jobId, prior);
  }
  const recorded = jobs.filter(
    actualProfitEligible,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Quoted and recorded margin</CardTitle>
        <p className="text-xs text-muted-foreground">
          Closed jobs in the report period with recorded revenue. Quoted margin
          comes from a single accepted estimate.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {recorded.length > 0 ? (
          <table className="w-full">
            <caption className="sr-only">
              Margin on closed jobs with recorded revenue
            </caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="pb-2 text-left">
                  Job
                </th>
                <th scope="col" className="pb-2 text-right">
                  Quoted
                </th>
                <th scope="col" className="pb-2 text-right">
                  Recorded
                </th>
              </tr>
            </thead>
            <tbody>
              {recorded.map((job) => {
                const completedAt = Date.parse(
                  recordedJobDate(job, "completed") ?? "",
                );
                const quotes = (acceptedByJob.get(job.id) ?? []).filter(
                  (quote) => Date.parse(quote.acceptedAt ?? "") <= completedAt,
                );
                const quote = quotes.length === 1 ? quotes[0] : undefined;
                const snapshot = quote?.estimateSnapshot;
                const quotedMargin =
                  quote &&
                  snapshot?.valid &&
                  Number.isFinite(snapshot.marginPercent) &&
                  snapshot.sellingPrice > 0 &&
                  Math.abs(snapshot.sellingPrice - quote.estimatedPrice) <= 0.01
                    ? percent(snapshot.marginPercent)
                    : "Unknown";
                const current = computeCosting(job);
                const gaps = jobCostingGaps(job);
                return (
                  <tr key={job.id} className="border-t">
                    <th scope="row" className="py-2 pr-2 text-left font-medium">
                      <Link
                        href={`/jobs/${encodeURIComponent(job.id)}`}
                        className="text-primary hover:underline"
                      >
                        {job.jobNumber}
                      </Link>
                    </th>
                    <td className="px-2 text-right tabular-nums">
                      {quotedMargin}
                    </td>
                    <td className="text-right tabular-nums">
                      <span>{fmtPercent(current.actualMarginPct)}</span>
                      {gaps.length > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          Provisional · {gaps.join(", ")}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p>No closed jobs with recorded revenue in this period.</p>
        )}
        {recorded.length < jobs.length && (
          <p className="text-xs text-muted-foreground">
            {jobs.length - recorded.length} closed jobs have unreconciled full-job
            revenue or costs and are excluded from recorded margin.
          </p>
        )}
        {recorded.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Recorded margins use costs entered so far. Provisional figures have
            unconfirmed labor or material costs.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
