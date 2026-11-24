import type { Job } from "@/lib/types";
import { commissionEligible, jobForecast } from "@/lib/costing";

export function UnreconciledReportNotice({
  jobs,
  kind = "forecast",
}: {
  jobs: readonly Job[];
  kind?: "forecast" | "commission";
}) {
  const count = jobs.filter((job) =>
    kind === "commission" ? !commissionEligible(job) : !jobForecast(job),
  ).length;
  if (!count) return null;
  return (
    <p role="note" className="rounded border bg-muted/30 p-3 text-sm">
      {count} job(s) excluded from{" "}
      {kind === "commission"
        ? "commission calculations"
        : "financial forecast totals"}
      . Imported or unreconciled amounts are unknown, not zero.
      {kind === "commission"
        ? " Imported jobs remain excluded even after forecast review."
        : " Review the full-job forecast on each imported job; its remaining billing ceiling is separate."}
    </p>
  );
}
