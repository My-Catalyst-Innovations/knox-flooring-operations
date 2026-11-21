import { describe, expect, it } from "vitest";
import { GetPublicJobResponse, UpdateInvoiceBody } from "@workspace/api-zod";
import { assertQuickBooksCompanyLink, invoiceServiceMappingKey, isActiveQuickBooksServiceItem, quickBooksInvoiceLines, quickBooksInvoicePaymentState } from "./quickbooks-invoice";

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
const services = new Map([["Labor", "432"], ["Add-on", "433"], ["Materials", "434"]] as const);
const labor = { id: "labor", description: "Installation labor", category: "Labor" as const, quantity: 2, unitPrice: 8.5 };
const addOn = { id: "allowance", description: "Surface preparation", category: "Add-on" as const, quantity: 1, unitPrice: 40 };

describe("QuickBooks invoice lines", () => {
  it("uses the linked product ID with the invoice's negotiated rate and line amount", () => {
    expect(quickBooksInvoiceLines(exportable, links, services)).toEqual([
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
    expect(() => quickBooksInvoiceLines(exportable, new Map([[line.sku, "999"]]), services))
      .toThrow(/Link TILE-42.*Import & reconcile/);
    expect(() => quickBooksInvoiceLines(exportable, new Map([[line.productId, "SIM-id"]]), services))
      .toThrow(/Link TILE-42/);
  });

  it("blocks unmapped service lines whose charge QuickBooks would ignore", () => {
    expect(() => quickBooksInvoiceLines({
      ...exportable,
      lineItems: [...exportable.lineItems, labor],
      total: 87.37,
    }, links, new Map())).toThrow(/Installation labor.*approved QuickBooks service item for Labor/);
  });

  it("uses distinct approved categories for mixed invoices while retaining the rate and amount", () => {
    const lines = quickBooksInvoiceLines({
      ...exportable,
      lineItems: [line, labor, addOn],
      total: 127.37,
    }, links, services);
    expect(lines.map((item) => "SalesItemLineDetail" in item && item.SalesItemLineDetail.ItemRef.value)).toEqual(["123", "432", "433"]);
    expect(lines.map((item) => "SalesItemLineDetail" in item && item.SalesItemLineDetail.UnitPrice)).toEqual([23.4567, 8.5, 40]);
    expect(lines.map((item) => item.Amount)).toEqual([70.37, 17, 40]);
  });

  it("prepares a fixed discount for a first sandbox export with a matching total", () => {
    const invoice = { ...exportable, discountAmount: 5.24, total: 65.13 };
    expect(quickBooksInvoiceLines(invoice, links, services, true).at(-1)).toEqual({
      Amount: 5.24, DetailType: "DiscountLineDetail", DiscountLineDetail: { PercentBased: false },
    });
    expect(() => quickBooksInvoiceLines({ ...invoice, total: 65.12 }, links, services, true)).toThrow(/total does not match/);
    expect(() => quickBooksInvoiceLines({ ...invoice, discountAmount: 5.243 }, links, services, true)).toThrow(/exact currency amount/);
    expect(() => quickBooksInvoiceLines(invoice, links, services)).toThrow(/accounting settings/);
  });

  it.each([
    [{ depositAmount: 20 }, /deposit.*No payment was created/],
    [{ taxAmount: 2 }, /invoice tax/],
    [{ discountAmount: 5 }, /invoice discounts/],
    [{ total: 50 }, /total does not match/],
  ] as const)("blocks an unsupported invoice balance adjustment %o", (change, error) => {
    expect(() => quickBooksInvoiceLines({ ...exportable, ...change }, links, services)).toThrow(error);
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

  it("only recognizes the selected active QuickBooks Service item", () => {
    const item = { Id: "432", Type: "Service", Active: true };
    expect(isActiveQuickBooksServiceItem(item, "432")).toBe(true);
    expect(isActiveQuickBooksServiceItem(item, "433")).toBe(false);
    expect(isActiveQuickBooksServiceItem({ ...item, Active: false }, "432")).toBe(false);
    expect(isActiveQuickBooksServiceItem({ ...item, Type: "Inventory" }, "432")).toBe(false);
    expect(isActiveQuickBooksServiceItem(undefined, "432")).toBe(false);
  });

  it("keeps distinct service approvals by environment, company and category", () => {
    const company = { realmId: "tenant", environment: "production" };
    const keys = [
      invoiceServiceMappingKey(company, "Labor"),
      invoiceServiceMappingKey({ ...company, realmId: "other" }, "Labor"),
      invoiceServiceMappingKey({ ...company, environment: "sandbox" }, "Labor"),
      invoiceServiceMappingKey(company, "Add-on"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("QuickBooks invoice payment import", () => {
  const now = new Date("2026-11-21T02:00:00.000Z"); // Still November 20 in Knoxville.
  const paidAt = "2026-11-18T16:30:00.000Z";
  const paid = { status: "Paid", dueDate: "2026-11-20", paidAt, depositAmount: 0, refundedAmount: 0 };

  it("reopens a previously paid or partial invoice when QuickBooks returns the full balance", () => {
    const remote = { TotalAmt: 100, Balance: 100 };
    expect(quickBooksInvoicePaymentState(paid, remote, now)).toEqual({
      total: 100, paidAmount: 0, balanceAmount: 100, status: "Sent", paidAt: null,
    });
    expect(quickBooksInvoicePaymentState({ ...paid, status: "Partial", dueDate: "2026-11-19" }, remote, now))
      .toMatchObject({ status: "Overdue", paidAt: null, paidAmount: 0, balanceAmount: 100 });
  });

  it("clears the paid date on a partial reversal and retains it on repeated fully paid updates", () => {
    expect(quickBooksInvoicePaymentState(paid, { TotalAmt: 100, Balance: 30 }, now))
      .toMatchObject({ status: "Partial", paidAt: null, paidAmount: 70, balanceAmount: 30 });
    expect(quickBooksInvoicePaymentState(paid, { TotalAmt: 100, Balance: 0 }, now))
      .toMatchObject({ status: "Paid", paidAt });
  });

  it("does not count the already recorded invoice deposit a second time as payments", () => {
    const local = { ...paid, depositAmount: 20 };
    expect(quickBooksInvoicePaymentState(local, { TotalAmt: 100, Balance: 65, Deposit: 20 }, now))
      .toMatchObject({ status: "Partial", paidAmount: 15, balanceAmount: 65 });
    expect(quickBooksInvoicePaymentState(local, { TotalAmt: 100, Balance: 80, Deposit: 20 }, now))
      .toMatchObject({ status: "Partial", paidAmount: 0, balanceAmount: 80 });
    expect(quickBooksInvoicePaymentState(local, { TotalAmt: 100, Balance: 80, Deposit: 19 }, now)).toBeUndefined();
  });

  it.each([
    { TotalAmt: 100 }, { TotalAmt: 100, Balance: null }, { TotalAmt: 100, Balance: "0" },
    { TotalAmt: 100, Balance: -1 }, { TotalAmt: 100, Balance: NaN }, { TotalAmt: 100, Balance: 101 },
    { Balance: 0 }, { TotalAmt: 0, Balance: 0 },
  ])("leaves local amounts intact for an incomplete or invalid snapshot %o", (remote) => {
    expect(quickBooksInvoicePaymentState(paid, remote, now)).toBeUndefined();
  });

  it("preserves manually settled records and does not treat a linked credit or refund as cash", () => {
    for (const status of ["Credited", "Refunded", "Voided"]) {
      expect(quickBooksInvoicePaymentState({ ...paid, status }, { TotalAmt: 100, Balance: 100 }, now)).toBeUndefined();
    }
    expect(quickBooksInvoicePaymentState({ ...paid, refundedAmount: 10 }, { TotalAmt: 100, Balance: 0 }, now)).toBeUndefined();
    expect(quickBooksInvoicePaymentState(paid, { TotalAmt: 100, Balance: 0, LinkedTxn: [{ TxnType: "CreditMemo" }] }, now)).toBeUndefined();
  });

  it("preserves original totals while closing an explicitly voided QuickBooks invoice", () => {
    expect(quickBooksInvoicePaymentState(paid, { TotalAmt: 0, Balance: 0, PrivateNote: "Voided\nOld memo" }, now))
      .toEqual({ status: "Voided", paidAmount: 0, balanceAmount: 0, paidAt: null });
  });
});
