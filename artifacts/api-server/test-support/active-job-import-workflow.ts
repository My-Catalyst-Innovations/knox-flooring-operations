/** Disposable real PostgreSQL + actual tenant/auth/router. No live provider IO. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import {
  db,
  pool,
  usersTable,
  closeWorkspaceConnections,
  invoicesTable,
} from "@workspace/db";
import { inWorkspace, workspaceConfigs } from "@workspace/db/workspace";
import { hashPassword } from "../src/lib/auth";
import {
  assertCutoverInvoiceSubmission,
  consumeCutoverInvoice,
} from "../src/lib/job-cutover-invoices";
import { lockedCutoverJob } from "../src/lib/job-cutover";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { cutoverHash } from "../src/lib/cutover-hash";
import { encryptSecret } from "../src/lib/quickbooks";
import type {
  ActiveJobImportBatch,
  ActiveJobImportDecision,
  JobCutoverPayload,
} from "@workspace/domain";
assert.equal(workspaceConfigs.length, 2);
for (const workspace of workspaceConfigs) {
  const url = new URL(workspace.databaseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.pathname, /^\/active_jobs_[a-f0-9]{32}_[ab]$/);
}
const checks: string[] = [],
  originalFetch = globalThis.fetch;
let unexpectedProviderCalls = 0,
  simulatedInvoicePosts = 0;
globalThis.fetch = (async () => {
  unexpectedProviderCalls++;
  throw Error("No provider IO is allowed in active-job migration fixtures");
}) as typeof fetch;
const context = <T>(index: number, work: () => Promise<T>) =>
  inWorkspace(workspaceConfigs[index], work);
const password = "Fictional-active-job-fixture-password",
  customerId = randomUUID(),
  siteId = randomUUID(),
  nativeJobId = randomUUID();
type Actor = { host: string; cookie: string; csrf: string };
function http(actor: Actor, method: string, path: string) {
  const call = (request(app) as any)
    [method.toLowerCase()]("/api" + path)
    .set("Host", actor.host)
    .set("Origin", "https://" + actor.host)
    .set("Cookie", actor.cookie);
  return method === "GET" ? call : call.set("x-csrf-token", actor.csrf);
}
async function call(
  actor: Actor,
  method: string,
  path: string,
  input?: unknown,
  status = 200,
) {
  const response = await (input === undefined
    ? http(actor, method, path)
    : http(actor, method, path).send(input));
  assert.equal(
    response.status,
    status,
    `${method} ${path}: HTTP${response.status} ${String(response.body?.error ?? "").slice(0, 220)}`,
  );
  return response.body;
}
async function login(index: number, role: string) {
  const host = `${index ? "b" : "a"}.activejob.test`,
    response = await request(app)
      .post("/api/auth/login")
      .set("Host", host)
      .set("Origin", "https://" + host)
      .send({ email: `${role}@activejob.example.invalid`, password });
  assert.equal(response.status, 200);
  return {
    host,
    cookie: response.headers["set-cookie"][0].split(";")[0],
    csrf: response.body.csrfToken,
  };
}
const originalCsv =
  "\uFEFFsource_id,source_job_number,source_status,source_customer_id,source_customer_name,source_created_at,source_stage_at,sold_at,scope_of_work,notes\r\n000081,000001,In Progress,OLD-0001,Original source customer,2026-01-02,2026-11-20T13:45:59.1234567-05:00,2026-11-01,Original legacy scope,=1+1\r\n";
const input = (batchKey: string, csv = originalCsv) => ({
  sourceSystem: "fictional-active-jobs",
  batchKey,
  fileName: 'Original "active" jobs.csv',
  csv,
  delimiter: ",",
});
const path = (batch: ActiveJobImportBatch, action: string) =>
  `/active-job-imports/${batch.id}/${action}`;
async function choices(actor: Actor) {
  return call(actor, "GET", "/active-job-imports/choices?q=Retained");
}
async function approve(
  actor: Actor,
  batch: ActiveJobImportBatch,
  decisions?: ActiveJobImportDecision[],
) {
  const selected = await choices(actor),
    customer = selected.customers.find((row: any) => row.id === customerId),
    site = customer.sites.find((row: any) => row.id === siteId);
  const reviewed = await call(actor, "POST", path(batch, "review"), {
    revision: batch.revision,
    previewFingerprint: batch.previewFingerprint,
    note: "Verified identities and unknown history; no stock, provider or balances",
    decisions:
      decisions ??
      batch.rows.map((row) => ({
        line: row.line,
        action: "create",
        customerId,
        customerRevision: customer.revision,
        siteId,
        siteFingerprint: site.fingerprint,
        entryStage: "Approved",
        flooringType: "Tile",
        stageMappingReason:
          "Original in-progress state is retained; real crew booking must be verified separately",
        acceptSourceDates: true,
        note: "Explicit existing customer and site; no historical financial assumptions",
      })),
  });
  return call(actor, "POST", path(reviewed, "approve"), {
    revision: reviewed.revision,
    reviewFingerprint: reviewed.reviewFingerprint,
    confirmNoFinancialOrOperationalSideEffects: true,
  }) as Promise<ActiveJobImportBatch>;
}
const commitBody = (batch: ActiveJobImportBatch) => ({
  revision: batch.revision,
  approvalId: batch.approval!.id,
  approvalFingerprint: batch.approval!.fingerprint,
  confirmNoFinancialOrOperationalSideEffects: true,
});
async function cutoverCommit(
  actor: Actor,
  jobId: string,
  payload: JobCutoverPayload,
) {
  const state = await call(actor, "GET", `/jobs/${jobId}/cutover`);
  const review = await call(
    actor,
    "POST",
    `/jobs/${jobId}/cutover/reviews`,
    {
      jobRevision: state.jobRevision,
      cutoverRevision: state.cutover.revision,
      payload,
    },
    201,
  );
  const approval = await call(
    actor,
    "POST",
    `/jobs/${jobId}/cutover/reviews/${review.id}/approve`,
    { fingerprint: review.fingerprint },
  );
  const body = {
    approvalId: approval.approval.id,
    fingerprint: approval.fingerprint,
  };
  const saved = await call(
    actor,
    "POST",
    `/jobs/${jobId}/cutover/reviews/${review.id}/commit`,
    body,
  );
  assert.deepEqual(
    await call(
      actor,
      "POST",
      `/jobs/${jobId}/cutover/reviews/${review.id}/commit`,
      body,
    ),
    saved,
  );
  return saved;
}
async function protectedSnapshot() {
  const result: Record<string, unknown> = {};
  for (const table of [
    "customers",
    "customer_sites",
    "products",
    "supplier_product_aliases",
    "supplier_buy_prices",
    "warehouses",
    "inventory_movements",
    "inventory_reservations",
    "purchase_orders",
    "purchase_order_lines",
    "crew_bookings",
    "materials",
    "job_materials",
    "communications",
    "quickbooks_entity_mappings",
    "quickbooks_connections",
    "quickbooks_conflicts",
  ]) {
    result[table] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
      )
    ).rows;
  }
  return result;
}
try {
  const encoded = await hashPassword(password);
  for (const index of [0, 1])
    await context(index, async () => {
      for (const role of ["owner", "sales", "operations", "installer"])
        await db.insert(usersTable).values({
          id: role,
          email: `${role}@activejob.example.invalid`,
          name: role,
          role: role as any,
          passwordHash: encoded,
          createdAt: "2026-11-23",
          updatedAt: "2026-11-23",
        });
      await pool.query(
        "INSERT INTO customers(id,name,created_at,updated_at) VALUES($1,'Retained customer','2026-11-23','2026-11-23')",
        [customerId],
      );
      await pool.query(
        "INSERT INTO customer_sites(id,customer_id,label,address,city,created_at,updated_at) VALUES($1,$2,'Retained site','1 Original Street','Knoxville','2026-11-23','2026-11-23')",
        [siteId, customerId],
      );
      await pool.query(
        "INSERT INTO jobs(id,job_number,customer_id,site_id,customer_name,flooring_type,material_status,priority_level,risk_level,status,actual_revenue,actual_labor_cost,created_at,updated_at) VALUES($1,'J-0010',$2,$3,'Retained customer','Tile','Received','Medium','Low','Approved',430.10,35.04,'2026-11-23','2026-11-23')",
        [nativeJobId, customerId, siteId],
      );
    });
  const owner = await login(0, "owner"),
    other = await login(1, "owner"),
    sales = await login(0, "sales"),
    operations = await login(0, "operations"),
    installer = await login(0, "installer");
  const baseline = await context(0, protectedSnapshot),
    otherBaseline = await context(1, protectedSnapshot),
    nativeBefore = await context(0, () =>
      pool.query("SELECT to_jsonb(j) row FROM jobs j WHERE id=$1", [
        nativeJobId,
      ]),
    );
  assert.equal(
    (await request(app).get("/api/active-job-imports").set("Host", owner.host))
      .status,
    401,
  );
  for (const actor of [sales, operations, installer]) {
    await call(actor, "GET", "/active-job-imports", undefined, 403);
    await call(
      actor,
      "POST",
      "/active-job-imports/preview",
      input("denied"),
      403,
    );
    await call(actor, "GET", `/jobs/${nativeJobId}/cutover`, undefined, 403);
  }
  checks.push(
    "only actual owner outside preview may inspect or mutate cutover/import",
  );
  for (const role of ["sales", "operations", "installer"]) {
    await call(owner, "POST", "/auth/persona", { role });
    await call(owner, "GET", "/active-job-imports", undefined, 403);
    await call(
      owner,
      "POST",
      "/active-job-imports/preview",
      input("preview-denied"),
      403,
    );
    await call(owner, "POST", "/auth/persona", { role: null });
  }
  checks.push("actual-owner role preview does not bypass owner-only importer");
  await call(
    { ...owner, csrf: "wrong" },
    "POST",
    "/active-job-imports/preview",
    input("bad-csrf"),
    403,
  );
  await call(
    { ...owner, host: other.host },
    "GET",
    "/active-job-imports",
    undefined,
    401,
  );
  checks.push("CSRF and host-only session boundaries enforced");
  let batch = (await call(
    owner,
    "POST",
    "/active-job-imports/preview",
    input("original"),
    201,
  )) as ActiveJobImportBatch;
  assert.equal(batch.rows[0].data.source_id, "000081");
  assert.equal(batch.rows[0].data.source_job_number, "000001");
  assert.equal(
    batch.rows[0].data.source_stage_at,
    "2026-11-20T13:45:59.1234567-05:00",
  );
  checks.push(
    "source IDs/status/calendar precision and original notes preserved exactly",
  );
  const download = await http(owner, "GET", path(batch, "source"))
    .buffer(true)
    .parse((res: any, done: any) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
  assert.equal(download.status, 200);
  assert.equal(download.body.toString("utf8"), originalCsv);
  assert.match(download.headers["content-disposition"], /attachment/);
  checks.push(
    "original UTF8 BOM/CRLF source is private attachment bytes, never evaluated",
  );
  await call(other, "GET", `/active-job-imports/${batch.id}`, undefined, 404);
  await call(other, "GET", path(batch, "source"), undefined, 404);
  checks.push("different tenant cannot read original source or batch");
  await call(
    owner,
    "POST",
    "/active-job-imports/preview",
    input("original", originalCsv.replace("000081", "000082")),
    409,
  );
  checks.push("source batch identity cannot be rebound to changed bytes");
  const historicId = randomUUID();
  await context(0, async () => {
    const fingerprint = cutoverHash([
      historicId,
      "default",
      batch.sourceSystem,
      "prior-host-adoption",
      batch.fileName,
      batch.sourceSha256,
      batch.rows,
    ]);
    await pool.query(
      "INSERT INTO active_job_import_batches(id,workspace_key,source_system,batch_key,file_name,source_sha256,source_csv,delimiter,rows,preview_fingerprint,created_by,created_at,updated_at) VALUES($1,'default',$2,'prior-host-adoption',$3,$4,$5,',',$6,$7,'owner','2026-11-23','2026-11-23')",
      [
        historicId,
        batch.sourceSystem,
        batch.fileName,
        batch.sourceSha256,
        originalCsv,
        JSON.stringify(batch.rows),
        fingerprint,
      ],
    );
  });
  assert.equal(
    (await call(owner, "GET", `/active-job-imports/${historicId}`)).id,
    historicId,
  );
  assert.equal(
    (await http(owner, "GET", `/active-job-imports/${historicId}/source`))
      .status,
    200,
  );
  await call(other, "GET", `/active-job-imports/${historicId}`, undefined, 404);
  checks.push(
    "historical default-host label remains accessible in its trusted company database without crossing tenants",
  );
  const selected = await choices(owner),
    customer = selected.customers[0],
    site = customer.sites[0];
  await call(
    owner,
    "POST",
    path(batch, "review"),
    {
      revision: batch.revision,
      previewFingerprint: batch.previewFingerprint,
      note: "No guessed identity",
      decisions: [
        {
          line: batch.rows[0].line,
          action: "create",
          customerId,
          customerRevision: customer.revision,
          siteId,
          siteFingerprint: site.fingerprint,
          entryStage: "In Progress",
          flooringType: "Tile",
          acceptSourceDates: true,
          note: "No real booking",
        },
      ],
    },
    400,
  );
  checks.push(
    "source in-progress stage cannot create fictional crew booking or silently enter scheduled stage",
  );
  batch = await approve(owner, batch);
  const [first, replay] = await Promise.all([
    call(owner, "POST", path(batch, "commit"), commitBody(batch)),
    call(owner, "POST", path(batch, "commit"), commitBody(batch)),
  ]);
  assert.deepEqual(first.result, replay.result);
  const jobId = first.result.jobIds[0];
  checks.push("concurrent reviewed commit is atomic and replays one new job");
  assert.deepEqual(await context(0, protectedSnapshot), baseline);
  assert.equal(
    (
      await context(0, () =>
        pool.query("SELECT count(*)::int n FROM quickbooks_sync_jobs"),
      )
    ).rows[0].n,
    0,
  );
  checks.push(
    "import produces zero stock/bookings/materials/invoices/provider queue/customer mutations",
  );
  let job = await call(owner, "GET", `/jobs/${jobId}`);
  for (const key of [
    "laborEstimate",
    "materialEstimate",
    "estRevenue",
    "estGrossProfit",
    "grossMarginPct",
    "actualRevenue",
    "actualLaborCost",
    "actualMaterialCost",
    "actualAddOnCost",
  ])
    assert.equal(job[key], null);
  assert.equal(job.shareToken, "");
  assert.deepEqual(job.stageHistory, []);
  assert.equal(job.soldAt, "2026-11-01");
  assert.equal(job.migrationCutover.source.sourceStatus, "In Progress");
  checks.push(
    "all nine financials remain null, no customer share token or fabricated event history",
  );
  assert.equal(job.migrationCutover.billing.ceilingCents, null);
  assert.equal(job.migrationCutover.forecastReportsEligible, false);
  assert.equal(job.migrationCutover.commissionReportsEligible, false);
  checks.push(
    "unknown forecast/full actuals/commission and billing scope are explicitly excluded",
  );
  await call(
    owner,
    "PATCH",
    `/jobs/${jobId}`,
    { revision: job.revision, actualRevenue: 0 },
    409,
  );
  await call(
    owner,
    "PATCH",
    `/jobs/${jobId}`,
    { revision: job.revision, estRevenue: 200 },
    409,
  );
  await call(owner, "DELETE", `/jobs/${jobId}`, undefined, 409);
  checks.push(
    "ordinary finance edit and job deletion cannot erase unknown cutover history",
  );
  await call(owner, "PATCH", `/jobs/${jobId}`, {
    revision: job.revision,
    notes: "New operational note",
  });
  job = await call(owner, "GET", `/jobs/${jobId}`);
  assert.equal(job.actualRevenue, null);
  assert.equal(
    (
      await context(0, () =>
        pool.query("SELECT count(*)::int n FROM quickbooks_sync_jobs"),
      )
    ).rows[0].n,
    0,
  );
  checks.push(
    "ordinary operational edit stays usable without queuing provider records or filling zeros",
  );
  const invoiceInput = (gross: number, key = randomUUID()) => ({
    jobId,
    customerName: "Retained customer",
    lineItems: [
      {
        id: "remaining-line",
        description: "Evidenced remaining work only",
        category: "Labor",
        quantity: 1,
        unitPrice: gross,
      },
    ],
    status: "Draft",
    issueDate: "2026-11-23",
    dueDate: "2026-12-23",
    requestKey: key,
    expectedCutoverRevision: job.migrationCutover.revision,
  });
  await call(owner, "POST", "/invoices", invoiceInput(50), 409);
  checks.push(
    "new invoice blocks unknown remaining-billable scope before any invoice/queue insert",
  );
  const state = await call(owner, "GET", `/jobs/${jobId}/cutover`);
  await call(
    owner,
    "POST",
    `/jobs/${jobId}/cutover/reviews`,
    {
      jobRevision: state.jobRevision,
      cutoverRevision: state.cutover.revision,
      payload: {
        kind: "operational",
        targetStage: "Scheduled",
        note: "No confirmed crew booking exists",
        confirmRealReadiness: true,
      },
    },
    409,
  );
  checks.push(
    "operational review reuses actual readiness and cannot override missing booking",
  );
  await cutoverCommit(owner, jobId, {
    kind: "operational",
    targetStage: "Approved",
    note: "Accepted safe operational entry stage; original in-progress source is retained",
    confirmRealReadiness: true,
  });
  checks.push(
    "safe operational review/approval/commit are immutable and replayable without creating schedule",
  );
  await context(0, () =>
    db.insert(usersTable).values({
      id: "queued-owner",
      email: "queued-owner@activejob.example.invalid",
      name: "Queued owner",
      role: "owner",
      passwordHash: encoded,
      createdAt: "2026-11-23",
      updatedAt: "2026-11-23",
    }),
  );
  const queuedOwner = await login(0, "queued-owner");
  const waitForLock = async (client: any, fragment: string) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      await client.query("SELECT pg_stat_clear_snapshot()");
      const result = await client.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",
        [`%${fragment}%`],
      );
      if (result.rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw Error("Expected fixture lock wait was not observed");
  };
  await context(0, async () => {
    const holder = await pool.connect();
    try {
      await holder.query(
        "SELECT pg_advisory_lock(hashtext('active-job-source-import'))",
      );
      const pending = http(queuedOwner, "POST", "/active-job-imports/preview")
        .send(
          input(
            "queued-owner-revoked",
            originalCsv.replace("000081", "000099"),
          ),
        )
        .then((response: any) => response);
      await waitForLock(holder, "active-job-source-import");
      await pool.query("UPDATE users SET role='sales' WHERE id='queued-owner'");
      await holder.query(
        "SELECT pg_advisory_unlock(hashtext('active-job-source-import'))",
      );
      assert.equal((await pending).status, 403);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM active_job_import_batches WHERE batch_key='queued-owner-revoked'",
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
  });
  checks.push(
    "owner demoted while waiting on import advisory lock cannot write a preview or approval source",
  );
  await context(0, () =>
    pool.query(
      "UPDATE users SET role='owner',active=true WHERE id='queued-owner'",
    ),
  );
  const beforeRevoked = await call(owner, "GET", `/jobs/${jobId}/cutover`);
  await context(0, async () => {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM jobs WHERE id=$1 FOR UPDATE", [jobId]);
      const pending = http(
        queuedOwner,
        "POST",
        `/jobs/${jobId}/cutover/reviews`,
      )
        .send({
          jobRevision: beforeRevoked.jobRevision,
          cutoverRevision: beforeRevoked.cutover.revision,
          payload: {
            kind: "operational",
            targetStage: "Approved",
            note: "Queued owner will be revoked while waiting",
            confirmRealReadiness: true,
          },
        })
        .then((response: any) => response);
      await waitForLock(holder, "jobs");
      await pool.query("UPDATE users SET active=false WHERE id='queued-owner'");
      await holder.query("COMMIT");
      assert.equal((await pending).status, 403);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
  assert.equal(
    (await call(owner, "GET", `/jobs/${jobId}/cutover`)).reviews.length,
    beforeRevoked.reviews.length,
  );
  checks.push(
    "owner deactivated during job-lock wait cannot persist a cutover review after request authentication",
  );
  const documentId = randomUUID(),
    docPath = `/objects/files/job-document/${randomUUID()}`,
    sha = "b".repeat(64);
  await context(0, () =>
    pool.query(
      "INSERT INTO job_documents(id,job_id,object_path,name,size,sha256,actor_user_id,request_key,created_at) VALUES($1,$2,$3,'Original cutover agreement.pdf',128,$4,'owner',$5,'2026-11-23')",
      [documentId, jobId, docPath, sha, randomUUID()],
    ),
  );
  const financial = {
    kind: "financial_context" as const,
    fullJobRevenueCents: 100000,
    fullJobLaborForecastCents: 20000,
    fullJobMaterialForecastCents: 30000,
    fullJobOtherForecastCents: 10000,
    evidenceDocumentIds: [documentId],
    note: "Full job forecast only; historical actual revenue and costs remain unknown",
    confirmForecastOnly: true as const,
  };
  await cutoverCommit(owner, jobId, financial);
  job = await call(owner, "GET", `/jobs/${jobId}`);
  assert.equal(job.estRevenue, null);
  assert.equal(job.actualRevenue, null);
  assert.equal(job.migrationCutover.financial.fullJobRevenueCents, 100000);
  assert.equal(job.migrationCutover.forecastReportsEligible, true);
  assert.equal(job.migrationCutover.actualProfitReportsEligible, false);
  checks.push(
    "full-job forecast is exact separate context, never native actuals or remaining-scope profit",
  );
  const metrics = await call(
    owner,
    "GET",
    "/metrics?from=2026-11-01&to=2026-12-01",
  );
  assert.equal(metrics.soldRevenue, 1000);
  assert.equal(
    metrics.migrationCutoverExclusions
      .remainingBillingScopeExcludedFromFullJobRevenue,
    true,
  );
  checks.push(
    "source calendar-day sold date uses business day and full forecast appears separately in metrics",
  );
  await cutoverCommit(owner, jobId, {
    kind: "billing",
    worksGrossInvoiceCeilingAfterLegacyCents: 10000,
    evidenceDocumentIds: [documentId],
    note: "Remaining gross after every legacy invoice including unpaid invoices; no legacy receivable is created",
    confirmIncludesAllLegacyInvoices: true,
    confirmNoLegacyBalancesCreated: true,
  });
  job = await call(owner, "GET", `/jobs/${jobId}`);
  checks.push(
    "evidenced still-billable gross ceiling is independent of full contract and unpaid legacy AR",
  );
  const beforeRounding = await context(0, async () => ({
    invoices: (await pool.query("SELECT count(*)::int n FROM invoices")).rows[0]
      .n,
    claims: (
      await pool.query(
        "SELECT count(*)::int n FROM job_cutover_invoice_requests",
      )
    ).rows[0].n,
  }));
  const unfaithful = await call(
    owner,
    "POST",
    "/invoices",
    { ...invoiceInput(0), taxAmount: 200000.01 },
    409,
  );
  assert.match(unfaithful.error, /cannot retain.*exactly/);
  assert.deepEqual(
    await context(0, async () => ({
      invoices: (await pool.query("SELECT count(*)::int n FROM invoices"))
        .rows[0].n,
      claims: (
        await pool.query(
          "SELECT count(*)::int n FROM job_cutover_invoice_requests",
        )
      ).rows[0].n,
    })),
    beforeRounding,
  );
  checks.push(
    "requested cents versus REAL readback are compared; large fractional tax rounding rejects atomically",
  );
  const key = randomUUID(),
    requestBody = invoiceInput(60, key),
    created = await call(owner, "POST", "/invoices", requestBody, 201);
  assert.equal(created.total, 60);
  assert.ok(created.invoiceFinancialFingerprint);
  assert.equal(
    (await call(owner, "POST", "/invoices", requestBody)).id,
    created.id,
  );
  await call(
    owner,
    "POST",
    "/invoices",
    {
      ...requestBody,
      lineItems: [{ ...requestBody.lineItems[0], unitPrice: 61 }],
    },
    409,
  );
  checks.push(
    "invoice request UUID replays exact immutable input and rejects changed-key reuse",
  );
  await call(owner, "POST", "/invoices", invoiceInput(41), 409);
  checks.push(
    "all retained gross invoice consumption, including drafts, enforces exact remaining ceiling",
  );
  const edited = await call(owner, "PATCH", `/invoices/${created.id}`, {
    lineItems: [{ ...requestBody.lineItems[0], unitPrice: 55 }],
    expectedCutoverRevision: job.migrationCutover.revision,
    expectedInvoiceFingerprint: created.invoiceFinancialFingerprint,
  });
  assert.equal(edited.total, 55);
  checks.push(
    "pre-approval draft edit recaptures source and ceiling and cancels stale accounting review",
  );
  await call(
    owner,
    "PATCH",
    `/invoices/${created.id}`,
    {
      lineItems: [{ ...requestBody.lineItems[0], unitPrice: 101 }],
      expectedCutoverRevision: job.migrationCutover.revision,
      expectedInvoiceFingerprint: edited.invoiceFinancialFingerprint,
    },
    409,
  );
  await call(
    owner,
    "PATCH",
    `/invoices/${created.id}`,
    {
      customerId: null,
      expectedCutoverRevision: job.migrationCutover.revision,
      expectedInvoiceFingerprint: edited.invoiceFinancialFingerprint,
    },
    409,
  );
  await call(owner, "DELETE", `/invoices/${created.id}`, undefined, 409);
  checks.push(
    "over-ceiling edit, customer removal and deletion cannot free billing capacity",
  );
  const voided = await call(owner, "PATCH", `/invoices/${created.id}`, {
    status: "Voided",
    expectedCutoverRevision: job.migrationCutover.revision,
    expectedInvoiceFingerprint: edited.invoiceFinancialFingerprint,
  });
  job = await call(owner, "GET", `/jobs/${jobId}`);
  assert.equal(job.migrationCutover.billing.consumedCents, 5500);
  assert.equal(job.migrationCutover.billing.remainingCents, 4500);
  assert.equal(voided.status, "Voided");
  checks.push("void does not silently replenish consumed gross ceiling");
  const parallel = await Promise.all([
    http(owner, "POST", "/invoices").send(invoiceInput(40)),
    http(owner, "POST", "/invoices").send(invoiceInput(40)),
  ]);
  assert.deepEqual(parallel.map((row) => row.status).sort(), [201, 409]);
  const accepted = parallel.find((row) => row.status === 201)!.body;
  checks.push(
    "competing invoice creations serialize under job lock so only one fits remaining capacity",
  );
  await context(0, async () => {
    const [source] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, accepted.id));
    await db.transaction((tx) =>
      assertCutoverInvoiceSubmission(tx, source, true),
    );
  });
  await call(
    owner,
    "PATCH",
    `/invoices/${accepted.id}`,
    {
      notes: "Changed after submission",
      expectedCutoverRevision: job.migrationCutover.revision,
      expectedInvoiceFingerprint: accepted.invoiceFinancialFingerprint,
    },
    409,
  );
  checks.push(
    "actual submission claim durably freezes financial/provider document before any provider POST",
  );
  await context(0, async () => {
    for (const scenario of [
      "foreign_job",
      "foreign_customer",
      "changed_gross",
    ]) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const foreignInvoice = randomUUID();
        await client.query(
          "INSERT INTO invoices(id,invoice_number,job_id,customer_id,customer_name,total,status,created_at,updated_at) VALUES($1,$1,$2,$3,'Fixture',1,'Draft','2026-11-23','2026-11-23')",
          [
            foreignInvoice,
            scenario === "foreign_job" ? nativeJobId : jobId,
            scenario === "foreign_customer" ? null : customerId,
          ],
        );
        await assert.rejects(
          client.query(
            "INSERT INTO job_cutover_invoice_requests(id,job_id,invoice_id,billing_commit_id,request_fingerprint,request_payload,initial_gross_cents,current_gross_cents,financial_fingerprint,created_by,created_at,updated_at) SELECT $1,$2,$3,billing_commit_id,request_fingerprint,request_payload,$4,$4,financial_fingerprint,'owner','2026-11-23','2026-11-23' FROM job_cutover_invoice_requests WHERE invoice_id=$5",
            [
              randomUUID(),
              jobId,
              foreignInvoice,
              scenario === "changed_gross" ? 0 : 100,
              accepted.id,
            ],
          ),
          /must match its current approved job/,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
  });
  checks.push(
    "actual PostgreSQL rejects cross-job, wrong-customer and mismatched gross claim insertion",
  );
  await cutoverCommit(owner, jobId, {
    kind: "billing",
    worksGrossInvoiceCeilingAfterLegacyCents: 30000000,
    evidenceDocumentIds: [documentId],
    note: "Explicit large fixture ceiling to verify draft REAL readback; existing claims remain consumed",
    confirmIncludesAllLegacyInvoices: true,
    confirmNoLegacyBalancesCreated: true,
  });
  job = await call(owner, "GET", `/jobs/${jobId}`);
  await context(0, async () => {
    await assert.rejects(
      db.transaction(async (tx) => {
        const locked = await lockedCutoverJob(tx, jobId),
          id = randomUUID();
        const requested = {
          lineItems: [
            {
              id: "faithful-line",
              description: "Exact-cent storage fixture",
              category: "Labor" as const,
              quantity: 1,
              unitPrice: 100000.01,
            },
          ],
          subtotal: 100000.01,
          taxableAmount: 100000.01,
          taxAmount: 0,
          discountAmount: 0,
          total: 100000.01,
          depositAmount: 0,
        };
        const [saved] = await tx
          .insert(invoicesTable)
          .values({
            ...requested,
            id,
            invoiceNumber: `EXACT-${id}`,
            jobId,
            customerId,
            customerName: "Retained customer",
            status: "Draft",
            createdAt: "2026-11-23",
            updatedAt: "2026-11-23",
          })
          .returning();
        assert.equal(Math.round(saved.total * 100), 10000001);
        await consumeCutoverInvoice(
          tx,
          locked,
          saved,
          randomUUID(),
          { fixture: "faithful-real-readback" },
          "owner",
          job.migrationCutover.revision,
          requested,
        );
        throw Error("rollback faithful-storage fixture");
      }),
      /rollback faithful-storage fixture/,
    );
  });
  checks.push(
    "faithful large REAL amount keeps its requested cents through double-precision SQL binding, with fixture rollback",
  );
  const emptyDraft = await call(
    owner,
    "POST",
    "/invoices",
    invoiceInput(0),
    201,
  );
  const badEdit = await call(
    owner,
    "PATCH",
    `/invoices/${emptyDraft.id}`,
    {
      taxAmount: 200000.01,
      expectedCutoverRevision: job.migrationCutover.revision,
      expectedInvoiceFingerprint: emptyDraft.invoiceFinancialFingerprint,
    },
    409,
  );
  assert.match(badEdit.error, /cannot retain.*exactly/);
  const unchanged = (await call(owner, "GET", "/invoices")).find(
    (row: any) => row.id === emptyDraft.id,
  );
  assert.equal(unchanged.total, 0);
  assert.equal(
    unchanged.invoiceFinancialFingerprint,
    emptyDraft.invoiceFinancialFingerprint,
  );
  await context(0, async () =>
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT current_gross_cents FROM job_cutover_invoice_requests WHERE invoice_id=$1",
            [emptyDraft.id],
          )
        ).rows[0].current_gross_cents,
      ),
      0,
    ),
  );
  checks.push(
    "draft edit readback rounding rolls back invoice, consumption and cancelled review changes together",
  );
  await call(
    owner,
    "POST",
    `/customers/${customerId}/merge`,
    { targetId: randomUUID(), revision: 1 },
    409,
  );
  checks.push(
    "invalid customer merge does not move source or consume fake billing capacity",
  );
  await context(0, () =>
    pool.query(
      "UPDATE jobs SET scope_of_work='Explicit new remaining scope',revision=revision+1 WHERE id=$1",
      [jobId],
    ),
  );
  await context(0, async () => {
    const [source] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, accepted.id));
    await assert.rejects(
      db.transaction((tx) => assertCutoverInvoiceSubmission(tx, source, true)),
      /stale/,
    );
  });
  job = await call(owner, "GET", `/jobs/${jobId}`);
  assert.equal(job.migrationCutover.billing.current, false);
  assert.equal(job.migrationCutover.forecastReportsEligible, false);
  checks.push(
    "scope change invalidates financial context/billing approval and actual provider submit refuses stale snapshot",
  );
  const linkPreview = await call(
    owner,
    "POST",
    "/active-job-imports/preview",
    input("link-existing", "source_id,source_status\nLINK-0001,Approved\n"),
    201,
  );
  const linkChoices = await choices(owner),
    linkCustomer = linkChoices.customers.find(
      (row: any) => row.id === customerId,
    ),
    linkSite = linkCustomer.sites.find((row: any) => row.id === siteId),
    nativeChoice = linkChoices.jobs.find((row: any) => row.id === nativeJobId);
  const linkDecision = {
    line: linkPreview.rows[0].line,
    action: "link" as const,
    customerId,
    customerRevision: linkCustomer.revision,
    siteId,
    siteFingerprint: linkSite.fingerprint,
    jobId: nativeJobId,
    jobRevision: nativeChoice.revision,
    note: "Explicit source link to the existing exact job, without changing its fields",
  };
  const linkApproved = await approve(owner, linkPreview, [linkDecision]);
  await context(0, () =>
    pool.query(
      "UPDATE customer_sites SET city='Changed after review' WHERE id=$1",
      [siteId],
    ),
  );
  await call(
    owner,
    "POST",
    path(linkApproved, "commit"),
    commitBody(linkApproved),
    409,
  );
  await context(0, () =>
    pool.query("UPDATE customer_sites SET city='Knoxville' WHERE id=$1", [
      siteId,
    ]),
  );
  checks.push(
    "site content change after approval blocks commit atomically without overwriting the selected existing job",
  );
  const linked = await call(
    owner,
    "POST",
    path(linkApproved, "commit"),
    commitBody(linkApproved),
  );
  assert.equal(linked.result.linked, 1);
  assert.equal(
    (await call(owner, "GET", `/jobs/${nativeJobId}`)).migrationCutover,
    null,
  );
  checks.push(
    "explicit link-existing preserves native financials and eligibility and never creates cutover restrictions",
  );
  assert.deepEqual(
    (
      await context(0, () =>
        pool.query("SELECT to_jsonb(j) row FROM jobs j WHERE id=$1", [
          nativeJobId,
        ]),
      )
    ).rows,
    nativeBefore.rows,
  );
  assert.deepEqual(await context(0, protectedSnapshot), baseline);
  assert.deepEqual(await context(1, protectedSnapshot), otherBaseline);
  checks.push(
    "native existing job values, all protected financial/stock/customer/provider records and other tenant stay unchanged",
  );
  // Additional explicit synthetic workflow exercises are separate from the
  // import-preservation snapshot above. No real provider is ever contacted.
  const newReceiptId = randomUUID();
  await context(0, () =>
    pool.query(
      "INSERT INTO job_documents(id,job_id,object_path,name,size,sha256,actor_user_id,request_key,created_at) VALUES($1,$2,$3,'Fictional new Works expense receipt.pdf',128,$4,'owner',$5,'2026-11-23')",
      [
        newReceiptId,
        jobId,
        `/objects/files/job-document/${randomUUID()}`,
        "c".repeat(64),
        randomUUID(),
      ],
    ),
  );
  await call(
    owner,
    "POST",
    `/jobs/${jobId}/expenses`,
    {
      requestKey: randomUUID(),
      kind: "paid_purchase",
      category: "other",
      description: "New Works-recorded cost after cutover",
      vendorName: "Fictional receipt supplier",
      transactionDate: "2026-11-23",
      dueDate: null,
      currency: "USD",
      amountCents: 50,
      taxCents: 0,
      receiptDocumentId: newReceiptId,
      reference: "FIXTURE-COST-1",
      notes: "Synthetic test receipt; historical costs remain unknown",
    },
    201,
  );
  job = await call(owner, "GET", `/jobs/${jobId}`);
  assert.equal(job.trackedExpenseCost, 0.5);
  assert.equal(job.actualRevenue, null);
  assert.equal(job.actualAddOnCost, null);
  assert.equal(job.migrationCutover.actualProfitReportsEligible, false);
  checks.push(
    "new receipt-backed local costs remain usable while historical actuals/profit stay unknown",
  );
  await cutoverCommit(owner, jobId, {
    kind: "operational",
    targetStage: "Approved",
    note: "Current remaining operational scope reviewed; no assumed booking",
    confirmRealReadiness: true,
  });
  await cutoverCommit(owner, jobId, {
    kind: "billing",
    worksGrossInvoiceCeilingAfterLegacyCents: 20000,
    evidenceDocumentIds: [documentId],
    note: "Current remaining scope after every legacy invoice; existing Works gross is retained",
    confirmIncludesAllLegacyInvoices: true,
    confirmNoLegacyBalancesCreated: true,
  });
  job = await call(owner, "GET", `/jobs/${jobId}`);
  const proposalId = randomUUID();
  await context(0, () =>
    pool.query(
      "INSERT INTO proposals(id,job_id,customer_id,site_id,customer_name,project_location,flooring_type,room_list,total_sq_ft,scope_of_work,estimated_price,expected_timeline,material_assumptions,exclusions,warranty_note,status,share_token,line_items,created_at,accepted_at) VALUES($1,$2,$3,$4,'Retained customer','Knoxville','Tile','[]',0,'Explicit new remaining work only',25,'No imported booking','','','','Accepted','','[]','2026-11-23','2026-11-23')",
      [proposalId, jobId, customerId, siteId],
    ),
  );
  const beforeConversion = await context(0, () =>
    pool.query("SELECT to_jsonb(j) row FROM jobs j WHERE id=$1", [jobId]),
  );
  const converted = await call(
    owner,
    "POST",
    `/proposals/${proposalId}/convert`,
    { expectedCutoverRevision: job.migrationCutover.revision },
  );
  const convertedAgain = await call(
    owner,
    "POST",
    `/proposals/${proposalId}/convert`,
    { expectedCutoverRevision: job.migrationCutover.revision },
  );
  assert.equal(convertedAgain.invoice.id, converted.invoice.id);
  assert.equal(converted.invoice.total, 25);
  assert.ok(converted.invoice.invoiceFinancialFingerprint);
  assert.equal(converted.job.estRevenue, null);
  assert.deepEqual(
    (
      await context(0, () =>
        pool.query("SELECT to_jsonb(j) row FROM jobs j WHERE id=$1", [jobId]),
      )
    ).rows,
    beforeConversion.rows,
  );
  assert.equal(
    (
      await context(0, () =>
        pool.query("SELECT count(*)::int n FROM materials WHERE job_id=$1", [
          jobId,
        ]),
      )
    ).rows[0].n,
    0,
  );
  checks.push(
    "accepted remaining quote conversion shares ceiling/claim, replays one invoice and preserves imported full-job context/materials",
  );
  const connectedInvoice = await call(
      owner,
      "POST",
      "/invoices",
      invoiceInput(10),
      201,
    ),
    connectionId = randomUUID(),
    realm = "1234567";
  await context(0, async () => {
    await pool.query(
      "INSERT INTO quickbooks_connections(id,realm_id,company_name,environment,granted_scopes,encrypted_access_token,encrypted_refresh_token,access_token_expires_at,refresh_token_expires_at,status,created_at,updated_at) VALUES($1,$2,'Synthetic provider fixture','sandbox',ARRAY['com.intuit.quickbooks.accounting'],$3,$4,'2099-01-01','2099-01-01','connected','2026-11-23','2026-11-23')",
      [
        connectionId,
        realm,
        encryptSecret("synthetic-access"),
        encryptSecret("synthetic-refresh"),
      ],
    );
    for (const [entity, localId, remoteId] of [
      ["customer", jobId, "100"],
      ["invoice-service", JSON.stringify(["sandbox", realm, "Labor"]), "200"],
    ])
      await pool.query(
        "INSERT INTO quickbooks_entity_mappings(id,entity_type,local_id,quickbooks_id,realm_id,environment,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'sandbox','linked','2026-11-23','2026-11-23')",
        [randomUUID(), entity, localId, remoteId, realm],
      );
  });
  let staleAtPreferences = false;
  const remoteInvoices: any[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "sandbox-quickbooks.api.intuit.com") {
      unexpectedProviderCalls++;
      throw Error("Unexpected provider transport");
    }
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname.endsWith("/query")) {
      const statement = url.searchParams.get("query") ?? "";
      const match = /DocNumber = '([^']+)'/.exec(statement);
      assert.ok(match);
      return json({
        QueryResponse: {
          Invoice: remoteInvoices.filter((row) => row.DocNumber === match[1]),
        },
      });
    }
    if (url.pathname.endsWith("/preferences")) {
      if (staleAtPreferences) {
        staleAtPreferences = false;
        await pool.query(
          "UPDATE jobs SET scope_of_work='Changed immediately before actual provider submit',revision=revision+1 WHERE id=$1",
          [jobId],
        );
      }
      return json({
        Preferences: { SalesFormsPrefs: { CustomTxnNumbers: true } },
      });
    }
    if (url.pathname.endsWith("/invoice") && init?.method === "POST") {
      const document = JSON.parse(String(init.body));
      assert.ok(url.searchParams.get("requestid"));
      const invoice = (
        await pool.query("SELECT id FROM invoices WHERE invoice_number=$1", [
          document.DocNumber,
        ])
      ).rows[0];
      const claim = (
        await pool.query(
          "SELECT submission_locked FROM job_cutover_invoice_requests WHERE invoice_id=$1",
          [invoice.id],
        )
      ).rows[0];
      assert.equal(claim.submission_locked, true);
      await assert.rejects(
        pool.query("UPDATE invoices SET total=0 WHERE id=$1", [invoice.id]),
        /Submitted/,
      );
      simulatedInvoicePosts++;
      const total = document.Line.reduce(
        (sum: number, line: any) => sum + line.Amount,
        0,
      );
      const remote = {
        ...document,
        Id: String(9000 + simulatedInvoicePosts),
        SyncToken: "0",
        TotalAmt: total,
        Balance: total,
      };
      remoteInvoices.push(remote);
      return json({ Invoice: remote });
    }
    unexpectedProviderCalls++;
    throw Error("Unexpected synthetic QuickBooks operation");
  }) as typeof fetch;
  const queueFor = async (id: string) =>
    context(
      0,
      async () =>
        (
          await pool.query(
            "SELECT * FROM quickbooks_sync_jobs WHERE entity_type='invoice' AND local_id=$1 AND status='pending_approval' ORDER BY created_at DESC LIMIT 1",
            [id],
          )
        ).rows[0],
    );
  const waitQueue = async (id: string, status: string) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const row = await context(
        0,
        async () =>
          (
            await pool.query(
              "SELECT status,last_error FROM quickbooks_sync_jobs WHERE id=$1",
              [id],
            )
          ).rows[0],
      );
      if (row.status === status) return row;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error(`Queue did not reach ${status}`);
  };
  const queued = await queueFor(connectedInvoice.id);
  const approvedQueue = await call(owner, "POST", "/quickbooks/queue/approve", {
    ids: [queued.id],
  });
  assert.equal(
    approvedQueue[0].payload.migrationCutoverApproval.company.connectionId,
    connectionId,
  );
  await waitQueue(queued.id, "completed");
  assert.equal(simulatedInvoicePosts, 1);
  checks.push(
    "actual owner approval freezes company/cutover proof; actual worker POST sees durable immutable submission claim",
  );
  const driftInvoice = await call(
      owner,
      "POST",
      "/invoices",
      invoiceInput(5),
      201,
    ),
    driftQueue = await queueFor(driftInvoice.id);
  staleAtPreferences = true;
  await call(owner, "POST", "/quickbooks/queue/approve", {
    ids: [driftQueue.id],
  });
  const failed = await waitQueue(driftQueue.id, "failed");
  assert.match(failed.last_error, /stale|changed/);
  assert.equal(simulatedInvoicePosts, 1);
  checks.push(
    "scope changed between provider preparation and actual POST is refused with zero additional provider writes",
  );
  assert.equal(unexpectedProviderCalls, 0);
  console.log(
    JSON.stringify({
      activeJobImport: "passed",
      checks,
      unexpectedProviderCalls,
      protectedRecordsChanged: false,
      simulatedInvoicePosts,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  await closeWorkspaceConnections();
}
