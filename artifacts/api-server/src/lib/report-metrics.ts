const dayMs = 24 * 60 * 60 * 1000;
const businessDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function reportBusinessDate(date: Date) {
  return businessDateFormatter.format(date);
}

export function isReportDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const midnight = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(midnight) &&
    new Date(midnight).toISOString().slice(0, 10) === value
  );
}

export function shiftReportDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * dayMs)
    .toISOString()
    .slice(0, 10);
}

function recordedBusinessDate(value: string | null | undefined) {
  if (!value || !isReportDate(value.slice(0, 10))) return null;
  if (value.length === 10) return value;
  const instant = Date.parse(value);
  return /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && Number.isFinite(instant)
    ? reportBusinessDate(new Date(instant))
    : null;
}

const agingBands = [
  "current",
  "pastDue1To30",
  "pastDue31To60",
  "pastDue61To90",
  "pastDue91Plus",
  "unknown",
] as const;
type AgingBand = (typeof agingBands)[number];

function agingBand(days: number): AgingBand {
  if (!Number.isFinite(days)) return "unknown";
  if (days <= 0) return "current";
  if (days <= 30) return "pastDue1To30";
  if (days <= 60) return "pastDue31To60";
  return days <= 90 ? "pastDue61To90" : "pastDue91Plus";
}

export function invoiceAging(
  invoices: ReadonlyArray<{
    status: string;
    dueDate: string;
    balanceAmount: number;
  }>,
  asOfDate: string,
) {
  const buckets = agingBands.map((band) => ({
    band,
    invoiceCount: 0,
    cents: 0,
  }));
  const byBand = new Map(buckets.map((bucket) => [bucket.band, bucket]));
  for (const invoice of invoices) {
    if (
      !["Sent", "Partial", "Overdue"].includes(invoice.status) ||
      !Number.isFinite(invoice.balanceAmount) ||
      invoice.balanceAmount <= 0
    )
      continue;
    const dueDate = recordedBusinessDate(invoice.dueDate);
    const daysPastDue = dueDate
      ? (Date.parse(asOfDate) - Date.parse(dueDate)) / dayMs
      : NaN;
    const bucket = byBand.get(agingBand(daysPastDue))!;
    bucket.invoiceCount += 1;
    bucket.cents += Math.round(invoice.balanceAmount * 100);
  }
  return buckets.map(({ band, invoiceCount, cents }) => ({
    band,
    invoiceCount,
    balance: cents / 100,
  }));
}

export function completionTimeliness(
  jobs: ReadonlyArray<{
    recordedCompletion: string;
    committedCompletionDate: string | null;
    committedCompletionRecordedAt: string | null;
    estCompletionDate: string | null;
  }>,
) {
  const committed = { onTime: 0, late: 0 };
  const estimated = { onTime: 0, late: 0 };
  let unknown = 0;
  for (const job of jobs) {
    const completionDay = recordedBusinessDate(job.recordedCompletion);
    const commitmentDay = recordedBusinessDate(job.committedCompletionDate);
    const recordedAt = Date.parse(job.committedCompletionRecordedAt ?? "");
    const completedAt = Date.parse(job.recordedCompletion);
    if (
      completionDay &&
      commitmentDay &&
      Number.isFinite(recordedAt) &&
      recordedAt <= completedAt
    ) {
      committed[completionDay <= commitmentDay ? "onTime" : "late"] += 1;
      continue;
    }
    const estimateDay = recordedBusinessDate(job.estCompletionDate);
    if (completionDay && estimateDay)
      estimated[completionDay <= estimateDay ? "onTime" : "late"] += 1;
    else unknown += 1;
  }
  return { committed, estimated, unknown };
}

export const movementWindows = [30, 60, 90] as const;

export function inventoryActivity(
  counts: ReadonlyArray<{
    kind: string;
    last30: number;
    last60: number;
    last90: number;
  }>,
) {
  return movementWindows.map((days) => {
    const totals = {
      days,
      movements: 0,
      receipts: 0,
      issued: 0,
      returns: 0,
      transfers: 0,
      binMoves: 0,
      adjustments: 0,
      other: 0,
    };
    for (const row of counts) {
      const count = row[`last${days}`];
      totals.movements += count;
      switch (row.kind) {
        case "receipt":
          totals.receipts += count;
          break;
        case "consume":
          totals.issued += count;
          break;
        case "return":
          totals.returns += count;
          break;
        case "transfer_in":
        case "transfer_out":
          totals.transfers += count;
          break;
        case "bin_in":
        case "bin_out":
          totals.binMoves += count;
          break;
        case "adjustment":
          totals.adjustments += count;
          break;
        default:
          totals.other += count;
      }
    }
    return totals;
  });
}

export function stockAuditSummary(
  rows: ReadonlyArray<{
    reason: string;
    productId: string;
    sku: string;
    productName: string;
    unit: string;
    entries: number;
    matches: number;
    quantity: number;
    jobId?: string | null;
    jobNumber?: string | null;
    crewId?: string | null;
    crewName?: string | null;
  }>,
) {
  let checked = 0;
  let matched = 0;
  type Waste = {
    productId: string;
    sku: string;
    productName: string;
    unit: string;
    entries: number;
    quantity: number;
  };
  type Assignment = {
    jobId: string | null;
    jobNumber: string | null;
    crewId: string | null;
    crewName: string | null;
    unit: string;
    entries: number;
    quantity: number;
  };
  const waste = new Map<string, Waste>();
  const wasteByJob = new Map<string, Assignment>();
  for (const row of rows) {
    if (row.reason === "count") {
      checked += row.entries;
      matched += row.matches;
    } else if (row.reason === "waste") {
      const productKey = JSON.stringify([
        row.productId,
        row.sku,
        row.productName,
        row.unit,
      ]);
      const product = waste.get(productKey) ?? {
        productId: row.productId,
        sku: row.sku,
        productName: row.productName,
        unit: row.unit,
        entries: 0,
        quantity: 0,
      };
      product.entries += row.entries;
      product.quantity += row.quantity;
      waste.set(productKey, product);
      const jobKey = JSON.stringify([
        row.jobId ?? null,
        row.crewId ?? null,
        row.unit,
      ]);
      const assignment = wasteByJob.get(jobKey) ?? {
        jobId: row.jobId ?? null,
        jobNumber: row.jobNumber ?? null,
        crewId: row.crewId ?? null,
        crewName: row.crewName ?? null,
        unit: row.unit,
        entries: 0,
        quantity: 0,
      };
      assignment.entries += row.entries;
      assignment.quantity += row.quantity;
      wasteByJob.set(jobKey, assignment);
    }
  }
  const roundQuantity = <T extends { quantity: number }>(row: T) => ({
    ...row,
    quantity: Math.round(row.quantity * 1e6) / 1e6,
  });
  return {
    checked,
    matched,
    waste: [...waste.values()].map(roundQuantity),
    wasteByJob: [...wasteByJob.values()].map(roundQuantity),
  };
}

export function upcomingInstallationJobs(
  jobs: ReadonlyArray<{
    id: string;
    status: string;
    estStartDate: string | null;
  }>,
  bookings: ReadonlyArray<{
    jobId: string;
    crewId: string;
    status: string;
    startAt: string;
    endAt: string;
  }>,
  activeCrews: ReadonlySet<string>,
  now: Date,
  end: Date,
) {
  const today = reportBusinessDate(now);
  const endDate = reportBusinessDate(end);
  const scheduledJobs = new Set<string>();
  const bookedInWindow = new Set<string>();
  const activeInWindow = new Set<string>();
  for (const booking of bookings) {
    const start = Date.parse(booking.startAt);
    const finish = Date.parse(booking.endAt);
    if (
      booking.status !== "Confirmed" ||
      !(finish > now.getTime() && finish > start)
    )
      continue;
    const active = activeCrews.has(booking.crewId);
    if (active) scheduledJobs.add(booking.jobId);
    if (start >= end.getTime()) continue;
    bookedInWindow.add(booking.jobId);
    if (active) activeInWindow.add(booking.jobId);
  }
  const confirmedJobIds: string[] = [];
  let needsCrew = 0;
  for (const job of jobs) {
    if (["Completed", "Invoiced"].includes(job.status)) continue;
    if (activeInWindow.has(job.id)) {
      confirmedJobIds.push(job.id);
      continue;
    }
    const plannedDay = recordedBusinessDate(job.estStartDate);
    if (
      bookedInWindow.has(job.id) ||
      (!scheduledJobs.has(job.id) &&
        plannedDay &&
        plannedDay >= today &&
        plannedDay < endDate &&
        [
          "Approved",
          "Material Ordered",
          "Material Received",
          "Scheduled",
          "In Progress",
        ].includes(job.status))
    )
      needsCrew += 1;
  }
  return { confirmedJobIds, needsCrew };
}
