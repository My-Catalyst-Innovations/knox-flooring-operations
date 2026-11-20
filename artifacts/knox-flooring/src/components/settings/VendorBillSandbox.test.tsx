import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QuickBooksSettings } from "./QuickBooksSettings";

const { customFetch, operation } = vi.hoisted(() => ({ customFetch: vi.fn(), operation: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({ customFetch }));
vi.mock("@/lib/operations", () => ({ operation }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("records a local supplier bill review without selecting a QuickBooks vendor", async () => {
  const path = "/quickbooks/vendor-bills";
  const preview = {
    mode: "review",
    fingerprint: "reviewed-preview",
    supplier: "Fixture Supply",
    billNumber: "F-500",
    billDate: "2026-11-19",
    totalCents: 49925,
    priceDiffers: true,
    lines: [{
      supplierSku: "00073",
      internalSku: "KF-0073",
      productName: "Oak",
      unit: "box",
      quantity: "10",
      billedUnitCost: "49.925",
      expectedUnitCost: "48.000000",
      priceEffectiveOn: "2026-11-01",
      priceSource: "Vendor agreement",
      priceDiffers: true,
    }],
  };
  const draft = { id: "bill-1", status: "pending_approval", payload: preview };
  customFetch.mockResolvedValueOnce({
    configured: false,
    demoAvailable: false,
    connection: { connected: false, status: "disconnected" },
  }).mockResolvedValueOnce([]);
  operation
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(preview)
    .mockResolvedValueOnce(draft)
    .mockResolvedValueOnce({ ...draft, status: "reviewed" });
  render(<QuickBooksSettings />);

  expect(await screen.findByText("Supplier bills · local review")).toBeVisible();
  expect(operation).toHaveBeenCalledWith(`${path}?mode=review`);
  expect(screen.queryByLabelText("Sandbox vendor ID")).not.toBeInTheDocument();
  const fields = {
    Supplier: "Fixture Supply",
    "Bill number": "F-500",
    "Bill date": "2026-11-19",
    "Source bill total (USD)": "499.25",
    "Supplier SKU": "00073",
    Quantity: "10",
    "Billed unit cost": "49.925",
  };
  Object.entries(fields).forEach(([label, value]) => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview supplier bill" }));
  const queue = await screen.findByRole("button", { name: "Queue for review" });
  expect(screen.getByText("00073 → KF-0073 · Oak")).toBeInTheDocument();
  expect(screen.getByText("2026-11-01 · Vendor agreement")).toBeInTheDocument();
  expect(operation).toHaveBeenLastCalledWith(`${path}/preview`, "POST", {
    mode: "review",
    supplier: "Fixture Supply",
    vendorId: undefined,
    billNumber: "F-500",
    billDate: "2026-11-19",
    billTotal: "499.25",
    lines: [{ supplierSku: "00073", unit: "box", quantity: "10", unitCost: "49.925" }],
  });

  fireEvent.click(queue);
  const record = await screen.findByRole("button", { name: "Record owner review" });
  fireEvent.click(screen.getByText("Bill details"));
  expect(screen.getByText("Bill date 2026-11-19")).toBeVisible();
  expect(screen.getByText(/Quantity 10 · Approved/)).toBeVisible();
  expect(operation).toHaveBeenLastCalledWith(path, "POST", expect.objectContaining({
    mode: "review",
    fingerprint: preview.fingerprint,
  }));
  fireEvent.click(record);

  expect(await screen.findByText("Reviewed in Catalyst Works")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Supplier bill review recorded.");
  expect(screen.queryByText(/Simulated bill|Verified sandbox bill/)).not.toBeInTheDocument();
  expect(operation).toHaveBeenLastCalledWith(`${path}/bill-1/approve`, "POST");
});
