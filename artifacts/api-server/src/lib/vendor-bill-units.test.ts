import { describe, expect, it } from "vitest";
import { convertedSupplierLine, supplierBuyQuantity } from "@workspace/domain";
import { buildVendorBill, vendorBillInput } from "./vendor-bill";

const input = vendorBillInput.parse({
  mode: "production", supplier: "Sample Supply", vendorId: "22", billNumber: "B-701", billDate: "2026-11-20", billTotal: "75.98",
  lines: [{ supplierSku: "A-12", unit: "case", quantity: "2", unitCost: "37.99" }],
});
const mapping = {
  supplierSku: "A-12", productName: "Sample Carpet", internalSku: "CARPET-A", unit: "case",
  expectedUnitCost: "37.99", priceEffectiveOn: "2026-11-01", priceSource: "Price list", quickBooksItemId: "777",
  stockConversion: { unit: "sqft", unitsPerBuyUnit: "24" },
};

describe("supplier purchase units", () => {
  it("preserves supplier quantities and cents while posting the equivalent stock units", () => {
    const result = buildVendorBill(input, [mapping], "22");
    expect(result.totalCents).toBe(7598);
    expect(result.lines[0]).toMatchObject({
      quantity: "2", billedUnitCost: "37.99", unit: "case", stockLine: { quantity: "48", unitCost: "1.582917", unit: "sqft" },
    });
    expect(result.quickBooksBill.Line[0]).toMatchObject({
      Amount: 75.98, ItemBasedExpenseLineDetail: { Qty: 48, UnitPrice: 1.582917, ItemRef: { value: "777" } },
    });
  });

  it("rejects unsupported precision and conversions that would change the reviewed cents", () => {
    expect(supplierBuyQuantity("10", "24")).toBeNull();
    expect(convertedSupplierLine("0.000001", "5", "0.5")).toBeNull();
    expect(convertedSupplierLine("100000", "37.99", "24")).toBeNull();
    const tiny = { ...input, lines: [{ ...input.lines[0], quantity: "0.000001" }] };
    expect(() => buildVendorBill(tiny, [{ ...mapping, stockConversion: { unit: "sqft", unitsPerBuyUnit: "0.5" } }], "22")).toThrow("cannot preserve");
  });
});
