import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db, invoicesTable, jobsTable, productsTable, proposalsTable, quickbooksConnectionsTable, quickbooksConflictsTable, quickbooksEntityMappingsTable, quickbooksSyncJobsTable, quickbooksWebhookEventsTable, type InvoiceLineCategory } from "@workspace/db";
import { audit } from "./auth";
import { getConnection, qboQuery, qboRequest, QuickBooksRequestError } from "./quickbooks";
import { logger } from "./logger";
import { assertQuickBooksCompanyLink, invoiceServiceEntity, invoiceServiceMappingKey, quickBooksInvoiceLines, quickBooksInvoicePaymentState } from "./quickbooks-invoice";
import { quickBooksWebhookChanges } from "./quickbooks-webhooks";
import { invoiceCreateAttempt, invoiceCreateRecord, prepareQuickBooksInvoiceCreate, QuickBooksInvoiceValidationError, reconcileQuickBooksInvoiceCreate } from "./quickbooks-invoice-create";
import { quickBooksCdcInvoiceIds, quickBooksPaymentInvoiceIds } from "./quickbooks-cdc";

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

async function exportJob(job: typeof quickbooksSyncJobsTable.$inferSelect) {
  if (job.entityType === "customer" || job.entityType === "project") {
    const [source] = await db.select().from(jobsTable).where(eq(jobsTable.id, job.localId)).limit(1); if (!source) throw new Error("Local job not found");
    const connection = await getConnection();
    if (connection?.status !== "connected") throw new Error("QuickBooks is not connected");
    const parent = job.entityType === "project" ? await mapping("customer", source.id) : null;
    const payload: any = job.entityType === "customer" ? { DisplayName: source.customerName, PrimaryEmailAddr: source.email ? { Address: source.email } : undefined, PrimaryPhone: source.phone ? { FreeFormNumber: source.phone } : undefined, BillAddr: { Line1: source.address, City: source.city } } : { DisplayName: `${source.jobNumber} - ${source.customerName}`, Job: true, ParentRef: parent ? { value: parent.quickbooksId } : undefined };
    if (job.entityType === "project" && !parent) throw new Error("Customer must be linked before its project");
    if (parent) assertQuickBooksCompanyLink("customer", parent, connection);
    const existing = await mapping(job.entityType, source.id);
    if (existing) {
      if (job.entityType === "customer") assertQuickBooksCompanyLink("customer", existing, connection);
      Object.assign(payload, { Id: existing.quickbooksId, SyncToken: existing.syncToken, sparse: true });
    }
    const result = await qboRequest("/customer", { method: "POST", body: JSON.stringify(payload) }, connection.id);
    await saveMapping(job.entityType, source.id, result.Customer, job.entityType === "customer" ? connection : undefined);
  } else if (job.entityType === "invoice") {
    const [source] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, job.localId)).limit(1);
    if (!source) throw new Error("Local invoice not found");
    const connection = await getConnection();
    if (connection?.status !== "connected") throw new Error("QuickBooks is not connected");
    const existing = await mapping("invoice", source.id);
    if (existing) {
      assertQuickBooksCompanyLink("invoice", existing, connection);
      if (job.action === "create") return;
    }
    const productIds = [...new Set(source.lineItems.flatMap(({ productId }) => productId ? [productId] : []))];
    const serviceCategories = [...new Set(source.lineItems.flatMap(({ productId, category }) => productId ? [] : [category]))];
    const categoriesByKey = new Map(serviceCategories.map((category) => [invoiceServiceMappingKey(connection, category), category]));
    const items = quickbooksEntityMappingsTable;
    const links = await db.select({ entityType: items.entityType, localId: items.localId, itemId: items.quickbooksId })
      .from(items).where(and(
        eq(items.status, "linked"),
        eq(items.realmId, connection.realmId),
        eq(items.environment, connection.environment),
        or(
          and(eq(items.entityType, "item"), inArray(items.localId, productIds)),
          and(eq(items.entityType, invoiceServiceEntity), inArray(items.localId, [...categoriesByKey.keys()])),
        ),
      ));
    const itemIds = new Map<string, string>();
    const serviceIds = new Map<InvoiceLineCategory, string>();
    for (const link of links) {
      if (link.entityType === "item") itemIds.set(link.localId, link.itemId);
      const category = categoriesByKey.get(link.localId);
      if (link.entityType === invoiceServiceEntity && category) serviceIds.set(category, link.itemId);
    }
    const lines = quickBooksInvoiceLines(source, itemIds, serviceIds);
    const customer = await mapping("customer", source.jobId);
    if (!customer) throw new Error("Customer mapping is required");
    assertQuickBooksCompanyLink("customer", customer, connection);
    const payload = {
      CustomerRef: { value: customer.quickbooksId },
      DocNumber: source.invoiceNumber,
      TxnDate: source.issueDate || undefined,
      DueDate: source.dueDate || undefined,
      PrivateNote: source.notes || undefined,
      Line: lines,
      ...(existing ? { Id: existing.quickbooksId, SyncToken: existing.syncToken, sparse: false } : {}),
    };
    if (existing) {
      const result = await qboRequest("/invoice", { method: "POST", body: JSON.stringify(payload) }, connection.id);
      await saveMapping("invoice", source.id, result.Invoice, connection);
    } else {
      const desired = prepareQuickBooksInvoiceCreate(connection, source.id, payload);
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
  } else if (job.entityType === "estimate") {
    const [source] = await db.select().from(proposalsTable).where(eq(proposalsTable.id, job.localId)).limit(1); if (!source) throw new Error("Local proposal not found");
    const customer = await mapping("customer", source.convertedJobId ?? source.id); if (!customer) throw new Error("Customer mapping is required");
    const payload: any = { CustomerRef: { value: customer.quickbooksId }, PrivateNote: source.scopeOfWork, Line: [{ Amount: source.estimatedPrice, DetailType: "SalesItemLineDetail", Description: source.flooringType, SalesItemLineDetail: { Qty: 1, UnitPrice: source.estimatedPrice } }] };
    const existing = await mapping("estimate", source.id); if (existing) Object.assign(payload, { Id: existing.quickbooksId, SyncToken: existing.syncToken });
    const result = await qboRequest("/estimate", { method: "POST", body: JSON.stringify(payload) }); await saveMapping("estimate", source.id, result.Estimate);
  } else if (job.entityType === "item") {
    const [source] = await db.select().from(productsTable).where(eq(productsTable.id, job.localId)).limit(1); if (!source) throw new Error("Local product not found");
    throw new Error(`Product ${source.name} needs an approved income-account mapping`);
  } else throw new Error(`Unsupported export entity: ${job.entityType}`);
}

export async function processQuickBooksQueue() {
  if ((await getConnection())?.status !== "connected") return;
  const now = new Date().toISOString();
  const rows = await db.select().from(quickbooksSyncJobsTable).where(and(inArray(quickbooksSyncJobsTable.status, ["approved", "retry"]), lte(quickbooksSyncJobsTable.nextAttemptAt, now))).orderBy(asc(quickbooksSyncJobsTable.createdAt)).limit(10);
  for (const row of rows) {
    const started = await db.update(quickbooksSyncJobsTable).set({ status: "processing", startedAt: now, attempts: row.attempts + 1, updatedAt: now }).where(and(eq(quickbooksSyncJobsTable.id, row.id), inArray(quickbooksSyncJobsTable.status, ["approved", "retry"]))).returning(); if (!started.length) continue;
    try { await exportJob(row); const done = new Date().toISOString(); await db.update(quickbooksSyncJobsTable).set({ status: "completed", completedAt: done, lastError: null, updatedAt: done }).where(eq(quickbooksSyncJobsTable.id, row.id)); await audit("quickbooks.sync_completed", { entityType: row.entityType, entityId: row.localId }); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); const retryable = error instanceof QuickBooksRequestError ? error.status === 429 || error.status >= 500 : /429|timeout|temporar|network|fetch/i.test(message); const status = retryable && row.attempts < 5 ? "retry" : "failed"; const delay = Math.min(60, 2 ** (row.attempts + 1)) * 60_000; await db.update(quickbooksSyncJobsTable).set({ status, lastError: message, nextAttemptAt: new Date(Date.now() + delay).toISOString(), updatedAt: new Date().toISOString() }).where(eq(quickbooksSyncJobsTable.id, row.id)); logger.error({ error, jobId: row.id }, "QuickBooks sync failed"); }
  }
}

async function importInvoice(quickbooksId: string, connection: NonNullable<Awaited<ReturnType<typeof getConnection>>>) {
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
  const [updated] = await db.update(invoicesTable).set({ ...payment, updatedAt: now })
    .where(and(eq(invoicesTable.id, local.id), eq(invoicesTable.updatedAt, local.updatedAt)))
    .returning({ id: invoicesTable.id });
  if (!updated) throw new Error("The local invoice changed during payment reconciliation. Retry the sync.");
  await db.update(quickbooksEntityMappingsTable).set({ syncToken: String(remote.SyncToken ?? link.syncToken), fingerprint: fingerprint(remote), lastSyncedAt: now, updatedAt: now }).where(eq(quickbooksEntityMappingsTable.id, link.id));
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

let lastCdcRun: { connectionId: string; startedAt: number } | undefined;
async function pollChanges() {
  const connection = await getConnection();
  if (connection?.status !== "connected") return;
  const startedAt = Date.now();
  if (lastCdcRun?.connectionId === connection.id && startedAt - lastCdcRun.startedAt < 5 * 60_000) return;
  lastCdcRun = { connectionId: connection.id, startedAt };
  const changedSince = connection.lastCdcAt ?? new Date(startedAt - 24 * 60 * 60_000).toISOString();
  const result = await qboRequest(`/cdc?entities=Invoice,Payment&changedSince=${encodeURIComponent(changedSince)}`, {}, connection.id);
  for (const invoiceId of quickBooksCdcInvoiceIds(result)) await importInvoice(invoiceId, connection);
  const now = new Date().toISOString();
  await db.update(quickbooksConnectionsTable).set({ lastCdcAt: new Date(startedAt).toISOString(), lastSyncAt: now, updatedAt: now })
    .where(and(eq(quickbooksConnectionsTable.id, connection.id), eq(quickbooksConnectionsTable.status, "connected"),
      or(sql`${quickbooksConnectionsTable.lastCdcAt} is null`, lte(quickbooksConnectionsTable.lastCdcAt, new Date(startedAt).toISOString())),
    ));
}

let timer: NodeJS.Timeout | undefined;
export function startQuickBooksWorker() { if (timer) return; timer = setInterval(() => Promise.all([processQuickBooksQueue(), processWebhookInbox(), pollChanges()]).catch((error) => logger.error({ error }, "QuickBooks worker failed")), 30_000); timer.unref(); }
