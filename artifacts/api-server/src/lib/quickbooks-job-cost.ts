import { createHash } from "node:crypto";
import { z } from "zod";
import { workspaceEnvironment } from "@workspace/db/workspace";
import { sql, type SQLWrapper } from "drizzle-orm";

export type CostKind = "labor" | "expense";
export type CostProvider = {
  request: (path: string, init?: RequestInit) => Promise<any>;
  query: (statement: string) => Promise<any>;
};
const providerId = z.string().regex(/^\d{1,30}$/);
export const costSelection = z
  .object({
    connectionId: z.string().min(1),
    sourceRevision: z.number().int().positive(),
    projectMode: z.enum(["customer", "project"]),
    billableStatus: z.literal("NotBillable"),
    taxTreatment: z.literal("included_in_cost"),
    vendorId: providerId.optional(),
    expenseAccountId: providerId.optional(),
    paymentType: z.enum(["Cash", "Check", "CreditCard"]).optional(),
    paymentAccountId: providerId.optional(),
  })
  .strict();
export type CostSelection = z.infer<typeof costSelection>;
export function stableFingerprint(value: unknown): string {
  const sort = (input: any): any =>
    Array.isArray(input)
      ? input.map(sort)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .filter((key) => input[key] !== undefined)
              .map((key) => [key, sort(input[key])]),
          )
        : input;
  return createHash("sha256")
    .update(JSON.stringify(sort(value)))
    .digest("hex");
}
export function jobCostExportsAvailable(
  connection: { status: string; environment: string; realmId: string } | null,
) {
  const env = workspaceEnvironment();
  return (
    !!connection &&
    connection.status === "connected" &&
    env.DEMO_MODE !== "true" &&
    (connection.environment === "sandbox" ||
      (connection.environment === "production" &&
        env.QUICKBOOKS_PRODUCTION_JOB_COSTS_ENABLED === "true" &&
        env.QUICKBOOKS_PRODUCTION_JOB_COSTS_REALM_ID === connection.realmId))
  );
}
export function assertCost(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}
export function validCostMoney(amount: number) {
  return (
    Number.isFinite(amount) &&
    amount >= 0 &&
    amount <= 10_000_000 &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 0.000001
  );
}
export function timeDuration(hours: number) {
  const minutes = Math.round(hours * 60);
  assertCost(
    Number.isFinite(hours) &&
      minutes > 0 &&
      minutes <= 1440 &&
      // Existing hours use PostgreSQL REAL. Allow only its small storage error,
      // including late-day values such as 23h59m; genuine fractional minutes fail.
      Math.abs(hours * 60 - minutes) < 0.0002,
    "Record an individual worker's time in whole minutes, between one minute and 24 hours per entry.",
  );
  return { Hours: Math.floor(minutes / 60), Minutes: minutes % 60 };
}
/** Reviewed individual labor rounds each row half-up in cents, without a binary
 * hours*rate product. Unreviewed legacy crew hours are deliberately not normalized. */
export function reviewedLaborCostCents(hours: number, hourlyCost: number) {
  const duration = timeDuration(hours);
  assertCost(
    validCostMoney(hourlyCost),
    "Enter the actual hourly cost to two decimal places.",
  );
  const minutes = duration.Hours * 60 + duration.Minutes,
    rateCents = Math.round(hourlyCost * 100);
  return Math.floor((minutes * rateCents + 30) / 60);
}
/** SQL counterpart of the same whole-minute/integer-cent row calculation. */
export function reviewedLaborCostCentsSql(
  hours: SQLWrapper,
  hourlyCost: SQLWrapper,
) {
  return sql<number>`floor((round(${hours}::numeric * 60) * round(${hourlyCost}::numeric * 100) + 30) / 60)`;
}
export async function verifyCostCompany(
  provider: CostProvider,
  realmId: string,
  customerId: string,
) {
  const [info, prefs, customer] = await Promise.all([
    provider.request(`/companyinfo/${realmId}`),
    provider.request("/preferences"),
    provider.request(`/customer/${customerId}`),
  ]);
  assertCost(
    ["US", "USA", "United States"].includes(info.CompanyInfo?.Country) &&
      prefs.Preferences?.CurrencyPrefs?.HomeCurrency?.value === "USD" &&
      prefs.Preferences?.CurrencyPrefs?.MultiCurrencyEnabled !== true,
    "Job-cost export currently requires a verified US company using USD without currency conversion.",
  );
  assertCost(
    customer.Customer?.Id === customerId &&
      customer.Customer.Active === true &&
      (!customer.Customer.CurrencyRef ||
        customer.Customer.CurrencyRef.value === "USD"),
    "Reconcile an active USD customer in this QuickBooks company.",
  );
  return {
    company: info.CompanyInfo,
    preferences: prefs.Preferences,
    customer: customer.Customer,
  };
}
export async function verifyCostEntity(
  provider: CostProvider,
  entity: "Employee" | "Vendor" | "Item" | "Account",
  id: string,
) {
  providerId.parse(id);
  const response = await provider.request(`/${entity.toLowerCase()}/${id}`),
    record = response[entity];
  assertCost(
    record?.Id === id && record.Active === true,
    `Choose an active ${entity} in the selected QuickBooks company.`,
  );
  return record;
}
export function costDocument(
  kind: CostKind,
  source: any,
  selection: CostSelection,
  customerId: string,
  projectId: string | null,
  reference: string,
) {
  if (kind === "labor") {
    assertCost(
      source.singleWorkerConfirmed === true &&
        source.costReviewed === true &&
        ["Employee", "Vendor"].includes(source.workerType) &&
        providerId.safeParse(source.workerExternalId).success &&
        providerId.safeParse(source.serviceItemExternalId).success,
      "Confirm this entry belongs to one named worker and review its worker, service item and actual cost rate.",
    );
    assertCost(
      validCostMoney(source.hourlyCost),
      "Enter the actual hourly cost to two decimal places.",
    );
    return {
      TxnDate: source.date,
      NameOf: source.workerType,
      [source.workerType === "Employee" ? "EmployeeRef" : "VendorRef"]: {
        value: source.workerExternalId,
      },
      ItemRef: { value: source.serviceItemExternalId },
      CustomerRef: { value: customerId },
      ...(projectId ? { ProjectRef: { value: projectId } } : {}),
      ...timeDuration(source.hours),
      BillableStatus: "NotBillable",
      CostRate: source.hourlyCost,
      Description: `${source.notes ?? ""}\n[${reference}]`.trim(),
    };
  }
  assertCost(
    source.currency === "USD" &&
      Number.isSafeInteger(source.amountCents) &&
      source.amountCents > 0 &&
      Number.isSafeInteger(source.taxCents) &&
      source.taxCents >= 0 &&
      source.taxCents <= source.amountCents,
    "Review the receipt gross amount, actual included tax and USD currency.",
  );
  assertCost(
    selection.vendorId && selection.expenseAccountId,
    "Select the actual vendor and expense account.",
  );
  const line = {
    Amount: source.amountCents / 100,
    Description: `${source.description}\n[${reference}]`,
    DetailType: "AccountBasedExpenseLineDetail",
    ...(projectId ? { ProjectRef: { value: projectId } } : {}),
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: selection.expenseAccountId },
      CustomerRef: { value: customerId },
      BillableStatus: "NotBillable",
    },
  };
  const common = {
    TxnDate: source.transactionDate,
    DocNumber: source.reference,
    CurrencyRef: { value: "USD" },
    PrivateNote:
      `${source.notes ?? ""}\nReceipt ${source.reference}; included tax ${(source.taxCents / 100).toFixed(2)} USD. [${reference}]`.trim(),
    Line: [line],
  };
  if (source.kind === "contractor_bill") {
    assertCost(
      source.dueDate && !selection.paymentAccountId && !selection.paymentType,
      "An unpaid contractor bill requires its actual due date and must not specify a payment or funding account.",
    );
    assertCost(
      source.category === "labor",
      "Use an unpaid contractor bill only for an actual contractor labor charge.",
    );
    return {
      ...common,
      VendorRef: { value: selection.vendorId },
      DueDate: source.dueDate,
    };
  }
  assertCost(
    source.kind === "paid_purchase" &&
      selection.paymentType &&
      selection.paymentAccountId,
    "Select the actual payment type and funding account for this paid receipt.",
  );
  return {
    ...common,
    EntityRef: { value: selection.vendorId, type: "Vendor" },
    PaymentType: selection.paymentType,
    AccountRef: { value: selection.paymentAccountId },
  };
}
function expectedMatches(expected: any, actual: any): boolean {
  if (expected === null || typeof expected !== "object") {
    if (typeof expected === "number")
      return (
        typeof actual === "number" && Math.abs(expected - actual) < 0.000001
      );
    return expected === actual;
  }
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => expectedMatches(value, actual[index]))
    );
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) =>
    expectedMatches(value, actual[key]),
  );
}
export function costRemoteMatches(
  document: Record<string, unknown>,
  actual: any,
  entity: string,
) {
  if (!actual || !providerId.safeParse(String(actual.Id)).success) return false;
  if (
    entity !== "TimeActivity" &&
    (!validCostMoney(actual.TotalAmt) ||
      Math.round(actual.TotalAmt * 100) !==
        Math.round(
          (document.Line as any[]).reduce((sum, line) => sum + line.Amount, 0) *
            100,
        ))
  )
    return false;
  return expectedMatches(document, actual);
}
export async function findCostRemote(
  attempt: {
    remoteEntity: string;
    remoteId?: string | null;
    document: Record<string, unknown>;
  },
  provider: CostProvider,
) {
  if (attempt.remoteId) {
    providerId.parse(attempt.remoteId);
    const response = await provider.request(
      `/${attempt.remoteEntity.toLowerCase()}/${attempt.remoteId}`,
    );
    assertCost(
      costRemoteMatches(
        attempt.document,
        response[attempt.remoteEntity],
        attempt.remoteEntity,
      ),
      "The linked QuickBooks cost differs from the approved record. Reconcile it in its original company.",
    );
    return response[attempt.remoteEntity];
  }
  const date = String(attempt.document.TxnDate);
  assertCost(
    /^\d{4}-\d{2}-\d{2}$/.test(date),
    "An approved transaction date is required.",
  );
  const escape = (value: string) =>
    value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  const condition =
    attempt.remoteEntity === "TimeActivity"
      ? `TxnDate = '${date}'`
      : `DocNumber = '${escape(String(attempt.document.DocNumber))}'`;
  let found: any[] = [];
  const seen = new Set<string>();
  for (let start = 1; start <= 100_000; start += 1000) {
    const response = await provider.query(
      `select * from ${attempt.remoteEntity} where ${condition} startposition ${start} maxresults 1000`,
    );
    assertCost(
      response.QueryResponse && typeof response.QueryResponse === "object",
      "QuickBooks did not confirm the cost reconciliation lookup. No new write is allowed.",
    );
    const page = response.QueryResponse[attempt.remoteEntity] ?? [];
    assertCost(
      Array.isArray(page) && page.length <= 1000,
      "QuickBooks returned an invalid cost reconciliation page.",
    );
    for (const row of page) {
      assertCost(
        typeof row.Id === "string" && !seen.has(row.Id),
        "QuickBooks repeated a cost reconciliation page. Review it before sending anything.",
      );
      seen.add(row.Id);
      if (costRemoteMatches(attempt.document, row, attempt.remoteEntity))
        found.push(row);
    }
    if (
      attempt.remoteEntity !== "TimeActivity" &&
      page.some(
        (row: any) =>
          !costRemoteMatches(attempt.document, row, attempt.remoteEntity),
      )
    )
      throw Error(
        "A different QuickBooks expense or bill already uses this receipt reference. Link or reconcile it before creating another.",
      );
    assertCost(
      found.length <= 1,
      "Multiple QuickBooks records match this cost. Reconcile them before continuing.",
    );
    if (page.length < 1000) return found[0] ?? null;
  }
  throw Error(
    "The reconciliation lookup exceeded its bounded page limit. No financial record was submitted.",
  );
}
