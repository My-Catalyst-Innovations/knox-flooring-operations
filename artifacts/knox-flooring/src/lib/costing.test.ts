import { describe, expect, it } from "vitest";
import { computeCosting, jobCostingGaps } from "./costing";
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
  it("keeps estimate-based commission active until actual revenue is recorded", () => {
    const result = computeCosting({ ...job, trackedMaterialCost: 193 });
    expect(result.hasActuals).toBe(true);
    expect(result.hasActualProfit).toBe(false);
    expect(result.actualCost).toBe(193);
    expect(result.effectiveGrossProfit).toBe(250);
  });

  it("uses ledger returns and honors a legacy manual cost once", () => {
    const actuals = { ...job, actualRevenue: 500, actualLaborCost: 100, trackedMaterialCost: 193 };
    expect(computeCosting(actuals).actualGrossProfit).toBe(207);
    expect(computeCosting({ ...actuals, actualMaterialCost: 175 }).actualGrossProfit).toBe(225);
    expect(computeCosting({ ...job, trackedMaterialCost: 0 }).hasActuals).toBe(true);
    expect(computeCosting(job).hasActuals).toBe(false);
  });

  it("keeps profit unavailable without revenue and flags provisional material cost", () => {
    expect(computeCosting({ ...job, actualLaborCost: 75, actualMaterialCost: 20 }).hasActualProfit).toBe(false);
    expect(jobCostingGaps({ ...job, actualRevenue: 500, trackedMaterialCost: 193 })).toEqual(["labor cost", "review of inventory-derived material cost"]);
    expect(jobCostingGaps({ ...job, actualRevenue: 500, actualLaborCost: 100, actualMaterialCost: 150 })).toEqual([]);
  });
});
