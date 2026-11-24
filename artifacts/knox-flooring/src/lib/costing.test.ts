import { describe, expect, it } from "vitest";
import {
  actualProfitEligible,
  commissionEligible,
  computeCommission,
  computeCosting,
  fmtMoney,
  forecastReportJobs,
  jobCostingGaps,
  jobForecast,
} from "./costing";
import { importedJob } from "@/test/active-job-fixtures";
import type { Job } from "./types";

const job = {
  estRevenue: 500,
  laborEstimate: 100,
  materialEstimate: 150,
  actualRevenue: 0,
  actualLaborCost: 0,
  actualMaterialCost: 0,
  actualAddOnCost: 0,
} as Job;

describe("tracked material costing", () => {
  it("keeps unresolved imported money unknown despite new Works costs", () => {
    const imported = structuredClone(importedJob),
      result = computeCosting(imported);
    expect(result.estRevenue).toBeNull();
    expect(result.actualCost).toBeNull();
    expect(result.actualGrossProfit).toBeNull();
    expect(result.effectiveGrossProfit).toBeNull();
    expect(result.hasActualProfit).toBe(false);
    expect(fmtMoney(result.actualRevenue)).toBe("Unreconciled");
    expect(jobForecast(imported)).toBeNull();
    expect(forecastReportJobs([job, imported])).toHaveLength(1);
    expect(commissionEligible(imported)).toBe(false);
    expect(actualProfitEligible(imported)).toBe(false);
    expect(
      computeCommission(
        imported,
        { id: "rep-1" } as never,
        { defaultCommissionRate: 10 } as never,
      ),
    ).toBeNull();
  });
  it("derives only a current full-job forecast, never remaining ceiling or actual profit", () => {
    const imported = structuredClone(importedJob),
      cutover = imported.migrationCutover!;
    cutover.financial = {
      ...cutover.financial,
      status: "context_reviewed",
      current: true,
      fullJobRevenueCents: 100000,
      fullJobLaborForecastCents: 20000,
      fullJobMaterialForecastCents: 30000,
      fullJobOtherForecastCents: 10000,
    };
    cutover.forecastReportsEligible = true;
    cutover.billing = {
      ...cutover.billing,
      current: true,
      remainingCents: 2500,
      ceilingCents: 2500,
    };
    expect(jobForecast(imported)).toMatchObject({
      revenue: 1000,
      cost: 600,
      grossProfit: 400,
    });
    expect(computeCosting(imported).actualGrossProfit).toBeNull();
    expect(forecastReportJobs([imported])[0].estRevenue).toBe(1000);
    expect(forecastReportJobs([imported])[0]).toMatchObject({
      materialEstimate: 300,
      forecastOtherCost: 100,
      estGrossProfit: 400,
    });
    expect(commissionEligible(imported)).toBe(false);
    cutover.financial.current = false;
    expect(jobForecast(imported)).toBeNull();
  });
  it("retains explicit zero full-job forecasts without treating blank or stale inputs as zero", () => {
    const imported = structuredClone(importedJob),
      cutover = imported.migrationCutover!;
    cutover.financial = {
      ...cutover.financial,
      status: "context_reviewed",
      current: true,
      fullJobRevenueCents: 0,
      fullJobLaborForecastCents: 0,
      fullJobMaterialForecastCents: 0,
      fullJobOtherForecastCents: 0,
    };
    cutover.forecastReportsEligible = true;
    expect(jobForecast(imported)?.revenue).toBe(0);
    expect(forecastReportJobs([imported])).toHaveLength(1);
    cutover.financial.fullJobOtherForecastCents = null;
    expect(jobForecast(imported)).toBeNull();
  });
  it("keeps estimate-based commission active until actual revenue is recorded", () => {
    const result = computeCosting({ ...job, trackedMaterialCost: 193 });
    expect(result.hasActuals).toBe(true);
    expect(result.hasActualProfit).toBe(false);
    expect(result.actualCost).toBe(193);
    expect(result.effectiveGrossProfit).toBe(250);
  });

  it("uses ledger returns and honors a legacy manual cost once", () => {
    const actuals = {
      ...job,
      actualRevenue: 500,
      actualLaborCost: 100,
      trackedMaterialCost: 193,
    };
    expect(computeCosting(actuals).actualGrossProfit).toBe(207);
    expect(
      computeCosting({ ...actuals, actualMaterialCost: 175 }).actualGrossProfit,
    ).toBe(225);
    expect(computeCosting({ ...job, trackedMaterialCost: 0 }).hasActuals).toBe(
      true,
    );
    expect(computeCosting(job).hasActuals).toBe(false);
  });

  it("keeps profit unavailable without revenue and flags provisional material cost", () => {
    expect(
      computeCosting({ ...job, actualLaborCost: 75, actualMaterialCost: 20 })
        .hasActualProfit,
    ).toBe(false);
    expect(
      jobCostingGaps({ ...job, actualRevenue: 500, trackedMaterialCost: 193 }),
    ).toEqual(["labor cost", "review of inventory-derived material cost"]);
    expect(
      jobCostingGaps({
        ...job,
        actualRevenue: 500,
        actualLaborCost: 100,
        actualMaterialCost: 150,
      }),
    ).toEqual([]);
  });

  it("counts reviewed labor and receipt expenses once while preserving a manual labor override", () => {
    const actuals = {
      ...job,
      actualRevenue: 1000,
      trackedLaborCost: 120,
      trackedMaterialCost: 200,
      trackedExpenseCost: 75,
      actualAddOnCost: 10,
    };
    expect(computeCosting(actuals).actualCost).toBe(405);
    expect(computeCosting(actuals).actualGrossProfit).toBe(595);
    expect(
      computeCosting({ ...actuals, actualLaborCost: 150 }).actualCost,
    ).toBe(435);
    expect(jobCostingGaps({ ...actuals, actualMaterialCost: 200 })).toEqual([]);
    expect(
      jobCostingGaps({
        ...actuals,
        actualMaterialCost: 200,
        unpricedLaborCount: 1,
      }),
    ).toEqual(["review of unpriced labor"]);
    expect(computeCosting({ ...job, trackedExpenseCost: 0 }).hasActuals).toBe(
      false,
    );
  });
});
