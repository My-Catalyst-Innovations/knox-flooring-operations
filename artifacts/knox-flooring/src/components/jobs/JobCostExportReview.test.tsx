import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JobCostExportReview } from "./JobCostExportReview";
import type {
  JobExpense,
  JobAccountingOptions,
  JobCostSelection,
} from "@/lib/job-accounting";

const api = vi.hoisted(() => ({ operation: vi.fn(), changed: vi.fn() }));
vi.mock("@/lib/operations", () => ({
  operation: api.operation,
  currency: (value: number) => `$${value.toFixed(2)}`,
}));
const company = {
  connectionId: "connection-1",
  realmId: "realm-1",
  environment: "sandbox" as const,
  name: "Verified company",
};
const options: JobAccountingOptions = {
  enabled: true,
  company,
  employees: [],
  vendors: [{ id: "vendor-1", name: "Verified vendor" }],
  serviceItems: [],
  customers: [],
  expenseAccounts: [
    { id: "expense-1", name: "Disposal expense" },
    { id: "expense-2", name: "Travel expense" },
  ],
  bankAccounts: [{ id: "bank-1", name: "Company bank" }],
  creditCardAccounts: [{ id: "card-1", name: "Company card" }],
};
const source = {
  id: "expense-1",
  jobId: "job-1",
  revision: 3,
  kind: "paid_purchase",
  description: "Job disposal",
  vendorName: "Receipt vendor",
  transactionDate: "2026-11-23",
  dueDate: null,
  currency: "USD",
  amountCents: 12345,
  taxCents: 345,
  receiptDocumentId: "document-1",
  receiptName: "Receipt.pdf",
  receiptUrl: "/api/storage/objects/private/receipt",
  reference: "RECEIPT-1",
  exportState: "unreviewed",
} as JobExpense;
beforeEach(() => {
  api.operation.mockReset();
  api.changed.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);
function choose() {
  fireEvent.change(screen.getByLabelText("Job attribution"), {
    target: { value: "customer" },
  });
  fireEvent.change(screen.getByLabelText("QuickBooks vendor"), {
    target: { value: "vendor-1" },
  });
  fireEvent.change(screen.getByLabelText("Expense account"), {
    target: { value: "expense-1" },
  });
  fireEvent.change(screen.getByLabelText("Payment type"), {
    target: { value: "CreditCard" },
  });
  fireEvent.change(screen.getByLabelText("Payment account"), {
    target: { value: "card-1" },
  });
  fireEvent.click(screen.getByLabelText(/I reviewed the receipt/));
}
function preview(selection: JobCostSelection, overrides = {}) {
  return {
    kind: "expense",
    sourceId: source.id,
    sourceRevision: source.revision,
    company,
    selection,
    document: { PaymentType: "CreditCard", TotalAmt: 123.45 },
    evidence: {},
    fingerprint: "saved-fingerprint",
    warnings: [],
    existingRemoteId: null,
    ...overrides,
  };
}
it("requires explicit verified accounting choices and owner approval of the frozen request", async () => {
  api.operation.mockImplementation(
    async (path: string, _method: string, body: JobCostSelection) =>
      path.endsWith("/review")
        ? preview(body)
        : { export: { state: "prepared", remoteId: null } },
  );
  render(
    <JobCostExportReview
      kind="expense"
      source={source}
      options={options}
      onChanged={api.changed}
    />,
  );
  const prepare = screen.getByRole("button", {
    name: "Prepare exact accounting review",
  });
  expect(prepare).toBeDisabled();
  choose();
  fireEvent.click(prepare);
  const approve = await screen.findByRole("button", {
    name: "Approve frozen export",
  });
  expect(approve).toBeDisabled();
  expect(screen.getByText(/Frozen review/)).toHaveTextContent(
    "Verified company · sandbox · Company realm-1",
  );
  fireEvent.click(screen.getByLabelText(/I approve this exact source/));
  fireEvent.click(approve);
  await waitFor(() =>
    expect(api.operation).toHaveBeenCalledWith(
      "/quickbooks/job-costs/expense/expense-1/approve",
      "POST",
      {
        connectionId: "connection-1",
        sourceRevision: 3,
        projectMode: "customer",
        billableStatus: "NotBillable",
        taxTreatment: "included_in_cost",
        vendorId: "vendor-1",
        expenseAccountId: "expense-1",
        paymentType: "CreditCard",
        paymentAccountId: "card-1",
        fingerprint: "saved-fingerprint",
      },
    ),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Owner approval saved",
  );
  expect(screen.queryByText(/Confirmed in QuickBooks/)).not.toBeInTheDocument();
});
it("invalidates a review when an accounting choice changes and resets payment-account selection", async () => {
  api.operation.mockImplementation(
    async (_path: string, _method: string, body: JobCostSelection) =>
      preview(body),
  );
  render(
    <JobCostExportReview
      kind="expense"
      source={source}
      options={options}
      onChanged={api.changed}
    />,
  );
  choose();
  fireEvent.click(
    screen.getByRole("button", { name: "Prepare exact accounting review" }),
  );
  await screen.findByRole("button", { name: "Approve frozen export" });
  fireEvent.change(screen.getByLabelText("Expense account"), {
    target: { value: "expense-2" },
  });
  expect(
    screen.queryByRole("button", { name: "Approve frozen export" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Payment type"), {
    target: { value: "Check" },
  });
  expect(screen.getByLabelText("Payment account")).toHaveValue("");
  expect(
    screen.getByRole("button", { name: "Prepare exact accounting review" }),
  ).toBeDisabled();
});
it("refuses a preview from another connected company or a stale source revision", async () => {
  api.operation.mockImplementation(
    async (_path: string, _method: string, body: JobCostSelection) =>
      preview(body, { company: { ...company, realmId: "other" } }),
  );
  render(
    <JobCostExportReview
      kind="expense"
      source={source}
      options={options}
      onChanged={api.changed}
    />,
  );
  choose();
  fireEvent.click(
    screen.getByRole("button", { name: "Prepare exact accounting review" }),
  );
  await waitFor(() => expect(api.operation).toHaveBeenCalled());
  expect(
    screen.queryByRole("button", { name: "Approve frozen export" }),
  ).not.toBeInTheDocument();
});
it("offers reconciliation only for an ambiguous prior submission", async () => {
  api.operation.mockResolvedValue({ outcome: "unresolved" });
  render(
    <JobCostExportReview
      kind="expense"
      source={{
        ...source,
        exportState: "unknown",
        export: {
          id: "export-1",
          state: "unknown",
          remoteId: null,
          sourceKind: "expense",
          sourceId: source.id,
          sourceRevision: 3,
        },
      }}
      options={options}
      onChanged={api.changed}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Prepare exact accounting review" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /retry/i }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Reconcile original submission" }),
  );
  await waitFor(() =>
    expect(api.operation).toHaveBeenCalledExactlyOnceWith(
      "/quickbooks/job-costs/exports/export-1/reconcile",
      "POST",
      { connectionId: "connection-1" },
    ),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "remains unresolved",
  );
});
it("never requests a payment source for an unpaid bill", () => {
  render(
    <JobCostExportReview
      kind="expense"
      source={{ ...source, kind: "contractor_bill", dueDate: "2026-12-01" }}
      options={options}
      onChanged={api.changed}
    />,
  );
  expect(screen.queryByLabelText("Payment type")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Payment account")).not.toBeInTheDocument();
});

it("keeps a cancelled unsubmitted approval editable and pauses reconciliation in a different company", () => {
  const view = render(
    <JobCostExportReview
      kind="expense"
      source={{ ...source, exportState: "cancelled" }}
      options={options}
      onChanged={api.changed}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Prepare exact accounting review" }),
  ).toBeVisible();
  view.rerender(
    <JobCostExportReview
      kind="expense"
      source={{
        ...source,
        exportState: "unknown",
        export: {
          id: "old-export",
          state: "unknown",
          remoteId: null,
          sourceKind: "expense",
          sourceId: source.id,
          sourceRevision: 3,
          connectionId: "previous-connection",
          realmId: "previous-realm",
          environment: "production",
        },
      }}
      options={options}
      onChanged={api.changed}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Reconcile original submission" }),
  ).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Restore the original QuickBooks company",
  );
  expect(api.operation).not.toHaveBeenCalled();
});

it("reconciles the original record after reconnecting the same realm without creating another export", async () => {
  api.operation.mockResolvedValue({
    outcome: "confirmed",
    warning: "The local source changed; its costs were not overwritten.",
  });
  const original = {
    ...source,
    exportState: "unknown" as const,
    export: {
      id: "old-export",
      state: "unknown",
      remoteId: null,
      sourceKind: "expense",
      sourceId: source.id,
      sourceRevision: 3,
      connectionId: "old-connection",
      realmId: company.realmId,
      environment: company.environment,
    },
  };
  const view = render(
    <JobCostExportReview
      kind="expense"
      source={original}
      options={options}
      onChanged={api.changed}
    />,
  );
  const reconcile = screen.getByRole("button", {
    name: "Reconcile original submission",
  });
  expect(reconcile).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Prepare exact accounting review" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve frozen export" }),
  ).not.toBeInTheDocument();
  fireEvent.click(reconcile);
  await waitFor(() =>
    expect(api.operation).toHaveBeenCalledExactlyOnceWith(
      "/quickbooks/job-costs/exports/old-export/reconcile",
      "POST",
      { connectionId: company.connectionId },
    ),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "local source changed",
  );
  view.rerender(
    <JobCostExportReview
      kind="expense"
      source={{
        ...original,
        export: { ...original.export, environment: "production" },
      }}
      options={options}
      onChanged={api.changed}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Reconcile original submission" }),
  ).toBeDisabled();
});

it("cancels only an unsubmitted approval after same-company reconnect and still requires a fresh review", async () => {
  api.operation.mockResolvedValue({ export: { state: "cancelled" } });
  render(
    <JobCostExportReview
      kind="expense"
      source={{
        ...source,
        exportState: "prepared",
        export: {
          id: "prepared-export",
          state: "prepared",
          remoteId: null,
          sourceKind: "expense",
          sourceId: source.id,
          sourceRevision: 3,
          connectionId: "old-connection",
          realmId: company.realmId,
          environment: company.environment,
        },
      }}
      options={options}
      onChanged={api.changed}
    />,
  );
  const cancel = screen.getByRole("button", {
    name: "Cancel unsubmitted approval",
  });
  expect(cancel).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Approve frozen export" }),
  ).not.toBeInTheDocument();
  fireEvent.click(cancel);
  await waitFor(() =>
    expect(api.operation).toHaveBeenCalledExactlyOnceWith(
      "/quickbooks/job-costs/exports/prepared-export/cancel",
      "POST",
      { connectionId: company.connectionId },
    ),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Review the source before approving again",
  );
});
