import { describe, expect, it } from "vitest";
import { GetPublicJobResponse, UpdateInvoiceBody } from "@workspace/api-zod";
import { assertQuickBooksCompanyLink, quickBooksInvoiceLines } from "./quickbooks-invoice";

const line = {
  id: "line",
  productId: "stable-product-id",
  sku: "TILE-42",
  description: "Tile (box)",
  category: "Materials" as const,
  quantity: 3,
  unitPrice: 23.4567,
};
const exportable = {
  lineItems: [line],
  total: 70.37,
  discountAmount: 0,
  taxAmount: 0,
  depositAmount: 0,
};
const links = new Map([[line.productId, "123"], [line.sku, "999"]]);

describe("QuickBooks invoice lines", () => {
  it("uses the linked product ID with the invoice's negotiated rate and line amount", () => {
    expect(quickBooksInvoiceLines(exportable, links)).toEqual([
      {
        Amount: 70.37,
        DetailType: "SalesItemLineDetail",
        Description: "Tile (box)",
        SalesItemLineDetail: {
          ItemRef: { value: "123" },
          Qty: 3,
          UnitPrice: 23.4567,
        },
      },
    ]);
  });

  it("rejects missing item links and never falls back to SKU or placeholder item values", () => {
    expect(() => quickBooksInvoiceLines(exportable, new Map([[line.sku, "999"]])))
      .toThrow(/Link TILE-42.*Import & reconcile/);
    expect(() => quickBooksInvoiceLines(exportable, new Map([[line.productId, "SIM-id"]])))
      .toThrow(/Link TILE-42/);
  });

  it("blocks unmapped service lines whose charge QuickBooks would ignore", () => {
    expect(() => quickBooksInvoiceLines({
      ...exportable,
      lineItems: [...exportable.lineItems, { ...line, productId: undefined, description: "Labor", quantity: 1, unitPrice: 100 }],
      total: 170.37,
    }, links)).toThrow(/Labor.*approved QuickBooks service item/);
  });

  it.each([
    [{ depositAmount: 20 }, /deposit.*No payment was created/],
    [{ taxAmount: 2 }, /invoice tax/],
    [{ discountAmount: 5 }, /invoice discounts/],
    [{ total: 50 }, /total does not match/],
  ] as const)("blocks an unsupported invoice balance adjustment %o", (change, error) => {
    expect(() => quickBooksInvoiceLines({ ...exportable, ...change }, links)).toThrow(error);
  });

  it("preserves private identity in the edit contract and excludes it from the public invoice", () => {
    const { productId, sku, ...legacyLine } = line;
    const invoiceLine = GetPublicJobResponse.shape.invoices.unwrap().element.shape.lineItems.element;
    expect(UpdateInvoiceBody.parse({ lineItems: [line, legacyLine] }).lineItems).toEqual([line, legacyLine]);
    expect(invoiceLine.parse(line)).toEqual(legacyLine);
  });

  it("accepts verified customer and invoice mappings and rejects foreign or unscoped links", () => {
    const company = { realmId: "tenant", environment: "production" };
    const verified = { ...company, status: "linked" };
    expect(() => assertQuickBooksCompanyLink("customer", verified, company)).not.toThrow();
    expect(() => assertQuickBooksCompanyLink("invoice", verified, company)).not.toThrow();
    expect(() => assertQuickBooksCompanyLink("customer", { ...verified, realmId: "foreign" }, company)).toThrow(/customer link/);
    expect(() => assertQuickBooksCompanyLink("invoice", { ...verified, environment: "sandbox" }, company)).toThrow(/invoice link/);
    expect(() => assertQuickBooksCompanyLink("invoice", { ...verified, realmId: null, environment: null }, company)).toThrow(/invoice link/);
    expect(() => assertQuickBooksCompanyLink("customer", { ...verified, status: "ignored" }, company)).toThrow(/customer link/);
  });
});
