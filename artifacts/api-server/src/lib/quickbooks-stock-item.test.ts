import { describe, expect, it, vi } from "vitest";
import {
  exportSandboxStockItem,
  findSandboxStockItem,
  inventoryProductionAvailable,
  inventorySandboxAvailable,
  prepareSandboxStockItem,
} from "./quickbooks-stock-item";
import { QuickBooksRequestError } from "./quickbooks";

vi.mock("@workspace/db", () => ({ db: {}, quickbooksConnectionsTable: {} }));

const product = {
  id: "product-1",
  name: "Oak cartons",
  sku: "00073",
  active: true,
  inventoryType: "Inventory",
  quantityOnHand: 50,
};
const input = {
  productId: product.id,
  connectionId: "connection-1",
  incomeAccountId: "71",
  cogsAccountId: "72",
  assetAccountId: "73",
  inventoryStartDate: "2026-11-20",
};
const accounts = {
  "/account/71": {
    Id: "71",
    Active: true,
    Name: "Sales income",
    AccountType: "Income",
    AccountSubType: "SalesOfProductIncome",
  },
  "/account/72": {
    Id: "72",
    Active: true,
    Name: "COGS",
    AccountType: "Cost of Goods Sold",
    AccountSubType: "SuppliesMaterialsCogs",
  },
  "/account/73": {
    Id: "73",
    Active: true,
    Name: "Stock value",
    AccountType: "Other Current Asset",
    AccountSubType: "Inventory",
  },
};
const empty = { QueryResponse: {} };
const item = (
  prepared: Awaited<ReturnType<typeof prepareSandboxStockItem>>,
) => ({ ...prepared.document, Id: "74", Active: true, SyncToken: "0" });

describe("sandbox inventory item creation", () => {
  const chartRequest = async (path: string) => ({
    Account: accounts[path as keyof typeof accounts],
  });

  it("requires both a sandbox runtime and a connected sandbox company", () => {
    const sandbox = {
      id: input.connectionId,
      realmId: "11111",
      status: "connected",
      environment: "sandbox",
    };
    expect(inventorySandboxAvailable(sandbox, "sandbox")).toBe(true);
    expect(inventorySandboxAvailable(sandbox, "production")).toBe(false);
    expect(
      inventorySandboxAvailable(
        { ...sandbox, environment: "production" },
        "sandbox",
      ),
    ).toBe(false);
    expect(
      inventorySandboxAvailable(
        { ...sandbox, status: "disconnected" },
        "sandbox",
      ),
    ).toBe(false);
  });

  it("uses the approved accounts, preserves the SKU and dates, and starts at zero", async () => {
    const provider = { request: vi.fn(chartRequest), query: vi.fn() };
    const prepared = await prepareSandboxStockItem(
      product,
      "11111",
      input,
      provider,
    );
    expect(prepared.document).toEqual({
      Name: "Oak cartons",
      Sku: "00073",
      Type: "Inventory",
      TrackQtyOnHand: true,
      QtyOnHand: 0,
      InvStartDate: "2026-11-20",
      IncomeAccountRef: { value: "71" },
      ExpenseAccountRef: { value: "72" },
      AssetAccountRef: { value: "73" },
    });
    expect(prepared.requestId).toHaveLength(50);
    expect(
      (await prepareSandboxStockItem(product, "11111", input, provider))
        .requestId,
    ).toBe(prepared.requestId);
    expect(
      (await prepareSandboxStockItem(product, "22222", input, provider))
        .requestId,
    ).not.toBe(prepared.requestId);
    await expect(
      prepareSandboxStockItem(
        product,
        "11111",
        { ...input, assetAccountId: "74" },
        provider,
      ),
    ).rejects.toThrow(/active Inventory Asset/);
  });

  it("requires a separately configured production realm and keeps the opening stock at zero", async () => {
    const connection = { id: input.connectionId, realmId: "11111", status: "connected", environment: "production" };
    const enabled = { QUICKBOOKS_ENVIRONMENT: "production", QUICKBOOKS_PRODUCTION_STOCK_ITEMS_ENABLED: "true", QUICKBOOKS_PRODUCTION_STOCK_ITEMS_REALM_ID: "11111" };
    expect(inventoryProductionAvailable(connection, {})).toBe(false);
    expect(inventoryProductionAvailable(connection, enabled)).toBe(true);
    expect(inventoryProductionAvailable({ ...connection, realmId: "22222" }, enabled)).toBe(false);
    expect(inventoryProductionAvailable(connection, { ...enabled, DEMO_MODE: "true" })).toBe(false);
    const provider = { request: vi.fn(chartRequest), query: vi.fn() };
    const production = await prepareSandboxStockItem(product, connection.realmId, input, provider, "production");
    const sandbox = await prepareSandboxStockItem(product, connection.realmId, input, provider, "sandbox");
    expect(production.document).toEqual(sandbox.document);
    expect(production.document.QtyOnHand).toBe(0);
    expect(production.requestId).not.toBe(sandbox.requestId);
    expect(production.fingerprint).not.toBe(sandbox.fingerprint);
  });

  it("reconciles a single exact item and blocks case variants, inactive duplicates, and name collisions", async () => {
    const provider = { request: vi.fn(chartRequest), query: vi.fn() };
    const prepared = await prepareSandboxStockItem(
      product,
      "11111",
      input,
      provider,
    );
    const existing = item(prepared);
    provider.query.mockResolvedValueOnce({
      QueryResponse: { Item: [existing] },
    });
    expect(await findSandboxStockItem(prepared, provider)).toEqual(existing);
    expect(provider.query).toHaveBeenCalledWith(
      expect.stringContaining("Active IN (true, false)"),
    );
    for (const conflicting of [
      { ...existing, Active: false },
      { ...existing, Sku: "73" },
      { ...existing, QtyOnHand: 10 },
    ]) {
      provider.query.mockResolvedValueOnce({
        QueryResponse: { Item: [conflicting] },
      });
      await expect(exportSandboxStockItem(prepared, provider)).rejects.toThrow(
        /already uses/,
      );
    }
    provider.query.mockResolvedValueOnce(empty);
    await expect(
      exportSandboxStockItem(prepared, provider, "different-link"),
    ).rejects.toThrow(/saved product link/);
  });

  it("verifies a created item and checks for an exact existing item before replaying an ambiguous POST", async () => {
    const prepared = await prepareSandboxStockItem(product, "11111", input, {
      request: chartRequest,
      query: vi.fn(),
    });
    const posted = item(prepared);
    const query = vi.fn().mockResolvedValue(empty);
    const request = vi
      .fn()
      .mockResolvedValueOnce({ Item: { Id: "74" } })
      .mockResolvedValueOnce({ Item: posted });
    expect(await exportSandboxStockItem(prepared, { query, request })).toEqual({
      item: posted,
      reconciledExisting: false,
    });
    expect(request.mock.calls[0]).toEqual([
      `/item?requestid=${prepared.requestId}`,
      { method: "POST", body: JSON.stringify(prepared.document) },
    ]);
    expect(request.mock.calls[1]).toEqual(["/item/74"]);

    query
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({ QueryResponse: { Item: [posted] } });
    request.mockRejectedValueOnce(new Error("network connection lost"));
    await expect(
      exportSandboxStockItem(prepared, { query, request }),
    ).rejects.toThrow(/network/);
    await expect(
      exportSandboxStockItem(prepared, { query, request }),
    ).resolves.toEqual({ item: posted, reconciledExisting: true });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("looks up a provider duplicate request and rejects altered readback fields", async () => {
    const prepared = await prepareSandboxStockItem(product, "11111", input, {
      request: chartRequest,
      query: vi.fn(),
    });
    const posted = item(prepared);
    const query = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({ QueryResponse: { Item: [posted] } });
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new QuickBooksRequestError(
          "Duplicate ID",
          400,
          "ValidationFault",
          "600",
        ),
      );
    await expect(
      exportSandboxStockItem(prepared, { query, request }),
    ).resolves.toMatchObject({ reconciledExisting: true });
    query.mockResolvedValueOnce(empty);
    request
      .mockResolvedValueOnce({ Item: { Id: "74" } })
      .mockResolvedValueOnce({
        Item: { ...posted, AssetAccountRef: { value: "111" } },
      });
    await expect(
      exportSandboxStockItem(prepared, { query, request }),
    ).rejects.toThrow(/returned QuickBooks item differs/);
  });
});
