import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import WarehouseBins from "./warehouse-bins";

vi.mock("@/hooks/use-store", () => ({
  useStore: () => ({
    jobs: [],
    products: [],
    queryState: { products: { isLoading: false, error: null } },
  }),
}));
vi.mock("@/lib/operations", async (original) => ({
  ...(await original<typeof import("@/lib/operations")>()),
  useRefreshOperations: () => vi.fn(),
  useOperation: (path: string) => ({
    allowed: true,
    isLoading: false,
    isError: false,
    data:
      path === "/inventory/warehouses"
        ? [
            { id: "office", name: "Office warehouse" },
            { id: "remote", name: "Remote warehouse" },
          ]
        : path === "/inventory/bins"
          ? [{ id: "shelf-7", warehouseId: "remote", code: "S-07" }]
          : [],
  }),
}));

afterEach(cleanup);

it("opens an exact scanned bin in its warehouse and prints the same stable location code", () => {
  window.history.replaceState({}, "", "/inventory/bins");
  render(<WarehouseBins />);
  fireEvent.change(screen.getByLabelText("Scan a location label"), {
    target: { value: "BIN:shelf-7" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open location" }));
  expect(screen.getByLabelText("Warehouse", { exact: true })).toHaveValue(
    "remote",
  );
  expect(screen.getByLabelText("Bin", { exact: true })).toHaveValue("shelf-7");
  fireEvent.click(screen.getByRole("button", { name: "Print bin label" }));
  const preview = within(screen.getByRole("dialog", { name: "Bin label" }));
  expect(preview.getByText("S-07")).toBeVisible();
  expect(
    preview.getByRole("img", { name: "Code 128 barcode for BIN:shelf-7" }),
  ).toBeVisible();
});
