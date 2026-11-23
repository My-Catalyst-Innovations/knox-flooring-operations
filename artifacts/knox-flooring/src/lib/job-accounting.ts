export interface AccountingCompany {
  connectionId: string;
  realmId: string;
  environment: "sandbox" | "production";
  name: string;
}

export interface AccountingOption {
  id: string;
  name: string;
}
export interface JobAccountingOptions {
  enabled: boolean;
  company: AccountingCompany | null;
  employees: AccountingOption[];
  vendors: AccountingOption[];
  serviceItems: AccountingOption[];
  customers: AccountingOption[];
  expenseAccounts: AccountingOption[];
  bankAccounts: AccountingOption[];
  creditCardAccounts: AccountingOption[];
}
export type JobExportState =
  | "unreviewed"
  | "prepared"
  | "submitting"
  | "unknown"
  | "confirmed"
  | "rejected"
  | "cancelled";
export interface JobCostExport {
  id: string;
  connectionId?: string;
  realmId?: string;
  environment?: string;
  remoteEntity?: string;
  state: string;
  remoteId: string | null;
  lastError?: string | null;
  sourceKind: string;
  sourceId: string;
  sourceRevision: number;
}
export interface AccountingLabor {
  id: string;
  jobId: string;
  date: string;
  crew: string;
  hours: number;
  notes: string;
  revision: number;
  costReviewed: boolean;
  singleWorkerConfirmed: boolean;
  workerType: "Employee" | "Vendor" | "unmapped";
  workerExternalId: string | null;
  workerName: string | null;
  serviceItemExternalId: string | null;
  hourlyCost: number | null;
  exportState: JobExportState;
  export?: JobCostExport | null;
}
export interface JobExpense {
  id: string;
  jobId: string;
  revision: number;
  requestKey: string;
  kind: "paid_purchase" | "contractor_bill";
  description: string;
  category: "materials" | "labor" | "other";
  vendorName: string;
  transactionDate: string;
  dueDate: string | null;
  relatedLaborEntryId?: string | null;
  currency: "USD";
  amountCents: number;
  taxCents: number;
  receiptDocumentId: string;
  receiptName: string;
  receiptUrl: string;
  reference: string;
  notes: string;
  exportState: JobExportState;
  export?: JobCostExport | null;
}
export interface JobAccountingCosts {
  labor: AccountingLabor[];
  expenses: JobExpense[];
  totals: {
    trackedLaborCost: number | null;
    unpricedLaborCount: number;
    trackedExpenseCost: number;
  };
  warnings: string[];
}
export interface JobCostSelection {
  connectionId: string;
  sourceRevision: number;
  projectMode: "customer" | "project";
  billableStatus: "NotBillable";
  taxTreatment: "included_in_cost";
  vendorId?: string;
  expenseAccountId?: string;
  paymentType?: "Cash" | "Check" | "CreditCard";
  paymentAccountId?: string;
}
export interface JobCostPreview {
  kind: "labor" | "expense";
  sourceId: string;
  sourceRevision: number;
  company: AccountingCompany;
  document: Record<string, unknown>;
  selection: JobCostSelection;
  evidence: Record<string, unknown>;
  fingerprint: string;
  warnings: string[];
  existingRemoteId: string | null;
}
export function expenseReceiptHref(value: string | undefined) {
  return value &&
    /^\/api\/storage\/objects\/[a-z0-9/_-]+(?:\?[^#]*)?$/i.test(value)
    ? value
    : null;
}
export function moneyInputCents(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : null;
}
export function jobExportLabel(state: JobExportState) {
  return {
    unreviewed: "Not exported",
    prepared: "Owner-approved export",
    submitting: "Submitting to QuickBooks",
    unknown: "Previous submission needs reconciliation",
    confirmed: "Confirmed in QuickBooks",
    rejected: "Export rejected — review required",
    cancelled: "Unsubmitted approval cancelled",
  }[state];
}
