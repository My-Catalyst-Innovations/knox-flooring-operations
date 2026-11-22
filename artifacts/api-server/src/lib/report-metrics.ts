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

export function invoiceAging<
  T extends { status: string; dueDate: string; balanceAmount: number },
>(invoices: readonly T[], asOfDate: string) {
  const buckets = agingBands.map((band) => ({
    band,
    invoiceCount: 0,
    cents: 0,
  }));
  const byBand = new Map(buckets.map((bucket) => [bucket.band, bucket]));
  const records: {
    invoice: T;
    band: AgingBand;
    balance: number;
    dueDate: string | null;
  }[] = [];
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
    const band = agingBand(daysPastDue);
    const cents = Math.round(invoice.balanceAmount * 100);
    const bucket = byBand.get(band)!;
    bucket.invoiceCount += 1;
    bucket.cents += cents;
    records.push({ invoice, band, balance: cents / 100, dueDate });
  }
  return {
    buckets: buckets.map(({ band, invoiceCount, cents }) => ({
      band,
      invoiceCount,
      balance: cents / 100,
    })),
    records,
  };
}

export function completionTimeliness<
  T extends {
    recordedCompletion: string;
    committedCompletionDate: string | null;
    committedCompletionRecordedAt: string | null;
    estCompletionDate: string | null;
  },
>(jobs: readonly T[]) {
  const committed = { onTime: 0, late: 0 };
  const estimated = { onTime: 0, late: 0 };
  let unknown = 0;
  const records: {
    job: T;
    completedOn: string;
    targetOn: string | null;
    basis: "committed" | "estimated" | "unknown";
    outcome: "onTime" | "late" | "unknown";
  }[] = [];
  for (const job of jobs) {
    const completionDay = recordedBusinessDate(job.recordedCompletion);
    const commitmentDay = recordedBusinessDate(job.committedCompletionDate);
    const recordedAt = Date.parse(job.committedCompletionRecordedAt ?? "");
    const completedAt = Date.parse(job.recordedCompletion);
    const committedTarget =
      completionDay &&
      commitmentDay &&
      Number.isFinite(recordedAt) &&
      recordedAt <= completedAt
        ? commitmentDay
        : null;
    const estimateTarget = completionDay
      ? recordedBusinessDate(job.estCompletionDate)
      : null;
    const targetOn = committedTarget ?? estimateTarget;
    if (!completionDay || !targetOn) {
      unknown += 1;
      records.push({
        job,
        completedOn: completionDay ?? job.recordedCompletion,
        targetOn: null,
        basis: "unknown",
        outcome: "unknown",
      });
    } else {
      const basis = committedTarget ? "committed" : "estimated";
      const outcome = completionDay <= targetOn ? "onTime" : "late";
      (basis === "committed" ? committed : estimated)[outcome] += 1;
      records.push({
        job,
        completedOn: completionDay,
        targetOn,
        basis,
        outcome,
      });
    }
  }
  return { committed, estimated, unknown, records };
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
    productId: string;
    sku: string;
    productName: string;
    unit: string;
    entries: number;
    quantity: number;
    jobId?: string | null;
    jobNumber?: string | null;
    crewId?: string | null;
    crewName?: string | null;
  }>,
  postedCounts: readonly { bookedQuantity: number; countedQuantity: number }[],
) {
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
  const roundQuantity = <T extends { quantity: number }>(row: T) => ({
    ...row,
    quantity: Math.round(row.quantity * 1e6) / 1e6,
  });
  return {
    checked: postedCounts.length,
    matched: postedCounts.filter(
      (row) => row.bookedQuantity === row.countedQuantity,
    ).length,
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
  const bookedInWindow = new Map<string, number>();
  const activeInWindow = new Map<string, number>();
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
    bookedInWindow.set(
      booking.jobId,
      Math.min(start, bookedInWindow.get(booking.jobId) ?? Infinity),
    );
    if (active)
      activeInWindow.set(
        booking.jobId,
        Math.min(start, activeInWindow.get(booking.jobId) ?? Infinity),
      );
  }
  const confirmedJobIds: string[] = [];
  const needsCrewJobIds: string[] = [];
  const datesByJob = new Map<string, string>();
  for (const job of jobs) {
    if (["Completed", "Invoiced"].includes(job.status)) continue;
    const confirmed = activeInWindow.get(job.id);
    if (confirmed !== undefined) {
      confirmedJobIds.push(job.id);
      datesByJob.set(job.id, reportBusinessDate(new Date(confirmed)));
      continue;
    }
    const plannedDay = recordedBusinessDate(job.estStartDate);
    const booked = bookedInWindow.get(job.id);
    if (
      booked !== undefined ||
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
    ) {
      needsCrewJobIds.push(job.id);
      const date =
        booked === undefined
          ? plannedDay
          : reportBusinessDate(new Date(booked));
      if (date) datesByJob.set(job.id, date);
    }
  }
  return { confirmedJobIds, needsCrewJobIds, datesByJob };
}
