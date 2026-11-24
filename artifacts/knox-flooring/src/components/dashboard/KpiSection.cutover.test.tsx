import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Job } from "@/lib/types";
import { importedJob } from "@/test/active-job-fixtures";
import { KpiSection } from "./KpiSection";
const state = vi.hoisted(() => ({ jobs: [] as Job[] }));
vi.mock("@/hooks/use-store", () => ({
  useStore: () => ({
    jobs: state.jobs,
    invoices: [],
    leads: [],
    salespeople: [],
    proposals: [],
  }),
}));
vi.mock("recharts", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Box,
    AreaChart: Box,
    Area: () => null,
    BarChart: Box,
    Bar: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    PieChart: Box,
    Pie: Box,
    Cell: () => null,
    CartesianGrid: () => null,
  };
});
afterEach(cleanup);
it("includes only full-job forecasts in money while retaining the real operational sold count", () => {
  const native = {
    ...structuredClone(importedJob),
    id: "native",
    migrationCutover: null,
    estRevenue: 500,
    laborEstimate: 100,
    materialEstimate: 100,
  };
  const reviewed = structuredClone(importedJob);
  reviewed.id = "reviewed";
  reviewed.migrationCutover!.forecastReportsEligible = true;
  reviewed.migrationCutover!.financial = {
    ...reviewed.migrationCutover!.financial,
    status: "context_reviewed",
    current: true,
    fullJobRevenueCents: 100000,
    fullJobLaborForecastCents: 20000,
    fullJobMaterialForecastCents: 30000,
    fullJobOtherForecastCents: 10000,
  };
  reviewed.migrationCutover!.billing.remainingCents = 100;
  const unknown = { ...structuredClone(importedJob), estRevenue: 99999 };
  state.jobs = [native, reviewed, unknown];
  render(<KpiSection />);
  expect(
    screen.getByText("Sold value (estimated)").parentElement?.parentElement,
  ).toHaveTextContent("$1,500.00");
  expect(
    screen.getByText("Jobs Sold").parentElement?.parentElement,
  ).toHaveTextContent("3");
  expect(screen.getByRole("note")).toHaveTextContent("1 job(s) excluded");
  expect(screen.queryByText("$99,999.00")).toBeNull();
  expect(screen.queryByText("$1.00")).toBeNull();
});
