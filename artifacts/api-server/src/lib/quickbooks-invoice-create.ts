import { createHash } from "node:crypto";
import { z } from "zod";
import { QuickBooksRequestError } from "./quickbooks";

const document = z.object({
  CustomerRef: z.object({ value: z.string().regex(/^\d{1,30}$/) }),
  DocNumber: z.string().regex(/^[\w./-]{1,21}$/),
  TxnDate: z.string().optional(),
  DueDate: z.string().optional(),
  PrivateNote: z.string(),
  Line: z.array(z.discriminatedUnion("DetailType", [
    z.object({
      Amount: z.number(),
      DetailType: z.literal("SalesItemLineDetail"),
      Description: z.string().default(""),
      SalesItemLineDetail: z.object({
        ItemRef: z.object({ value: z.string() }),
        Qty: z.number(),
        UnitPrice: z.number(),
      }),
    }),
    z.object({
      Amount: z.number().positive(),
      DetailType: z.literal("DiscountLineDetail"),
      DiscountLineDetail: z.object({ PercentBased: z.literal(false).default(false) }),
    }),
  ])).min(1),
});

export type QuickBooksInvoiceDocument = z.infer<typeof document>;
export const invoiceCreateRecord = "quickBooksInvoiceCreateAttempt";
export const invoiceCreateAttempt = z.object({
  requestId: z.string().regex(/^cwinv-[a-f0-9]{44}$/),
  document,
});
type CreateAttempt = z.infer<typeof invoiceCreateAttempt>;

export function prepareQuickBooksInvoiceCreate(
  company: { realmId: string; environment: string },
  invoiceId: string,
  invoice: Omit<QuickBooksInvoiceDocument, "PrivateNote"> & { PrivateNote?: string },
): CreateAttempt {
  const hash = createHash("sha256").update(JSON.stringify([company.environment, company.realmId, invoiceId])).digest("hex");
  const requestId = `cwinv-${hash.slice(0, 44)}`;
  const marker = `Catalyst Works invoice ${requestId}`;
  const privateNote = invoice.PrivateNote ? `${invoice.PrivateNote}\n\n${marker}` : marker;
  if (privateNote.length > 4000) throw new Error("Shorten the invoice note before exporting it to QuickBooks.");
  const parsed = document.safeParse({ ...invoice, PrivateNote: privateNote });
  if (!parsed.success) throw new Error("Confirm a valid QuickBooks customer and invoice number before exporting.");
  return { requestId, document: parsed.data };
}

function sameInvoice(expected: QuickBooksInvoiceDocument, posted: unknown) {
  const result = document.extend({
    Id: z.string().regex(/^\d{1,30}$/),
    TotalAmt: z.number(),
    Line: z.array(z.unknown()),
  }).safeParse(posted);
  if (!result.success) return false;
  const invoice = result.data;
  const postedLines = invoice.Line.filter((line) => (line as { DetailType?: string } | null)?.DetailType !== "SubTotalLineDetail");
  const lines = document.shape.Line.safeParse(postedLines);
  const totalInCents = expected.Line.reduce((total, line) =>
    total + Math.round(line.Amount * 100) * (line.DetailType === "DiscountLineDetail" ? -1 : 1), 0);
  return invoice.DocNumber === expected.DocNumber && invoice.CustomerRef.value === expected.CustomerRef.value &&
    (!expected.TxnDate || invoice.TxnDate === expected.TxnDate) && (!expected.DueDate || invoice.DueDate === expected.DueDate) &&
    invoice.PrivateNote === expected.PrivateNote && Math.round(invoice.TotalAmt * 100) === totalInCents &&
    lines.success && JSON.stringify(lines.data) === JSON.stringify(expected.Line);
}

type Provider = {
  query: (statement: string) => Promise<unknown>;
  request: (path: string, init?: RequestInit) => Promise<unknown>;
};

export class QuickBooksInvoiceValidationError extends Error {}

export async function reconcileQuickBooksInvoiceCreate(attempt: CreateAttempt, provider: Provider, mayCreate = true) {
  const { requestId, document: invoice } = attempt;
  const existing = await findQuickBooksInvoice(invoice, provider.query);
  if (existing) return existing;
  if (!mayCreate) throw new Error("The first QuickBooks export has a different approved invoice version. Review the original export before retrying.");

  const preferences = z.object({ Preferences: z.object({ SalesFormsPrefs: z.object({ CustomTxnNumbers: z.literal(true) }) }) })
    .safeParse(await provider.request("/preferences"));
  if (!preferences.success)
    throw new Error("Enable custom transaction numbers in QuickBooks or reconcile this invoice manually. Its invoice number is required for safe retry.");

  let result: unknown;
  try {
    result = await provider.request(`/invoice?requestid=${requestId}`, { method: "POST", body: JSON.stringify(invoice) });
  } catch (error) {
    if (error instanceof QuickBooksRequestError && (error.faultCode === "600" || error.faultCode === "6140")) {
      const recovered = await findQuickBooksInvoice(invoice, provider.query);
      if (recovered) return recovered;
      throw new Error("QuickBooks reported a duplicate invoice request. Reconcile it in the connected company before retrying.");
    }
    if (error instanceof QuickBooksRequestError && error.status === 400 && error.faultType === "ValidationFault")
      throw new QuickBooksInvoiceValidationError(error.message);
    throw error;
  }
  const posted = z.object({ Invoice: z.unknown() }).safeParse(result);
  if (!posted.success || !sameInvoice(invoice, posted.data.Invoice))
    throw new Error("QuickBooks returned an invoice that differs from the approved details. Review it in QuickBooks before retrying.");
  return posted.data.Invoice;
}

async function findQuickBooksInvoice(invoice: QuickBooksInvoiceDocument, query: Provider["query"]) {
  const response = z.object({ QueryResponse: z.object({ Invoice: z.array(z.unknown()).default([]) }) })
    .safeParse(await query(`select * from Invoice where DocNumber = '${invoice.DocNumber}'`));
  if (!response.success) throw new Error("QuickBooks did not return invoice reconciliation results. Review before retrying.");
  const existing = response.data.QueryResponse.Invoice;
  if (existing.length) {
    if (existing.length !== 1 || !sameInvoice(invoice, existing[0]))
      throw new Error(`QuickBooks already has an invoice numbered ${invoice.DocNumber}. Reconcile it before exporting.`);
    return existing[0];
  }
  return undefined;
}
