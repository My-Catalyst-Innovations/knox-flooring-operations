import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { StagnantInventoryReport } from "./StagnantInventoryReport";

const { useOperation } = vi.hoisted(() => ({ useOperation: vi.fn() }));
vi.mock("@/lib/operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations")>()),
  useOperation,
}));

it("opens the SKU and warehouse records contributing to each overlapping window", () => {
  const fixture = {
    active: true,
    productName: "Synthetic tile",
    unit: "box",
    onHand: 3,
    lastMovedOn: "2026-08-10",
    receiptValue: 22,
    estimatedValue: 6,
  };
  useOperation.mockReturnValue({
    data: {
      asOfDate: "2026-11-20",
      unknownMovementLocations: 0,
      windows: [30, 60, 90].map((days) => ({
        days,
        locations: days === 30 ? 2 : 1,
        receiptValue: 22,
        estimatedValue: 6,
        unvaluedLocations: 0,
      })),
      records: [
        {
          ...fixture,
          productId: "product-1",
          sku: "OLD-1",
          warehouseId: "office west",
          warehouseName: "West office",
          inactiveDays: 91,
          incompleteValue: false,
        },
        {
          ...fixture,
          productId: "product-2",
          sku: "OLD-2",
          active: false,
          warehouseId: null,
          warehouseName: null,
          inactiveDays: 30,
          incompleteValue: true,
        },
      ],
    },
  });
  render(<StagnantInventoryReport />);

  const recent = screen
    .getByText("View SKU locations inactive 30+ days (2)")
    .closest("details")!;
  const oldest = screen
    .getByText("View SKU locations inactive 90+ days (1)")
    .closest("details")!;
  recent.open = true;
  oldest.open = true;
  expect(within(oldest).getByRole("link")).toHaveAttribute(
    "href",
    "/inventory?q=OLD-1&warehouse=office+west",
  );
  expect(
    within(oldest).getByText(/Receipt cost \$22\.00 · Estimated \$6\.00/),
  ).toBeVisible();
  expect(within(recent).getByRole("link", { name: /OLD-2/ })).toHaveAttribute(
    "href",
    "/inventory?q=OLD-2&warehouse=unassigned&state=archived",
  );
  expect(within(recent).getByText(/Value incomplete/)).toBeVisible();
});
