import { describe, expect, it, vi } from "vitest";
import {
  buildVendorBill,
  confirmProductionVendorBill,
  matchesPostedBill,
  productionVendorBillsAvailable,
  reconcileQuickBooksVendorBill,
  reviewVendorBill,
  vendorBillInput,
} from "./vendor-bill";

const input = vendorBillInput.parse({
  mode: "sandbox",
  supplier: "Fixture Supply",
  vendorId: "0087",
  billNumber: "F-500",
  billDate: "2026-11-19",
  billTotal: "499.25",
  lines: [
    { supplierSku: "00073", unit: "BOX", quantity: "10", unitCost: "49.925" },
  ],
});
const mapping = [
  {
    supplierSku: "00073",
    productName: "Oak",
    internalSku: "KF-0073",
    unit: "box",
    expectedUnitCost: "48.000000",
    priceEffectiveOn: "2026-11-01",
    priceSource: "Vendor agreement",
    quickBooksItemId: "9130357829826776",
  },
];

describe("supplier bill purchase reconciliation", () => {
  it("requires explicit production enablement, a matching connected company, and an exact approval", () => {
    const connection = {
      environment: "production",
      status: "connected",
      realmId: "1111",
    };
    const configured = {
      QUICKBOOKS_ENVIRONMENT: "production",
      QUICKBOOKS_PRODUCTION_VENDOR_BILLS_ENABLED: "true",
      QUICKBOOKS_PRODUCTION_VENDOR_BILLS_REALM_ID: "1111",
    };
    expect(productionVendorBillsAvailable(connection, {})).toBe(false);
    expect(productionVendorBillsAvailable(connection, configured)).toBe(true);
    expect(
      productionVendorBillsAvailable(connection, {
        ...configured,
        DEMO_MODE: "true",
      }),
    ).toBe(false);
    expect(
      productionVendorBillsAvailable(connection, {
        ...configured,
        QUICKBOOKS_ENVIRONMENT: "sandbox",
      }),
    ).toBe(false);
    expect(
      productionVendorBillsAvailable(
        { ...connection, realmId: "2222" },
        configured,
      ),
    ).toBe(false);
    expect(
      productionVendorBillsAvailable(
        { ...connection, environment: "sandbox" },
        configured,
      ),
    ).toBe(false);
    expect(
      productionVendorBillsAvailable(
        { ...connection, status: "disconnected" },
        configured,
      ),
    ).toBe(false);
    const fingerprint = "a".repeat(64);
    expect(() =>
      confirmProductionVendorBill(
        { confirmedFingerprint: fingerprint },
        fingerprint,
      ),
    ).not.toThrow();
    expect(() => confirmProductionVendorBill(undefined, fingerprint)).toThrow(
      "confirm this exact bill",
    );
    expect(() =>
      confirmProductionVendorBill(
        { confirmedFingerprint: "b".repeat(64) },
        fingerprint,
      ),
    ).toThrow("confirm this exact bill");
  });

  it("reviews dated purchase prices and exact totals without QuickBooks identifiers", () => {
    const reviewInput = vendorBillInput.parse({
      ...input,
      mode: "review",
      vendorId: undefined,
    });
    const localMapping = [
      {
        supplierSku: "00073",
        productName: "Oak",
        internalSku: "KF-0073",
        unit: "box",
        expectedUnitCost: "48.000000",
        priceEffectiveOn: "2026-11-01",
        priceSource: "Vendor agreement",
      },
    ];

    expect(reviewVendorBill(reviewInput, localMapping)).toEqual({
      supplier: "Fixture Supply",
      totalCents: 49925,
      priceDiffers: true,
      lines: [
        {
          ...localMapping[0],
          quantity: "10",
          billedUnitCost: "49.925",
          totalCents: 49925,
          priceDiffers: true,
        },
      ],
    });
    expect(() =>
      reviewVendorBill({ ...reviewInput, billTotal: "499.24" }, localMapping),
    ).toThrow("source bill total");
    expect(() =>
      reviewVendorBill(reviewInput, [{ ...localMapping[0], unit: "sqft" }]),
    ).toThrow("purchase unit");
  });

  it("preserves the approved lot's price context and sends the exact source bill amount and item ID", () => {
    const review = buildVendorBill(input, mapping, input.vendorId!);
    expect(review.priceDiffers).toBe(true);
    expect(review.totalCents).toBe(49925);
    expect(review.lines[0]).toMatchObject({
      expectedUnitCost: "48.000000",
      billedUnitCost: "49.925",
      priceSource: "Vendor agreement",
    });
    expect(review.quickBooksBill.Line[0]).toEqual({
      Amount: 499.25,
      DetailType: "ItemBasedExpenseLineDetail",
      Description: "Oak (00073)",
      ItemBasedExpenseLineDetail: {
        ItemRef: { value: "9130357829826776" },
        Qty: 10,
        UnitPrice: 49.925,
      },
    });
  });

  it("rejects bad units, totals, and bill numbers that are unsafe in provider queries", () => {
    expect(() =>
      buildVendorBill({ ...input, billTotal: "480" }, mapping, "0087"),
    ).toThrow("source bill total");
    expect(() =>
      buildVendorBill(input, [{ ...mapping[0], unit: "sqft" }], "0087"),
    ).toThrow("purchase unit");
    expect(
      vendorBillInput.safeParse({ ...input, billNumber: "'other'" }).success,
    ).toBe(false);
  });

  it("verifies line and counterparty read-back before reporting a sandbox post as complete", () => {
    const prepared = buildVendorBill(input, mapping, "0087").quickBooksBill;
    const posted = { ...prepared, Id: "123456", TotalAmt: 499.25 };
    expect(matchesPostedBill(prepared, posted)).toBe(true);
    expect(
      matchesPostedBill(prepared, { ...posted, VendorRef: { value: "5" } }),
    ).toBe(false);
    expect(matchesPostedBill(prepared, { ...posted, TotalAmt: 480 })).toBe(
      false,
    );
    expect(
      matchesPostedBill(prepared, { ...posted, CurrencyRef: { value: "CAD" } }),
    ).toBe(false);
    expect(
      matchesPostedBill(prepared, {
        ...posted,
        Line: [
          ...prepared.Line,
          { DetailType: "AccountBasedExpenseLineDetail", Amount: 0 },
        ],
      }),
    ).toBe(false);
    expect(
      matchesPostedBill(prepared, {
        ...posted,
        Line: [
          {
            ...posted.Line[0],
            ItemBasedExpenseLineDetail: {
              ...posted.Line[0].ItemBasedExpenseLineDetail,
              UnitPrice: 48,
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("posts to the sandbox with a stable request ID, then reads the inserted bill back", async () => {
    const prepared = buildVendorBill(input, mapping, "0087").quickBooksBill;
    const provider = {
      query: vi.fn().mockResolvedValue({ QueryResponse: {} }),
      request: vi
        .fn()
        .mockResolvedValueOnce({ Vendor: { Id: "0087" } })
        .mockResolvedValueOnce({
          Preferences: { CurrencyPrefs: { HomeCurrency: { value: "USD" } } },
        })
        .mockResolvedValueOnce({
          Item: { Id: mapping[0].quickBooksItemId, Type: "Inventory" },
        })
        .mockResolvedValueOnce({ Bill: { Id: "123456" } })
        .mockResolvedValueOnce({
          Bill: { ...prepared, Id: "123456", TotalAmt: 499.25 },
        }),
    };
    await expect(
      reconcileQuickBooksVendorBill(prepared, "request-identifier", provider),
    ).resolves.toEqual({ postedId: "123456", reconciledExisting: false });
    expect(provider.query).toHaveBeenCalledWith(
      "select * from Bill where DocNumber = 'F-500' and VendorRef = '0087'",
    );
    expect(provider.request).toHaveBeenNthCalledWith(
      4,
      "/bill?requestid=request-identifier",
      { method: "POST", body: JSON.stringify(prepared) },
    );
    expect(provider.request).toHaveBeenNthCalledWith(5, "/bill/123456");
  });

  it("reconciles an identical existing bill and rejects a conflicting one without a second POST", async () => {
    const prepared = buildVendorBill(input, mapping, "0087").quickBooksBill;
    const returned = { ...prepared, Id: "123456", TotalAmt: 499.25 };
    const request = vi.fn().mockImplementation(async (path: string) =>
      path.startsWith("/vendor/")
        ? { Vendor: { Id: "0087" } }
        : {
            Preferences: {
              CurrencyPrefs: { HomeCurrency: { value: "USD" } },
            },
          },
    );
    const query = vi
      .fn()
      .mockResolvedValueOnce({ QueryResponse: { Bill: [returned] } })
      .mockResolvedValueOnce({
        QueryResponse: { Bill: [{ ...returned, TotalAmt: 480 }] },
      });
    await expect(
      reconcileQuickBooksVendorBill(prepared, "request-identifier", {
        request,
        query,
      }),
    ).resolves.toEqual({ postedId: "123456", reconciledExisting: true });
    await expect(
      reconcileQuickBooksVendorBill(prepared, "request-identifier", {
        request,
        query,
      }),
    ).rejects.toThrow("different QuickBooks bill");
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks production posting if the reviewed vendor or currency options changed", async () => {
    const prepared = buildVendorBill(input, mapping, "0087").quickBooksBill;
    const query = vi.fn().mockResolvedValue({ QueryResponse: {} });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        Vendor: { Id: "0087", DisplayName: "Fixture Supply" },
      })
      .mockResolvedValueOnce({
        Preferences: {
          CurrencyPrefs: {
            MultiCurrencyEnabled: true,
            HomeCurrency: { value: "USD" },
          },
        },
      });
    await expect(
      reconcileQuickBooksVendorBill(
        prepared,
        "request-identifier",
        { request, query },
        { vendorName: "Fixture Supply", includeCurrency: false },
      ),
    ).rejects.toThrow("changed after review");
    expect(request.mock.calls).toEqual([["/vendor/0087"], ["/preferences"]]);
  });

  it("reconciles after a lost create response without issuing a second write", async () => {
    const prepared = buildVendorBill(
      { ...input, mode: "production" },
      mapping,
      "0087",
    ).quickBooksBill;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        Vendor: { Id: "0087", DisplayName: "Fixture Supply" },
      })
      .mockResolvedValueOnce({
        Preferences: { CurrencyPrefs: { HomeCurrency: { value: "USD" } } },
      })
      .mockResolvedValueOnce({
        Item: { Id: mapping[0].quickBooksItemId, Type: "Inventory" },
      })
      .mockRejectedValueOnce(new Error("connection lost"));
    const query = vi
      .fn()
      .mockResolvedValueOnce({ QueryResponse: {} })
      .mockResolvedValueOnce({
        QueryResponse: { Bill: [{ ...prepared, Id: "520", TotalAmt: 499.25 }] },
      });
    const target = { vendorName: "Fixture Supply", includeCurrency: false };
    await expect(
      reconcileQuickBooksVendorBill(
        prepared,
        "request-identifier",
        { request, query },
        target,
      ),
    ).rejects.toThrow("connection lost");
    await expect(
      reconcileQuickBooksVendorBill(
        prepared,
        "request-identifier",
        { request, query },
        target,
      ),
    ).resolves.toEqual({ postedId: "520", reconciledExisting: true });
    expect(
      request.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toEqual([
      [
        "/bill?requestid=request-identifier",
        { method: "POST", body: JSON.stringify(prepared) },
      ],
    ]);
  });
});
