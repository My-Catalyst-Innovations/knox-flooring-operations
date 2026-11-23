import { expect, it, vi } from "vitest";
import {
  prepareQuickBooksInvoiceCreate,
  reconcileQuickBooksInvoiceCreate,
} from "./quickbooks-invoice-create";
import { quickBooksInvoiceLines } from "./quickbooks-invoice";
import {
  reviewedInvoicesAvailable,
  requiresInvoiceReview,
  verifyClassicInvoiceTax,
  verifyExistingInvoice,
  verifyInvoiceReviewCompany,
} from "./quickbooks-invoice-review";

vi.mock("@workspace/db", () => ({ db: {}, quickbooksConnectionsTable: {} }));

const company = {
  id: "connection",
  status: "connected",
  realmId: "111",
  environment: "production",
};
const source = {
  lineItems: [
    {
      id: "line1",
      productId: "product",
      category: "Materials" as const,
      description: "Oak",
      quantity: 5,
      unitPrice: 20,
    },
  ],
  discountAmount: 10,
  taxAmount: 8.325,
  depositAmount: 0,
  total: 98.33,
  balanceAmount: 98.33,
};
const choice = { taxCodeId: "18", taxableLineIds: ["line1"] };
const responses: Record<string, unknown> = {
  "/preferences": {
    Preferences: {
      CurrencyPrefs: { HomeCurrency: { value: "USD" } },
      SalesFormsPrefs: { CustomTxnNumbers: true, AllowDiscount: true },
      TaxPrefs: { UsingSalesTax: true },
    },
  },
  "/customer/32": {
    Customer: {
      Id: "32",
      DisplayName: "Verified customer",
      Active: true,
      Taxable: true,
    },
  },
  "/companyinfo/111": { CompanyInfo: { Country: "US" } },
  "/taxcode/18": {
    TaxCode: {
      Id: "18",
      Name: "Local sales tax",
      Active: true,
      Taxable: true,
      TaxGroup: true,
      SalesTaxRateList: {
        TaxRateDetail: [
          { TaxTypeApplicable: "TaxOnAmount", TaxRateRef: { value: "19" } },
        ],
      },
    },
  },
  "/taxrate/19": {
    TaxRate: { Id: "19", Active: true, RateValue: 9.25, EffectiveTaxRate: [] },
  },
};

it("unlocks reviewed production accounting only in the configured connected company", () => {
  const env = {
    QUICKBOOKS_ENVIRONMENT: "production",
    QUICKBOOKS_PRODUCTION_REVIEWED_INVOICES_ENABLED: "true",
    QUICKBOOKS_PRODUCTION_REVIEWED_INVOICES_REALM_ID: "111",
  };
  expect(reviewedInvoicesAvailable(company, {})).toBe(false);
  expect(reviewedInvoicesAvailable(company, env)).toBe(true);
  expect(
    reviewedInvoicesAvailable(company, { ...env, DEMO_MODE: "true" }),
  ).toBe(false);
  expect(reviewedInvoicesAvailable({ ...company, realmId: "222" }, env)).toBe(
    false,
  );
  expect(
    reviewedInvoicesAvailable({ ...company, status: "disconnected" }, env),
  ).toBe(false);
  expect(reviewedInvoicesAvailable(company, {
    ...env, QUICKBOOKS_PRODUCTION_REVIEWED_INVOICES_ENABLED: "false",
  })).toBe(false);
  expect(reviewedInvoicesAvailable(company, {
    ...env, QUICKBOOKS_ENVIRONMENT: "sandbox",
  })).toBe(false);
});

it("permits the same owner accounting review in a connected real sandbox without opening production books", () => {
  const sandbox = { ...company, environment: "sandbox" };
  const env = { DEMO_MODE: "false", QUICKBOOKS_ENVIRONMENT: "sandbox" };
  expect(reviewedInvoicesAvailable(sandbox, env)).toBe(true);
  expect(reviewedInvoicesAvailable(sandbox, { ...env, DEMO_MODE: "true" })).toBe(false);
  expect(reviewedInvoicesAvailable(sandbox, { ...env, QUICKBOOKS_ENVIRONMENT: "production" })).toBe(false);
  expect(reviewedInvoicesAvailable(sandbox, { DEMO_MODE: "false" })).toBe(false);
  expect(reviewedInvoicesAvailable({ ...sandbox, status: "disconnected" }, env)).toBe(false);
  expect(reviewedInvoicesAvailable(null, env)).toBe(false);
  expect(reviewedInvoicesAvailable(company, env)).toBe(false);
  expect(reviewedInvoicesAvailable({ ...company, environment: "unrecognized" }, {
    QUICKBOOKS_ENVIRONMENT: "unrecognized",
  })).toBe(false);
});

it("requires accounting review for an existing payment even without tax, discount or deposit", () => {
  const plain = { taxAmount: 0, discountAmount: 0, depositAmount: 0, paidAmount: 0 };
  expect(requiresInvoiceReview(plain)).toBe(false);
  expect(requiresInvoiceReview({ ...plain, paidAmount: 25 })).toBe(true);
  expect(requiresInvoiceReview({ ...plain, taxAmount: 9.25 })).toBe(true);
  expect(requiresInvoiceReview({ ...plain, discountAmount: 10 })).toBe(true);
  expect(requiresInvoiceReview({ ...plain, depositAmount: 25 })).toBe(true);
});

it("verifies the exact classic US tax on discounted lines and will not guess an AST rate", async () => {
  const request = vi.fn(async (path: string) => responses[path]);
  const target = await verifyInvoiceReviewCompany("32", request);
  const exact = { ...source, taxAmount: 8.33 };
  await expect(
    verifyClassicInvoiceTax(exact, choice, company.realmId, target, request),
  ).resolves.toEqual({
    id: "18",
    name: "Local sales tax",
    rateId: "19",
    percent: 9.25,
  });
  await expect(
    verifyClassicInvoiceTax(
      { ...exact, taxAmount: 8.34 },
      choice,
      company.realmId,
      target,
      request,
    ),
  ).rejects.toThrow(/does not equal/);
  await expect(
    verifyClassicInvoiceTax(
      exact,
      { ...choice, taxableLineIds: ["other"] },
      company.realmId,
      target,
      request,
    ),
  ).rejects.toThrow(/Select the taxable sales lines/);
  const ast = {
    ...target,
    preferences: {
      ...target.preferences,
      TaxPrefs: { UsingSalesTax: true, PartnerTaxEnabled: true },
    },
  };
  await expect(
    verifyClassicInvoiceTax(exact, choice, company.realmId, ast, request),
  ).rejects.toThrow(/automated sales tax/i);
});

it.each(["production", "sandbox"])("posts only the frozen %s discounted/taxed invoice and rejects a different QuickBooks calculation", async (environment) => {
  const invoice = { ...source, taxAmount: 8.33 };
  const lineItems = quickBooksInvoiceLines(
    invoice,
    new Map([["product", "13"]]),
    new Map(),
    true,
    new Set(["line1"]),
  );
  const attempt = prepareQuickBooksInvoiceCreate({ ...company, environment }, "local-invoice", {
    CustomerRef: { value: "32" },
    DocNumber: "F-100",
    Line: lineItems,
    ApplyTaxAfterDiscount: true,
    TxnTaxDetail: { TxnTaxCodeRef: { value: "18" }, TotalTax: 8.33 },
  });
  const remote = { ...attempt.document, Id: "40", TotalAmt: 98.33 };
  const provider = {
    query: vi.fn().mockResolvedValue({ QueryResponse: {} }),
    request: vi
      .fn()
      .mockResolvedValueOnce(responses["/preferences"])
      .mockResolvedValueOnce({ Invoice: remote }),
  };
  await expect(
    reconcileQuickBooksInvoiceCreate(attempt, provider),
  ).resolves.toEqual(remote);
  expect(provider.request).toHaveBeenCalledWith(
    `/invoice?requestid=${attempt.requestId}`,
    { method: "POST", body: JSON.stringify(attempt.document) },
  );
  provider.request
    .mockResolvedValueOnce(responses["/preferences"])
    .mockResolvedValueOnce({
      Invoice: {
        ...remote,
        TxnTaxDetail: { ...remote.TxnTaxDetail, TotalTax: 8.34 },
      },
    });
  await expect(
    reconcileQuickBooksInvoiceCreate(attempt, provider),
  ).rejects.toThrow(/differs from the approved details/);
});

it("verifies and links an existing invoice deposit and bank account without cash writes", async () => {
  const invoice = {
    ...source,
    taxAmount: 8.33,
    depositAmount: 25,
    balanceAmount: 73.33,
  };
  const lines = quickBooksInvoiceLines(
    invoice,
    new Map([["product", "13"]]),
    new Map(),
    true,
    "existing",
    true,
  );
  const attempt = prepareQuickBooksInvoiceCreate(company, "local-deposit", {
    CustomerRef: { value: "32" },
    DocNumber: "F-101",
    Line: lines,
  });
  const quickBooksInvoice = {
    ...attempt.document,
    PrivateNote: "Existing bookkeeper invoice",
    Id: "41",
    SyncToken: "2",
    TotalAmt: 98.33,
    TxnTaxDetail: { TotalTax: 8.33 },
    Deposit: 25,
    Balance: 73.33,
    DepositToAccountRef: { value: "70" },
  };
  const request = vi.fn(async (path: string): Promise<unknown> =>
    path === "/invoice/41"
      ? { Invoice: quickBooksInvoice }
      : { Account: { Id: "70", Name: "Checking", AccountType: "Bank" } },
  );
  await expect(
    verifyExistingInvoice(invoice, "41", attempt.document, request),
  ).resolves.toEqual({
    invoiceId: "41",
    syncToken: "2",
    depositAccount: { Id: "70", Name: "Checking", AccountType: "Bank" },
  });
  expect(request.mock.calls).toEqual([["/invoice/41"], ["/account/70"]]);
  await expect(
    verifyExistingInvoice(
      { ...invoice, depositAmount: 24 },
      "41",
      attempt.document,
      request,
    ),
  ).rejects.toThrow(/open balance/);
  request.mockResolvedValueOnce({
    Invoice: { ...quickBooksInvoice, LinkedTxn: [{ TxnType: "CreditMemo" }] },
  });
  await expect(
    verifyExistingInvoice(invoice, "41", attempt.document, request),
  ).rejects.toThrow(/open balance/);
});
