import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Product } from "@/lib/types";
import { StockCounts } from "./StockCounts";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), role: "operations" }));
vi.mock("@workspace/api-client-react", () => ({ customFetch: mocks.fetch }));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: { id: "tester", role: mocks.role } }) }));

const warehouse = { id: "w1", name: "Main warehouse" };
const bin = { id: "b1", warehouseId: warehouse.id, code: "A-01" };
const product: Product = {
  id: "p1", name: "Oak carton", sku: "OAK-01", category: "Hardwood", color: "", unit: "box", cost: 15, price: 30,
  inventoryType: "Inventory", active: true, supplier: "", quantityOnHand: 10, createdAt: "", updatedAt: "", notes: "",
};
const endpoint = "/api/inventory/stock-counts";
const pending = {
  id: "count1", productId: product.id, warehouseId: warehouse.id, binId: bin.id, productName: product.name, sku: product.sku,
  unit: product.unit, bookedQuantity: 10, countedQuantity: 8, variance: -2, reason: "damage", note: "Two boxes damaged",
  status: "Pending", counterName: "Warehouse employee", createdAt: "2026-11-20T18:00:00Z",
};

function mount() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <StockCounts warehouse={warehouse} bins={[bin]} products={[product]} productsUnavailable={false} />
  </QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Stock counts" }));
}

afterEach(() => {
  cleanup();
  mocks.fetch.mockReset();
  mocks.role = "operations";
});

it("takes a location snapshot and submits an explained count for review", async () => {
  let saved = false;
  mocks.fetch.mockImplementation(async (url: string, init: { method: string }) => {
    if (url === `${endpoint}?warehouseId=w1`) return saved ? [pending] : [];
    if (url === `${endpoint}/snapshot?productId=p1&warehouseId=w1&binId=b1`)
      return { productId: "p1", warehouseId: "w1", binId: "b1", unit: "box", bookedQuantity: 10, snapshotKey: "snapshot-token" };
    if (url === endpoint && init.method === "POST") { saved = true; return pending; }
    throw new Error(`Unexpected operation ${url}`);
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Record count" }));
  fireEvent.change(screen.getByLabelText("Count product"), { target: { value: product.id } });
  fireEvent.change(screen.getByLabelText("Count location"), { target: { value: bin.id } });
  fireEvent.click(screen.getByRole("button", { name: "Start counting" }));
  const counted = await screen.findByLabelText("Physical count (box)");
  fireEvent.change(counted, { target: { value: "8" } });
  expect(screen.getByRole("button", { name: "Submit for review" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Count reason"), { target: { value: "damage" } });
  fireEvent.change(screen.getByLabelText("Count note"), { target: { value: "Two boxes damaged" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
  expect(await screen.findByText(/Awaiting review · Booked 10 · Counted 8/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Review OAK-01" })).toBeNull();
  const submitted = mocks.fetch.mock.calls.find(([url]) => url === endpoint);
  expect(JSON.parse(submitted?.[1].body)).toMatchObject({
    ...{ productId: product.id, warehouseId: warehouse.id, binId: bin.id }, countedQuantity: 8,
    reason: "damage", note: "Two boxes damaged", snapshotKey: "snapshot-token", idempotencyKey: expect.any(String),
  });
});

it("allows the owner to post a reviewed adjustment and see it in history", async () => {
  mocks.role = "owner";
  const posted = { ...pending, status: "Reconciled", reviewerName: "Owner", resolvedAt: "2026-11-20T19:00:00Z" };
  let saved = false;
  mocks.fetch.mockImplementation(async (url: string, init: { method: string }) => {
    if (url === `${endpoint}?warehouseId=w1`) return [saved ? posted : pending];
    if (url === `${endpoint}/${pending.id}/reconcile` && init.method === "POST") { saved = true; return posted; }
    throw new Error(`Unexpected operation ${url}`);
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Review OAK-01" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Two boxes damaged");
  fireEvent.click(screen.getByRole("button", { name: "Post adjustment" }));
  expect(await screen.findByText(/Reconciled · Booked 10 · Counted 8/)).toBeVisible();
  expect(screen.getByText(/Owner ·/)).toBeVisible();
});
