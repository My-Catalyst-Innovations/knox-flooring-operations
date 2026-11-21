import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BinStock, PurchaseOrder, PurchaseReceipt, WarehouseBin } from "@/lib/purchasing";
import type { Product } from "@/lib/types";
import PurchaseOrders from "./purchase-orders";
import WarehouseBins from "./warehouse-bins";

const { customFetch } = vi.hoisted(() => ({ customFetch: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({ customFetch }));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: { id: "staff", role: "operations" } }) }));
vi.mock("@/hooks/use-store", () => ({ useStore: () => ({ products: [product], queryState: { products: {} } }) }));

const product: Product = {
  id: "oak", name: "Sample Oak", sku: "KF-0008", category: "Hardwood", supplier: "Example Supply", color: "", unit: "box",
  cost: 20, price: 30, quantityOnHand: 6, inventoryType: "Inventory", active: true, createdAt: "", updatedAt: "", notes: "",
};
const warehouses = [{ id: "north", name: "North warehouse" }, { id: "south", name: "South warehouse" }];
const bins = [
  { id: "a1", warehouseId: "north", code: "A-01" },
  { id: "a2", warehouseId: "north", code: "A-02" },
  { id: "b1", warehouseId: "south", code: "B-01" },
];
const purchasePath = "/api/inventory/purchase-orders";
const change = (name: string | RegExp, value: string, scope: Pick<typeof screen, "getByLabelText"> = screen) => fireEvent.change(scope.getByLabelText(name), { target: { value } });

function mount(element: React.ReactNode, path: string) {
  window.history.replaceState({}, "", path);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={query}>{element}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.history.replaceState({}, "", "/");
});

it("creates an order and retries a split partial receipt with the original idempotency key", async () => {
  let order: PurchaseOrder | undefined;
  let receipt: PurchaseReceipt | undefined;
  let receiveAttempts = 0;
  const createdAt = "2026-11-20T15:00:00.000Z";
  customFetch.mockImplementation(async (path: string, init: { method: string; body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (path === "/api/inventory/warehouses") return warehouses;
    if (path === "/api/inventory/bins") return bins;
    if (path.startsWith("/api/inventory/supplier-crosswalk?asOf=")) {
      const alias = { productId: product.id, supplier: "example supply", supplierSku: "V-008", latestPrice: { unit: "box", unitCost: "17.324125" } };
      return [
        alias,
        { ...alias, supplier: "Different Supply", supplierSku: "D-008", latestPrice: { unit: "box", unitCost: "30" } },
        { ...alias, supplierSku: "V-AREA", latestPrice: { unit: "sqft", unitCost: "1" } },
        { ...alias, supplier: "Case Supply", supplierSku: "CASE-008", latestPrice: { unit: "case", unitCost: "37.99", stockUnitsPerBuyUnit: "24" } },
      ];
    }
    if (path === `${purchasePath}/po-1/receipts`) return receipt ? [receipt] : [];
    if (path === purchasePath && init.method === "GET") return order ? [order] : [];
    if (path === purchasePath && init.method === "POST") {
      order = {
        id: "po-1", orderNumber: "PO-1001", supplier: body.supplier, warehouseId: body.warehouseId, notes: body.notes, status: "Draft", revision: 1, createdAt, updatedAt: createdAt,
        lines: [{ ...body.lines[0], id: "line-1", productName: product.name, sku: product.sku, unit: product.unit, receivedQuantity: 0 }],
      };
      return order;
    }
    if (path === `${purchasePath}/po-1` && order) {
      order = { ...order, status: body.status, revision: 2 };
      return order;
    }
    if (path === `${purchasePath}/po-1/receive` && order) {
      if (++receiveAttempts === 1) throw new Error("Connection interrupted. Try again.");
      order = { ...order, status: "Partially received", revision: 3, lines: [{ ...order.lines[0], receivedQuantity: 5 }] };
      receipt = { id: "receipt-1", reference: body.reference, receivedAt: createdAt, lines: body.lines.map((item: object, index: number) => ({ ...item, productId: product.id, movementId: `movement-${index}` })) };
      return { order, receipt };
    }
    throw new Error(`Unexpected request ${init.method} ${path}`);
  });

  mount(<PurchaseOrders />, "/inventory/purchase-orders");
  const newOrder = await screen.findByRole("button", { name: "New purchase order" });
  await waitFor(() => expect(newOrder).toBeEnabled());
  fireEvent.click(newOrder);
  change("Supplier", "Example Supply");
  change("Receiving warehouse", "north");
  change("Product 1", product.id);
  change(/Quantity 1/, "10");
  expect(await screen.findByText("Approved supplier price · V-008")).toBeVisible();
  expect(screen.getByLabelText("Unit cost 1")).toHaveValue("17.324125");
  change("Supplier", "Different Supply");
  expect(screen.getByLabelText("Unit cost 1")).toHaveValue("30");
  change("Supplier", "Case Supply");
  expect(screen.getByLabelText("Unit cost 1")).toHaveValue("1.582917");
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Check the supplier unit conversion");
  expect(customFetch.mock.calls.some(([path, init]) => path === purchasePath && init.method === "POST")).toBe(false);
  change(/Quantity 1/, "48");
  expect(screen.getByText(/1 case = 24 box.*Order equivalent 2 case/)).toBeVisible();
  expect(screen.getByText("$75.98")).toBeVisible();
  change(/Quantity 1/, "10");
  change("Supplier", "Example Supply");
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByRole("heading", { name: "PO-1001" })).toBeVisible();
  const create = customFetch.mock.calls.find(([path, init]) => path === purchasePath && init.method === "POST");
  expect(JSON.parse(create?.[1].body)).toMatchObject({ warehouseId: "north", idempotencyKey: expect.any(String), lines: [{ productId: "oak", quantity: 10, unitCost: "17.324125" }] });

  fireEvent.click(screen.getByRole("button", { name: "Mark ordered" }));
  fireEvent.click(await screen.findByRole("button", { name: "Receive shipment" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.queryByRole("option", { name: "B-01" })).not.toBeInTheDocument();
  fireEvent.change(dialog.getByLabelText("Packing slip or reference (optional)"), { target: { value: "Packing 123" } });
  fireEvent.change(dialog.getByLabelText("Received quantity 1"), { target: { value: "3" } });
  fireEvent.change(dialog.getByLabelText("Destination bin 1"), { target: { value: "a1" } });
  fireEvent.click(dialog.getByRole("button", { name: "Split across bins" }));
  fireEvent.change(dialog.getByLabelText("Received quantity 2"), { target: { value: "2" } });
  fireEvent.change(dialog.getByLabelText("Destination bin 2"), { target: { value: "a2" } });
  fireEvent.click(dialog.getByRole("button", { name: "Record receipt" }));
  expect(await dialog.findByRole("alert")).toHaveTextContent("Connection interrupted");
  expect(dialog.getByLabelText("Received quantity 1")).toHaveValue(3);
  fireEvent.click(dialog.getByRole("button", { name: "Record receipt" }));

  expect(await screen.findByText(/Packing 123 ·/)).toBeVisible();
  expect(screen.getByText("KF-0008 · 3 box · A-01")).toBeVisible();
  expect(screen.getByText("KF-0008 · 2 box · A-02")).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel remainder" })).toBeVisible();
  const receiveBodies = customFetch.mock.calls.filter(([path]) => path === `${purchasePath}/po-1/receive`).map(([, init]) => JSON.parse(init.body));
  expect(receiveBodies).toHaveLength(2);
  expect(receiveBodies[1]).toEqual(receiveBodies[0]);
  expect(receiveBodies[0]).toMatchObject({
    revision: 2, reference: "Packing 123", idempotencyKey: expect.any(String),
    lines: [{ lineId: "line-1", quantity: 3, binId: "a1" }, { lineId: "line-1", quantity: 2, binId: "a2" }],
  });
});

it("records an entirely damaged delivery and shows why the order remains open", async () => {
  const timestamp = "2026-11-20T15:00:00.000Z";
  const order: PurchaseOrder = {
    id: "po-damaged", orderNumber: "PO-1002", supplier: "Example Supply", warehouseId: "north", notes: null,
    status: "Ordered", revision: 2, createdAt: timestamp, updatedAt: timestamp,
    lines: [{ id: "line-2", productId: product.id, productName: product.name, sku: product.sku, unit: product.unit, quantity: 5, receivedQuantity: 0, unitCost: "20" }],
  };
  let receipt: PurchaseReceipt | undefined;
  customFetch.mockImplementation(async (path: string, init: { method: string; body?: string }) => {
    if (path === "/api/inventory/warehouses") return warehouses;
    if (path === "/api/inventory/bins") return bins;
    if (path === purchasePath) return [order];
    if (path === `${purchasePath}/${order.id}/receipts`) return receipt ? [receipt] : [];
    if (path === `${purchasePath}/${order.id}/receive`) {
      const body = JSON.parse(init.body!);
      receipt = { id: "damage-1", reference: body.reference, receivedAt: timestamp, lines: [
        { ...body.lines[0], id: "damage-line", productId: product.id, movementId: null, unitCost: null },
      ] };
      return { order, receipt };
    }
    throw new Error(`Unexpected request ${init.method} ${path}`);
  });

  mount(<PurchaseOrders />, "/inventory/purchase-orders?order=po-damaged");
  const receiveShipment = await screen.findByRole("button", { name: "Receive shipment" });
  await waitFor(() => expect(receiveShipment).toBeEnabled());
  fireEvent.click(receiveShipment);
  const dialog = within(screen.getByRole("dialog"));
  change("Damaged quantity", "5", dialog);
  change("Damage note (optional)", "Cartons crushed", dialog);
  fireEvent.click(dialog.getByRole("button", { name: "Record receipt" }));
  expect(await screen.findByText(/5 box damaged/)).toBeVisible();
  expect(screen.getByText("Cartons crushed")).toBeVisible();
  expect(screen.getByRole("button", { name: "Receive shipment" })).toBeEnabled();
  const submit = customFetch.mock.calls.find(([path]) => path === `${purchasePath}/${order.id}/receive`);
  expect(JSON.parse(submit?.[1].body).lines).toEqual([
    { lineId: "line-2", quantity: 0, binId: null, damagedQuantity: 5, damageNote: "Cartons crushed" },
  ]);
});

it("opens a bin by warehouse, creates a new bin, and transfers on-hand stock into it", async () => {
  let warehouseBins = [...bins];
  let stock: BinStock[] = [{ warehouseId: "north", binId: "a1", productId: product.id, onHand: 6 }];
  customFetch.mockImplementation(async (path: string, init: { method: string; body?: string }) => {
    if (path === "/api/inventory/warehouses") return warehouses;
    if (path === "/api/inventory/bins" && init.method === "GET") return warehouseBins;
    if (path === "/api/inventory/bin-stock?warehouseId=north") return stock;
    if (path === "/api/inventory/bins" && init.method === "POST") {
      const bin: WarehouseBin = { id: "a3", ...JSON.parse(init.body!) };
      warehouseBins = [...warehouseBins, bin];
      return bin;
    }
    if (path === "/api/inventory/bin-moves") {
      stock = [{ ...stock[0], onHand: 2 }, { ...stock[0], binId: "a3", onHand: 4 }];
      return { id: "move-1" };
    }
    throw new Error(`Unexpected request ${init.method} ${path}`);
  });

  mount(<WarehouseBins />, "/inventory/bins?warehouse=north&bin=a1");
  expect(await screen.findByRole("link", { name: /KF-0008/ })).toHaveAttribute("href", "/inventory?q=KF-0008");
  expect(screen.queryByRole("option", { name: "B-01" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add bin" }));
  change("Bin code", "A-03");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add bin" }));
  expect(await screen.findByRole("option", { name: "A-03" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Move KF-0008 from A-01" }));
  expect(screen.getByLabelText("From bin")).toHaveValue("a1");
  change("To bin", "a3");
  change(/Quantity/, "4");
  change("Reason", "Consolidate shelf stock");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move stock" }));
  expect(await screen.findByText("Stock move recorded.")).toBeVisible();
  change(/^Bin$/, "a3");
  expect(await screen.findByText("4 box")).toBeVisible();
  const move = customFetch.mock.calls.find(([path]) => path === "/api/inventory/bin-moves");
  expect(JSON.parse(move?.[1].body)).toMatchObject({ warehouseId: "north", productId: "oak", fromBinId: "a1", toBinId: "a3", quantity: 4, idempotencyKey: expect.any(String) });
});
