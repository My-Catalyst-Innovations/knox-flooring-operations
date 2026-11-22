import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, inArray, like, notInArray, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db, invoicesTable, jobsTable, materialsTable, productsTable, proposalsTable, quickbooksAccountingMappingsTable, quickbooksConflictsTable, quickbooksConnectionsTable, quickbooksEntityMappingsTable, quickbooksSyncJobsTable, quickbooksWebhookEventsTable } from "@workspace/db";
import { workspaceEnvironment } from "@workspace/db/workspace";
import { audit } from "../lib/auth";
import { encryptSecret, getConnection, qboQuery, qboRequest, signOAuthState, verifyOAuthState } from "../lib/quickbooks";
import { loadQuickBooksCatalogEntity, quickBooksCatalogEntities } from "../lib/quickbooks-catalog";
import { prepareReviewedInvoice, processQuickBooksQueue } from "../lib/quickbooks-worker";
import { requireOwner } from "../middlewares/auth";
import { vendorBillEntity } from "../lib/vendor-bill";
import { productionStockItemEntity, sandboxStockItemEntity } from "../lib/quickbooks-stock-item";
import { stockAdjustmentEntity } from "../lib/quickbooks-inventory-reconciliation";
import { invoiceServiceCategories, invoiceServiceEntity, invoiceServiceMappingKey, isActiveQuickBooksServiceItem } from "../lib/quickbooks-invoice";
import { domainRoute, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { quickBooksWebhookEntries, verifyQuickBooksWebhookSignature } from "../lib/quickbooks-webhooks";
import { invoiceCreateRecord } from "../lib/quickbooks-invoice-create";
import { invoiceReviewInput, requiresInvoiceReview, reviewedInvoiceApproval, reviewedInvoiceRecord, reviewedInvoicesAvailable } from "../lib/quickbooks-invoice-review";

const router: IRouter = Router();
const configured = () => Boolean(workspaceEnvironment().QUICKBOOKS_CLIENT_ID && workspaceEnvironment().QUICKBOOKS_CLIENT_SECRET && workspaceEnvironment().QUICKBOOKS_REDIRECT_URI && workspaceEnvironment().QUICKBOOKS_ENCRYPTION_KEY);
const demoAvailable = () => workspaceEnvironment().DEMO_MODE === "true";
const publicConnection = (c: Awaited<ReturnType<typeof getConnection>>) => c ? ({ connected: c.status === "connected", status: c.status, realmId: c.realmId, companyName: c.companyName, environment: c.environment, readinessStatus: c.readinessStatus, lastSyncAt: c.lastSyncAt, lastCdcAt: c.lastCdcAt, refreshTokenExpiresAt: c.refreshTokenExpiresAt }) : ({ connected: false, status: configured() ? "not_connected" : "not_configured", readinessStatus: "configuration_required" });

router.get("/quickbooks/status", async (_req, res) => res.json({ configured: configured(), demoAvailable: demoAvailable(), demoCompany: demoAvailable() ? { name: "Knoxville Flooring Demo Company", environment: "simulated", lastFour: "1982" } : null, connection: publicConnection(await getConnection()) }));

router.get("/quickbooks/demo", async (_req, res) => {
  if (!demoAvailable()) { res.status(404).json({ error: "QuickBooks demo mode is unavailable" }); return; }
  const items = await db.select().from(quickbooksSyncJobsTable).where(like(quickbooksSyncJobsTable.idempotencyKey, "qbdemo:%")).orderBy(asc(quickbooksSyncJobsTable.createdAt));
  res.json({ company: { name: "Knoxville Flooring Demo Company", environment: "simulated", companyId: "DEMO-1982" }, items });
});

router.post("/quickbooks/demo/load", requireOwner, async (req, res) => {
  if (!demoAvailable()) { res.status(404).json({ error: "QuickBooks demo mode is unavailable" }); return; }
  const connection = await getConnection();
  if (connection?.status === "connected") { res.status(409).json({ error: "Disconnect the live QuickBooks company before running the simulator" }); return; }
  const [[job], [proposal], [invoice], [product], [material]] = await Promise.all([
    db.select().from(jobsTable).orderBy(desc(jobsTable.createdAt)).limit(1),
    db.select().from(proposalsTable).orderBy(desc(proposalsTable.createdAt)).limit(1),
    db.select().from(invoicesTable).where(inArray(invoicesTable.status, ["Partial", "Overdue", "Sent"])).orderBy(desc(invoicesTable.createdAt)).limit(1),
    db.select().from(productsTable).orderBy(asc(productsTable.name)).limit(1),
    db.select().from(materialsTable).limit(1),
  ]);
  const now = new Date().toISOString();
  const definitions = [
    job && { entityType: "customer", localId: job.id, action: "create", destination: "QuickBooks Customer", summary: `Create customer record for ${job.jobNumber}`, amount: null, preview: { DisplayName: job.customerName, PrimaryEmailAddr: job.email || "Not supplied" } },
    job && { entityType: "project", localId: job.id, action: "create", destination: "QuickBooks Project", summary: `Create ${job.jobNumber} beneath its customer`, amount: job.estRevenue, preview: { Name: `${job.jobNumber} - ${job.flooringType}`, Status: "In Progress" } },
    product && { entityType: "item", localId: product.id, action: "create", destination: "Products & Services", summary: `Map ${product.name} to flooring income`, amount: product.price, preview: { Name: product.name, Sku: product.sku, UnitPrice: product.price } },
    proposal && { entityType: "estimate", localId: proposal.id, action: "create", destination: "QuickBooks Estimate", summary: `Export approved ${proposal.flooringType} proposal`, amount: proposal.estimatedPrice, preview: { TotalAmt: proposal.estimatedPrice, TxnStatus: proposal.status } },
    invoice && { entityType: "invoice", localId: invoice.id, action: "create", destination: "QuickBooks Invoice", summary: `Post invoice ${invoice.invoiceNumber} with tax and deposit`, amount: invoice.total, preview: { DocNumber: invoice.invoiceNumber, TotalAmt: invoice.total, Balance: invoice.balanceAmount, TaxCode: invoice.taxCode || "TAX" } },
    invoice && { entityType: "payment", localId: invoice.id, action: "import", destination: "Knox payment status", summary: `Import a QuickBooks payment against ${invoice.invoiceNumber}`, amount: Math.min(invoice.balanceAmount || invoice.total, 2500), preview: { PaymentRefNum: "DEMO-PMT-1982", AppliedTo: invoice.invoiceNumber } },
    job && { entityType: "time", localId: job.id, action: "create", destination: "QuickBooks Time Activity", summary: `Assign crew labor to project ${job.jobNumber}`, amount: job.actualLaborCost || job.laborEstimate, preview: { Hours: job.estLaborHours, EmployeeOrVendor: job.crewAssigned } },
    material && { entityType: "expense", localId: material.id, action: "create", destination: "QuickBooks Billable Expense", summary: `Assign material purchase to ${material.jobNumber}`, amount: null, preview: { Vendor: material.supplier || "Demo Flooring Supply", Project: material.jobNumber, Status: material.status } },
  ].filter(Boolean) as Array<{ entityType: string; localId: string; action: string; destination: string; summary: string; amount: number | null; preview: Record<string, unknown> }>;
  await db.transaction(async (tx) => {
    await tx.delete(quickbooksSyncJobsTable).where(like(quickbooksSyncJobsTable.idempotencyKey, "qbdemo:%"));
    if (definitions.length) await tx.insert(quickbooksSyncJobsTable).values(definitions.map((item, index) => ({
      id: randomUUID(),
      idempotencyKey: `qbdemo:${item.entityType}:${item.localId}:${index}`,
      entityType: item.entityType,
      localId: item.localId,
      action: item.action,
      status: "demo_pending",
      payload: { demoSimulation: true, flowStep: index + 1, destination: item.destination, summary: item.summary, amount: item.amount, quickBooksPreview: item.preview },
      warnings: item.entityType === "invoice" ? ["Owner approval required before accounting export"] : [],
      nextAttemptAt: now,
      createdAt: new Date(Date.now() + index).toISOString(),
      updatedAt: now,
    })));
  });
  await audit("quickbooks.demo_loaded", { userId: req.auth!.userId, entityType: "quickbooks_demo", details: { count: definitions.length } });
  res.json({ loaded: definitions.length });
});

router.post("/quickbooks/demo/approve", requireOwner, async (req, res) => {
  if (!demoAvailable()) { res.status(404).json({ error: "QuickBooks demo mode is unavailable" }); return; }
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) { res.status(400).json({ error: "ids are required" }); return; }
  const rows = await db.select().from(quickbooksSyncJobsTable).where(and(inArray(quickbooksSyncJobsTable.id, ids), eq(quickbooksSyncJobsTable.status, "demo_pending")));
  const now = new Date().toISOString();
  const changed = [];
  for (const row of rows) {
    if ((row.payload as any)?.demoSimulation !== true || !row.idempotencyKey.startsWith("qbdemo:")) continue;
    const demoId = `QB-DEMO-${createHash("sha256").update(`${row.entityType}:${row.localId}`).digest("hex").slice(0, 8).toUpperCase()}`;
    const [updated] = await db.update(quickbooksSyncJobsTable).set({ status: "demo_completed", attempts: 1, approvedBy: req.auth!.userId, approvedAt: now, startedAt: now, completedAt: now, updatedAt: now, payload: { ...row.payload, demoResult: { id: demoId, syncToken: "0", completedAt: now, direction: row.action === "import" ? "QuickBooks → Knox" : "Knox → QuickBooks" } } }).where(eq(quickbooksSyncJobsTable.id, row.id)).returning();
    if (updated) changed.push(updated);
  }
  await audit("quickbooks.demo_sync_completed", { userId: req.auth!.userId, entityType: "quickbooks_demo", details: { ids: changed.map((row) => row.id) } });
  res.json(changed);
});

router.get("/quickbooks/connect", async (req, res) => {
  if (!configured()) { res.status(503).json({ error: "QuickBooks environment variables are not configured" }); return; }
  const state = signOAuthState(`${req.auth!.userId}:${Date.now()}:${randomUUID()}`);
  res.cookie("qbo_oauth_state", state, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 10 * 60_000, path: "/" });
  const url = new URL("https://appcenter.intuit.com/connect/oauth2");
  url.searchParams.set("client_id", workspaceEnvironment().QUICKBOOKS_CLIENT_ID!); url.searchParams.set("response_type", "code"); url.searchParams.set("scope", "com.intuit.quickbooks.accounting"); url.searchParams.set("redirect_uri", workspaceEnvironment().QUICKBOOKS_REDIRECT_URI!); url.searchParams.set("state", state);
  res.json({ authorizationUrl: url.toString() });
});

router.get("/quickbooks/callback", async (req, res) => {
  const state = String(req.query.state ?? ""); const cookieState = String(req.cookies?.qbo_oauth_state ?? "");
  if (!verifyOAuthState(state) || state !== cookieState || !req.query.code || !req.query.realmId) { res.status(400).send("Invalid QuickBooks authorization response"); return; }
  const auth = Buffer.from(`${workspaceEnvironment().QUICKBOOKS_CLIENT_ID}:${workspaceEnvironment().QUICKBOOKS_CLIENT_SECRET}`).toString("base64");
  const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", { method: "POST", headers: { Authorization: `Basic ${auth}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: String(req.query.code), redirect_uri: workspaceEnvironment().QUICKBOOKS_REDIRECT_URI! }) });
  if (!response.ok) { res.status(502).send("QuickBooks token exchange failed"); return; }
  const token = await response.json() as any; const now = new Date(); const realmId = String(req.query.realmId);
  await db.delete(quickbooksConnectionsTable);
  await db.insert(quickbooksConnectionsTable).values({ id: randomUUID(), realmId, environment: workspaceEnvironment().QUICKBOOKS_ENVIRONMENT === "production" ? "production" : "sandbox", encryptedAccessToken: encryptSecret(token.access_token), encryptedRefreshToken: encryptSecret(token.refresh_token), accessTokenExpiresAt: new Date(now.getTime() + token.expires_in * 1000).toISOString(), refreshTokenExpiresAt: new Date(now.getTime() + token.x_refresh_token_expires_in * 1000).toISOString(), status: "connected", readinessStatus: "reconciliation_required", createdAt: now.toISOString(), updatedAt: now.toISOString() });
  res.clearCookie("qbo_oauth_state", { path: "/" }); await audit("quickbooks.connected", { userId: req.auth!.userId, entityType: "quickbooks_company", entityId: realmId, ip: req.ip }); res.redirect("/settings?quickbooks=connected");
});

router.post("/quickbooks/disconnect", async (req, res) => { const c = await getConnection(); if (c) await db.update(quickbooksConnectionsTable).set({ status: "disconnected", encryptedAccessToken: encryptSecret("revoked"), encryptedRefreshToken: encryptSecret("revoked"), updatedAt: new Date().toISOString() }).where(eq(quickbooksConnectionsTable.id, c.id)); await audit("quickbooks.disconnected", { userId: req.auth!.userId, ip: req.ip }); res.status(204).end(); });

router.post("/quickbooks/reconcile", async (req, res) => {
  const connection = await getConnection();
  if (connection?.status !== "connected") { res.status(409).json({ error: "Connect QuickBooks before reconciling the catalog." }); return; }
  const result: Record<string, Awaited<ReturnType<typeof loadQuickBooksCatalogEntity>>> = {};
  for (const entity of quickBooksCatalogEntities) {
    result[entity.toLowerCase()] = await loadQuickBooksCatalogEntity(entity, (statement) => qboQuery(statement, connection.id));
  }
  const [current] = await db.update(quickbooksConnectionsTable).set({ lastSyncAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).where(and(eq(quickbooksConnectionsTable.id, connection.id), eq(quickbooksConnectionsTable.status, "connected"))).returning({ id: quickbooksConnectionsTable.id });
  if (!current) { res.status(409).json({ error: "The QuickBooks connection changed during reconciliation. Reconcile again." }); return; }
  const localJobs = await db.select().from(jobsTable); const localProducts = await db.select().from(productsTable); const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9@]/g, "");
  const customers = result.customer;
  const items = result.item.filter((item) => item.Active !== false && item.Type !== "Category");
  const normalizeSku = (value: string | undefined) => value?.trim().toLowerCase() || "";
  const candidates = [
    ...localJobs.map(local => { const matches = customers.filter(remote => norm(remote.PrimaryEmailAddr?.Address) === norm(local.email) || norm(remote.PrimaryPhone?.FreeFormNumber) === norm(local.phone) || norm(remote.DisplayName) === norm(local.customerName)); return { entityType: "customer", localId: local.id, localName: local.customerName, matches: matches.map(m => ({ id: String(m.Id), name: m.DisplayName, confidence: norm(m.PrimaryEmailAddr?.Address) === norm(local.email) && Boolean(local.email) ? "exact" : "suggested" })) }; }),
    ...localProducts.map((local) => {
      const sku = normalizeSku(local.sku);
      const exact = sku ? items.filter((item) => normalizeSku(item.Sku) === sku) : [];
      const matches = exact.length ? exact : items.filter((item) => norm(item.Name) === norm(local.name));
      return {
        entityType: "item", localId: local.id, localName: local.name,
        matches: matches.map((item) => ({ id: item.Id, name: item.Name, confidence: exact.length === 1 ? "exact" : "suggested" })),
      };
    }),
  ];
  await audit("quickbooks.reconciliation_loaded", { userId: req.auth!.userId, details: Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.length])) }); res.json({ lists: result, candidates, connectionId: connection.id });
});

const serviceCategorySchema = z.enum(invoiceServiceCategories);

router.get("/quickbooks/invoice-service-mappings", requireOwner, domainRoute(async (_req, res) => {
  const connection = await getConnection();
  if (connection?.status !== "connected") throw new DomainError(409, "Connect QuickBooks before reviewing invoice service items.");
  const mappings = quickbooksEntityMappingsTable;
  const rows = await db.select({ localId: mappings.localId, itemId: mappings.quickbooksId })
    .from(mappings).where(and(
      eq(mappings.entityType, invoiceServiceEntity),
      eq(mappings.status, "linked"),
      eq(mappings.realmId, connection.realmId),
      eq(mappings.environment, connection.environment),
    ));
  const byKey = new Map(rows.map((row) => [row.localId, row.itemId]));
  res.json({
    connectionId: connection.id,
    mappings: invoiceServiceCategories.map((category) => ({
      category,
      itemId: byKey.get(invoiceServiceMappingKey(connection, category)) ?? null,
    })),
  });
}));

router.put("/quickbooks/invoice-service-mappings/:category", requireOwner, domainRoute(async (req, res) => {
  const category = parse(serviceCategorySchema, req.params.category);
  const { connectionId, itemId } = parse(z.object({
    connectionId: z.string().min(1),
    itemId: z.string().regex(/^\d{1,30}$/).nullable(),
  }), req.body);
  const connection = await getConnection();
  if (connection?.status !== "connected" || connection.id !== connectionId)
    throw new DomainError(409, "The QuickBooks connection changed. Refresh invoice service items.");
  const item = itemId ? (await qboRequest(`/item/${itemId}`, {}, connection.id)).Item : undefined;
  if (itemId && !isActiveQuickBooksServiceItem(item, itemId))
    throw new DomainError(409, "Select an active Service item in the connected QuickBooks company.");

  const mappings = quickbooksEntityMappingsTable;
  const localId = invoiceServiceMappingKey(connection, category);
  const now = new Date().toISOString();
  const values = {
    quickbooksId: itemId ?? "ignored",
    realmId: connection.realmId,
    environment: connection.environment,
    status: itemId ? "linked" : "ignored",
    syncToken: String(item?.SyncToken ?? "0"),
    updatedAt: now,
  };
  await db.transaction(async (tx) => {
    const [current] = await tx.select({ id: quickbooksConnectionsTable.id }).from(quickbooksConnectionsTable)
      .where(and(eq(quickbooksConnectionsTable.id, connection.id), eq(quickbooksConnectionsTable.status, "connected"))).for("update");
    if (!current) throw new DomainError(409, "The QuickBooks connection changed. Refresh invoice service items.");
    await tx.insert(mappings).values({ id: randomUUID(), entityType: invoiceServiceEntity, localId, ...values, createdAt: now })
      .onConflictDoUpdate({ target: [mappings.entityType, mappings.localId], set: values });
  });
  await audit("quickbooks.invoice_service_mapping_saved", {
    userId: req.auth!.userId,
    entityType: invoiceServiceEntity,
    entityId: localId,
    details: { category, itemId, realmId: connection.realmId, environment: connection.environment },
  });
  res.json({ category, itemId });
}));

router.get("/quickbooks/mappings", async (_req, res) => res.json({ entities: await db.select().from(quickbooksEntityMappingsTable), accounting: await db.select().from(quickbooksAccountingMappingsTable) }));
router.put("/quickbooks/entity-mappings/:entityType/:localId", async (req, res) => {
  const entityType = String(req.params.entityType); const localId = String(req.params.localId); const decision = String(req.body?.decision ?? "link"); const quickbooksId = String(req.body?.quickbooksId ?? "");
  if (entityType === invoiceServiceEntity) { res.status(400).json({ error: "Use Invoice service items to approve this mapping." }); return; }
  if (!quickbooksId && decision === "link") { res.status(400).json({ error: "quickbooksId is required to link a record" }); return; }
  const connectionId = typeof req.body?.connectionId === "string" ? req.body.connectionId : null;
  const connection = connectionId ? await getConnection() : null;
  if (connectionId && (connection?.status !== "connected" || connection.id !== connectionId)) { res.status(409).json({ error: "The QuickBooks connection changed. Import records again before linking this item." }); return; }
  let syncToken = String(req.body?.syncToken ?? "0");
  if (connection && entityType === "item" && decision === "link") {
    if (!/^\d{1,30}$/.test(quickbooksId)) { res.status(400).json({ error: "Enter an item ID from this QuickBooks company." }); return; }
    const item = (await qboRequest(`/item/${quickbooksId}`, {}, connection.id)).Item;
    if (item?.Id !== quickbooksId || item.Active === false || item.Type === "Category") { res.status(409).json({ error: "The QuickBooks item is unavailable. Import the list again." }); return; }
    syncToken = String(item.SyncToken ?? "0");
  }
  const now = new Date().toISOString(); const [existing] = await db.select().from(quickbooksEntityMappingsTable).where(and(eq(quickbooksEntityMappingsTable.entityType, entityType), eq(quickbooksEntityMappingsTable.localId, localId))).limit(1);
  const values = { quickbooksId: quickbooksId || "ignored", realmId: connection?.realmId ?? null, environment: connection?.environment ?? null, status: decision === "ignore" ? "ignored" : "linked", syncToken, fingerprint: "", lastError: null, updatedAt: now };
  const [saved] = existing ? await db.update(quickbooksEntityMappingsTable).set(values).where(eq(quickbooksEntityMappingsTable.id, existing.id)).returning() : await db.insert(quickbooksEntityMappingsTable).values({ id: randomUUID(), entityType, localId, ...values, createdAt: now }).returning();
  await audit("quickbooks.entity_reconciled", { userId: req.auth!.userId, entityType, entityId: localId, details: { decision, quickbooksId } }); res.json(saved);
});
router.put("/quickbooks/mappings/:type/:key", async (req, res) => {
  const mappingType = String(req.params.type); const localKey = String(req.params.key); const quickbooksId = String(req.body?.quickbooksId ?? ""); if (!quickbooksId) { res.status(400).json({ error: "quickbooksId is required" }); return; }
  const now = new Date().toISOString(); const [existing] = await db.select().from(quickbooksAccountingMappingsTable).where(and(eq(quickbooksAccountingMappingsTable.mappingType, mappingType), eq(quickbooksAccountingMappingsTable.localKey, localKey))).limit(1);
  const values = { quickbooksId, quickbooksName: String(req.body?.quickbooksName ?? ""), approved: Boolean(req.body?.approved), metadata: req.body?.metadata ?? {}, updatedAt: now };
  const [saved] = existing ? await db.update(quickbooksAccountingMappingsTable).set(values).where(eq(quickbooksAccountingMappingsTable.id, existing.id)).returning() : await db.insert(quickbooksAccountingMappingsTable).values({ id: randomUUID(), mappingType, localKey, ...values, createdAt: now }).returning();
  await audit("quickbooks.mapping_saved", { userId: req.auth!.userId, entityType: mappingType, entityId: localKey }); res.json(saved);
});

const accountingQueue = quickbooksSyncJobsTable;
const accountingSource = invoicesTable;
const invoiceNeedsAccountingReview = () => sql<boolean>`(${accountingQueue.entityType} = 'invoice' and exists (
  select 1 from ${accountingSource} where ${accountingSource.id} = ${accountingQueue.localId}
  and (${accountingSource.taxAmount} <> 0 or ${accountingSource.discountAmount} <> 0 or ${accountingSource.depositAmount} <> 0)
))`;
router.get("/quickbooks/queue", async (_req, res) => res.json(await db.select({ ...getTableColumns(accountingQueue), accountingReviewRequired: invoiceNeedsAccountingReview() }).from(accountingQueue).orderBy(desc(accountingQueue.createdAt)).limit(250)));

const reviewPath = "/quickbooks/queue/:id/accounting";
const reviewableStates = ["pending_approval", "failed"];
router.get("/quickbooks/invoice-accounting/capabilities", requireOwner, domainRoute(async (_req, res) => {
  const company = await getConnection();
  res.json({ enabled: reviewedInvoicesAvailable(company), realmId: company?.realmId ?? null });
}));

async function reviewContext(queueId: string) {
  const company = await getConnection();
  if (!company || !reviewedInvoicesAvailable(company)) throw new DomainError(409, "Reviewed invoice accounting is disabled for this QuickBooks company.");
  const [job] = await db.select().from(accountingQueue).where(and(eq(accountingQueue.id, queueId), eq(accountingQueue.entityType, "invoice"), inArray(accountingQueue.status, reviewableStates))).limit(1);
  if (!job || !["create", "upsert", "update"].includes(job.action) || job.payload.demoSimulation) throw new DomainError(404, "Invoice accounting review not found.");
  const [source] = await db.select().from(accountingSource).where(eq(accountingSource.id, job.localId)).limit(1);
  if (!source || !requiresInvoiceReview(source)) throw new DomainError(404, "This invoice does not require an accounting review.");
  return { company, job, source };
}

router.get(reviewPath, requireOwner, domainRoute(async (req, res) => {
  const { source, company } = await reviewContext(String(req.params.id));
  res.json({ invoiceNumber: source.invoiceNumber, company: company.companyName || company.realmId,
    tax: source.taxAmount, discount: source.discountAmount, deposit: source.depositAmount, paid: source.paidAmount,
    lines: source.lineItems.map(({ id, description }) => ({ id, description })) });
}));

async function previewAccounting(queueId: string, choice: z.infer<typeof invoiceReviewInput>) {
  const { source, job, company } = await reviewContext(queueId);
  try {
    const preview = await prepareReviewedInvoice(source, company, choice);
    return { preview, job };
  } catch (failure) {
    throw new DomainError(409, failure instanceof Error ? failure.message : "Could not verify the QuickBooks accounting details.");
  }
}

router.post(`${reviewPath}/preview`, requireOwner, domainRoute(async (req, res) => {
  const { preview } = await previewAccounting(String(req.params.id), parse(invoiceReviewInput, req.body));
  res.json(preview);
}));

router.post(`${reviewPath}/approve`, requireOwner, domainRoute(async (req, res) => {
  const review = parse(reviewedInvoiceApproval.strict(), req.body);
  const { preview, job } = await previewAccounting(String(req.params.id), review.request);
  if (preview.fingerprint !== review.fingerprint) throw new DomainError(409, "The invoice or accounting details changed. Preview them again before approving.");
  const now = new Date().toISOString();
  const [accepted] = await db.update(accountingQueue).set({ payload: { ...job.payload, [reviewedInvoiceRecord]: review },
    status: "approved", approvedBy: req.auth!.userId, approvedAt: now, nextAttemptAt: now, updatedAt: now, lastError: null,
  }).where(and(eq(accountingQueue.id, job.id), eq(accountingQueue.updatedAt, job.updatedAt), inArray(accountingQueue.status, reviewableStates))).returning();
  if (!accepted) throw new DomainError(409, "This invoice approval is already being processed. Refresh the queue.");
  await audit("quickbooks.invoice_accounting_approved", { userId: req.auth!.userId, entityType: "invoice", entityId: job.localId,
    details: { realmId: preview.realmId, fingerprint: review.fingerprint, existingInvoiceId: review.request.existingInvoiceId } });
  void processQuickBooksQueue();
  res.json(accepted);
}));
router.post("/quickbooks/queue", async (req, res) => {
  const entityType = String(req.body?.entityType ?? ""); const localId = String(req.body?.localId ?? ""); const action = String(req.body?.action ?? "upsert"); if (!entityType || !localId || !["customer", "project", "estimate", "invoice", "item", "labor", "expense"].includes(entityType)) { res.status(400).json({ error: "Valid entityType and localId are required" }); return; }
  if (req.body?.payload && [invoiceCreateRecord, reviewedInvoiceRecord].some((key) => Object.hasOwn(req.body.payload, key))) { res.status(400).json({ error: "The QuickBooks invoice accounting record is reserved." }); return; }
  const now = new Date().toISOString(); const version = createHash("sha256").update(JSON.stringify(req.body?.payload ?? {})).digest("hex").slice(0, 16); const [created] = await db.insert(quickbooksSyncJobsTable).values({ id: randomUUID(), idempotencyKey: `${entityType}:${localId}:${action}:${version}`, entityType, localId, action, payload: req.body?.payload ?? {}, warnings: req.body?.warnings ?? [], status: "pending_approval", nextAttemptAt: now, createdAt: now, updatedAt: now }).onConflictDoNothing().returning(); res.status(created ? 201 : 200).json(created ?? { duplicate: true });
});
const dedicatedApprovalEntities = [vendorBillEntity, sandboxStockItemEntity, productionStockItemEntity, stockAdjustmentEntity];
const genericApproval = () => and(notInArray(accountingQueue.entityType, dedicatedApprovalEntities),
  workspaceEnvironment().QUICKBOOKS_ENVIRONMENT === "production" ? sql`not ${invoiceNeedsAccountingReview()}` : undefined,
  sql`not (${accountingQueue.payload} ? ${reviewedInvoiceRecord})`);
router.post("/quickbooks/queue/approve", async (req, res) => { const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []; if (!ids.length) { res.status(400).json({ error: "ids are required" }); return; } const now = new Date().toISOString(); const changed = await db.update(quickbooksSyncJobsTable).set({ status: "approved", approvedBy: req.auth!.userId, approvedAt: now, nextAttemptAt: now, updatedAt: now }).where(and(inArray(quickbooksSyncJobsTable.id, ids), eq(quickbooksSyncJobsTable.status, "pending_approval"), genericApproval())).returning(); await audit("quickbooks.sync_approved", { userId: req.auth!.userId, details: { ids: changed.map((entry) => entry.id) } }); void processQuickBooksQueue(); res.json(changed); });
router.post("/quickbooks/queue/:id/retry", async (req, res) => { const now = new Date().toISOString(); const [row] = await db.update(quickbooksSyncJobsTable).set({ status: "retry", nextAttemptAt: now, lastError: null, updatedAt: now }).where(and(eq(quickbooksSyncJobsTable.id, String(req.params.id)), inArray(quickbooksSyncJobsTable.status, ["failed", "retry"]), genericApproval())).returning(); if (!row) { res.status(404).json({ error: "Sync job not found" }); return; } void processQuickBooksQueue(); res.json(row); });

router.get("/quickbooks/conflicts", async (_req, res) => res.json(await db.select().from(quickbooksConflictsTable).orderBy(desc(quickbooksConflictsTable.createdAt))));
router.post("/quickbooks/conflicts/:id/resolve", async (req, res) => { const resolution = String(req.body?.resolution ?? ""); if (!["keep_knox", "accept_quickbooks"].includes(resolution)) { res.status(400).json({ error: "Invalid resolution" }); return; } const now = new Date().toISOString(); const [row] = await db.update(quickbooksConflictsTable).set({ status: "resolved", resolution, resolvedBy: req.auth!.userId, resolvedAt: now }).where(eq(quickbooksConflictsTable.id, String(req.params.id))).returning(); await audit("quickbooks.conflict_resolved", { userId: req.auth!.userId, entityType: row?.entityType, entityId: row?.localId, details: { resolution } }); res.json(row); });

export async function quickBooksWebhook(req: Request, res: Response) {
  const verifier = workspaceEnvironment().QUICKBOOKS_WEBHOOK_VERIFIER;
  if (!verifier) { res.status(503).end(); return; }
  const signature = req.get("intuit-signature");
  if (!signature || !req.rawBody || !verifyQuickBooksWebhookSignature(req.rawBody, signature, verifier)) {
    res.status(401).end();
    return;
  }
  const connection = await getConnection();
  const entries = connection?.status === "connected" ? quickBooksWebhookEntries(req.body, req.rawBody, connection.realmId) : [];
  if (entries.length) {
    const receivedAt = new Date().toISOString();
    await db.insert(quickbooksWebhookEventsTable)
      .values(entries.map((entry) => ({ ...entry, id: randomUUID(), receivedAt })))
      .onConflictDoNothing();
  }
  res.status(200).end();
}

export default router;
