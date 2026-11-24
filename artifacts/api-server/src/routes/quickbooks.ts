import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, inArray, like, notInArray, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db, invoicesTable, jobsTable, materialsTable, productsTable, proposalsTable, quickbooksAccountingMappingsTable, quickbooksConflictsTable, quickbooksConnectionsTable, quickbooksEntityMappingsTable, quickbooksSyncJobsTable, quickbooksWebhookEventsTable } from "@workspace/db";
import { workspaceEnvironment } from "@workspace/db/workspace";
import { audit, getSession, SESSION_COOKIE } from "../lib/auth";
import { accountingScope, projectsScope, grantedQuickBooksScopes, quickBooksOAuthRequestedScopes, quickBooksOAuthConnectionLifecycle, quickBooksConnectionLifecycle, consumeQuickBooksOAuthState, createQuickBooksOAuthState, encryptSecret, getConnection, qboQuery, qboRequest, quickBooksProjectReadiness, replaceQuickBooksConnection, validQuickBooksOAuthState, assertQuickBooksRevocationResolved, disconnectQuickBooks } from "../lib/quickbooks";
import { projectsCapability } from "../lib/quickbooks-projects";
import { customerReconciliationMatches } from "../lib/quickbooks-reconciliation";
import { loadQuickBooksCatalogEntity, quickBooksCatalogEntities } from "../lib/quickbooks-catalog";
import { prepareGenericExportApproval, prepareReviewedInvoice, processQuickBooksQueue } from "../lib/quickbooks-worker";
import { assertGenericExportCompany, genericExportAttempt, genericExportRecord, GenericExportReviewRequired } from "../lib/quickbooks-generic-export";
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
import { costEntities } from "../lib/job-accounting";
import { safeDiagnostic } from "../lib/safe-logging";
import { assertCutoverInvoiceSubmission } from "../lib/job-cutover-invoices";

const router: IRouter = Router();
const configured = () => Boolean(workspaceEnvironment().QUICKBOOKS_CLIENT_ID && workspaceEnvironment().QUICKBOOKS_CLIENT_SECRET && workspaceEnvironment().QUICKBOOKS_REDIRECT_URI && workspaceEnvironment().QUICKBOOKS_ENCRYPTION_KEY);
const demoAvailable = () => workspaceEnvironment().DEMO_MODE === "true";
const publicConnection = (c: Awaited<ReturnType<typeof getConnection>>) => c ? ({ connected: c.status === "connected", status: c.status, realmId: c.realmId, companyName: c.companyName, environment: c.environment, readinessStatus: c.readinessStatus, lastSyncAt: c.lastSyncAt, lastCdcAt: c.lastCdcAt, refreshTokenExpiresAt: c.refreshTokenExpiresAt }) : ({ connected: false, status: configured() ? "not_connected" : "not_configured", readinessStatus: "configuration_required" });

router.get("/quickbooks/status", async (_req, res) => {
  const connection=await getConnection();const capability=await projectsCapability(connection);
  res.json({ configured: configured(), demoAvailable: demoAvailable(), demoCompany: demoAvailable() ? { name: "Knoxville Flooring Demo Company", environment: "simulated", lastFour: "1982" } : null, connection: publicConnection(connection), projects:{verified:capability.available,readiness:capability.available?"ready":"blocked",legacySubcustomersPreserved:true,detail:capability.reason??"True Projects capability is verified for this connected company. Review each job's Project separately."} });
});

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
    job && { entityType: "project", localId: job.id, action: "create", destination: "Project concept · API access unverified", summary: `Illustrate ${job.jobNumber} beneath its customer; real Project exports are blocked`, amount: job.estRevenue, preview: { Name: `${job.jobNumber} - ${job.flooringType}`, Status: "Simulated concept only" } },
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

router.get("/quickbooks/connect", requireOwner, domainRoute(async (req, res) => {
  if (!configured()) { res.status(503).json({ error: "QuickBooks environment variables are not configured" }); return; }
  const previousConnection=await getConnection();assertQuickBooksRevocationResolved(previousConnection);
  if(demoAvailable()&&workspaceEnvironment().QUICKBOOKS_ENVIRONMENT==="production"){res.status(409).json({error:"Connect only an Intuit sandbox in a demonstration."});return;}
  const requestedScopes=req.query.projects==="true"?[accountingScope,projectsScope]:[accountingScope];
  const state = createQuickBooksOAuthState(req.auth!.userId,req.auth!.csrfToken,Date.now(),requestedScopes,quickBooksConnectionLifecycle(previousConnection));
  res.cookie("qbo_oauth_state", state, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 10 * 60_000, path: "/" });
  const url = new URL("https://appcenter.intuit.com/connect/oauth2");
  url.searchParams.set("client_id", workspaceEnvironment().QUICKBOOKS_CLIENT_ID!); url.searchParams.set("response_type", "code"); url.searchParams.set("scope", requestedScopes.join(" ")); url.searchParams.set("redirect_uri", workspaceEnvironment().QUICKBOOKS_REDIRECT_URI!); url.searchParams.set("state", state);
  res.json({ authorizationUrl: url.toString() });
}));

/** Mounted after the company boundary, before generic auth, so even expired sessions
 * receive a code-free redirect. Authorization remains mandatory inside this handler. */
export async function quickBooksOAuthCallback(req: Request, res: Response) {
  const finish = (outcome: "connected" | "invalid" | "cancelled" | "sign_in_required" | "owner_required" | "blocked" | "failed") => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.status(302).location(`/settings?quickbooks=${outcome}`).end();
  };
  res.clearCookie("qbo_oauth_state", { path: "/" });
  try {
    const found = await getSession(req.cookies?.[SESSION_COOKIE]);
    if (!found) { finish("sign_in_required"); return; }
    if (found.user.role !== "owner" || found.session.previewRole) { finish("owner_required"); return; }
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const cookieState = typeof req.cookies?.qbo_oauth_state === "string" ? req.cookies.qbo_oauth_state : "";
    if (req.method !== "GET" || !validQuickBooksOAuthState(state, found.user.id, found.session.csrfToken) || state !== cookieState) { finish("invalid"); return; }
    if (req.query.error !== undefined) { finish("cancelled"); return; }
    const code = req.query.code, realmId = req.query.realmId;
    if (typeof code !== "string" || !code || typeof realmId !== "string" || !/^\d{1,30}$/.test(realmId)) { finish("invalid"); return; }
    if (!configured()) { finish("failed"); return; }
    if (demoAvailable() && workspaceEnvironment().QUICKBOOKS_ENVIRONMENT === "production") { finish("blocked"); return; }
    assertQuickBooksRevocationResolved(await getConnection());
    if (!await consumeQuickBooksOAuthState(state, found.user.id)) { finish("invalid"); return; }
    await replaceQuickBooksConnection(async () => {
      const auth = Buffer.from(`${workspaceEnvironment().QUICKBOOKS_CLIENT_ID}:${workspaceEnvironment().QUICKBOOKS_CLIENT_SECRET}`).toString("base64");
      const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000), headers: { Authorization: `Basic ${auth}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: workspaceEnvironment().QUICKBOOKS_REDIRECT_URI! }) });
      if (!response.ok) throw new DomainError(502, "QuickBooks token exchange failed");
      const token = await response.json() as any; const now = new Date();
      if (typeof token?.access_token !== "string" || !token.access_token || typeof token?.refresh_token !== "string" || !token.refresh_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || !Number.isFinite(token.x_refresh_token_expires_in) || token.x_refresh_token_expires_in <= 0) throw new DomainError(502, "QuickBooks returned incomplete authorization; reconnect.");
      const grantedScopes = grantedQuickBooksScopes(token.scope, quickBooksOAuthRequestedScopes(state));
      return { id: randomUUID(), realmId, grantedScopes, environment: workspaceEnvironment().QUICKBOOKS_ENVIRONMENT === "production" ? "production" : "sandbox", encryptedAccessToken: encryptSecret(token.access_token), encryptedRefreshToken: encryptSecret(token.refresh_token), accessTokenExpiresAt: new Date(now.getTime() + token.expires_in * 1000).toISOString(), refreshTokenExpiresAt: new Date(now.getTime() + token.x_refresh_token_expires_in * 1000).toISOString(), status: "connected", readinessStatus: "reconciliation_required", createdAt: now.toISOString(), updatedAt: now.toISOString() };
    }, quickBooksOAuthConnectionLifecycle(state));
    await audit("quickbooks.connected", { userId: found.user.id, entityType: "quickbooks_company", entityId: realmId, ip: req.ip });
    finish("connected");
  } catch (error) {
    // Provider bodies, query parameters and error messages may contain credentials
    // or company data. The destination contains only this closed diagnostic state.
    req.log?.error(safeDiagnostic("qbo_authorization_failed", error), "QuickBooks authorization failed");
    finish(error instanceof DomainError && error.status === 409 ? "blocked" : "failed");
  }
}

router.post("/quickbooks/disconnect", requireOwner, domainRoute(async (req, res) => {
  const input = parse(z.object({ retryRevocation: z.boolean().optional() }).strict(), req.body ?? {});
  const result = await disconnectQuickBooks(input.retryRevocation === true);
  await audit("quickbooks.disconnected", { userId: req.auth!.userId, ip: req.ip, details: { revocation: result.revocation } });
  res.json(result);
}));

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
  const savedLinks=await db.select().from(quickbooksEntityMappingsTable).where(and(eq(quickbooksEntityMappingsTable.status,"linked"),eq(quickbooksEntityMappingsTable.realmId,connection.realmId),eq(quickbooksEntityMappingsTable.environment,connection.environment)));
  const customers = result.customer;
  const items = result.item.filter((item) => item.Active !== false && item.Type !== "Category");
  const normalizeSku = (value: string | undefined) => value?.trim().toLowerCase() || "";
  const candidates = [
    ...localJobs.map(local => ({entityType:"customer",localId:local.id,localName:local.customerName,matches:customerReconciliationMatches(local,customers,savedLinks.find(link=>link.entityType==="customer"&&link.localId===local.id)?.quickbooksId)})),
    ...localProducts.map((local) => {
      const sku = normalizeSku(local.sku);
      const saved=savedLinks.find(link=>link.entityType==="item"&&link.localId===local.id);
      if(saved)return {entityType:"item",localId:local.id,localName:local.name,matches:items.filter(item=>item.Id===saved.quickbooksId).map(item=>({id:item.Id,name:item.Name,confidence:"exact"}))};
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
  and (${accountingSource.taxAmount} <> 0 or ${accountingSource.discountAmount} <> 0 or ${accountingSource.depositAmount} <> 0 or ${accountingSource.paidAmount} <> 0)
))`;
router.get("/quickbooks/queue", async (_req, res) => res.json(await db.select({ ...getTableColumns(accountingQueue), accountingReviewRequired: invoiceNeedsAccountingReview() }).from(accountingQueue).orderBy(desc(accountingQueue.createdAt)).limit(250)));

const reviewPath = "/quickbooks/queue/:id/accounting";
const reviewableStates = ["pending_approval", "failed"];
router.get("/quickbooks/invoice-accounting/capabilities", requireOwner, domainRoute(async (_req, res) => {
  const company = await getConnection();
  res.json({ enabled: reviewedInvoicesAvailable(company), realmId: company?.realmId ?? null,
    environment: company?.environment ?? null, connectionId: company?.id ?? null });
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
    environment: company.environment, realmId: company.realmId, connectionId: company.id,
    tax: source.taxAmount, discount: source.discountAmount, deposit: source.depositAmount, paid: source.paidAmount,
    lines: source.lineItems.map(({ id, description }) => ({ id, description })) });
}));

async function previewAccounting(queueId: string, choice: z.infer<typeof invoiceReviewInput>) {
  const { source, job, company } = await reviewContext(queueId);
  try {
    const prepared = await prepareReviewedInvoice(source, company, choice);
    const preview = { ...prepared, environment: company.environment, connectionId: company.id };
    return { preview, job, sourceUpdatedAt:source.updatedAt };
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
  const { preview, job, sourceUpdatedAt } = await previewAccounting(String(req.params.id), review.request);
  if (preview.fingerprint !== review.fingerprint) throw new DomainError(409, "The invoice or accounting details changed. Preview them again before approving.");
  const now = new Date().toISOString();
  const [accepted] = await db.transaction(async tx=>{
    const [source]=await tx.select().from(accountingSource).where(eq(accountingSource.id,job.localId));
    if(!source)throw new DomainError(404,"Invoice not found.");
    if(source.updatedAt!==sourceUpdatedAt)throw new DomainError(409,"The invoice changed after preview. Review the current source before approving.");
    await assertCutoverInvoiceSubmission(tx,source,false);
    return tx.update(accountingQueue).set({ payload: { ...job.payload, [reviewedInvoiceRecord]: review },
    status: "approved", approvedBy: req.auth!.userId, approvedAt: now, nextAttemptAt: now, updatedAt: now, lastError: null,
  }).where(and(eq(accountingQueue.id, job.id), eq(accountingQueue.updatedAt, job.updatedAt), inArray(accountingQueue.status, reviewableStates))).returning();
  });
  if (!accepted) throw new DomainError(409, "This invoice approval is already being processed. Refresh the queue.");
  await audit("quickbooks.invoice_accounting_approved", { userId: req.auth!.userId, entityType: "invoice", entityId: job.localId,
    details: { realmId: preview.realmId, environment: preview.environment, connectionId: preview.connectionId,
      fingerprint: review.fingerprint, existingInvoiceId: review.request.existingInvoiceId } });
  void processQuickBooksQueue();
  res.json(accepted);
}));
router.post("/quickbooks/queue", async (req, res) => {
  const entityType = String(req.body?.entityType ?? ""); const localId = String(req.body?.localId ?? ""); const action = String(req.body?.action ?? "upsert"); if (!entityType || !localId || !["customer", "project", "estimate", "invoice", "item", "labor", "expense"].includes(entityType)) { res.status(400).json({ error: "Valid entityType and localId are required" }); return; }
  if(entityType==="project"){res.status(409).json({error:quickBooksProjectReadiness().detail});return;}
  if(["labor","expense",...costEntities].includes(entityType)){res.status(409).json({error:"Use the dedicated job-cost source and owner accounting review before exporting time or expenses."});return;}
  if (req.body?.payload && [invoiceCreateRecord, reviewedInvoiceRecord, genericExportRecord].some((key) => Object.hasOwn(req.body.payload, key))) { res.status(400).json({ error: "The QuickBooks accounting approval record is reserved." }); return; }
  const now = new Date().toISOString(); const version = createHash("sha256").update(JSON.stringify(req.body?.payload ?? {})).digest("hex").slice(0, 16); const [created] = await db.insert(quickbooksSyncJobsTable).values({ id: randomUUID(), idempotencyKey: `${entityType}:${localId}:${action}:${version}`, entityType, localId, action, payload: req.body?.payload ?? {}, warnings: req.body?.warnings ?? [], status: "pending_approval", nextAttemptAt: now, createdAt: now, updatedAt: now }).onConflictDoNothing().returning(); res.status(created ? 201 : 200).json(created ?? { duplicate: true });
});
const dedicatedApprovalEntities = [vendorBillEntity, sandboxStockItemEntity, productionStockItemEntity, stockAdjustmentEntity,"project","labor","expense",...costEntities];
const genericApproval = () => and(notInArray(accountingQueue.entityType, dedicatedApprovalEntities),
  sql`not ${invoiceNeedsAccountingReview()}`,
  sql`not (${accountingQueue.payload} ? ${reviewedInvoiceRecord})`);
router.post("/quickbooks/queue/approve", domainRoute(async (req, res) => {
  const input = parse(z.object({ ids: z.array(z.string().min(1)).min(1).max(100), estimateCategories: z.record(z.string(), z.enum(invoiceServiceCategories)).optional() }).strict(), req.body);
  const now = new Date().toISOString();
  let changed;
  try {
    changed = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
      // Prelock invoice job IDs before queue/invoice rows, matching ordinary
      // invoice edits. Re-read the source under these locks below.
      const candidates=await tx.select().from(accountingQueue).where(and(inArray(accountingQueue.id,input.ids),eq(accountingQueue.status,"pending_approval"),genericApproval())).limit(100);
      if(!candidates.length)return [];
      const [company] = await tx.select().from(quickbooksConnectionsTable).where(eq(quickbooksConnectionsTable.status, "connected")).for("update");
      if (!company) throw new DomainError(409, "Connect the intended QuickBooks company before approving exports.");
      const invoiceIds=candidates.filter(row=>row.entityType==="invoice").map(row=>row.localId);
      const sources=invoiceIds.length?await tx.select({jobId:invoicesTable.jobId}).from(invoicesTable).where(inArray(invoicesTable.id,invoiceIds)).limit(100):[];
      const lockedJobs=[...new Set(sources.map(row=>row.jobId))].sort();
      for(const jobId of lockedJobs)await tx.select({id:jobsTable.id}).from(jobsTable).where(eq(jobsTable.id,jobId)).for("update");
      const rows = await tx.select().from(accountingQueue).where(and(inArray(accountingQueue.id, input.ids), eq(accountingQueue.status, "pending_approval"), genericApproval())).for("update");
      if (!rows.length) return [];
      const approved = [];
      for (const row of rows) {
        let payload = row.payload;
        if(row.entityType==="invoice"){
          const [invoice]=await tx.select().from(invoicesTable).where(eq(invoicesTable.id,row.localId));
          if(!invoice||!lockedJobs.includes(invoice.jobId))throw new DomainError(409,"Invoice attribution changed. Refresh before accounting approval.");
          const cutover=await assertCutoverInvoiceSubmission(tx,invoice,false);
          if(cutover)payload={...payload,migrationCutoverApproval:{...cutover,company:{connectionId:company.id,realmId:company.realmId,environment:company.environment}}};
        }
        if (row.entityType === "customer" || row.entityType === "estimate") {
          const previous = payload[genericExportRecord];
          let frozen;
          if (previous) {
            frozen = genericExportAttempt.parse(previous);
            assertGenericExportCompany(frozen, company);
            if (frozen.state !== "prepared") throw new GenericExportReviewRequired("Reconcile the previously submitted document before approving another attempt.");
          } else {
            payload = { ...payload, ...(input.estimateCategories?.[row.id] ? { estimateServiceCategory: input.estimateCategories[row.id] } : {}) };
            frozen = await prepareGenericExportApproval(tx, { ...row, payload }, company);
          }
          payload = { ...payload, [genericExportRecord]: frozen };
        }
        const [saved] = await tx.update(accountingQueue).set({ payload, status: "approved", approvedBy: req.auth!.userId, approvedAt: now, nextAttemptAt: now, updatedAt: now }).where(eq(accountingQueue.id, row.id)).returning();
        approved.push(saved);
      }
      return approved;
    });
  } catch (error) {
    if (error instanceof GenericExportReviewRequired) throw new DomainError(409, error.message);
    throw error;
  }
  await audit("quickbooks.sync_approved", { userId: req.auth!.userId, details: { ids: changed.map(entry => entry.id) } });
  void processQuickBooksQueue(); res.json(changed);
}));
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
