import { safeDiagnostic } from "./safe-logging";
import { workspaceScopeKey } from "@workspace/db/workspace";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db, withWorkspaceConnection, invoicesTable, jobsTable, productsTable, proposalsTable, quickbooksConnectionsTable, quickbooksConflictsTable, quickbooksEntityMappingsTable, quickbooksSyncJobsTable, quickbooksWebhookEventsTable, type InvoiceLineCategory } from "@workspace/db";
import { audit } from "./auth";
import { getConnection, qboQuery, qboRequest, QuickBooksRequestError, requireQuickBooksProjects } from "./quickbooks";
import { logger } from "./logger";
import { assertQuickBooksCompanyLink, invoiceServiceEntity, invoiceServiceMappingKey, quickBooksInvoiceLines, quickBooksInvoicePaymentState } from "./quickbooks-invoice";
import { quickBooksWebhookChanges } from "./quickbooks-webhooks";
import { invoiceCreateAttempt, invoiceCreateRecord, prepareQuickBooksInvoiceCreate, QuickBooksInvoiceValidationError, reconcileQuickBooksInvoiceCreate } from "./quickbooks-invoice-create";
import { quickBooksCdcInvoiceIds, quickBooksPaymentInvoiceIds } from "./quickbooks-cdc";
import { invoiceReviewFingerprint, isReviewedInvoiceAmount, requiresInvoiceReview, reviewedInvoiceApproval, reviewedInvoiceRecord, reviewedInvoicesAvailable, verifyClassicInvoiceTax, verifyExistingInvoice, verifyInvoiceDiscountAccount, verifyInvoiceReviewCompany, type InvoiceReviewInput } from "./quickbooks-invoice-review";
import { assertGenericExportCompany, genericExportAttempt, genericExportRecord, GenericExportReviewRequired, prepareGenericExport, reconcileGenericExport } from "./quickbooks-generic-export";
import { costEntities, processQueuedJobCost } from "./job-accounting";
import { verifiedProjectForJob } from "./quickbooks-projects";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QueueJob = typeof quickbooksSyncJobsTable.$inferSelect;

export async function prepareGenericExportApproval(tx: Transaction, job: Pick<QueueJob, "id" | "entityType" | "localId" | "payload">, company: NonNullable<Awaited<ReturnType<typeof getConnection>>>) {
  const findLink = async (entity: string, localId: string) => {
    const [link] = await tx.select().from(quickbooksEntityMappingsTable).where(and(eq(quickbooksEntityMappingsTable.entityType, entity), eq(quickbooksEntityMappingsTable.localId, localId))).limit(1);
    if (link && (link.status !== "linked" || link.realmId !== company.realmId || link.environment !== company.environment))
      throw new GenericExportReviewRequired("Reconcile the existing mapping in the selected QuickBooks company before approving this export.");
    return link;
  };
  let document: Record<string, unknown>;
  if (job.entityType === "customer") {
    const [source] = await tx.select().from(jobsTable).where(eq(jobsTable.id, job.localId)).for("update");
    if (!source || !source.customerName.trim()) throw new GenericExportReviewRequired("Review the customer name before approving this export.");
    document = { DisplayName: source.customerName, PrimaryEmailAddr: source.email ? { Address: source.email } : undefined,
      PrimaryPhone: source.phone ? { FreeFormNumber: source.phone } : undefined, BillAddr: { Line1: source.address, City: source.city } };
  } else if (job.entityType === "estimate") {
    const [source] = await tx.select().from(proposalsTable).where(eq(proposalsTable.id, job.localId)).for("update");
    if (!source || !Number.isFinite(source.estimatedPrice) || source.estimatedPrice <= 0) throw new GenericExportReviewRequired("Review the estimate amount before approving this export.");
    const customer = await findLink("customer", source.convertedJobId ?? source.id);
    if (!customer) throw new GenericExportReviewRequired("Reconcile the estimate customer before approving this export.");
    const category = job.payload.estimateServiceCategory;
    if (category !== "Labor" && category !== "Add-on" && category !== "Materials")
      throw new GenericExportReviewRequired("Select the estimateServiceCategory (Materials, Labor, or Add-on) and its approved sales item before queueing this estimate.");
    const service = await findLink(invoiceServiceEntity, invoiceServiceMappingKey(company, category));
    if (!service) throw new GenericExportReviewRequired("Map the selected estimate category to an active QuickBooks service item before approving it.");
    const amount = Math.round(source.estimatedPrice * 100) / 100;
    document = { CustomerRef: { value: customer.quickbooksId }, PrivateNote: source.scopeOfWork,
      Line: [{ Amount: amount, DetailType: "SalesItemLineDetail", Description: source.flooringType,
        SalesItemLineDetail: { Qty: 1, UnitPrice: amount, ItemRef: { value: service.quickbooksId } } }] };
  } else return null;
  const existing = await findLink(job.entityType, job.localId);
  if (existing) Object.assign(document, { Id: existing.quickbooksId, SyncToken: existing.syncToken, ...(job.entityType === "customer" ? { sparse: true } : {}) });
  return prepareGenericExport(job.id, job.entityType, job.localId, company, document);
}

async function exportGenericJob(job: QueueJob) {
  const parsed = genericExportAttempt.safeParse(job.payload[genericExportRecord]);
  if (!parsed.success || parsed.data.entityType !== job.entityType || parsed.data.localId !== job.localId)
    throw new GenericExportReviewRequired("This customer or estimate needs a fresh owner approval with a frozen QuickBooks document.", true);
  const attempt = parsed.data;
  const connection = await getConnection();
  if (!connection) throw new GenericExportReviewRequired("Restore the approved QuickBooks connection before exporting.");
  assertGenericExportCompany(attempt, connection);
  const provider = { query: (statement: string) => qboQuery(statement, attempt.connectionId),
    request: (path: string, init?: RequestInit) => qboRequest(path, init, attempt.connectionId) };
  await reconcileGenericExport(attempt, provider, async () => {
    await db.transaction(async tx => {
      const [current] = await tx.select().from(quickbooksSyncJobsTable).where(eq(quickbooksSyncJobsTable.id, job.id)).for("update");
      const saved = genericExportAttempt.safeParse(current?.payload[genericExportRecord]);
      if (!saved.success || current?.status !== "processing" || saved.data.state !== "prepared" || JSON.stringify(saved.data) !== JSON.stringify(attempt))
        throw new GenericExportReviewRequired("Another attempt already claimed this approved QuickBooks document. Reconcile it before retrying.");
      await tx.update(quickbooksSyncJobsTable).set({ payload: { ...current.payload, [genericExportRecord]: { ...attempt, state: "submitting" } }, updatedAt: new Date().toISOString() }).where(eq(quickbooksSyncJobsTable.id, job.id));
    });
  }, async remote => {
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
      const [company] = await tx.select().from(quickbooksConnectionsTable).where(eq(quickbooksConnectionsTable.id, attempt.connectionId)).for("update");
      if (!company) throw new GenericExportReviewRequired("The QuickBooks connection changed after submission. Reconcile the original company.");
      assertGenericExportCompany(attempt, company);
      const [current] = await tx.select().from(quickbooksSyncJobsTable).where(eq(quickbooksSyncJobsTable.id, job.id)).for("update");
      const saved = genericExportAttempt.parse(current?.payload[genericExportRecord]);
      if (saved.requestId !== attempt.requestId || saved.connectionId !== attempt.connectionId)
        throw new GenericExportReviewRequired("The approved export changed during submission. Reconcile it before proceeding.");
      const [link] = await tx.select().from(quickbooksEntityMappingsTable).where(and(eq(quickbooksEntityMappingsTable.entityType, attempt.entityType), eq(quickbooksEntityMappingsTable.localId, attempt.localId))).for("update");
      if (link && (link.quickbooksId !== String(remote.Id) || link.realmId !== attempt.realmId || link.environment !== attempt.environment))
        throw new GenericExportReviewRequired("The local mapping changed after submission. Reconcile the original QuickBooks document.");
      const now = new Date().toISOString();
      const fields = { quickbooksId: String(remote.Id), syncToken: String(remote.SyncToken ?? "0"), fingerprint: fingerprint(remote), realmId: attempt.realmId, environment: attempt.environment, status: "linked", lastSyncedAt: now, updatedAt: now };
      if (link) await tx.update(quickbooksEntityMappingsTable).set(fields).where(eq(quickbooksEntityMappingsTable.id, link.id));
      else await tx.insert(quickbooksEntityMappingsTable).values({ id: randomUUID(), entityType: attempt.entityType, localId: attempt.localId, createdAt: now, ...fields });
      await tx.update(quickbooksSyncJobsTable).set({ payload: { ...current.payload, [genericExportRecord]: { ...saved, state: "confirmed", remoteId: String(remote.Id) } }, updatedAt: now }).where(eq(quickbooksSyncJobsTable.id, job.id));
    });
  });
}

const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function mapping(entityType: string, localId: string) { const [row] = await db.select().from(quickbooksEntityMappingsTable).where(and(eq(quickbooksEntityMappingsTable.entityType, entityType), eq(quickbooksEntityMappingsTable.localId, localId))).limit(1); return row; }

async function saveMapping(entityType: string, localId: string, entity: any, company?: Pick<typeof quickbooksConnectionsTable.$inferSelect, "realmId" | "environment">) {
  const now = new Date().toISOString(); const existing = await mapping(entityType, localId);
  const values = { quickbooksId: String(entity.Id), syncToken: String(entity.SyncToken ?? "0"), fingerprint: fingerprint(entity), status: "linked", lastSyncedAt: now, lastError: null, updatedAt: now, ...(company ? { realmId: company.realmId, environment: company.environment } : {}) };
  if (existing) await db.update(quickbooksEntityMappingsTable).set(values).where(eq(quickbooksEntityMappingsTable.id, existing.id));
  else await db.insert(quickbooksEntityMappingsTable).values({ id: randomUUID(), entityType, localId, ...values, createdAt: now });
}

async function holdInvoiceCreateAttempt(
  job: typeof quickbooksSyncJobsTable.$inferSelect,
  source: typeof invoicesTable.$inferSelect,
  desired: ReturnType<typeof prepareQuickBooksInvoiceCreate>,
) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ updatedAt: invoicesTable.updatedAt }).from(invoicesTable)
      .where(eq(invoicesTable.id, source.id)).for("update");
    if (current?.updatedAt !== source.updatedAt) throw new Error("The invoice changed before export. Review it and retry.");

    const queue = quickbooksSyncJobsTable;
    const [prior] = await tx.select({ payload: queue.payload }).from(queue).where(and(
      eq(queue.entityType, "invoice"), eq(queue.localId, source.id), sql`${queue.payload} ? ${invoiceCreateRecord}`,
    )).limit(1);
    if (prior) {
      const attempt = invoiceCreateAttempt.parse(prior.payload[invoiceCreateRecord]);
      if (attempt.requestId !== desired.requestId) throw new Error("The first invoice export belongs to a different QuickBooks company. Reconcile before exporting.");
      return attempt;
    }

    const [held] = await tx.update(queue).set({ payload: { ...job.payload, [invoiceCreateRecord]: desired } })
      .where(and(eq(queue.id, job.id), eq(queue.status, "processing"))).returning({ id: queue.id });
    if (!held) throw new Error("The invoice export is no longer being processed. Review the queue and retry.");
    return desired;
  });
}

async function saveCreatedInvoiceMapping(localId: string, entity: any, company: Pick<typeof quickbooksConnectionsTable.$inferSelect, "realmId" | "environment">) {
  const now = new Date().toISOString();
  const [created] = await db.insert(quickbooksEntityMappingsTable).values({
    id: randomUUID(), entityType: "invoice", localId, quickbooksId: String(entity.Id),
    realmId: company.realmId, environment: company.environment, status: "linked", syncToken: String(entity.SyncToken ?? "0"),
    fingerprint: fingerprint(entity), lastSyncedAt: now, createdAt: now, updatedAt: now,
  }).onConflictDoNothing().returning({ id: quickbooksEntityMappingsTable.id });
  if (created) return;
  const current = await mapping("invoice", localId);
  if (!current || current.quickbooksId !== String(entity.Id)) throw new Error("The invoice mapping changed during export. Review it in QuickBooks.");
  assertQuickBooksCompanyLink("invoice", current, company);
}

type InvoiceSource = typeof invoicesTable.$inferSelect;
type ConnectedCompany = NonNullable<Awaited<ReturnType<typeof getConnection>>>;

async function compileInvoice(
  source: InvoiceSource,
  connection: ConnectedCompany,
  allowDiscount: boolean,
  taxSelection?: ReadonlySet<string> | "existing",
  allowExistingDeposit = false,
) {
  const productIds = [...new Set(source.lineItems.flatMap(({ productId }) => productId ? [productId] : []))];
  const categories = [...new Set(source.lineItems.flatMap(({ productId, category }) => productId ? [] : [category]))];
  const categoriesByKey = new Map(categories.map((category) => [invoiceServiceMappingKey(connection, category), category]));
  const items = quickbooksEntityMappingsTable;
  const links = await db.select({ entityType: items.entityType, localId: items.localId, itemId: items.quickbooksId })
    .from(items).where(and(
      eq(items.status, "linked"), eq(items.realmId, connection.realmId), eq(items.environment, connection.environment),
      or(and(eq(items.entityType, "item"), inArray(items.localId, productIds)),
        and(eq(items.entityType, invoiceServiceEntity), inArray(items.localId, [...categoriesByKey.keys()]))),
    ));
  const itemIds = new Map<string, string>();
  const serviceIds = new Map<InvoiceLineCategory, string>();
  for (const link of links) {
    if (link.entityType === "item") itemIds.set(link.localId, link.itemId);
    const category = categoriesByKey.get(link.localId);
    if (link.entityType === invoiceServiceEntity && category) serviceIds.set(category, link.itemId);
  }
  const customer = await mapping("customer", source.jobId);
  if (!customer) throw new Error("Customer mapping is required");
  assertQuickBooksCompanyLink("customer", customer, connection);
  const project = await verifiedProjectForJob(source.jobId, customer.quickbooksId, connection);
  return {
    CustomerRef: { value: customer.quickbooksId }, DocNumber: source.invoiceNumber,
    ...(project ? { ProjectRef: { value: project.projectId } } : {}),
    TxnDate: source.issueDate || undefined, DueDate: source.dueDate || undefined, PrivateNote: source.notes || undefined,
    Line: quickBooksInvoiceLines(source, itemIds, serviceIds, allowDiscount, taxSelection, allowExistingDeposit),
  };
}

export async function prepareReviewedInvoice(
  source: InvoiceSource,
  connection: ConnectedCompany,
  choice: InvoiceReviewInput,
) {
  if (!reviewedInvoicesAvailable(connection) || !requiresInvoiceReview(source))
    throw new Error("Reviewed invoice accounting is unavailable for this invoice and QuickBooks company.");
  if (["Credited", "Refunded", "Voided"].includes(source.status) || source.refundedAmount !== 0 ||
    !source.issueDate || !source.dueDate)
    throw new Error("Review an active invoice with an issue date and a due date.");
  if (![source.taxAmount, source.discountAmount, source.depositAmount, source.paidAmount, source.total, source.balanceAmount].every(isReviewedInvoiceAmount) ||
    Math.round(source.total * 100) - Math.round(source.depositAmount * 100) - Math.round(source.paidAmount * 100) !== Math.round(source.balanceAmount * 100))
    throw new Error("Review the exact invoice amounts. The invoice, deposit, payments, and open balance must reconcile to the cent.");
  if ((choice.existingInvoiceId || !source.taxAmount) && (choice.taxCodeId || choice.taxableLineIds.length))
    throw new Error("Select taxable lines and a tax code only when creating a new taxed invoice.");
  if (choice.discountAccountId && (choice.existingInvoiceId || !source.discountAmount))
    throw new Error("Select a sales discount account only when creating a new discounted invoice.");
  if (!choice.existingInvoiceId && (source.depositAmount || source.paidAmount))
    throw new Error("A paid invoice or deposit needs an existing matching QuickBooks invoice. No cash entry is created.");
  const existing = await mapping("invoice", source.id);
  if (existing) {
    assertQuickBooksCompanyLink("invoice", existing, connection);
    if (choice.existingInvoiceId !== existing.quickbooksId)
      throw new Error("Review the existing QuickBooks invoice ID attached to this invoice.");
  }

  const selection = choice.existingInvoiceId ? "existing" : new Set(choice.taxableLineIds);
  const local = await compileInvoice(source, connection, true, selection, !!choice.existingInvoiceId);
  if (!/^\d{1,30}$/.test(local.CustomerRef.value)) throw new Error("Reconcile the mapped QuickBooks customer before reviewing the invoice.");
  const request = (path: string) => qboRequest(path, {}, connection.id);
  const company = await verifyInvoiceReviewCompany(local.CustomerRef.value, request);
  if (!choice.existingInvoiceId && (company.preferences.SalesFormsPrefs?.CustomTxnNumbers !== true ||
    (source.discountAmount > 0 && company.preferences.SalesFormsPrefs.AllowDiscount !== true)))
    throw new Error("Enable custom transaction numbers and the applicable discount preference in QuickBooks before exporting.");
  if (!choice.existingInvoiceId) {
    const products = new Map<string, boolean>();
    local.Line.forEach((line, index) => {
      if (line.DetailType !== "SalesItemLineDetail") return;
      const id = line.SalesItemLineDetail.ItemRef.value;
      products.set(id, products.get(id) === true || !source.lineItems[index].productId);
    });
    await Promise.all([...products].map(async ([id, forService]) => {
      const { Item: item } = await qboRequest(`/item/${id}`, {}, connection.id);
      if (item?.Id !== id || item.Active !== true || !(forService ? item.Type === "Service" : ["Inventory", "NonInventory", "Service"].includes(item.Type)))
        throw new Error(`QuickBooks sales item ${id} no longer matches its active mapping.`);
    }));
  }

  const tax = source.taxAmount && !choice.existingInvoiceId
    ? await verifyClassicInvoiceTax(source, choice, connection.realmId, company, request) : undefined;
  const discountAccount = source.discountAmount && !choice.existingInvoiceId
    ? await verifyInvoiceDiscountAccount(choice.discountAccountId, request) : undefined;
  const attempt = prepareQuickBooksInvoiceCreate(connection, source.id, {
    ...local,
    Line: local.Line.map((line) => line.DetailType === "DiscountLineDetail" && discountAccount
      ? { ...line, DiscountLineDetail: { ...line.DiscountLineDetail, DiscountAccountRef: { value: discountAccount.id } } } : line),
    ...(!choice.existingInvoiceId && company.preferences.CurrencyPrefs.MultiCurrencyEnabled === true ? { CurrencyRef: { value: "USD" as const } } : {}),
    ...(tax ? { TxnTaxDetail: { TxnTaxCodeRef: { value: tax.id }, TotalTax: Math.round(source.taxAmount * 100) / 100 },
      ...(source.discountAmount > 0 ? { ApplyTaxAfterDiscount: true as const } : {}) } : {}),
  });
  const reconciliation = choice.existingInvoiceId ? await verifyExistingInvoice(source, choice.existingInvoiceId, attempt.document, request) : undefined;
  const evidence = { customer: company.customer, discountAccount, tax, reconciliation };
  const fingerprint = invoiceReviewFingerprint(connection, source, choice, attempt.document, evidence);
  return { fingerprint, attempt, evidence, companyName: connection.companyName, realmId: connection.realmId,
    total: source.total, discount: source.discountAmount, tax: source.taxAmount, deposit: source.depositAmount, balance: source.balanceAmount };
}

async function reconcileReviewedInvoice(source: InvoiceSource, company: ConnectedCompany, invoice: { invoiceId: string; syncToken: string }) {
  await db.transaction(async (tx) => {
    const [current] = await tx.select({ updatedAt: invoicesTable.updatedAt }).from(invoicesTable).where(eq(invoicesTable.id, source.id)).for("update");
    if (current?.updatedAt !== source.updatedAt) throw new Error("The local invoice changed before linking. Review it again.");
    const key = JSON.stringify(["invoice", company.environment, company.realmId, invoice.invoiceId]);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const links = quickbooksEntityMappingsTable;
    const matches = await tx.select().from(links).where(and(eq(links.entityType, "invoice"), or(
      eq(links.localId, source.id),
      and(eq(links.environment, company.environment), eq(links.realmId, company.realmId), eq(links.quickbooksId, invoice.invoiceId)),
    )));
    if (matches.some((link) => link.localId !== source.id || link.quickbooksId !== invoice.invoiceId))
      throw new Error("The QuickBooks invoice has a conflicting local link. Reconcile the conflicting mapping first.");
    const currentLink = matches[0];
    if (currentLink) assertQuickBooksCompanyLink("invoice", currentLink, company);
    const now = new Date().toISOString();
    const values = { quickbooksId: invoice.invoiceId, syncToken: invoice.syncToken, realmId: company.realmId,
      environment: company.environment, status: "linked", lastSyncedAt: now, updatedAt: now };
    if (currentLink) await tx.update(links).set(values).where(eq(links.id, currentLink.id));
    else await tx.insert(links).values({ id: randomUUID(), localId: source.id, entityType: "invoice", createdAt: now, ...values });
  });
}

async function exportJob(job: typeof quickbooksSyncJobsTable.$inferSelect) {
  if(costEntities.includes(job.entityType)) {
    if(typeof job.payload.jobCostExportId!=="string")throw new Error("This cost requires a dedicated owner review.");
    const result=await processQueuedJobCost(job);
    if(result.outcome!=="confirmed")throw new Error("This cost submission remains unconfirmed. Use Reconcile; no write was repeated.");
    return;
  }
  if(job.entityType==="project")requireQuickBooksProjects();
  if (job.entityType === "customer" || job.entityType === "estimate") {
    await exportGenericJob(job);
  } else if (job.entityType === "invoice") {
    const [source] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, job.localId)).limit(1);
    if (!source) throw new Error("Local invoice not found");
    const connection = await getConnection();
    if (connection?.status !== "connected") throw new Error("QuickBooks is not connected");
    const existing = await mapping("invoice", source.id);
    const accountingReview = reviewedInvoiceApproval.safeParse(job.payload[reviewedInvoiceRecord]);
    if (requiresInvoiceReview(source) && !accountingReview.success)
      throw new Error("Review and approve this invoice’s tax, discount, or deposit before exporting it to QuickBooks.");
    if (job.payload[reviewedInvoiceRecord] && !accountingReview.success)
      throw new Error("The invoice needs an updated owner accounting review.");
    if (existing && accountingReview.success && !accountingReview.data.request.existingInvoiceId) {
      if (!reviewedInvoicesAvailable(connection)) throw new Error("Reviewed invoice accounting is disabled for this QuickBooks company.");
      assertQuickBooksCompanyLink("invoice", existing, connection);
      const savedAttempt = invoiceCreateAttempt.safeParse(job.payload[invoiceCreateRecord]);
      if (!savedAttempt.success) throw new Error("The invoice already has a QuickBooks link. Review that existing invoice.");
      const recovered = await reconcileQuickBooksInvoiceCreate(savedAttempt.data, {
        query: (statement) => qboQuery(statement, connection.id), request: (path, init) => qboRequest(path, init, connection.id),
      }, false);
      if (!recovered || typeof recovered !== "object" || !("Id" in recovered) || recovered.Id !== existing.quickbooksId)
        throw new Error("The saved QuickBooks invoice differs from the approved export. Reconcile it before retrying.");
      return;
    }
    const reviewed = accountingReview.success ? await prepareReviewedInvoice(source, connection, accountingReview.data.request) : undefined;
    if (accountingReview.success && reviewed?.fingerprint !== accountingReview.data.fingerprint)
      throw new Error("The invoice or QuickBooks accounting details changed after approval. Review them again.");
    if (reviewed?.evidence.reconciliation) {
      await reconcileReviewedInvoice(source, connection, reviewed.evidence.reconciliation);
      return;
    }
    if (existing) {
      assertQuickBooksCompanyLink("invoice", existing, connection);
      if (job.action === "create") return;
    }
    if (existing) {
      const payload = { ...await compileInvoice(source, connection, false), Id: existing.quickbooksId, SyncToken: existing.syncToken, sparse: false };
      const result = await qboRequest("/invoice", { method: "POST", body: JSON.stringify(payload) }, connection.id);
      await saveMapping("invoice", source.id, result.Invoice, connection);
    } else {
      const desired = reviewed?.attempt ?? prepareQuickBooksInvoiceCreate(connection, source.id, await compileInvoice(source, connection, connection.environment === "sandbox"));
      const attempt = await holdInvoiceCreateAttempt(job, source, desired);
      const matchesApproval = JSON.stringify(attempt.document) === JSON.stringify(desired.document);
      let posted: unknown;
      try {
        posted = await reconcileQuickBooksInvoiceCreate(attempt, {
          query: (statement) => qboQuery(statement, connection.id),
          request: (path, init) => qboRequest(path, init, connection.id),
        }, matchesApproval);
      } catch (error) {
        if (error instanceof QuickBooksInvoiceValidationError) {
          const queue = quickbooksSyncJobsTable;
          await db.update(queue).set({ payload: sql`${queue.payload} - ${invoiceCreateRecord}` }).where(and(
            eq(queue.entityType, "invoice"), eq(queue.localId, source.id),
            sql`${queue.payload} -> ${invoiceCreateRecord} = ${JSON.stringify(attempt)}::jsonb`,
          ));
        }
        throw error;
      }
      await saveCreatedInvoiceMapping(source.id, posted, connection);
      if (!matchesApproval) throw new Error("Recovered the original QuickBooks invoice link. Review the latest changes before retrying this export.");
    }
  } else if (job.entityType === "item") {
    const [source] = await db.select().from(productsTable).where(eq(productsTable.id, job.localId)).limit(1); if (!source) throw new Error("Local product not found");
    throw new Error(`Product ${source.name} needs an approved income-account mapping`);
  } else throw new Error(`Unsupported export entity: ${job.entityType}`);
}

export async function processQuickBooksQueue() {
  if ((await getConnection())?.status !== "connected") return;
  const now = new Date().toISOString();
  // A killed worker may have submitted remotely but not saved its mapping. Keep
  // its immutable attempt and require reconciliation before any further write.
  await db.update(quickbooksSyncJobsTable).set({ status: "failed", lastError: "An earlier export was interrupted. Retry to reconcile its original QuickBooks record; an unconfirmed create will not be resubmitted.", updatedAt: now })
    .where(and(inArray(quickbooksSyncJobsTable.entityType, ["customer", "estimate"]), eq(quickbooksSyncJobsTable.status, "processing"), lte(quickbooksSyncJobsTable.startedAt, new Date(Date.now() - 120_000).toISOString())));
  const rows = await db.select().from(quickbooksSyncJobsTable).where(and(inArray(quickbooksSyncJobsTable.status, ["approved", "retry"]), lte(quickbooksSyncJobsTable.nextAttemptAt, now))).orderBy(asc(quickbooksSyncJobsTable.createdAt)).limit(10);
  for (const row of rows) {
    const started = await db.update(quickbooksSyncJobsTable).set({ status: "processing", startedAt: now, attempts: row.attempts + 1, updatedAt: now }).where(and(eq(quickbooksSyncJobsTable.id, row.id), inArray(quickbooksSyncJobsTable.status, ["approved", "retry"]))).returning(); if (!started.length) continue;
    try { await exportJob(row); const done = new Date().toISOString(); await db.update(quickbooksSyncJobsTable).set({ status: "completed", completedAt: done, lastError: null, updatedAt: done }).where(eq(quickbooksSyncJobsTable.id, row.id)); await audit("quickbooks.sync_completed", { entityType: row.entityType, entityId: row.localId }); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); const retryable = error instanceof GenericExportReviewRequired ? false : error instanceof QuickBooksRequestError ? error.status === 429 || error.status >= 500 : /429|timeout|temporar|network|fetch/i.test(message); const status = error instanceof GenericExportReviewRequired && error.approvalRequired ? "pending_approval" : retryable && row.attempts < 5 ? "retry" : "failed"; const delay = Math.min(60, 2 ** (row.attempts + 1)) * 60_000; await db.update(quickbooksSyncJobsTable).set({ status, lastError: message, nextAttemptAt: new Date(Date.now() + delay).toISOString(), updatedAt: new Date().toISOString() }).where(eq(quickbooksSyncJobsTable.id, row.id)); logger.error(safeDiagnostic("qbo_sync_failed", error), "QuickBooks sync failed"); }
  }
}

export async function importInvoice(quickbooksId: string, connection: NonNullable<Awaited<ReturnType<typeof getConnection>>>) {
  const mappings = quickbooksEntityMappingsTable;
  const [link] = await db.select().from(mappings).where(and(
    eq(mappings.entityType, "invoice"), eq(mappings.quickbooksId, quickbooksId), eq(mappings.status, "linked"),
    eq(mappings.realmId, connection.realmId), eq(mappings.environment, connection.environment),
  )).limit(1);
  if (!link) return;
  const { Invoice: remote } = await qboRequest(`/invoice/${quickbooksId}`, {}, connection.id);
  if (!remote) return;
  const [local] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, link.localId)).limit(1); if (!local) return;
  const importedAt = new Date();
  const payment = quickBooksInvoicePaymentState(local, remote, importedAt);
  if (!payment) return;
  const remoteUpdated = String(remote.MetaData?.LastUpdatedTime ?? "");
  if (link.lastSyncedAt && local.updatedAt > link.lastSyncedAt && remoteUpdated > link.lastSyncedAt) {
    const [existing] = await db.select().from(quickbooksConflictsTable).where(and(eq(quickbooksConflictsTable.entityType, "invoice"), eq(quickbooksConflictsTable.localId, local.id), eq(quickbooksConflictsTable.status, "open"))).limit(1);
    if (!existing) await db.insert(quickbooksConflictsTable).values({ id: randomUUID(), entityType: "invoice", localId: local.id, quickbooksId, localSnapshot: local as any, quickbooksSnapshot: remote, createdAt: new Date().toISOString() });
    return;
  }
  const now = importedAt.toISOString();
  await db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
    const [current]=await tx.select().from(quickbooksConnectionsTable).where(eq(quickbooksConnectionsTable.id,connection.id)).for("update");
    if(!current||current.status!=="connected"||current.realmId!==connection.realmId||current.environment!==connection.environment)throw new Error("The QuickBooks company changed during payment reconciliation. Local values were preserved.");
    const [currentLink]=await tx.select().from(mappings).where(eq(mappings.id,link.id)).for("update");
    if(!currentLink||currentLink.localId!==local.id||currentLink.quickbooksId!==quickbooksId||currentLink.realmId!==connection.realmId||currentLink.environment!==connection.environment||currentLink.status!=="linked")throw new Error("The invoice mapping changed during payment reconciliation. Review the link before importing.");
    const [updated] = await tx.update(invoicesTable).set({ ...payment, updatedAt: now })
      .where(and(eq(invoicesTable.id, local.id), eq(invoicesTable.updatedAt, local.updatedAt)))
      .returning({ id: invoicesTable.id });
    if (!updated) throw new Error("The local invoice changed during payment reconciliation. Retry the sync.");
    await tx.update(quickbooksEntityMappingsTable).set({ syncToken: String(remote.SyncToken ?? link.syncToken), fingerprint: fingerprint(remote), lastSyncedAt: now, updatedAt: now }).where(eq(quickbooksEntityMappingsTable.id, link.id));
  });
}

async function processWebhookInbox() {
  const connection = await getConnection();
  if (connection?.status !== "connected") return;
  const inbox = quickbooksWebhookEventsTable;
  const events = await db.select().from(inbox).where(and(
    eq(inbox.status, "received"), eq(inbox.realmId, connection.realmId),
  )).limit(25);
  for (const event of events) {
    try {
      for (const change of quickBooksWebhookChanges(event.payload, connection.realmId)) {
        // Deleted records cannot be fetched. Preserve local accounting records.
        if (change.deleted) continue;
        if (change.entity === "Invoice") {
          await importInvoice(change.id, connection);
          continue;
        }
        const { Payment: payment } = await qboRequest(`/payment/${change.id}`, {}, connection.id);
        for (const id of quickBooksPaymentInvoiceIds(payment)) await importInvoice(id, connection);
      }
      await db.update(quickbooksWebhookEventsTable).set({ status: "processed", processedAt: new Date().toISOString() }).where(eq(quickbooksWebhookEventsTable.id, event.id));
    } catch (error) { await db.update(quickbooksWebhookEventsTable).set({ status: "failed", lastError: error instanceof Error ? error.message : String(error) }).where(eq(quickbooksWebhookEventsTable.id, event.id)); }
  }
}

const lastCdcRuns = new Map<string, { connectionId: string; startedAt: number }>();
async function pollChanges() {
  const connection = await getConnection();
  if (connection?.status !== "connected") return;
  const startedAt = Date.now();
  const scope = workspaceScopeKey();
  const lastCdcRun = lastCdcRuns.get(scope);
  if (lastCdcRun?.connectionId === connection.id && startedAt - lastCdcRun.startedAt < 5 * 60_000) return;
  lastCdcRuns.set(scope, { connectionId: connection.id, startedAt });
  const changedSince = connection.lastCdcAt ?? new Date(startedAt - 24 * 60 * 60_000).toISOString();
  const result = await qboRequest(`/cdc?entities=Invoice,Payment&changedSince=${encodeURIComponent(changedSince)}`, {}, connection.id);
  for (const invoiceId of quickBooksCdcInvoiceIds(result)) await importInvoice(invoiceId, connection);
  const now = new Date().toISOString();
  await db.update(quickbooksConnectionsTable).set({ lastCdcAt: new Date(startedAt).toISOString(), lastSyncAt: now, updatedAt: now })
    .where(and(eq(quickbooksConnectionsTable.id, connection.id), eq(quickbooksConnectionsTable.status, "connected"),
      or(sql`${quickbooksConnectionsTable.lastCdcAt} is null`, lte(quickbooksConnectionsTable.lastCdcAt, new Date(startedAt).toISOString())),
    ));
}

const timers = new Map<string, NodeJS.Timeout>();
export function stopQuickBooksWorker() {
  const key = workspaceScopeKey();
  const timer = timers.get(key);
  if (timer) clearInterval(timer);
  timers.delete(key);
}
export function startQuickBooksWorker() {
  const key = workspaceScopeKey();
  if (timers.has(key)) return;
  const timer = setInterval(() =>
    withWorkspaceConnection(() => Promise.all([processQuickBooksQueue(), processWebhookInbox(), pollChanges()]))
      .catch((error) => logger.error(safeDiagnostic("qbo_worker_failed", error), "QuickBooks worker failed")), 30_000);
  timers.set(key, timer);
  timer.unref();
}
