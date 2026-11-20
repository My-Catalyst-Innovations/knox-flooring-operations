import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { operation } from "@/lib/operations";
import type { Product } from "@/lib/types";
import { StockActivity } from "./StockActivity";

const product: Product = {
  id: "oak",
  name: "Sample oak",
  sku: "KF-OAK",
  category: "Hardwood",
  supplier: "Fixture Supply",
  color: "",
  unit: "box",
  cost: 48,
  price: 69,
  quantityOnHand: 10,
  inventoryType: "Inventory",
  active: true,
  notes: "",
  createdAt: "",
  updatedAt: "",
};

vi.mock("@/contexts/auth", () => ({
  useAuth: () => ({ user: { role: "operations" } }),
}));
vi.mock("@/hooks/use-store", () => ({
  useStore: () => ({
    jobs: [{ id: "job-1", jobNumber: "JOB-1", customerName: "Fixture" }],
    queryState: { jobs: { isLoading: false, error: null } },
  }),
}));
vi.mock("@/lib/operations", () => ({
  operation: vi.fn(),
  quantity: String,
  useRefreshOperations: () => vi.fn().mockResolvedValue(undefined),
  useOperation: (path: string) => ({
    allowed: true,
    data: path.startsWith("/inventory/reservations?")
      ? [
          {
            id: "reservation-1",
            jobId: "job-1",
            quantity: 3,
            warehouseId: null,
            status: "Active",
            revision: 1,
          },
        ]
      : [],
  }),
}));
vi.mock("./WarehouseTransfers", () => ({ WarehouseTransfers: () => null }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("checks scanner input, blocks a wrong item, and submits the corrected label with the issue", async () => {
  vi.mocked(operation)
    .mockRejectedValueOnce(
      new Error("This label belongs to a different product."),
    )
    .mockResolvedValue(undefined);
  render(<StockActivity product={product} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Action"), {
    target: { value: "consume" },
  });
  fireEvent.change(screen.getByLabelText("Quantity (box)"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("Related job"), {
    target: { value: "job-1" },
  });
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Used for installation" },
  });
  const label = screen.getByRole("textbox", {
    name: "Product label (optional)",
  });
  fireEvent.change(label, { target: { value: "KF-WRONG" } });
  fireEvent.keyDown(label, { key: "Enter" });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "different product",
  );
  expect(
    screen.getByRole("button", { name: "Record activity" }),
  ).toBeDisabled();
  expect(vi.mocked(operation).mock.calls).toEqual([
    [
      "/inventory/verify-product-label",
      "POST",
      { productId: "oak", labelCode: "KF-WRONG" },
    ],
  ]);

  fireEvent.change(label, { target: { value: " 000824 " } });
  fireEvent.click(screen.getByRole("button", { name: "Check label" }));
  expect(await screen.findByText("Label matches Sample oak.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Record activity" }));
  await waitFor(() =>
    expect(operation).toHaveBeenCalledWith(
      "/inventory/movements",
      "POST",
      expect.objectContaining({
        productId: "oak",
        jobId: "job-1",
        kind: "consume",
        labelCode: "000824",
      }),
    ),
  );
  expect(await screen.findByText("Stock activity recorded.")).toBeVisible();
});

it("preserves the manual reservation issue and also accepts a scanned code", async () => {
  vi.mocked(operation).mockResolvedValue(undefined);
  render(<StockActivity product={product} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Record used" }));
  expect(
    await screen.findByText("Reserved stock recorded as used."),
  ).toBeVisible();
  expect(operation).toHaveBeenCalledWith(
    "/inventory/reservations/reservation-1",
    "PATCH",
    { revision: 1, status: "Consumed", labelCode: undefined },
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Product label (optional)" }),
    { target: { value: "MFR-6" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Record used" }));
  await waitFor(() =>
    expect(operation).toHaveBeenLastCalledWith(
      "/inventory/reservations/reservation-1",
      "PATCH",
      { revision: 1, status: "Consumed", labelCode: "MFR-6" },
    ),
  );
  expect(
    screen.queryByText("Label matches Sample oak."),
  ).not.toBeInTheDocument();
});
