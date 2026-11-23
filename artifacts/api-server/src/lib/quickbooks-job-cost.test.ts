import { describe, expect, it, vi } from "vitest";
vi.mock("@workspace/db/workspace", () => ({
  workspaceEnvironment: () => ({ DEMO_MODE: "false" }),
}));
import {
  costDocument,
  costRemoteMatches,
  costSelection,
  findCostRemote,
  jobCostExportsAvailable,
  timeDuration,
  verifyCostCompany,
  reviewedLaborCostCents,
} from "./quickbooks-job-cost";

const selection = costSelection.parse({
  connectionId: "connection",
  sourceRevision: 1,
  projectMode: "customer",
  billableStatus: "NotBillable",
  taxTreatment: "included_in_cost",
});
const time = {
  date: "2026-11-23",
  hours: 1.5,
  workerType: "Employee",
  workerExternalId: "5",
  serviceItemExternalId: "8",
  hourlyCost: 27.25,
  costReviewed: true,
  singleWorkerConfirmed: true,
  notes: "Installation",
};
const receipt = {
  kind: "paid_purchase",
  category: "other",
  transactionDate: "2026-11-23",
  dueDate: null,
  currency: "USD",
  amountCents: 10825,
  taxCents: 825,
  reference: "R-123",
  description: "Disposal",
  notes: "",
};
const paid = {
  ...selection,
  vendorId: "20",
  expenseAccountId: "30",
  paymentType: "CreditCard" as const,
  paymentAccountId: "40",
};
describe("reviewed ordinary labor and receipt expense contracts", () => {
  it("rounds reviewed whole-minute labor in integer cents consistently", () => {
    expect(reviewedLaborCostCents(1.75, 20.02)).toBe(3504);
    expect(reviewedLaborCostCents(0.25, 20.06)).toBe(502);
    expect(reviewedLaborCostCents(2.3, 20.05)).toBe(4612);
    expect(reviewedLaborCostCents(Math.fround(23 + 59 / 60), 20.02)).toBe(
      48015,
    );
    expect(() => reviewedLaborCostCents(1.001, 20.02)).toThrow(/whole minutes/);
  });
  it("keeps actual cost distinct from sales and payroll pay types", () => {
    const document = costDocument(
      "labor",
      time,
      selection,
      "1",
      "project-opaque",
      "CW-fixture",
    );
    expect(document).toMatchObject({
      Hours: 1,
      Minutes: 30,
      EmployeeRef: { value: "5" },
      ProjectRef: { value: "project-opaque" },
      CostRate: 27.25,
      BillableStatus: "NotBillable",
    });
    expect(document).not.toHaveProperty("HourlyRate");
    expect(document).not.toHaveProperty("PayrollItemRef");
  });
  it("rejects aggregate or unpriced labor instead of guessing a worker", () => {
    expect(() =>
      costDocument(
        "labor",
        { ...time, singleWorkerConfirmed: false },
        selection,
        "1",
        null,
        "CW-test",
      ),
    ).toThrow(/one named worker/);
    expect(() =>
      costDocument(
        "labor",
        { ...time, costReviewed: false },
        selection,
        "1",
        null,
        "CW-test",
      ),
    ).toThrow();
    expect(() =>
      costDocument(
        "labor",
        { ...time, hourlyCost: 20.001 },
        selection,
        "1",
        null,
        "CW-test",
      ),
    ).toThrow(/two decimal/);
  });
  it("requires precise whole-minute duration and rejects invalid daily totals", () => {
    expect(timeDuration(7.75)).toEqual({ Hours: 7, Minutes: 45 });
    for (const hours of [0, -1, 24.5, 1.001, NaN])
      expect(() => timeDuration(hours)).toThrow();
  });
  it("posts a gross receipt cost with explicit funding and line attribution", () => {
    expect(
      costDocument(
        "expense",
        receipt,
        paid,
        "1",
        "opaque-project",
        "CW-receipt",
      ),
    ).toMatchObject({
      PaymentType: "CreditCard",
      AccountRef: { value: "40" },
      EntityRef: { value: "20", type: "Vendor" },
      Line: [
        {
          Amount: 108.25,
          ProjectRef: { value: "opaque-project" },
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: "30" },
            CustomerRef: { value: "1" },
            BillableStatus: "NotBillable",
          },
        },
      ],
    });
    expect(() =>
      costDocument("expense", receipt, selection, "1", null, "CW-test"),
    ).toThrow(/vendor/);
    expect(() =>
      costDocument(
        "expense",
        receipt,
        { ...paid, paymentAccountId: undefined },
        "1",
        null,
        "CW-test",
      ),
    ).toThrow(/funding/);
  });
  it("an unpaid contractor bill never becomes a paid Purchase", () => {
    const source = {
        ...receipt,
        kind: "contractor_bill",
        category: "labor",
        dueDate: "2026-12-01",
      },
      choice = { ...selection, vendorId: "20", expenseAccountId: "30" };
    const document = costDocument(
      "expense",
      source,
      choice,
      "1",
      null,
      "CW-bill",
    );
    expect(document).toHaveProperty("VendorRef", { value: "20" });
    expect(document).not.toHaveProperty("PaymentType");
    expect(() =>
      costDocument("expense", source, paid, "1", null, "CW-bill"),
    ).toThrow(/must not specify/);
  });
  it("does not accept guessed currency, recoverable tax or extra approval fields", () => {
    expect(() =>
      costDocument(
        "expense",
        { ...receipt, currency: "CAD" },
        paid,
        "1",
        null,
        "CW-test",
      ),
    ).toThrow(/USD/);
    expect(() =>
      costDocument(
        "expense",
        { ...receipt, taxCents: 20000 },
        paid,
        "1",
        null,
        "CW-test",
      ),
    ).toThrow(/included tax/);
    expect(
      costSelection.safeParse({ ...selection, taxTreatment: "exempt" }).success,
    ).toBe(false);
    expect(
      costSelection.safeParse({ ...selection, document: { Amount: 1 } })
        .success,
    ).toBe(false);
  });
  it("a mapped sandbox is enabled while all new live writes remain disabled", () => {
    expect(
      jobCostExportsAvailable({
        status: "connected",
        realmId: "1",
        environment: "sandbox",
      }),
    ).toBe(true);
    expect(
      jobCostExportsAvailable({
        status: "connected",
        realmId: "1",
        environment: "production",
      }),
    ).toBe(false);
  });
  it("checks actual US/USD company and active customer", async () => {
    const records: any = {
      "/companyinfo/9": { CompanyInfo: { Country: "US" } },
      "/preferences": {
        Preferences: {
          CurrencyPrefs: {
            HomeCurrency: { value: "USD" },
            MultiCurrencyEnabled: false,
          },
        },
      },
      "/customer/1": { Customer: { Id: "1", Active: true } },
    };
    const provider = {
      request: async (path: string) => records[path],
      query: vi.fn(),
    };
    await expect(verifyCostCompany(provider, "9", "1")).resolves.toHaveProperty(
      "customer.Id",
      "1",
    );
    records["/preferences"].Preferences.CurrencyPrefs.MultiCurrencyEnabled =
      true;
    await expect(verifyCostCompany(provider, "9", "1")).rejects.toThrow(
      /without currency conversion/,
    );
  });
  it("reconciles only the exact approved cost and total", async () => {
    const document = costDocument(
        "expense",
        receipt,
        paid,
        "1",
        null,
        "CW-receipt",
      ),
      remote = { ...document, Id: "71", SyncToken: "0", TotalAmt: 108.25 };
    expect(costRemoteMatches(document, remote, "Purchase")).toBe(true);
    expect(
      costRemoteMatches(document, { ...remote, TotalAmt: 108.26 }, "Purchase"),
    ).toBe(false);
    const provider = {
      request: vi.fn(),
      query: vi.fn(async () => ({ QueryResponse: { Purchase: [remote] } })),
    };
    await expect(
      findCostRemote({ document, remoteEntity: "Purchase" }, provider),
    ).resolves.toHaveProperty("Id", "71");
    expect(provider.request).not.toHaveBeenCalled();
    provider.query.mockResolvedValue({
      QueryResponse: {
        Purchase: [{ ...remote, AccountRef: { value: "different" } }],
      },
    });
    await expect(
      findCostRemote({ document, remoteEntity: "Purchase" }, provider),
    ).rejects.toThrow(/different QuickBooks/);
  });
  it("missing or ambiguous provider evidence never implies a safe create", async () => {
    const document = costDocument(
        "labor",
        time,
        selection,
        "1",
        null,
        "CW-time",
      ),
      remote = { ...document, Id: "71" };
    const provider = {
      request: vi.fn(),
      query: vi.fn(async () => ({
        QueryResponse: { TimeActivity: [remote, { ...remote, Id: "72" }] },
      })),
    };
    await expect(
      findCostRemote({ document, remoteEntity: "TimeActivity" }, provider),
    ).rejects.toThrow(/Multiple/);
    provider.query.mockResolvedValue({} as any);
    await expect(
      findCostRemote({ document, remoteEntity: "TimeActivity" }, provider),
    ).rejects.toThrow(/did not confirm/);
  });
  it("time readback must preserve reviewed rate, date, duration, individual, service and project", () => {
    const document = costDocument(
        "labor",
        time,
        selection,
        "1",
        "true-project",
        "CW-time",
      ),
      remote = { ...document, Id: "71", SyncToken: "0" };
    expect(costRemoteMatches(document, remote, "TimeActivity")).toBe(true);
    for (const change of [
      { CostRate: 27.26 },
      { TxnDate: "2026-11-24" },
      { Hours: 2 },
      { Minutes: 31 },
      { EmployeeRef: { value: "6" } },
      { ItemRef: { value: "9" } },
      { ProjectRef: { value: "other-project" } },
    ])
      expect(
        costRemoteMatches(document, { ...remote, ...change }, "TimeActivity"),
      ).toBe(false);
  });
});
