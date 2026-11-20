import { describe, expect, it } from "vitest";
import { quickBooksCdcInvoiceIds, quickBooksPaymentInvoiceIds } from "./quickbooks-cdc";

const payment = {
  Id: "88",
  Line: [
    { LinkedTxn: [{ TxnType: "Invoice", TxnId: "15" }, { TxnType: "CreditMemo", TxnId: "80" }] },
    { LinkedTxn: [{ TxnType: "Invoice", TxnId: "15" }, { TxnType: "Invoice", TxnId: "17" }] },
    { LinkedTxn: [{ TxnType: "Invoice", TxnId: "32/99" }] },
  ],
};

describe("QuickBooks payment change recovery", () => {
  it("reads affected invoice IDs from live payment lines once each", () => {
    expect(quickBooksPaymentInvoiceIds(payment)).toEqual(["15", "17"]);
    expect(quickBooksPaymentInvoiceIds({ Id: "88", status: "Deleted" })).toEqual([]);
  });

  it("collects invoice and payment changes without fetching any deleted Invoice IDs", () => {
    const changes = { CDCResponse: [{ QueryResponse: [
      { Payment: [payment, { Id: "90", status: "Deleted" }] },
      { Invoice: [{ Id: "15" }, { Id: "17", status: "Deleted" }, { Id: "21" }] },
    ] }] };
    expect([...quickBooksCdcInvoiceIds(changes)]).toEqual(["15", "21"]);
  });

  it("fails incomplete or capped responses so the worker keeps its previous checkpoint", () => {
    expect(() => quickBooksCdcInvoiceIds({})).toThrow();
    const capped = { CDCResponse: [{ QueryResponse: [{ Payment: Array.from({ length: 1000 }, () => payment) }] }] };
    expect(() => quickBooksCdcInvoiceIds(capped)).toThrow(/change limit/);
  });
});
