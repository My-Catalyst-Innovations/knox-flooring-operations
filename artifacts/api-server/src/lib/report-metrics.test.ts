import { describe, expect, it } from "vitest";
import {
  completionTimeliness,
  inventoryActivity,
  invoiceAging,
  isReportDate,
  reportBusinessDate,
  shiftReportDate,
  stockAuditSummary,
  upcomingInstallationJobs,
} from "./report-metrics";

describe("operational report metrics", () => {
  it("scores physical count audits and separates posted waste by stocked unit", () => {
    const product = {
      productId: "stock-1",
      sku: "W-1",
      productName: "Test stock",
      unit: "box",
    };
    expect(
      stockAuditSummary([
        { ...product, reason: "count", entries: 3, matches: 2, quantity: 20 },
        { ...product, reason: "damage", entries: 30, matches: 0, quantity: 60 },
        {
          ...product,
          reason: "waste",
          entries: 2,
          matches: 0,
          quantity: 3,
          jobId: "job-1",
          jobNumber: "J-1",
          crewId: "crew-1",
          crewName: "Crew One",
        },
        {
          ...product,
          unit: "sqft",
          reason: "waste",
          entries: 1,
          matches: 0,
          quantity: 12.5,
        },
      ]),
    ).toEqual({
      checked: 3,
      matched: 2,
      waste: [
        { ...product, entries: 2, quantity: 3 },
        { ...product, unit: "sqft", entries: 1, quantity: 12.5 },
      ],
      wasteByJob: [
        {
          jobId: "job-1",
          jobNumber: "J-1",
          crewId: "crew-1",
          crewName: "Crew One",
          unit: "box",
          entries: 2,
          quantity: 3,
        },
        {
          jobId: null,
          jobNumber: null,
          crewId: null,
          crewName: null,
          unit: "sqft",
          entries: 1,
          quantity: 12.5,
        },
      ],
    });
  });

  it("counts each active upcoming job once and still surfaces planned jobs awaiting a crew", () => {
    const now = new Date("2026-11-20T18:00:00Z");
    const until = new Date("2026-12-04T05:00:00Z");
    const job = (
      id: string,
      status = "Approved",
      estStartDate: string | null = null,
    ) => ({ id, status, estStartDate });
    const booking = (
      jobId: string,
      crewId = "active",
      startAt = "2026-11-25T18:00:00Z",
      endAt = "2026-11-25T20:00:00Z",
      status = "Confirmed",
    ) => ({ jobId, crewId, startAt, endAt, status });
    expect(
      upcomingInstallationJobs(
        [
          job("ready"),
          job("inactive-crew"),
          job("ask", "Approved", "2026-11-22"),
          job("finished", "Completed"),
          job("future", "Scheduled", "2026-11-21"),
          job("quote", "Proposal Sent", "2026-11-22"),
        ],
        [
          booking("ready"),
          booking("ready"),
          booking("inactive-crew", "inactive"),
          booking("finished"),
          booking(
            "future",
            "active",
            "2026-12-04T05:00:00Z",
            "2026-12-04T07:00:00Z",
          ),
          booking("ask", "active", undefined, undefined, "Cancelled"),
        ],
        new Set(["active"]),
        now,
        until,
      ),
    ).toEqual({ confirmedJobIds: ["ready"], needsCrew: 2 });
  });

  it("uses Eastern business days and validates the calendar dates used for aging", () => {
    expect(reportBusinessDate(new Date("2026-11-21T03:59:59Z"))).toBe(
      "2026-11-20",
    );
    expect(shiftReportDate("2026-11-03", -3)).toBe("2026-10-31");
    expect(isReportDate("2026-02-29")).toBe(false);
    expect(isReportDate("2024-02-29")).toBe(true);
  });

  it("ages only current open balances and preserves undated receivables separately", () => {
    const today = "2026-11-20";
    const open = (dueDate: string, balanceAmount: number, status = "Sent") => ({
      status,
      dueDate,
      balanceAmount,
    });
    const buckets = invoiceAging(
      [
        open(today, 10),
        open(shiftReportDate(today, 1), 4),
        open(shiftReportDate(today, -1), 5.73, "Partial"),
        open(shiftReportDate(today, -30), 7.31),
        open(shiftReportDate(today, -31), 17),
        open(shiftReportDate(today, -60), 20),
        open(shiftReportDate(today, -61), 13),
        open(shiftReportDate(today, -90), 14, "Overdue"),
        open(shiftReportDate(today, -91), 15),
        open("", 2.67),
        open("2026-02-31", 11.04),
        open(today, 200, "Draft"),
        open(today, 200, "Paid"),
        open(today, 200, "Voided"),
        open(today, 0),
      ],
      today,
    );
    expect(buckets).toEqual([
      { band: "current", invoiceCount: 2, balance: 14 },
      { band: "pastDue1To30", invoiceCount: 2, balance: 13.04 },
      { band: "pastDue31To60", invoiceCount: 2, balance: 37 },
      { band: "pastDue61To90", invoiceCount: 2, balance: 27 },
      { band: "pastDue91Plus", invoiceCount: 1, balance: 15 },
      { band: "unknown", invoiceCount: 2, balance: 13.71 },
    ]);
  });

  it("classifies committed and estimated outcomes by local completion date and leaves unknown targets separate", () => {
    const job = {
      recordedCompletion: "2026-11-21T03:00:00Z",
      committedCompletionDate: null,
      committedCompletionRecordedAt: null,
      estCompletionDate: null,
    };
    expect(
      completionTimeliness([
        {
          ...job,
          committedCompletionDate: "2026-11-20",
          committedCompletionRecordedAt: "2026-11-10T15:00:00Z",
          estCompletionDate: "2026-11-19",
        },
        {
          ...job,
          committedCompletionDate: "2026-11-19",
          committedCompletionRecordedAt: "2026-11-10T15:00:00Z",
          estCompletionDate: "2026-11-25",
        },
        {
          ...job,
          estCompletionDate: "2026-11-21",
          committedCompletionDate: "2026-11-19",
          committedCompletionRecordedAt: "2026-11-21T04:00:00Z",
        },
        { ...job, estCompletionDate: "2026-11-19" },
        { ...job, committedCompletionDate: "2026-11-20" },
        { ...job, estCompletionDate: "2026-11-31" },
      ]),
    ).toEqual({
      committed: { onTime: 1, late: 1 },
      estimated: { onTime: 1, late: 1 },
      unknown: 2,
    });
  });

  it("keeps warehouse transfer, bin transfer, receipts, and unknown records separate in each rolling window", () => {
    const reports = inventoryActivity([
      { kind: "receipt", last30: 2, last60: 3, last90: 4 },
      { kind: "consume", last30: 0, last60: 1, last90: 1 },
      { kind: "transfer_in", last30: 1, last60: 1, last90: 1 },
      { kind: "transfer_out", last30: 1, last60: 1, last90: 1 },
      { kind: "bin_out", last30: 1, last60: 1, last90: 1 },
      { kind: "legacy", last30: 0, last60: 0, last90: 1 },
    ]);
    expect(reports.map(({ days, movements }) => ({ days, movements }))).toEqual(
      [
        { days: 30, movements: 5 },
        { days: 60, movements: 7 },
        { days: 90, movements: 9 },
      ],
    );
    expect(reports[2]).toMatchObject({
      receipts: 4,
      issued: 1,
      transfers: 2,
      binMoves: 1,
      other: 1,
    });
  });
});
