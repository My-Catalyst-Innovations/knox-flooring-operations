import { expect, it, vi } from "vitest";
import {
  adjustmentInput,
  exportStockReturnAdjustment,
  prepareStockReturnAdjustment,
  quantityUnits,
  stockAdjustmentsAvailable,
  verifyAdjustmentCompany,
} from "./quickbooks-inventory-reconciliation";

const company = {
  id: "knox-connection",
  environment: "sandbox",
  realmId: "80474",
  status: "connected",
};
const choice = adjustmentInput.parse({
  productId: "oak",
  returnId: "return-2",
  invoiceId: "invoice-30",
  billId: "receipt-50",
  date: "2026-11-22",
  accountId: "35",
  connectionId: company.id,
});
const evidence = {
  received: 50,
  issued: 30,
  returned: 2,
  bill: "buy-doc",
  invoice: "sale-doc",
};
const approved = prepareStockReturnAdjustment(
  company,
  choice,
  { before: 20, target: 22, returned: 2 },
  "81",
  evidence,
);
const item = (quantity: number) => ({
  Item: {
    Id: "81",
    Name: "Oak",
    Type: "Inventory",
    Active: true,
    TrackQtyOnHand: true,
    QtyOnHand: quantity,
  },
});
const record = {
  ...approved.document,
  Id: "456",
  AdjustAccountRef: {
    ...approved.document.AdjustAccountRef,
    name: "Returns offset",
  },
  Line: [
    {
      Id: "1",
      ItemAdjustmentLineDetail:
        approved.document.Line[0].ItemAdjustmentLineDetail,
    },
  ],
};

function callbacks(allowCreate = true) {
  return {
    allowCreate,
    verifyCurrent: vi.fn(async () => {}),
    markSubmitting: vi.fn(async () => {}),
    recordAdjustmentId: vi.fn(async (_id: string) => {}),
  };
}

it("derives +2 from a documented return and rejects guesses about another difference", () => {
  expect(approved.target).toBe(22);
  expect(approved.document.Line[0].ItemAdjustmentLineDetail).toEqual({
    ItemRef: { value: "81" },
    QtyDiff: 2,
  });
  expect(approved.requestId).toHaveLength(50);
  expect(
    prepareStockReturnAdjustment(
      company,
      choice,
      { before: 20, target: 22, returned: 2 },
      "81",
      evidence,
    ),
  ).toEqual(approved);
  expect(
    prepareStockReturnAdjustment(
      company,
      { ...choice, accountId: "36" },
      { before: 20, target: 22, returned: 2 },
      "81",
      evidence,
    ).fingerprint,
  ).not.toBe(approved.fingerprint);
  expect(() =>
    prepareStockReturnAdjustment(
      company,
      choice,
      { before: 20, target: 23, returned: 2 },
      "81",
      evidence,
    ),
  ).toThrow(/entire difference/);
  expect(quantityUnits(0.0000001)).toBeNull();
  expect(quantityUnits(22.000001)).toBe(22000001);
});

it("gates production by realm and confirms the US plan and active expense account", async () => {
  const live = { ...company, environment: "production" };
  const enabled = {
    QUICKBOOKS_ENVIRONMENT: "production",
    QUICKBOOKS_PRODUCTION_INVENTORY_ADJUSTMENTS_ENABLED: "true",
    QUICKBOOKS_PRODUCTION_INVENTORY_ADJUSTMENTS_REALM_ID: company.realmId,
  };
  expect(stockAdjustmentsAvailable(company, {})).toBe(true);
  expect(stockAdjustmentsAvailable(live, {})).toBe(false);
  expect(stockAdjustmentsAvailable(live, enabled)).toBe(true);
  expect(stockAdjustmentsAvailable({ ...live, realmId: "999" }, enabled)).toBe(
    false,
  );
  const account = {
    Id: "35",
    Name: "Returns offset",
    Active: true,
    AccountType: "Cost of Goods Sold",
  };
  const providerCompany = (offering: string, country = "US") => ({
    CompanyInfo: {
      Country: country,
      NameValue: [{ Name: "OfferingSku", Value: offering }],
    },
  });
  const provider = vi
    .fn()
    .mockResolvedValueOnce(providerCompany("QuickBooks Online Plus"))
    .mockResolvedValueOnce({ Account: account });
  await expect(verifyAdjustmentCompany(live, provider, "35")).resolves.toEqual({
    offering: "QuickBooks Online Plus",
    account,
  });
  provider
    .mockResolvedValueOnce(providerCompany("QuickBooks Online Advanced", "CA"))
    .mockResolvedValueOnce({ Account: account });
  await expect(verifyAdjustmentCompany(live, provider, "35")).rejects.toThrow(
    /verified US/,
  );
  provider
    .mockResolvedValueOnce(providerCompany("QuickBooks Online Advanced"))
    .mockResolvedValueOnce({ Account: { ...account, Active: false } });
  await expect(verifyAdjustmentCompany(live, provider, "35")).rejects.toThrow(
    /active QuickBooks/,
  );
});

it("checks the fresh quantity before committing the single submission and confirms readback", async () => {
  const staleProvider = {
    request: vi.fn().mockResolvedValue(item(21)),
    query: vi.fn(),
  };
  const stale = callbacks();
  await expect(
    exportStockReturnAdjustment(approved, staleProvider, stale),
  ).rejects.toThrow(/changed after review/);
  expect(stale.markSubmitting).not.toHaveBeenCalled();
  expect(staleProvider.request.mock.calls).toEqual([["/item/81"]]);

  const provider = {
    query: vi.fn(),
    request: vi
      .fn()
      .mockResolvedValueOnce(item(20))
      .mockResolvedValueOnce({ InventoryAdjustment: { Id: "456" } })
      .mockResolvedValueOnce({ InventoryAdjustment: record })
      .mockResolvedValueOnce(item(22)),
  };
  const controls = callbacks();
  await expect(
    exportStockReturnAdjustment(approved, provider, controls),
  ).resolves.toEqual({
    adjustmentId: "456",
    recovered: false,
    observed: 22,
    target: 22,
    balanceMatches: true,
  });
  expect(controls.markSubmitting).toHaveBeenCalledOnce();
  expect(controls.recordAdjustmentId).toHaveBeenCalledExactlyOnceWith("456");
  expect(provider.request.mock.calls).toEqual([
    ["/item/81"],
    [
      `/inventoryadjustment?requestid=${approved.requestId}`,
      { method: "POST", body: JSON.stringify(approved.document) },
    ],
    ["/inventoryadjustment/456"],
    ["/item/81"],
  ]);
  expect(provider.query).not.toHaveBeenCalled();
});

it("recovers an unconfirmed adjustment through the report and never submits the quantity twice", async () => {
  const report = {
    Header: { ReportName: "TransactionList" },
    Columns: {
      Column: [
        { ColType: "doc_num" },
        { ColType: "tx_date" },
        { ColType: "txn_type" },
      ],
    },
    Rows: {
      Row: [
        {
          Rows: {
            Row: [
              {
                ColData: [
                  { value: approved.document.DocNumber },
                  { value: choice.date },
                  { value: "Inventory Quantity Adjustment", id: "456" },
                ],
              },
            ],
          },
        },
      ],
    },
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce(report)
    .mockResolvedValueOnce({ InventoryAdjustment: record })
    .mockResolvedValueOnce(item(23));
  const provider = { request, query: vi.fn() };
  const controls = callbacks(false);
  await expect(
    exportStockReturnAdjustment(approved, provider, controls),
  ).resolves.toMatchObject({
    adjustmentId: "456",
    recovered: true,
    observed: 23,
    balanceMatches: false,
  });
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    `/reports/TransactionList?start_date=${choice.date}&end_date=${choice.date}&columns=tx_date%2Ctxn_type%2Cdoc_num`,
    "/inventoryadjustment/456",
    "/item/81",
  ]);
  expect(controls.markSubmitting).not.toHaveBeenCalled();
  request.mockRejectedValueOnce(new Error("report temporarily unavailable"));
  await expect(
    exportStockReturnAdjustment(approved, provider, controls),
  ).rejects.toThrow(approved.document.DocNumber);
  request.mockResolvedValueOnce({
    InventoryAdjustment: { ...record, AdjustAccountRef: { value: "36" } },
  });
  await expect(
    exportStockReturnAdjustment(approved, provider, {
      ...controls,
      knownAdjustmentId: "456",
    }),
  ).rejects.toThrow(/differs from the approved/);
  request.mockResolvedValueOnce({
    InventoryAdjustment: {
      ...record,
      Line: [{ ...record.Line[0], DetailType: "OtherType" }],
    },
  });
  await expect(
    exportStockReturnAdjustment(approved, provider, {
      ...controls,
      knownAdjustmentId: "456",
    }),
  ).rejects.toThrow(/differs from the approved/);
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
    false,
  );
});
