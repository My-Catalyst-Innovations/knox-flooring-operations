import { describe, expect, it } from "vitest";
import { calculateEstimate, invoiceLineAmount, invoiceSubtotal, type EstimateInput } from "@workspace/domain";
import { acceptedQuoteInvoice, sellingQuoteLines } from "./quote-lines";

describe("reviewed selling-price line allocation", () => {
  it("includes labor and allowances and reconciles fractional quantities to the cent", () => {
    const input: EstimateInput = {
      customerName: "Customer",
      city: "Knoxville",
      flooringType: "Tile",
      rooms: [{ id: "room", name: "Bath", length: 12.2, width: 8.7 }],
      wastePercent: 12,
      laborRate: 4.85,
      targetMarginPercent: 35,
      lines: [
        {
          productId: "tile",
          name: "Tile",
          sku: "T1",
          unit: "sqft",
          cost: 3.12,
          price: 4.9,
          coveragePerUnit: 1,
          orderMultiple: 0.01,
          minimumOrderQty: 0,
        },
      ],
      allowances: [{ id: "prep", name: "Subfloor preparation", cost: 247.15 }],
      notes: "",
      policyVersion: 1,
    };
    const estimate = calculateEstimate(input);
    const lines = sellingQuoteLines(estimate);
    expect(lines).toHaveLength(3);
    expect(
      Math.round(
        lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0) *
          100,
      ),
    ).toBe(Math.round(estimate.sellingPrice * 100));
    expect(
      Math.round(lines.reduce((sum, line) => sum + line.lineTotal!, 0) * 100),
    ).toBe(Math.round(estimate.sellingPrice * 100));
    expect(
      lines.every((line) => !("cost" in line) && !("totalCost" in line)),
    ).toBe(true);
    expect(lines[0].productId).toBe("tile");
    expect(lines[1].productId).toBeUndefined();
    const invoice = acceptedQuoteInvoice({
      lineItems: lines,
      estimatedPrice: estimate.sellingPrice,
      scopeOfWork: "Bathroom flooring",
      flooringType: "Tile",
    });
    expect(invoice.lineItems.map(invoiceLineAmount)).toEqual(lines.map((line) => line.lineTotal));
    expect(invoice.lineItems.map((line) => line.unitPrice)).toEqual(lines.map((line) => line.unitPrice));
    expect(invoice.lineItems.map((line) => line.quantity)).toEqual(lines.map((line) => line.quantity));
    expect(invoice.lineItems[0]).toMatchObject({ description: "Tile (sqft)", productId: "tile", sku: "T1" });
    expect(invoice.lineItems[1].category).toBe("Labor");
    expect(invoice.lineItems[1]).not.toHaveProperty("productId");
    expect(invoice).toMatchObject({
      subtotal: estimate.sellingPrice,
      taxableAmount: estimate.sellingPrice,
      total: estimate.sellingPrice,
      discountAmount: 0,
      balanceAmount: estimate.sellingPrice,
    });
  });

  const contract = { flooringType: "Vinyl", scopeOfWork: "Replace kitchen flooring" };
  const material = { id: "box", name: "Flooring", unit: "box", quantity: 3, unitPrice: 44 };

  it("fills the remaining scope when a legacy quote only itemizes materials", () => {
    const invoice = acceptedQuoteInvoice({ ...contract, estimatedPrice: 200, lineItems: [material] });
    expect(invoice.lineItems).toMatchObject([
      { description: "Flooring (box)", quantity: 3, unitPrice: 44 },
      { description: "Remaining quoted scope", quantity: 1, unitPrice: 68 },
    ]);
    expect(invoice).toMatchObject({ subtotal: 200, discountAmount: 0, total: 200 });
  });

  it("honors displayed historical line amounts and reconciles the accepted discount", () => {
    const invoice = acceptedQuoteInvoice({
      ...contract,
      estimatedPrice: 110,
      lineItems: [{ ...material, lineTotal: 130 }],
    });
    expect(invoice.lineItems).toHaveLength(1);
    expect(invoiceLineAmount(invoice.lineItems[0])).toBe(130);
    expect(invoice).toMatchObject({ subtotal: 130, discountAmount: 20, taxableAmount: 110, total: 110 });
  });

  it("retains one contract line for unitemized legacy quotes", () => {
    const invoice = acceptedQuoteInvoice({ ...contract, estimatedPrice: 200.25, lineItems: [] });
    expect(invoice.lineItems).toMatchObject([
      { description: contract.scopeOfWork, quantity: 1, unitPrice: 200.25 },
    ]);
    expect(invoice).toMatchObject({ subtotal: 200.25, discountAmount: 0, total: 200.25 });
  });

  it("rounds each fractional line to the cent shown on the invoice", () => {
    const line = { quantity: 1, unitPrice: 1.005 };
    expect(invoiceLineAmount(line)).toBe(1.01);
    expect(invoiceSubtotal([line, line])).toBe(2.02);
  });
});
