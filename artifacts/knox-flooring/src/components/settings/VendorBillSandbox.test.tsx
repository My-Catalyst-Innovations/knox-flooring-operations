import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QuickBooksSettings } from "./QuickBooksSettings";

const { customFetch, operation, useOperation } = vi.hoisted(() => ({
  customFetch: vi.fn(),
  operation: vi.fn(),
  useOperation: vi.fn(),
}));
vi.mock("@workspace/api-client-react", () => ({ customFetch }));
vi.mock("@/lib/operations", () => ({ operation, useOperation }));

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
    lines: [
      {
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
      },
    ],
  };
  const draft = { id: "bill-1", status: "pending_approval", payload: preview };
  customFetch
    .mockResolvedValueOnce({
      configured: false,
      demoAvailable: false,
      connection: { connected: false, status: "disconnected" },
    })
    .mockResolvedValueOnce([]);
  operation
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(preview)
    .mockResolvedValueOnce(draft)
    .mockResolvedValueOnce({ ...draft, status: "reviewed" });
  render(<QuickBooksSettings />);

  expect(
    await screen.findByText("Supplier bills · local review"),
  ).toBeVisible();
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
  fireEvent.click(
    screen.getByRole("button", { name: "Preview supplier bill" }),
  );
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
    lines: [
      { supplierSku: "00073", unit: "box", quantity: "10", unitCost: "49.925" },
    ],
  });

  fireEvent.click(queue);
  const record = await screen.findByRole("button", {
    name: "Record owner review",
  });
  fireEvent.click(screen.getByText("Bill details"));
  expect(screen.getByText("Bill date 2026-11-19")).toBeVisible();
  expect(screen.getByText(/Quantity 10 · Approved/)).toBeVisible();
  expect(operation).toHaveBeenLastCalledWith(
    path,
    "POST",
    expect.objectContaining({
      mode: "review",
      fingerprint: preview.fingerprint,
    }),
  );
  fireEvent.click(record);

  expect(
    await screen.findByText("Reviewed in Catalyst Works"),
  ).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Supplier bill review recorded.",
  );
  expect(
    screen.queryByText(/Simulated bill|Verified sandbox bill/),
  ).not.toBeInTheDocument();
  expect(operation).toHaveBeenLastCalledWith(`${path}/bill-1/approve`, "POST");
});

const productionStatus = {
  configured: true,
  demoAvailable: false,
  connection: {
    connected: true,
    status: "connected",
    environment: "production",
    realmId: "1111",
    readinessStatus: "connected",
  },
};

it("keeps production posting hidden when the server has not enabled it for this company", async () => {
  customFetch.mockResolvedValueOnce(productionStatus).mockResolvedValueOnce([]);
  useOperation.mockReturnValue({
    data: {
      productionEnabled: true,
      companyName: "Other company",
      companyId: "2222",
    },
  });
  operation.mockResolvedValue([]);
  render(<QuickBooksSettings />);
  expect(
    await screen.findByText("Supplier bills · local review"),
  ).toBeVisible();
  expect(
    screen.queryByText("Supplier bills · QuickBooks Online"),
  ).not.toBeInTheDocument();
  expect(operation).not.toHaveBeenCalledWith(
    "/quickbooks/vendor-bills?mode=production",
  );
});

it("requires the owner to confirm the exact bill and company before production posting", async () => {
  const path = "/quickbooks/vendor-bills";
  const fingerprint = "a".repeat(64);
  const draft = {
    id: "bill-1",
    status: "pending_approval",
    payload: {
      mode: "production",
      fingerprint,
      supplier: "Fixture Supply",
      totalCents: 49925,
      priceDiffers: true,
      quickBooksTarget: { vendorName: "Fixture Supply LLC" },
      quickBooksBill: {
        DocNumber: "F-500",
        TxnDate: "2026-11-19",
        VendorRef: { value: "87" },
      },
      lines: [
        {
          supplierSku: "00073",
          internalSku: "KF-0073",
          productName: "Oak",
          unit: "box",
          quantity: "10",
          billedUnitCost: "49.925",
          expectedUnitCost: "48.000000",
          priceEffectiveOn: "2026-11-01",
          priceSource: "Vendor agreement",
          quickBooksItemId: "723",
          priceDiffers: true,
        },
      ],
    },
  };
  customFetch.mockResolvedValueOnce(productionStatus).mockResolvedValueOnce([]);
  useOperation.mockReturnValue({
    data: {
      productionEnabled: true,
      companyName: "Fixture QuickBooks",
      companyId: "1111",
    },
  });
  operation.mockImplementation((requested: string) =>
    Promise.resolve(
      requested === `${path}?mode=production`
        ? [draft]
        : requested === `${path}/bill-1/approve`
          ? {
              ...draft,
              status: "completed",
              payload: { ...draft.payload, postedId: "520" },
            }
          : [],
    ),
  );
  render(<QuickBooksSettings />);

  const approve = await screen.findByRole("button", {
    name: "Approve and post to QuickBooks Online",
  });
  expect(approve).toBeDisabled();
  expect(
    screen.getByText(/QuickBooks vendor Fixture Supply LLC · ID 87/),
  ).toBeVisible();
  expect(screen.getByText(/QuickBooks item 723/)).toBeVisible();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /for posting to Fixture QuickBooks/ }),
  );
  fireEvent.click(approve);
  expect(await screen.findByText("Verified QuickBooks bill 520")).toBeVisible();
  expect(operation).toHaveBeenLastCalledWith(`${path}/bill-1/approve`, "POST", {
    confirmedFingerprint: fingerprint,
  });
});
