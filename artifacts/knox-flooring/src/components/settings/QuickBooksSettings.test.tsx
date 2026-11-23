import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuickBooksSettings } from "./QuickBooksSettings";

const state = vi.hoisted(() => ({
  fetch: vi.fn(), environment: "sandbox", capabilityEnvironment: "sandbox",
}));
vi.mock("@workspace/api-client-react", () => ({ customFetch: state.fetch }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/operations", () => ({ useOperation: () => ({ data: {
  enabled: true, realmId: "111", environment: state.capabilityEnvironment,
} }) }));
vi.mock("./InvoiceServiceMappings", () => ({ InvoiceServiceMappings: () => null }));
vi.mock("./VendorBillSandbox", () => ({ VendorBillSandbox: () => null, ProductionVendorBills: () => null }));
vi.mock("./SandboxStockItems", () => ({ SandboxStockItems: () => null, ProductionStockItems: () => null }));
vi.mock("./QuickBooksStockReconciliation", () => ({ QuickBooksStockReconciliation: () => null }));
vi.mock("./QuickBooksInvoiceReview", () => ({ QuickBooksInvoiceReview: () => <p>Dedicated invoice accounting review</p> }));

beforeEach(() => {
  state.environment = "sandbox";
  state.capabilityEnvironment = "sandbox";
  state.fetch.mockImplementation(async (path: string) => {
    if (path === "/api/quickbooks/status") return {
      configured: true, demoAvailable: false,
      connection: { connected: true, status: "connected", realmId: "111", companyName: "Internal sandbox",
        environment: state.environment, readinessStatus: "ready" },
    };
    if (path === "/api/quickbooks/queue") return [
      { id: "taxed-invoice", entityType: "invoice", localId: "invoice", action: "create", status: "pending_approval", accountingReviewRequired: true },
      { id: "plain-customer", entityType: "customer", localId: "job", action: "create", status: "pending_approval", accountingReviewRequired: false },
    ];
    return [];
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("keeps sandbox accounting-review invoices out of generic approval", async () => {
  render(<QuickBooksSettings />);
  expect(await screen.findByText("Dedicated invoice accounting review")).toBeVisible();
  const selectable = screen.getAllByRole("checkbox");
  expect(selectable).toHaveLength(1);
  fireEvent.click(selectable[0]);
  fireEvent.click(screen.getByRole("button", { name: "Approve selected for real QuickBooks" }));
  await waitFor(() => expect(state.fetch).toHaveBeenCalledWith("/api/quickbooks/queue/approve", {
    method: "POST", body: JSON.stringify({ ids: ["plain-customer"] }), responseType: "json",
  }));
});

it("does not offer a review panel using a capability from a different environment", async () => {
  state.capabilityEnvironment = "production";
  render(<QuickBooksSettings />);
  expect(await screen.findByText(/requires accounting review in the connected QuickBooks company/)).toBeVisible();
  expect(screen.queryByText("Dedicated invoice accounting review")).not.toBeInTheDocument();
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
});

it("requires an explicit mapped sales category before approving an estimate", async () => {
  const original = state.fetch.getMockImplementation()!;
  state.fetch.mockImplementation(async (path: string, options?: unknown) => path === "/api/quickbooks/queue"
    ? [{ id: "estimate-approval", entityType: "estimate", localId: "proposal-1", action: "create", status: "pending_approval" }]
    : original(path, options));
  render(<QuickBooksSettings />);
  const category = await screen.findByRole("combobox", { name: "Estimate sales category for proposal-1" });
  fireEvent.click(screen.getByRole("checkbox"));
  const approve = screen.getByRole("button", { name: "Approve selected for real QuickBooks" });
  expect(approve).toBeDisabled();
  fireEvent.change(category, { target: { value: "Labor" } });
  expect(approve).toBeEnabled();
  fireEvent.click(approve);
  await waitFor(() => expect(state.fetch).toHaveBeenCalledWith("/api/quickbooks/queue/approve", {
    method: "POST", body: JSON.stringify({ ids: ["estimate-approval"], estimateCategories: { "estimate-approval": "Labor" } }), responseType: "json",
  }));
});
