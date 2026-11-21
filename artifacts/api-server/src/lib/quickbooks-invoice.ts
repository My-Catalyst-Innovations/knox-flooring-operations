import type { InvoiceLineCategory, InvoiceRow, quickbooksConnectionsTable, quickbooksEntityMappingsTable } from "@workspace/db";
import { invoiceLineAmount, invoiceSubtotal } from "@workspace/domain";

type InvoiceExport = Pick<
  InvoiceRow,
  "lineItems" | "discountAmount" | "taxAmount" | "depositAmount" | "total"
>;
type QuickBooksCompany = Pick<typeof quickbooksConnectionsTable.$inferSelect, "realmId" | "environment">;
type QuickBooksLink = Pick<typeof quickbooksEntityMappingsTable.$inferSelect, "realmId" | "environment" | "status">;
export const invoiceServiceEntity = "invoice-service";
export const invoiceServiceCategories = ["Labor", "Add-on", "Materials"] as const;

export function invoiceServiceMappingKey(company: QuickBooksCompany, category: InvoiceLineCategory) {
  return JSON.stringify([company.environment, company.realmId, category]);
}

export function isActiveQuickBooksServiceItem(
  item: { Id?: string; Type?: string; Active?: boolean } | undefined,
  id: string,
) {
  return item?.Id === id && item.Type === "Service" && item.Active === true;
}

export function assertQuickBooksCompanyLink(
  entity: "customer" | "invoice",
  link: QuickBooksLink,
  company: QuickBooksCompany,
) {
  if (link.status === "linked" && link.realmId === company.realmId && link.environment === company.environment) return;
  throw new Error(`Confirm the existing ${entity} link in the connected QuickBooks company before exporting.`);
}

export function quickBooksInvoiceLines(
  invoice: InvoiceExport,
  itemIds: ReadonlyMap<string, string>,
  serviceIds: ReadonlyMap<InvoiceLineCategory, string>,
  allowFixedDiscount = false,
  taxSelection?: ReadonlySet<string> | "existing",
  allowExistingDeposit = false,
) {
  if (invoice.discountAmount !== 0 && !allowFixedDiscount)
    throw new Error("Review fixed invoice discounts in QuickBooks accounting settings before exporting this invoice.");
  if (invoice.taxAmount !== 0 && !taxSelection)
    throw new Error("Review the invoice tax amount and tax code in QuickBooks accounting settings before exporting this invoice.");
  if (invoice.depositAmount !== 0 && !allowExistingDeposit)
    throw new Error("Reconcile the applied deposit in QuickBooks before exporting this invoice. No payment was created.");
  const subtotal = Math.round(invoiceSubtotal(invoice.lineItems) * 100);
  const discount = Math.round(invoice.discountAmount * 100);
  const tax = Math.round(invoice.taxAmount * 100);
  if (!Number.isSafeInteger(discount) || discount < 0 || discount > subtotal ||
    (invoice.discountAmount !== discount / 100 && invoice.discountAmount !== Math.fround(discount / 100)))
    throw new Error("The invoice discount must be an exact currency amount up to the sales subtotal.");
  if (!invoice.lineItems.length || !Number.isSafeInteger(tax) || tax < 0 || Math.round(invoice.total * 100) !== subtotal - discount + tax)
    throw new Error("The invoice total does not match its sales lines. Review the invoice before exporting to QuickBooks.");

  const sales = invoice.lineItems.map((line) => {
    if (line.quantity <= 0 || line.unitPrice < 0)
      throw new Error(`Review the quantity and price on invoice line “${line.description}” before exporting.`);
    const itemId = line.productId ? itemIds.get(line.productId) : serviceIds.get(line.category);
    if (!itemId || !/^\d{1,30}$/.test(itemId)) {
      if (line.productId)
        throw new Error(`Link ${line.sku || line.description} to an item in the connected QuickBooks company through Import & reconcile.`);
      throw new Error(`Invoice line “${line.description}” needs an approved QuickBooks service item for ${line.category}. Open QuickBooks settings and review Invoice service items.`);
    }

    return {
      Amount: invoiceLineAmount(line),
      DetailType: "SalesItemLineDetail" as const,
      Description: line.description,
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: line.quantity,
        UnitPrice: line.unitPrice,
        ...(taxSelection && taxSelection !== "existing" ? { TaxCodeRef: { value: taxSelection.has(line.id) ? "TAX" as const : "NON" as const } } : {}),
      },
    };
  });
  return discount > 0 ? [...sales, {
    Amount: discount / 100,
    DetailType: "DiscountLineDetail" as const,
    DiscountLineDetail: { PercentBased: false as const },
  }] : sales;
}

const officeDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
const manuallySettled = new Set(["Credited", "Refunded", "Voided"]);

function invoiceCents(value: unknown) {
  if (typeof value !== "number" || value < 0) return undefined;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

export function quickBooksInvoicePaymentState(
  local: Pick<InvoiceRow, "status" | "dueDate" | "paidAt" | "depositAmount" | "refundedAmount">,
  remote: { TotalAmt?: unknown; Balance?: unknown; Deposit?: unknown; PrivateNote?: unknown; LinkedTxn?: unknown },
  now: Date,
) {
  if (manuallySettled.has(local.status) || local.refundedAmount > 0) return;
  const total = invoiceCents(remote.TotalAmt);
  const balance = invoiceCents(remote.Balance);
  if (total === undefined || balance === undefined || balance > total) return;

  // QuickBooks zeros a voided invoice and prefixes its private note with Voided.
  if (total === 0 && typeof remote.PrivateNote === "string" && /^Voided\b/i.test(remote.PrivateNote))
    return { status: "Voided", balanceAmount: 0, paidAmount: 0, paidAt: null };
  if (total === 0 || (Array.isArray(remote.LinkedTxn) && remote.LinkedTxn.some((entry) =>
    entry?.TxnType === "CreditMemo" || entry?.TxnType === "RefundReceipt",
  ))) return;

  const deposit = invoiceCents(local.depositAmount) ?? 0;
  if (deposit > 0 && (invoiceCents(remote.Deposit) !== deposit || deposit > total - balance)) return;
  const paid = total - balance - deposit;
  let status = local.status;
  if (balance === 0) status = "Paid";
  else if (paid > 0 || local.depositAmount > 0) status = "Partial";
  else if (status === "Paid" || status === "Partial") {
    const [month, day, year] = officeDate.formatToParts(now).filter((part) => part.type !== "literal").map((part) => part.value);
    const today = `${year}-${month}-${day}`;
    status = /^\d{4}-\d{2}-\d{2}$/.test(local.dueDate) && local.dueDate < today ? "Overdue" : "Sent";
  }
  return {
    total: total / 100, balanceAmount: balance / 100, paidAmount: paid / 100,
    status, paidAt: balance === 0 ? (local.paidAt ?? now.toISOString()) : null,
  };
}
