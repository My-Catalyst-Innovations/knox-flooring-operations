import { z } from "zod";

const id = z.string().regex(/^\d{1,30}$/);
const payment = z.object({
  status: z.string().optional(),
  Line: z.array(z.object({
    LinkedTxn: z.array(z.object({ TxnType: z.string(), TxnId: z.string() })).default([]),
  })).default([]),
});
const cdc = z.object({
  CDCResponse: z.array(z.object({
    QueryResponse: z.array(z.object({
      Invoice: z.array(z.object({ Id: id, status: z.string().optional() })).default([]),
      Payment: z.array(payment).default([]),
    })),
  })),
});

export function quickBooksPaymentInvoiceIds(value: unknown) {
  if (value == null) return [];
  const { status, Line } = payment.parse(value);
  if (status === "Deleted") return [];
  return [...new Set(Line.flatMap((line) => line.LinkedTxn.flatMap((link) =>
    link.TxnType === "Invoice" && id.safeParse(link.TxnId).success ? [link.TxnId] : [],
  )))];
}

export function quickBooksCdcInvoiceIds(value: unknown) {
  const invoiceIds = new Set<string>();
  const deleted = new Set<string>();
  let changeCount = 0;
  for (const response of cdc.parse(value).CDCResponse) {
    for (const query of response.QueryResponse) {
      changeCount += query.Invoice.length + query.Payment.length;
      for (const invoice of query.Invoice) {
        (invoice.status === "Deleted" ? deleted : invoiceIds).add(invoice.Id);
      }
      for (const payment of query.Payment) {
        for (const invoiceId of quickBooksPaymentInvoiceIds(payment)) invoiceIds.add(invoiceId);
      }
    }
  }
  if (changeCount >= 1000) throw new Error("QuickBooks returned its change limit. Review the missing sync window before advancing it.");
  for (const invoiceId of deleted) invoiceIds.delete(invoiceId);
  return invoiceIds;
}
