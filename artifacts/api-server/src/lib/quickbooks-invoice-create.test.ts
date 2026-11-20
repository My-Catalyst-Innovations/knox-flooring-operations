import { describe, expect, it, vi } from "vitest";
import { prepareQuickBooksInvoiceCreate, QuickBooksInvoiceValidationError, reconcileQuickBooksInvoiceCreate } from "./quickbooks-invoice-create";
import { QuickBooksRequestError } from "./quickbooks";

vi.mock("@workspace/db", () => ({ db: {}, quickbooksConnectionsTable: {} }));

const company = { environment: "production", realmId: "12345" };
const invoice = {
  DocNumber: "INV-1042",
  CustomerRef: { value: "88" },
  TxnDate: "2026-11-20",
  PrivateNote: "Delivery arranged",
  Line: [{
    Amount: 45,
    DetailType: "SalesItemLineDetail" as const,
    Description: "Material",
    SalesItemLineDetail: { ItemRef: { value: "91" }, Qty: 3, UnitPrice: 15 },
  }],
};
const attempt = prepareQuickBooksInvoiceCreate(company, "local-invoice", invoice);
const posted = {
  ...attempt.document, Id: "1122", SyncToken: "0", TotalAmt: 45,
  Line: [...attempt.document.Line, { Amount: 45, DetailType: "SubTotalLineDetail" }],
};
const empty = { QueryResponse: {} };
const found = { QueryResponse: { Invoice: [posted] } };

function mockProvider(query: (statement: string) => Promise<unknown>, post: (path: string, init?: RequestInit) => Promise<unknown>, customNumbers = true) {
  return { query, request: (path: string, init?: RequestInit) => path === "/preferences"
    ? Promise.resolve({ Preferences: { SalesFormsPrefs: { CustomTxnNumbers: customNumbers } } })
    : post(path, init) };
}

describe("first QuickBooks customer invoice creation", () => {
  it("uses one valid request ID for each realm, environment, and local invoice", () => {
    expect(attempt.requestId).toHaveLength(50);
    expect(attempt.document.PrivateNote).toBe(`Delivery arranged\n\nCatalyst Works invoice ${attempt.requestId}`);
    expect(prepareQuickBooksInvoiceCreate(company, "local-invoice", { ...invoice, PrivateNote: "Updated" }).requestId).toBe(attempt.requestId);
    for (const [target, localId] of [
      [{ ...company, realmId: "67890" }, "local-invoice"],
      [{ ...company, environment: "sandbox" }, "local-invoice"],
      [company, "different-invoice"],
    ] as const) {
      expect(prepareQuickBooksInvoiceCreate(target, localId, invoice).requestId).not.toBe(attempt.requestId);
    }
  });

  it("recovers a posted invoice when the connection drops without a second POST", async () => {
    const query = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(found);
    const request = vi.fn().mockRejectedValueOnce(new Error("network dropped after posting"));
    const provider = mockProvider(query, request);
    await expect(reconcileQuickBooksInvoiceCreate(attempt, provider)).rejects.toThrow("network dropped");
    await expect(reconcileQuickBooksInvoiceCreate(attempt, provider)).resolves.toEqual(posted);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith("select * from Invoice where DocNumber = 'INV-1042'");
    expect(request).toHaveBeenCalledExactlyOnceWith(`/invoice?requestid=${attempt.requestId}`, {
      method: "POST", body: JSON.stringify(attempt.document),
    });
  });

  it("replays the same ID and serialized document when the first POST did not save", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("network connection dropped"))
      .mockResolvedValueOnce({ Invoice: posted });
    const provider = mockProvider(vi.fn().mockResolvedValue(empty), request);
    await expect(reconcileQuickBooksInvoiceCreate(attempt, provider)).rejects.toThrow("network connection dropped");
    await expect(reconcileQuickBooksInvoiceCreate(attempt, provider)).resolves.toEqual(posted);
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
  });

  it("queries again when Intuit reports a duplicate request and reconciles only its own invoice", async () => {
    const query = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(found);
    const request = vi.fn().mockRejectedValueOnce(new QuickBooksRequestError("Duplicate Request ID", 400, "ValidationFault", "600"));
    await expect(reconcileQuickBooksInvoiceCreate(attempt, mockProvider(query, request))).resolves.toEqual(posted);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("blocks an unrelated same-number invoice or a divergent accounting amount", async () => {
    const request = vi.fn();
    for (const changed of [{ ...posted, PrivateNote: invoice.PrivateNote }, { ...posted, TotalAmt: 60 }]) {
      const query = vi.fn().mockResolvedValue({ QueryResponse: { Invoice: [changed] } });
      await expect(reconcileQuickBooksInvoiceCreate(attempt, { query, request })).rejects.toThrow(/already has an invoice/);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("requires the connected QuickBooks company to permit Catalyst's invoice number before posting", async () => {
    const query = vi.fn().mockResolvedValue(empty);
    const post = vi.fn();
    await expect(reconcileQuickBooksInvoiceCreate(attempt, mockProvider(query, post, false))).rejects.toThrow(/custom transaction numbers/);
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps an in-flight approval immutable after a local edit but can recover its existing link", async () => {
    const query = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(found);
    const request = vi.fn();
    await expect(reconcileQuickBooksInvoiceCreate(attempt, { query, request }, false)).rejects.toThrow(/different approved invoice version/);
    await expect(reconcileQuickBooksInvoiceCreate(attempt, { query, request }, false)).resolves.toEqual(posted);
    expect(request).not.toHaveBeenCalled();
  });

  it("distinguishes a definitive Intuit validation rejection from a potentially executed request", async () => {
    const query = vi.fn().mockResolvedValue(empty);
    const request = vi.fn().mockRejectedValueOnce(new QuickBooksRequestError("Invalid amount", 400, "ValidationFault", "2140"));
    await expect(reconcileQuickBooksInvoiceCreate(attempt, mockProvider(query, request))).rejects.toBeInstanceOf(QuickBooksInvoiceValidationError);
  });
});
