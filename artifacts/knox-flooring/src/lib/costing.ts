import type { Job, Salesperson, Settings } from "@/lib/types";

export interface JobCosting {
  /** Estimated figures (from the original estimate) */
  estRevenue: number | null;
  estCost: number | null;
  estGrossProfit: number | null;
  estMarginPct: number | null;
  /** Whether any actual cost/revenue has been recorded */
  hasActuals: boolean;
  hasActualProfit: boolean;
  /** Actual figures */
  actualRevenue: number | null;
  actualLaborCost: number | null;
  actualMaterialCost: number | null;
  actualAddOnCost: number | null;
  trackedExpenseCost: number;
  actualCost: number | null;
  actualGrossProfit: number | null;
  actualMarginPct: number | null;
  /** "True" figures — actual when recorded, otherwise the estimate */
  effectiveRevenue: number | null;
  effectiveGrossProfit: number | null;
  effectiveMarginPct: number | null;
  /** Variances (actual - estimate); positive cost variance = over budget */
  revenueVariance: number | null;
  costVariance: number | null;
  profitVariance: number | null;
}

const moneyKnown = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Full-job forecast, never the separate remaining-invoice ceiling. */
export function jobForecast(job: Job) {
  const cutover = job.migrationCutover;
  const source = cutover?.financial;
  const values = cutover
    ? source?.current &&
      cutover.forecastReportsEligible &&
      source.status === "context_reviewed"
      ? [
          source.fullJobRevenueCents,
          source.fullJobLaborForecastCents,
          source.fullJobMaterialForecastCents,
          source.fullJobOtherForecastCents,
        ].map((value) => (moneyKnown(value) ? value / 100 : null))
      : null
    : [job.estRevenue, job.laborEstimate, job.materialEstimate, 0];
  if (!values || !values.every(moneyKnown)) return null;
  const [revenue, labor, materials, other] = values as number[];
  const cost = labor + materials + other;
  return {
    revenue,
    labor,
    materials,
    other,
    cost,
    grossProfit: revenue - cost,
    marginPercent: revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0,
  };
}

export function forecastReportJobs(jobs: readonly Job[]) {
  return jobs.flatMap((job) => {
    const forecast = jobForecast(job);
    return forecast
      ? [
          {
            ...job,
            estRevenue: forecast.revenue,
            laborEstimate: forecast.labor,
            materialEstimate: forecast.materials,
            forecastOtherCost: forecast.other,
            estGrossProfit: forecast.grossProfit,
            grossMarginPct: forecast.marginPercent,
          },
        ]
      : [];
  });
}
export const commissionEligible = (job: Job) =>
  !job.migrationCutover && jobForecast(job) !== null;
export const actualProfitEligible = (job: Job) =>
  !job.migrationCutover && computeCosting(job).hasActualProfit;
export const fmtPercent = (value: number | null | undefined) =>
  moneyKnown(value) ? `${value.toFixed(1)}%` : "Unreconciled";
export const moneyDifference = (left: number | null, right: number | null) =>
  left === null || right === null ? null : left - right;

export function computeCosting(job: Job): JobCosting {
  if (job.migrationCutover) {
    const forecast = jobForecast(job);
    return {
      estRevenue: forecast?.revenue ?? null,
      estCost: forecast?.cost ?? null,
      estGrossProfit: forecast?.grossProfit ?? null,
      estMarginPct: forecast?.marginPercent ?? null,
      hasActuals: [
        job.trackedLaborCost,
        job.trackedMaterialCost,
        job.trackedExpenseCost,
      ].some(moneyKnown),
      hasActualProfit: false,
      actualRevenue: null,
      actualLaborCost: null,
      actualMaterialCost: null,
      actualAddOnCost: null,
      actualCost: null,
      actualGrossProfit: null,
      actualMarginPct: null,
      trackedExpenseCost: job.trackedExpenseCost ?? 0,
      effectiveRevenue: forecast?.revenue ?? null,
      effectiveGrossProfit: forecast?.grossProfit ?? null,
      effectiveMarginPct: forecast?.marginPercent ?? null,
      revenueVariance: null,
      costVariance: null,
      profitVariance: null,
    };
  }
  const estRevenue = job.estRevenue;
  const estCost =
    job.laborEstimate === null || job.materialEstimate === null
      ? null
      : job.laborEstimate + job.materialEstimate;
  const estGrossProfit = moneyDifference(estRevenue, estCost);
  const estMarginPct =
    estRevenue === null || estGrossProfit === null
      ? null
      : estRevenue > 0
        ? (estGrossProfit / estRevenue) * 100
        : 0;

  const actualRevenue = job.actualRevenue;
  const actualLaborCost =
    job.actualLaborCost === null
      ? null
      : job.actualLaborCost || job.trackedLaborCost || 0;
  const actualMaterialCost =
    job.actualMaterialCost === null
      ? null
      : job.actualMaterialCost || job.trackedMaterialCost || 0;
  const actualAddOnCost = job.actualAddOnCost;
  const trackedExpenseCost = job.trackedExpenseCost || 0;
  const actualCost =
    actualLaborCost === null ||
    actualMaterialCost === null ||
    actualAddOnCost === null
      ? null
      : actualLaborCost +
        actualMaterialCost +
        actualAddOnCost +
        trackedExpenseCost;
  const actualGrossProfit = moneyDifference(actualRevenue, actualCost);
  const actualMarginPct =
    actualRevenue === null || actualGrossProfit === null
      ? null
      : actualRevenue > 0
        ? (actualGrossProfit / actualRevenue) * 100
        : 0;

  const hasActuals =
    (actualRevenue !== null && actualRevenue > 0) ||
    (actualLaborCost !== null && actualLaborCost > 0) ||
    (actualMaterialCost !== null && actualMaterialCost > 0) ||
    job.trackedMaterialCost !== undefined ||
    (job.trackedLaborCost !== undefined && job.trackedLaborCost !== null) ||
    trackedExpenseCost > 0 ||
    (actualAddOnCost !== null && actualAddOnCost > 0);

  const effectiveRevenue =
    actualRevenue !== null && actualRevenue > 0 ? actualRevenue : estRevenue;
  const hasActualProfit =
    actualRevenue !== null && actualRevenue > 0 && actualGrossProfit !== null;
  const effectiveGrossProfit = hasActualProfit
    ? actualGrossProfit
    : estGrossProfit;
  const effectiveMarginPct =
    effectiveRevenue === null || effectiveGrossProfit === null
      ? null
      : effectiveRevenue > 0
        ? (effectiveGrossProfit / effectiveRevenue) * 100
        : 0;

  return {
    estRevenue,
    estCost,
    estGrossProfit,
    estMarginPct,
    hasActuals,
    hasActualProfit,
    actualRevenue,
    actualLaborCost,
    actualMaterialCost,
    actualAddOnCost,
    trackedExpenseCost,
    actualCost,
    actualGrossProfit,
    actualMarginPct,
    effectiveRevenue,
    effectiveGrossProfit,
    effectiveMarginPct,
    revenueVariance: moneyDifference(actualRevenue, estRevenue),
    costVariance: moneyDifference(actualCost, estCost),
    profitVariance: moneyDifference(actualGrossProfit, estGrossProfit),
  };
}

export function jobCostingGaps(
  job: Pick<
    Job,
    | "actualRevenue"
    | "actualLaborCost"
    | "trackedLaborCost"
    | "unpricedLaborCount"
    | "actualMaterialCost"
    | "trackedMaterialCost"
    | "migrationCutover"
  >,
) {
  if (job.migrationCutover)
    return [
      "legacy actual revenue and costs are unreconciled",
      ...((job.unpricedLaborCount ?? 0) > 0
        ? ["review of unpriced Works labor"]
        : []),
    ];
  return [
    (job.actualRevenue ?? 0) > 0 ? "" : "revenue",
    (job.actualLaborCost ?? 0) > 0
      ? ""
      : (job.unpricedLaborCount ?? 0) > 0
        ? "review of unpriced labor"
        : job.trackedLaborCost === undefined || job.trackedLaborCost === null
          ? "labor cost"
          : "",
    (job.actualMaterialCost ?? 0) > 0
      ? ""
      : job.trackedMaterialCost === undefined
        ? "material cost"
        : "review of inventory-derived material cost",
  ].filter(Boolean);
}

/** Effective commission rate (percent) for a rep, falling back to the global default. */
export function commissionRateFor(
  rep: Salesperson | null | undefined,
  settings: Settings,
): number {
  const override = rep?.commissionRate;
  if (override !== null && override !== undefined) return override;
  return settings.defaultCommissionRate || 0;
}

/** Per-job commission amount, driven by the configured scheme. */
export function computeCommission(
  job: Job,
  rep: Salesperson | null | undefined,
  settings: Settings,
): number | null {
  if (!commissionEligible(job)) return null;
  if (!rep) return 0;
  const costing = computeCosting(job);
  const basisAmount =
    settings.commissionBasis === "Revenue"
      ? costing.effectiveRevenue
      : costing.effectiveGrossProfit;
  const rate = commissionRateFor(rep, settings);
  return basisAmount === null ? null : Math.max(0, basisAmount) * (rate / 100);
}

export function fmtMoney(n: number | null | undefined): string {
  if (!moneyKnown(n)) return "Unreconciled";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
