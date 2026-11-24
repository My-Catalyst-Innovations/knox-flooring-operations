import type { StockReturnPlan } from "./stock-return-plan";

export type InventoryAccountingChoice = {
  productId: string;
  jobId: string;
  returnIds: string[];
  note: string;
};
export type InventoryAccountingPreview = {
  choice: InventoryAccountingChoice;
  fingerprint: string;
  plan: StockReturnPlan;
  observedAt: string;
  company: {
    connectionId: string;
    realmId: string;
    environment: "sandbox" | "production";
    companyName: string;
  } | null;
};
export type InventoryAccountingEvent = {
  id: string;
  kind: "operator_note" | "external_adjustment_verified";
  note: string;
  adjustmentId: string | null;
  balanceObservation?: {
    worksQuantity: string;
    quickBooksQuantity: string;
    matchesCurrentWorks: boolean;
    matchesSavedTarget: boolean;
    observedAt: string;
  };
  createdAt: string;
};
export type InventoryAccountingCase = {
  id: string;
  kind: "return_quantity_plan" | "manual_review";
  productId: string;
  jobId: string | null;
  note: string;
  reasonCodes: string[];
  reference: string;
  plan: StockReturnPlan;
  company: InventoryAccountingPreview["company"];
  events: InventoryAccountingEvent[];
  createdAt: string;
};
export type InventoryAccountingOptions = {
  product: { id: string; sku: string; name: string; unit: string };
  jobs: Array<{ id: string; number: string; customerName: string }>;
  returns: Array<{
    id: string;
    jobId: string;
    issueId: string;
    quantity: string;
    reason: string;
    createdAt: string;
  }>;
  cases: InventoryAccountingCase[];
  hasMore: boolean;
};
