import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  invoicesTable,
  jobCutoversTable,
  type InvoiceInsert,
  type InvoiceLineItem,
} from "@workspace/db";
import {
  ListInvoicesResponse,
  CreateInvoiceBody,
  UpdateInvoiceParams,
  UpdateInvoiceBody,
  UpdateInvoiceResponse,
  DeleteInvoiceParams,
} from "@workspace/api-zod";
import { stripNulls } from "../lib/strip-nulls";
import { queueQuickBooksReview } from "../lib/quickbooks-queue";
import { nextDocumentNumber } from "../lib/conversions";
import { domainRoute } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { invoiceSubtotal } from "@workspace/domain";
import {
  assertCutoverInvoiceCreate,
  consumeCutoverInvoice,
  cutoverInvoiceFingerprint,
  presentCutoverInvoice,
  replayCutoverInvoice,
  updateCutoverInvoiceClaim,
  assertCutoverInvoiceReadback,
} from "../lib/job-cutover-invoices";
import { lockedCutoverJob } from "../lib/job-cutover";
const router: IRouter = Router();
function totals(
  lines: InvoiceLineItem[],
  tax = 0,
  discount = 0,
  deposit = 0,
  paid = 0,
) {
  const subtotal = invoiceSubtotal(lines),
    taxableAmount = Math.max(0, subtotal - discount),
    total = Math.max(0, taxableAmount + tax);
  return {
    subtotal,
    taxableAmount,
    total,
    balanceAmount: Math.max(0, total - deposit - paid),
  };
}
async function response(invoice: typeof invoicesTable.$inferSelect) {
  const output = await presentCutoverInvoice(db, invoice);
  return {
    ...UpdateInvoiceResponse.parse(stripNulls(invoice)),
    ...("invoiceFinancialFingerprint" in output
      ? { invoiceFinancialFingerprint: output.invoiceFinancialFingerprint }
      : {}),
  };
}
router.get(
  "/invoices",
  domainRoute(async (_req, res) => {
    const rows = await db.select().from(invoicesTable);
    res.json(await Promise.all(rows.map(response)));
  }),
);
router.post(
  "/invoices",
  domainRoute(async (req, res) => {
    const parsed = CreateInvoiceBody.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ diagnostic: "request_validation_failed" }, "Invalid invoice body");
      throw new DomainError(400, parsed.error.message);
    }
    const data = parsed.data,
      now = new Date().toISOString(),
      lineItems = data.lineItems as InvoiceLineItem[];
    const payload = { ...data, lineItems };
    const requested={lineItems,taxAmount:data.taxAmount??0,discountAmount:data.discountAmount??0,depositAmount:data.depositAmount??0,...totals(lineItems,data.taxAmount??0,data.discountAmount??0,data.depositAmount??0)};
    const result = await db.transaction(async (tx) => {
      const job = await lockedCutoverJob(tx, data.jobId);
      const replay = await replayCutoverInvoice(
        tx,
        job,
        req.body.requestKey,
        payload,
      );
      if (replay) return { invoice: replay, replay: true };
      await assertCutoverInvoiceCreate(
        tx,
        job,
        req.body.expectedCutoverRevision,
      );
      const [invoice] = await tx
        .insert(invoicesTable)
        .values({
          ...data,
          id: randomUUID(),
          customerId: job.customerId,
          invoiceNumber: await nextDocumentNumber(tx, "invoice"),
          ...requested,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await consumeCutoverInvoice(
        tx,
        job,
        invoice,
        req.body.requestKey,
        payload,
        req.auth!.userId,
        req.body.expectedCutoverRevision,
        requested,
      );
      return { invoice, replay: false };
    });
    if (!result.replay)
      await queueQuickBooksReview(
        "invoice",
        result.invoice.id,
        "create",
        stripNulls(result.invoice),
        result.invoice.taxCode
          ? []
          : ["Confirm the QuickBooks tax code before approval"],
      );
    res.status(result.replay ? 200 : 201).json(await response(result.invoice));
  }),
);
router.patch(
  "/invoices/:id",
  domainRoute(async (req, res) => {
    const params = UpdateInvoiceParams.parse(req.params),
      parsed = UpdateInvoiceBody.safeParse(req.body);
    if (!parsed.success) throw new DomainError(400, parsed.error.message);
    const data = parsed.data;
    if (Object.hasOwn(req.body, "jobId"))
      throw new DomainError(
        400,
        "Invoice job attribution cannot be changed through an invoice edit.",
      );
    // Lock jobs in deterministic order before invoice/request rows. Recheck the
    // discovered attribution under those locks rather than trusting this read.
    const [seen] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, params.id));
    if (!seen) throw new DomainError(404, "Invoice not found.");
    const invoice = await db.transaction(async (tx) => {
      const ids = [seen.jobId];
      const jobs = [];
      for (const id of ids) jobs.push(await lockedCutoverJob(tx, id));
      const [current] = await tx
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.id, params.id))
        .for("update");
      if (!current || current.jobId !== seen.jobId)
        throw new DomainError(
          409,
          "Invoice attribution changed. Refresh before editing.",
        );
      const job = jobs.find((row) => row.id === current.jobId)!;
      const oldLines = new Map(
        current.lineItems.map((line) => [line.id, line]),
      );
      const lineItems =
        data.lineItems?.map((line) => {
          const old = oldLines.get(line.id),
            productId = line.productId ?? old?.productId,
            sku =
              line.sku ?? (productId === old?.productId ? old?.sku : undefined);
          return { ...line, productId, sku };
        }) ?? current.lineItems;
      const updates: Partial<InvoiceInsert> = {
        ...data,
        updatedAt: new Date().toISOString(),
      };
      if (
        data.lineItems ||
        data.taxAmount !== undefined ||
        data.discountAmount !== undefined ||
        data.depositAmount !== undefined
      )
        Object.assign(updates, {
          lineItems,
          ...totals(
            lineItems,
            data.taxAmount ?? current.taxAmount,
            data.discountAmount ?? current.discountAmount,
            data.depositAmount ?? current.depositAmount,
            current.paidAmount,
          ),
        });
      const next = { ...current, ...updates } as typeof current;
      const cutoverEdit=await updateCutoverInvoiceClaim(
        tx,
        job,
        current,
        next,
        req.body.expectedCutoverRevision,
        req.body.expectedInvoiceFingerprint,
      );
      const [saved] = await tx
        .update(invoicesTable)
        .set(updates)
        .where(eq(invoicesTable.id, current.id))
        .returning();
      if(cutoverEdit)assertCutoverInvoiceReadback(saved,next);
      return saved;
    });
    await queueQuickBooksReview(
      "invoice",
      invoice.id,
      "update",
      stripNulls(invoice),
      invoice.taxCode
        ? []
        : ["Confirm the QuickBooks tax code before approval"],
    );
    res.json(await response(invoice));
  }),
);
router.delete(
  "/invoices/:id",
  domainRoute(async (req, res) => {
    const params = DeleteInvoiceParams.parse(req.params),
      [seen] = await db
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.id, params.id));
    if (!seen) throw new DomainError(404, "Invoice not found.");
    await db.transaction(async (tx) => {
      await lockedCutoverJob(tx, seen.jobId);
      const [current] = await tx
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.id, seen.id))
        .for("update");
      if (!current || current.jobId !== seen.jobId)
        throw new DomainError(409, "Invoice changed. Refresh before deleting.");
      const [state] = await tx
        .select()
        .from(jobCutoversTable)
        .where(eq(jobCutoversTable.jobId, current.jobId));
      if (state)
        throw new DomainError(
          409,
          "Imported-job invoices and their billing consumption are retained. Delete, void, refund or payment status cannot silently replenish remaining capacity.",
        );
      await tx.delete(invoicesTable).where(eq(invoicesTable.id, current.id));
    });
    res.status(204).end();
  }),
);
export default router;
