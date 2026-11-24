import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuickBooksSettings } from "./QuickBooksSettings";

const state = vi.hoisted(() => ({
  fetch: vi.fn(), toast: vi.fn(), environment: "sandbox", capabilityEnvironment: "sandbox",
}));
vi.mock("@workspace/api-client-react", () => ({ customFetch: state.fetch }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }) }));
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

it("blocks new OAuth for a legacy stopped grant and offers only an available explicit retry", async () => {
  const original = state.fetch.getMockImplementation()!;
  state.fetch.mockImplementation(async (path: string, options?: unknown) => {
    if (path === "/api/quickbooks/status") return { configured: true, demoAvailable: false, connection: { connected: false, status: "disconnected", readinessStatus: "disconnected", revocationRetryAvailable: true } };
    if (path === "/api/quickbooks/disconnect") return { revocation: "not_requested", message: "No confirmed outcome is recorded." };
    return original(path, options);
  });
  render(<QuickBooksSettings />);
  const connect = await screen.findByRole("button", { name: "Connect a real company" }); expect(connect).toBeDisabled();
  const retry = screen.getByRole("button", { name: "Retry revocation" }); expect(retry).toBeEnabled(); fireEvent.click(retry);
  await waitFor(() => expect(state.fetch).toHaveBeenCalledWith("/api/quickbooks/disconnect", { method: "POST", body: JSON.stringify({ retryRevocation: true }), responseType: "json" }));
  expect(state.fetch.mock.calls.some(([path]) => path === "/api/quickbooks/connect")).toBe(false);
});

it("does not claim retry is available for an erased or unavailable stopped grant", async () => {
  const original = state.fetch.getMockImplementation()!;
  state.fetch.mockImplementation(async (path: string, options?: unknown) => path === "/api/quickbooks/status" ? { configured: true, demoAvailable: false, connection: { connected: false, status: "disconnected", readinessStatus: "disconnected", revocationRetryAvailable: false } } : original(path, options));
  render(<QuickBooksSettings />); expect(await screen.findByRole("button", { name: "Connect a real company" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Retry revocation" })).toBeDisabled();
  expect(screen.getByText(/retained grant cannot currently be retried safely/)).toBeInTheDocument();
  expect(state.fetch.mock.calls.some(([path]) => path === "/api/quickbooks/disconnect")).toBe(false);
});

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

it("shows an unconfirmed Intuit revocation and offers only an explicit same-grant retry", async () => {
  const original = state.fetch.getMockImplementation()!;
  let stopped = false;
  state.fetch.mockImplementation(async (path: string, options?: unknown) => {
    if (path === "/api/quickbooks/disconnect") { stopped = true; return { revocation: "unknown", message: "Intuit did not confirm revocation." }; }
    if (path === "/api/quickbooks/status" && stopped) return { configured: true, demoAvailable: false, connection: { connected: false, status: "disconnected", readinessStatus: "revocation_unknown" } };
    return original(path, options);
  });
  render(<QuickBooksSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  expect(await screen.findByText(/Works has stopped using this connection/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Connect a real company" })).toBeDisabled();
  expect(state.toast).toHaveBeenCalledWith({ title: "Intuit revocation not confirmed", description: "Intuit did not confirm revocation." });
  fireEvent.click(screen.getByRole("button", { name: "Retry revocation" }));
  await waitFor(() => expect(state.fetch).toHaveBeenCalledWith("/api/quickbooks/disconnect", { method: "POST", body: JSON.stringify({ retryRevocation: true }), responseType: "json" }));
});

it("claims provider revocation only after an explicit confirmed response", async () => {
  const original = state.fetch.getMockImplementation()!;
  let stopped = false;
  state.fetch.mockImplementation(async (path: string, options?: unknown) => {
    if (path === "/api/quickbooks/disconnect") { stopped = true; return { revocation: "confirmed", message: "Intuit confirmed revocation." }; }
    if (path === "/api/quickbooks/status" && stopped) return { configured: true, demoAvailable: false, connection: { connected: false, status: "disconnected", readinessStatus: "revocation_confirmed" } };
    return original(path, options);
  });
  render(<QuickBooksSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  expect(await screen.findByText(/Existing accounting history has been preserved/)).toBeVisible();
  expect(state.toast).toHaveBeenCalledWith({ title: "QuickBooks access revoked", description: "Intuit confirmed revocation." });
  expect(screen.getByRole("button", { name: "Connect a real company" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Retry revocation" })).not.toBeInTheDocument();
});
