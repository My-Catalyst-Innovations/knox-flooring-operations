import { createHash } from "node:crypto";
import { workspaceEnvironment } from "@workspace/db/workspace";
import type { InvoiceRow } from "@workspace/db";
import { invoiceLineAmount } from "@workspace/domain";
import { z } from "zod";
import {
  sameInvoice,
  type QuickBooksInvoiceDocument,
} from "./quickbooks-invoice-create";

type Company = {
  id: string;
  realmId: string;
  environment: string;
  status: string;
};
type Request = (path: string) => Promise<unknown>;
const providerId = z.string().regex(/^\d{1,30}$/);
export const invoiceReviewInput = z
  .object({
    existingInvoiceId: providerId.optional(),
    discountAccountId: providerId.optional(),
    taxCodeId: providerId.optional(),
    taxableLineIds: z.array(z.string().min(1).max(200)).max(250),
  })
  .strict();
export const reviewedInvoiceRecord = "quickBooksAccountingReview";
export const reviewedInvoiceApproval = z.object({
  request: invoiceReviewInput,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type InvoiceReviewInput = z.infer<typeof invoiceReviewInput>;

export function reviewedInvoicesAvailable(
  company: Company | null,
  env = workspaceEnvironment(),
) {
  return (
    env.DEMO_MODE !== "true" &&
    env.QUICKBOOKS_ENVIRONMENT === "production" &&
    env.QUICKBOOKS_PRODUCTION_REVIEWED_INVOICES_ENABLED === "true" &&
    company?.status === "connected" &&
    company.environment === "production" &&
    !!env.QUICKBOOKS_PRODUCTION_REVIEWED_INVOICES_REALM_ID &&
    company.realmId === env.QUICKBOOKS_PRODUCTION_REVIEWED_INVOICES_REALM_ID
  );
}

export const requiresInvoiceReview = (
  invoice: Pick<InvoiceRow, "taxAmount" | "depositAmount" | "discountAmount">,
) =>
  invoice.taxAmount !== 0 ||
  invoice.depositAmount !== 0 ||
  invoice.discountAmount !== 0;

export function invoiceReviewFingerprint(
  company: Company,
  invoice: InvoiceRow,
  choice: unknown,
  document: QuickBooksInvoiceDocument,
  evidence: unknown,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        company.environment,
        company.realmId,
        company.id,
        invoice.id,
        invoice.updatedAt,
        choice,
        document,
        evidence,
      ]),
    )
    .digest("hex");
}

const cents = (number: number) => Math.round(number * 100);
export function isReviewedInvoiceAmount(value: number) {
  const amount = cents(value);
  return (
    value >= 0 &&
    Number.isSafeInteger(amount) &&
    (value === amount / 100 || value === Math.fround(amount / 100))
  );
}
const preferencesResponse = z.object({
  Preferences: z.object({
    CurrencyPrefs: z.object({
      HomeCurrency: z.object({ value: z.literal("USD") }),
      MultiCurrencyEnabled: z.boolean().optional(),
    }),
    SalesFormsPrefs: z
      .object({
        CustomTxnNumbers: z.boolean().optional(),
        AllowDiscount: z.boolean().optional(),
      })
      .optional(),
    TaxPrefs: z
      .object({
        UsingSalesTax: z.boolean().optional(),
        PartnerTaxEnabled: z.boolean().optional(),
      })
      .optional(),
  }),
});

export async function verifyInvoiceReviewCompany(
  customerId: string,
  request: Request,
) {
  const [prefs, customer] = await Promise.all([
    request("/preferences"),
    request(`/customer/${customerId}`),
  ]);
  const preferences = preferencesResponse.safeParse(prefs);
  const actualCustomer = z
    .object({
      Customer: z.object({
        Id: providerId,
        Active: z.literal(true),
        DisplayName: z.string().min(1),
        CurrencyRef: z.object({ value: z.literal("USD") }).optional(),
        Taxable: z.boolean().optional(),
      }),
    })
    .safeParse(customer);
  if (
    !preferences.success ||
    !actualCustomer.success ||
    actualCustomer.data.Customer.Id !== customerId
  )
    throw new Error(
      "Review requires a QuickBooks company and an active customer that use USD.",
    );
  return {
    preferences: preferences.data.Preferences,
    customer: actualCustomer.data.Customer,
  };
}

export async function verifyInvoiceDiscountAccount(
  id: string | undefined,
  request: Request,
) {
  if (!id)
    throw new Error(
      "Choose the QuickBooks sales discount account for this fixed discount.",
    );
  const response = z
    .object({
      Account: z.object({
        Id: providerId,
        Name: z.string().min(1),
        Active: z.literal(true),
        AccountType: z.literal("Income"),
        AccountSubType: z.literal("DiscountsRefundsGiven"),
      }),
    })
    .safeParse(await request(`/account/${id}`));
  if (!response.success || response.data.Account.Id !== id)
    throw new Error(
      "Choose an active QuickBooks Discounts/Refunds Given income account.",
    );
  return { id, name: response.data.Account.Name };
}

export async function verifyClassicInvoiceTax(
  invoice: Pick<InvoiceRow, "taxAmount" | "discountAmount" | "lineItems">,
  choice: InvoiceReviewInput,
  realmId: string,
  company: Awaited<ReturnType<typeof verifyInvoiceReviewCompany>>,
  request: Request,
) {
  if (!choice.taxCodeId)
    throw new Error("Select the QuickBooks sales-tax code for this invoice.");
  if (
    company.preferences.TaxPrefs?.UsingSalesTax !== true ||
    company.preferences.TaxPrefs.PartnerTaxEnabled !== undefined ||
    company.customer.Taxable !== true
  )
    throw new Error(
      "A new taxed invoice requires classic QuickBooks sales tax and a taxable customer. For automated sales tax, record the invoice in QuickBooks and reconcile the existing invoice here.",
    );
  const selected = new Set(choice.taxableLineIds);
  const lines = invoice.lineItems.filter((line) => selected.has(line.id));
  if (
    !lines.length ||
    lines.length !== selected.size ||
    selected.size !== choice.taxableLineIds.length ||
    (invoice.discountAmount > 0 && lines.length !== invoice.lineItems.length)
  )
    throw new Error(
      "Select the taxable sales lines. For a taxed invoice with a fixed discount, all sales lines must be taxable for automatic export.",
    );

  const [companyInfo, taxCode] = await Promise.all([
    request(`/companyinfo/${realmId}`),
    request(`/taxcode/${choice.taxCodeId}`),
  ]);
  const country = z
    .object({
      CompanyInfo: z.object({
        Country: z.enum(["US", "USA", "United States"]),
      }),
    })
    .safeParse(companyInfo);
  const code = z
    .object({
      TaxCode: z.object({
        Id: providerId,
        Active: z.literal(true),
        Taxable: z.literal(true),
        TaxGroup: z.literal(true),
        Name: z.string().min(1),
        SalesTaxRateList: z.object({
          TaxRateDetail: z.tuple([
            z.object({
              TaxRateRef: z.object({ value: providerId }),
              TaxTypeApplicable: z.literal("TaxOnAmount"),
            }),
          ]),
        }),
      }),
    })
    .safeParse(taxCode);
  if (
    !country.success ||
    !code.success ||
    code.data.TaxCode.Id !== choice.taxCodeId
  )
    throw new Error(
      "Choose an active US sales-tax code with one tax-on-amount rate.",
    );
  const rateId =
    code.data.TaxCode.SalesTaxRateList.TaxRateDetail[0].TaxRateRef.value;
  const rate = z
    .object({
      TaxRate: z.object({
        Id: providerId,
        Active: z.literal(true),
        RateValue: z.number().positive().max(100),
        EffectiveTaxRate: z.array(z.unknown()).max(0).optional(),
      }),
    })
    .safeParse(await request(`/taxrate/${rateId}`));
  if (!rate.success || rate.data.TaxRate.Id !== rateId)
    throw new Error("Choose a single fixed, active QuickBooks sales-tax rate.");
  const percent = rate.data.TaxRate.RateValue;
  const basis =
    lines.reduce((sum, line) => sum + cents(invoiceLineAmount(line)), 0) -
    cents(invoice.discountAmount);
  const units = Math.round(percent * 10_000);
  if (
    units / 10_000 !== percent ||
    !Number.isSafeInteger(basis) ||
    basis <= 0 ||
    (BigInt(basis) * BigInt(units) + 500_000n) / 1_000_000n !==
      BigInt(cents(invoice.taxAmount))
  )
    throw new Error(
      "The exact QuickBooks sales tax on the selected lines does not equal the invoice tax amount.",
    );
  return {
    id: choice.taxCodeId,
    name: code.data.TaxCode.Name,
    rateId,
    percent,
  };
}

export async function verifyExistingInvoice(
  invoice: Pick<InvoiceRow, "taxAmount" | "depositAmount" | "balanceAmount">,
  id: string,
  document: QuickBooksInvoiceDocument,
  request: Request,
) {
  const response = z
    .object({ Invoice: z.unknown() })
    .parse(await request(`/invoice/${id}`));
  const evidence = {
    id,
    taxAmount: invoice.taxAmount,
    depositAmount: invoice.depositAmount,
    balanceAmount: invoice.balanceAmount,
  };
  if (!sameInvoice(document, response.Invoice, evidence))
    throw new Error(
      "The existing QuickBooks invoice must match the invoice number, customer, dates, items, discount, tax, deposit, and open balance.",
    );
  const remote = z
    .object({
      Id: providerId,
      SyncToken: z.string(),
      DepositToAccountRef: z.object({ value: providerId }).optional(),
    })
    .parse(response.Invoice);
  if (!invoice.depositAmount)
    return { invoiceId: remote.Id, syncToken: remote.SyncToken };
  const accountId = remote.DepositToAccountRef?.value;
  if (!accountId)
    throw new Error(
      "The existing invoice must contain a QuickBooks deposit with a deposit account.",
    );
  const responseAccount = z
    .object({
      Account: z.object({
        Id: providerId,
        Name: z.string().min(1),
        AccountType: z.enum(["Bank", "Other Current Asset"]),
      }),
    })
    .safeParse(await request(`/account/${accountId}`));
  if (!responseAccount.success || responseAccount.data.Account.Id !== accountId)
    throw new Error(
      "The invoice deposit account could not be verified in QuickBooks.",
    );
  return {
    invoiceId: remote.Id,
    syncToken: remote.SyncToken,
    depositAccount: responseAccount.data.Account,
  };
}
