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
) {
  if (invoice.discountAmount !== 0)
    throw new Error("Automatic QuickBooks export does not support invoice discounts. Reconcile this invoice manually.");
  if (invoice.taxAmount !== 0)
    throw new Error("Automatic QuickBooks export does not support invoice tax. Reconcile this invoice manually.");
  if (invoice.depositAmount !== 0)
    throw new Error("Reconcile the applied deposit in QuickBooks before exporting this invoice. No payment was created.");
  if (!invoice.lineItems.length || Math.round(invoice.total * 100) / 100 !== invoiceSubtotal(invoice.lineItems))
    throw new Error("The invoice total does not match its sales lines. Review the invoice before exporting to QuickBooks.");

  return invoice.lineItems.map((line) => {
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
      },
    };
  });
}
