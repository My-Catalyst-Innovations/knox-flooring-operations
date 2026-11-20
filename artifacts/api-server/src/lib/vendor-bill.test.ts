import { describe, expect, it, vi } from "vitest";
import {
  buildVendorBill,
  matchesPostedBill,
  reconcileSandboxBill,
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
      reconcileSandboxBill(prepared, "request-identifier", provider),
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
    const request = vi
      .fn()
      .mockImplementation(async (path: string) =>
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
      reconcileSandboxBill(prepared, "request-identifier", { request, query }),
    ).resolves.toEqual({ postedId: "123456", reconciledExisting: true });
    await expect(
      reconcileSandboxBill(prepared, "request-identifier", { request, query }),
    ).rejects.toThrow("different QuickBooks sandbox bill");
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/vendor/0087",
      "/preferences",
      "/vendor/0087",
      "/preferences",
    ]);
  });
});
