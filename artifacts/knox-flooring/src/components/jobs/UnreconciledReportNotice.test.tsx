import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { UnreconciledReportNotice } from "./UnreconciledReportNotice";
import { importedJob } from "@/test/active-job-fixtures";
afterEach(cleanup);
it("reports excluded unknowns while permitting an explicitly reviewed zero forecast", () => {
  const current = structuredClone(importedJob),
    reviewed = current.migrationCutover!;
  reviewed.forecastReportsEligible = true;
  reviewed.financial = {
    ...reviewed.financial,
    status: "context_reviewed",
    current: true,
    fullJobRevenueCents: 0,
    fullJobLaborForecastCents: 0,
    fullJobMaterialForecastCents: 0,
    fullJobOtherForecastCents: 0,
  };
  const { rerender } = render(
    <UnreconciledReportNotice jobs={[importedJob, current]} />,
  );
  expect(screen.getByRole("note")).toHaveTextContent(
    "1 job(s) excluded from financial forecast totals",
  );
  rerender(
    <UnreconciledReportNotice
      jobs={[importedJob, current]}
      kind="commission"
    />,
  );
  expect(screen.getByRole("note")).toHaveTextContent(
    "2 job(s) excluded from commission",
  );
});
