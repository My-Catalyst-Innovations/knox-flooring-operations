import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Product } from "@/lib/types";
import Inventory from "./inventory";

const testProduct = (id: string, name: string, sku: string): Product => ({
  id,
  name,
  sku,
  category: "Hardwood",
  supplier: "Sample supply",
  color: "",
  unit: "box",
  cost: 20,
  price: 35,
  quantityOnHand: 8,
  inventoryType: "Inventory",
  active: true,
  notes: "",
  createdAt: "",
  updatedAt: "",
});
const oak = { ...testProduct("oak", "Sample oak", "KF-OAK"), reorderPoint: 4 };
const ash = testProduct("ash", "Sample ash", "KF-ASH");
const warehouses = [
  { id: "north", name: "North warehouse" },
  { id: "south", name: "South warehouse" },
];
const aliases = [{ productId: oak.id, supplierSku: "000824", manufacturerPartNumber: "MFR-NORTH-6" }];
const balances = [
  {
    productId: oak.id,
    onHand: 8,
    reserved: 3,
    available: 5,
    locations: [
      { warehouseId: "north", onHand: 6, reserved: 3, available: 3 },
      { warehouseId: null, onHand: 2, reserved: 0, available: 2 },
      { warehouseId: "south", onHand: 0, reserved: 0, available: 0 },
    ],
  },
  {
    productId: ash.id,
    onHand: 8,
    reserved: 0,
    available: 8,
    locations: [{ warehouseId: "south", onHand: 8, reserved: 0, available: 8 }],
  },
];

vi.mock("@/contexts/auth", () => ({
  useAuth: () => ({ user: { role: "operations" } }),
}));
vi.mock("@/hooks/use-store", () => ({
  useStore: () => ({
    products: [oak, ash],
    queryState: { products: { isLoading: false, error: null } },
  }),
}));
vi.mock("@/lib/operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations")>()),
  useOperation: (path: string) => ({
    data: path === "/inventory/warehouses" ? warehouses : path === "/inventory/supplier-crosswalk" ? aliases : balances,
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("@/components/inventory/ProductDialog", () => ({
  ProductDialog: () => null,
}));
vi.mock("@/components/inventory/WarehouseSetup", () => ({
  WarehouseSetup: () => null,
}));

afterEach(cleanup);

it("locates a SKU, shows unassigned balance, and lists products by warehouse", () => {
  window.history.replaceState({}, "", "/inventory");
  render(<Inventory />);

  fireEvent.change(
    screen.getByLabelText("Search inventory"),
    {
      target: { value: "KF-OAK" },
    },
  );
  expect(
    screen.getAllByText(
      "North warehouse · 3 available · 6 on hand · 3 reserved",
    ),
  ).toHaveLength(2);
  expect(
    screen.getAllByText("Unassigned · 2 available · 2 on hand · 0 reserved"),
  ).toHaveLength(2);
  expect(screen.queryByText(ash.name)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  fireEvent.change(screen.getByLabelText("Warehouse"), {
    target: { value: "south" },
  });
  expect(screen.getAllByText(ash.name)).toHaveLength(2);
  expect(screen.queryByText(oak.name)).not.toBeInTheDocument();
});

it("finds the warehouse balance by supplier SKU and manufacturer part number", () => {
  window.history.replaceState({}, "", "/inventory");
  render(<Inventory />);

  const search = screen.getByLabelText("Search inventory");
  for (const value of ["000824", "mfr-north-6"]) {
    fireEvent.change(search, { target: { value } });
    expect(screen.getAllByText(oak.name)).toHaveLength(2);
    expect(screen.queryByText(ash.name)).not.toBeInTheDocument();
    expect(screen.getAllByText("North warehouse · 3 available · 6 on hand · 3 reserved")).toHaveLength(2);
  }
});

it("flags low stock from available warehouse units after reservations", () => {
  window.history.replaceState({}, "", "/inventory?q=KF-OAK");
  render(<Inventory />);
  expect(screen.getAllByText("In Stock")).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("Warehouse"), { target: { value: "north" } });
  expect(screen.getAllByText("Low Stock")).toHaveLength(2);
});

it("includes depleted warehouse stock in the reorder list", () => {
  window.history.replaceState({}, "", "/inventory?warehouse=south");
  render(<Inventory />);
  expect(screen.queryByText(oak.name)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Reorder attention/ }));
  expect(screen.getAllByText(oak.name)).toHaveLength(2);
  expect(screen.getAllByText("Out of Stock")).toHaveLength(2);
});
