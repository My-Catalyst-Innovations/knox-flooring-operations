/** Real PostgreSQL + actual owner routes; every Intuit response is a local fixture. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  jobDocumentsTable,
  jobsTable,
  laborEntriesTable,
  jobExpensesTable,
  quickbooksConnectionsTable,
  quickbooksEntityMappingsTable,
  quickbooksJobCostExportsTable,
  quickbooksSyncJobsTable,
} from "@workspace/db";
import accountingRouter from "../src/routes/job-accounting";
import laborRouter from "../src/routes/labor-entries";
import jobsRouter from "../src/routes/jobs";
import { encryptSecret } from "../src/lib/quickbooks";
import {
  prepareJobCost,
  approveJobCost,
  processJobCostExport,
  cancelJobCost,
} from "../src/lib/job-accounting";

const url = new URL(process.env.DATABASE_URL!);
assert.ok(
  ["127.0.0.1", "localhost"].includes(url.hostname) &&
    /^\/catalyst_release_/.test(url.pathname),
  "Cost fixtures refuse non-disposable databases",
);
let connectionId = randomUUID();
const connectionIds = [connectionId];
const jobId = "other-job",
  tag = randomUUID(),
  actor = "cost-fixture-owner",
  now = new Date().toISOString();
const laborIds = [0, 1, 2, 3].map(() => randomUUID()),
  documentIds = [0, 1, 2, 3].map(() => randomUUID());
const originalFetch = globalThis.fetch,
  records = new Map<string, any[]>(),
  writes: any[] = [];
let loseResponse = false,
  hideCreated = false,
  rejectOnce = false,
  mutateAtFinalRead: (() => Promise<void>) | null = null;
const seeded: any = {
  Employee: [{ Id: "5", DisplayName: "Pat Installer", Active: true }],
  Vendor: [{ Id: "20", DisplayName: "Sam Contracting", Active: true }],
  Item: [{ Id: "8", Name: "Installation", Active: true, Type: "Service" }],
  Customer: [{ Id: "1", DisplayName: "Fixture customer", Active: true }],
  Account: [
    { Id: "30", Name: "Job expense", Active: true, AccountType: "Expense" },
    {
      Id: "40",
      Name: "Company card",
      Active: true,
      AccountType: "Credit Card",
    },
  ],
};
globalThis.fetch = (async (input: any, options: RequestInit = {}) => {
  const target = new URL(String(input));
  assert.equal(
    target.origin,
    "https://sandbox-quickbooks.api.intuit.com",
    "This fixture must never contact a real provider",
  );
  assert.ok(target.pathname.startsWith("/v3/company/777/"));
  const entity = target.pathname.slice("/v3/company/777/".length);
  if (entity === "companyinfo/777")
    return Response.json({
      CompanyInfo: { Country: "US", CompanyName: "Internal sandbox" },
    });
  if (entity === "preferences")
    return Response.json({
      Preferences: {
        CurrencyPrefs: {
          HomeCurrency: { value: "USD" },
          MultiCurrencyEnabled: false,
        },
      },
    });
  if (entity === "query") {
    const query = target.searchParams.get("query")!,
      name = /select \* from (\w+)/i.exec(query)![1],
      actualName =
        Object.keys(seeded).find(
          (key) => key.toLowerCase() === name.toLowerCase(),
        ) ?? name;
    if (
      mutateAtFinalRead &&
      ["TimeActivity", "Purchase", "Bill"].includes(actualName)
    ) {
      const mutate = mutateAtFinalRead;
      mutateAtFinalRead = null;
      await mutate();
    }
    return Response.json({
      QueryResponse: {
        [actualName]:
          seeded[actualName] ??
          (hideCreated ? [] : (records.get(actualName) ?? [])),
      },
    });
  }
  const name = entity.split("/")[0],
    actualName = [
      "TimeActivity",
      "Purchase",
      "Bill",
      ...Object.keys(seeded),
    ].find((key) => key.toLowerCase() === name.toLowerCase());
  assert.ok(actualName);
  if (options.method === "POST") {
    assert.ok(["TimeActivity", "Purchase", "Bill"].includes(actualName));
    assert.ok((target.searchParams.get("requestid")?.length ?? 100) <= 50);
    const document = JSON.parse(String(options.body));
    assert.equal(document.HourlyRate, undefined);
    assert.equal(document.PayrollItemRef, undefined);
    if (rejectOnce) {
      rejectOnce = false;
      return Response.json(
        {
          Fault: {
            type: "ValidationFault",
            Error: [{ code: "2500", Message: "Synthetic invalid reference" }],
          },
        },
        { status: 400 },
      );
    }
    const remote = {
      ...document,
      Id: String(100 + writes.length),
      SyncToken: "0",
      ...(actualName !== "TimeActivity"
        ? {
            TotalAmt: document.Line.reduce(
              (sum: number, line: any) => sum + line.Amount,
              0,
            ),
          }
        : {}),
    };
    writes.push({
      entity: actualName,
      document,
      requestId: target.searchParams.get("requestid"),
    });
    records.set(actualName, [...(records.get(actualName) ?? []), remote]);
    if (loseResponse) {
      loseResponse = false;
      throw Error("Synthetic lost response after commit");
    }
    return Response.json({ [actualName]: remote });
  }
  const id = entity.split("/")[1],
    record = (seeded[actualName] ?? records.get(actualName) ?? []).find(
      (row: any) => row.Id === id,
    );
  assert.ok(record, `Unexpected fixture read ${entity}`);
  return Response.json({ [actualName]: record });
}) as typeof fetch;
const app = express();
app.use(express.json());
app.use((req: any, res, next) => {
  req.log = { error: () => {}, warn: () => {} };
  req.auth = {
    userId: actor,
    role: req.get("x-role") ?? "owner",
    actualRole: req.get("x-role") ?? "owner",
    previewRole: null,
  };
  next();
});
app.use(accountingRouter);
app.use(laborRouter);
app.use(jobsRouter);
async function call(
  method: "get" | "post" | "patch",
  path: string,
  body?: any,
  status = 200,
) {
  const result = await request(app)[method](path).send(body);
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
}
const selection = (revision: number, extra: any = {}) => ({
  connectionId,
  sourceRevision: revision,
  projectMode: "customer",
  billableStatus: "NotBillable",
  taxTreatment: "included_in_cost",
  ...extra,
});
async function configure(id: string, workerType = "Employee", hourlyCost = 40) {
  const source = (
    await db
      .select()
      .from(laborEntriesTable)
      .where(eq(laborEntriesTable.id, id))
  )[0];
  return call("patch", `/jobs/${jobId}/labor/${id}/accounting`, {
    revision: source.revision,
    singleWorkerConfirmed: true,
    workerType,
    workerExternalId: workerType === "Employee" ? "5" : "20",
    workerName: workerType === "Employee" ? "Pat Installer" : "Sam Contracting",
    serviceItemExternalId: "8",
    hourlyCost,
  });
}
async function receipt(index: number, extra: any = {}) {
  return call(
    "post",
    `/jobs/${jobId}/expenses`,
    {
      requestKey: randomUUID(),
      kind: "paid_purchase",
      category: "other",
      description: "Non-stock disposal fee",
      vendorName: "Sam Contracting",
      transactionDate: "2026-11-23",
      dueDate: null,
      currency: "USD",
      amountCents: 1083,
      taxCents: 83,
      receiptDocumentId: documentIds[index],
      reference: `C${index}-${tag.slice(0, 8)}`,
      notes: "Internal fixture",
      ...extra,
    },
    201,
  );
}
try {
  assert.equal((await db.select().from(quickbooksConnectionsTable)).length, 0);
  await db.insert(quickbooksConnectionsTable).values({
    id: connectionId,
    realmId: "777",
    companyName: "Internal sandbox",
    environment: "sandbox",
    grantedScopes: ["com.intuit.quickbooks.accounting"],
    encryptedAccessToken: encryptSecret("fixture-access"),
    encryptedRefreshToken: encryptSecret("fixture-refresh"),
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
    status: "connected",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(quickbooksEntityMappingsTable).values({
    id: randomUUID(),
    entityType: "customer",
    localId: jobId,
    quickbooksId: "1",
    realmId: "777",
    environment: "sandbox",
    status: "linked",
    fingerprint: "fixture",
    createdAt: now,
    updatedAt: now,
  });
  for (let i = 0; i < 4; i++) {
    await db.insert(laborEntriesTable).values({
      id: laborIds[i],
      jobId,
      date: "2026-11-23",
      crew: "Explicit fixture person",
      hours: 1.5,
      notes: `Individual ${i}`,
      createdAt: now,
    });
    await db.insert(jobDocumentsTable).values({
      id: documentIds[i],
      jobId,
      objectPath: `/objects/files/job-document/${randomUUID()}`,
      name: `Receipt ${i}.pdf`,
      size: 100,
      sha256: String(i + 1).repeat(64),
      actorUserId: actor,
      requestKey: randomUUID(),
      createdAt: now,
    });
  }
  assert.equal(
    (
      await request(app)
        .get(`/jobs/${jobId}/accounting-costs`)
        .set("x-role", "installer")
    ).status,
    403,
  );
  // A pre-existing aggregate crew record may retain fractional hours. It must
  // not become reviewed individual time by silently rounding those hours.
  await call("patch", `/jobs/${jobId}/labor/${laborIds[3]}`, { hours: 1.001 });
  const fractionalBefore = (
    await db
      .select()
      .from(laborEntriesTable)
      .where(eq(laborEntriesTable.id, laborIds[3]))
  )[0];
  await call(
    "patch",
    `/jobs/${jobId}/labor/${fractionalBefore.id}/accounting`,
    {
      revision: fractionalBefore.revision,
      singleWorkerConfirmed: true,
      workerType: "Employee",
      workerExternalId: "5",
      workerName: "Pat Installer",
      serviceItemExternalId: "8",
      hourlyCost: 20.02,
    },
    400,
  );
  const fractionalAfter = (
    await db
      .select()
      .from(laborEntriesTable)
      .where(eq(laborEntriesTable.id, laborIds[3]))
  )[0];
  assert.equal(fractionalAfter.hours, fractionalBefore.hours);
  assert.equal(fractionalAfter.revision, fractionalBefore.revision);
  assert.equal(fractionalAfter.costReviewed, false);
  assert.equal(
    (await call("get", `/jobs/${jobId}/accounting-costs`)).totals
      .trackedLaborCost,
    null,
  );
  await call("patch", `/jobs/${jobId}/labor/${fractionalBefore.id}`, {
    hours: 1.5,
  });
  // Cross-API regression: JS owner summary and SQL job/list presentation must
  // agree on the half-cent case that binary hours*rate previously undercounted.
  await call("patch", `/jobs/${jobId}/labor/${laborIds[2]}`, { hours: 1.75 });
  const rounded = await configure(laborIds[2], "Employee", 20.02);
  assert.equal(
    (await call("get", `/jobs/${jobId}/accounting-costs`)).totals
      .trackedLaborCost,
    35.04,
  );
  assert.equal((await call("get", `/jobs/${jobId}`)).trackedLaborCost, 35.04);
  assert.equal(
    (await call("get", "/jobs")).find((row: any) => row.id === jobId)
      .trackedLaborCost,
    35.04,
  );
  await call("patch", `/jobs/${jobId}/labor/${rounded.id}`, { hours: 1.5 });
  const configured = await configure(laborIds[0]);
  assert.equal(configured.revision, 2);
  const choice = selection(configured.revision);
  const preview = await call(
    "post",
    `/quickbooks/job-costs/labor/${configured.id}/review`,
    choice,
  );
  assert.equal(preview.document.CostRate, 40);
  assert.equal(preview.document.HourlyRate, undefined);
  assert.equal(writes.length, 0);
  await call(
    "post",
    `/quickbooks/job-costs/labor/${configured.id}/approve`,
    { ...choice, fingerprint: "0".repeat(64) },
    409,
  );
  const approvals = await Promise.all([
    call("post", `/quickbooks/job-costs/labor/${configured.id}/approve`, {
      ...choice,
      fingerprint: preview.fingerprint,
    }),
    call("post", `/quickbooks/job-costs/labor/${configured.id}/approve`, {
      ...choice,
      fingerprint: preview.fingerprint,
    }),
  ]);
  assert.equal(approvals[0].export.id, approvals[1].export.id);
  loseResponse = true;
  await assert.rejects(
    processJobCostExport(approvals[0].export.id, { allowSubmit: true }),
    /unconfirmed/,
  );
  assert.equal(writes.length, 1);
  hideCreated = true;
  const unresolved = await processJobCostExport(approvals[0].export.id, {
    allowSubmit: true,
  });
  assert.equal(unresolved.outcome, "unresolved");
  assert.equal(writes.length, 1);
  hideCreated = false;
  const originalConnectionId = connectionId;
  connectionId = randomUUID();
  connectionIds.push(connectionId);
  await db
    .update(quickbooksConnectionsTable)
    .set({ id: connectionId })
    .where(eq(quickbooksConnectionsTable.id, originalConnectionId));
  for (const change of [
    { realmId: "other-realm" },
    { realmId: "777", environment: "production" },
  ]) {
    await db
      .update(quickbooksConnectionsTable)
      .set(change)
      .where(eq(quickbooksConnectionsTable.id, connectionId));
    await call(
      "post",
      `/quickbooks/job-costs/exports/${approvals[0].export.id}/reconcile`,
      { connectionId },
      404,
    );
    assert.equal(writes.length, 1);
  }
  await db
    .update(quickbooksConnectionsTable)
    .set({ realmId: "777", environment: "sandbox" })
    .where(eq(quickbooksConnectionsTable.id, connectionId));
  await db
    .update(laborEntriesTable)
    .set({
      notes: "A later local correction must not alter the frozen submission",
      revision: configured.revision + 1,
    })
    .where(eq(laborEntriesTable.id, configured.id));
  const recovered = await call(
    "post",
    `/quickbooks/job-costs/exports/${approvals[0].export.id}/reconcile`,
    { connectionId },
  );
  assert.equal(recovered.outcome, "confirmed");
  assert.match(recovered.warning, /originally approved/);
  assert.equal(recovered.export.connectionId, originalConnectionId);
  assert.equal(
    (
      await db
        .select()
        .from(laborEntriesTable)
        .where(eq(laborEntriesTable.id, configured.id))
    )[0].accountingStatus,
    "review_required",
  );
  await db
    .update(laborEntriesTable)
    .set({
      notes: configured.notes,
      revision: configured.revision,
      accountingStatus: "exported",
    })
    .where(eq(laborEntriesTable.id, configured.id));
  assert.equal(writes.length, 1);
  await call(
    "patch",
    `/jobs/${jobId}/labor/${configured.id}`,
    { hours: 2 },
    409,
  );
  await call(
    "post",
    `/quickbooks/job-costs/exports/${approvals[0].export.id}/cancel`,
    { connectionId },
    409,
  );
  const vendor = await configure(laborIds[1], "Vendor");
  const paid = await receipt(0),
    paidChoice = selection(paid.revision, {
      vendorId: "20",
      expenseAccountId: "30",
      paymentType: "CreditCard",
      paymentAccountId: "40",
    });
  const paidPreview = await call(
    "post",
    `/quickbooks/job-costs/expense/${paid.id}/review`,
    paidChoice,
  );
  const paidApproved = await call(
    "post",
    `/quickbooks/job-costs/expense/${paid.id}/approve`,
    { ...paidChoice, fingerprint: paidPreview.fingerprint },
  );
  const posted = await processJobCostExport(paidApproved.export.id, {
    allowSubmit: true,
  });
  assert.equal(posted.outcome, "confirmed");
  assert.equal(writes[1].entity, "Purchase");
  const bill = await receipt(1, {
    kind: "contractor_bill",
    category: "labor",
    amountCents: 10000,
    taxCents: 0,
    dueDate: "2026-12-01",
    relatedLaborEntryId: vendor.id,
  });
  await call(
    "post",
    `/quickbooks/job-costs/labor/${vendor.id}/review`,
    selection(vendor.revision),
    409,
  );
  const billChoice = selection(bill.revision, {
      vendorId: "20",
      expenseAccountId: "30",
    }),
    billPreview = await call(
      "post",
      `/quickbooks/job-costs/expense/${bill.id}/review`,
      billChoice,
    );
  const billApproved = await call(
    "post",
    `/quickbooks/job-costs/expense/${bill.id}/approve`,
    { ...billChoice, fingerprint: billPreview.fingerprint },
  );
  assert.equal(
    (await processJobCostExport(billApproved.export.id, { allowSubmit: true }))
      .outcome,
    "confirmed",
  );
  assert.equal(writes[2].entity, "Bill");
  assert.equal(writes[2].document.PaymentType, undefined);
  const totals = await call("get", `/jobs/${jobId}/accounting-costs`);
  assert.equal(totals.totals.trackedLaborCost, 60);
  assert.equal(totals.totals.trackedExpenseCost, 110.83);
  const job = await call("get", `/jobs/${jobId}`);
  assert.equal(job.trackedLaborCost, 60);
  assert.equal(job.trackedExpenseCost, 110.83);
  const stale = await configure(laborIds[2]),
    staleChoice = selection(stale.revision),
    stalePreview = await prepareJobCost("labor", stale.id, staleChoice as any);
  const staleApproval = await approveJobCost(stalePreview, actor);
  let readCount = 0;
  mutateAtFinalRead = async () => {
    mutateAtFinalRead = async () => {
      readCount++;
      await db
        .update(jobsTable)
        .set({ revision: sqlIncrement() })
        .where(eq(jobsTable.id, jobId));
    };
  };
  await assert.rejects(
    processJobCostExport(staleApproval.export.id, { allowSubmit: true }),
    /changed/,
  );
  assert.equal(writes.length, 3);
  assert.equal(readCount, 1);
  await cancelJobCost(staleApproval.export.id, connectionId, actor);
  const correctionPreview = await prepareJobCost(
      "labor",
      stale.id,
      staleChoice as any,
    ),
    correction = await approveJobCost(correctionPreview, actor);
  rejectOnce = true;
  await assert.rejects(
    processJobCostExport(correction.export.id, { allowSubmit: true }),
    /rejected this request/,
  );
  assert.equal(
    (
      await db
        .select()
        .from(quickbooksJobCostExportsTable)
        .where(eq(quickbooksJobCostExportsTable.id, correction.export.id))
    )[0].state,
    "rejected",
  );
  assert.equal(writes.length, 3);
  const fresh = await approveJobCost(
    await prepareJobCost("labor", stale.id, staleChoice as any),
    actor,
  );
  assert.notEqual(fresh.export.id, correction.export.id);
  assert.equal(
    (await processJobCostExport(fresh.export.id, { allowSubmit: true }))
      .outcome,
    "confirmed",
  );
  assert.equal(writes.length, 4);
  await db
    .update(jobDocumentsTable)
    .set({ sha256: "1".repeat(64) })
    .where(eq(jobDocumentsTable.id, documentIds[3]));
  await receipt(3).then(
    () =>
      assert.fail(
        "An uploaded clone must not create another expense for the same receipt",
      ),
    (error) => assert.match(String(error), /already|in use|identifier/i),
  );
  const blockedVendor = await configure(laborIds[3], "Vendor"),
    blockedChoice = selection(blockedVendor.revision),
    blockedPreview = await prepareJobCost(
      "labor",
      blockedVendor.id,
      blockedChoice as any,
    );
  const blockedApproval = await approveJobCost(blockedPreview, actor);
  await receipt(2, {
    kind: "contractor_bill",
    category: "labor",
    amountCents: 5000,
    taxCents: 0,
    dueDate: "2026-12-01",
    relatedLaborEntryId: blockedVendor.id,
  }).then(
    () =>
      assert.fail("Known TimeActivity cost cannot also become a linked Bill"),
    (error) => assert.match(String(error), /approved|expected|409/i),
  );
  const priorConnectionId = connectionId;
  connectionId = randomUUID();
  connectionIds.push(connectionId);
  await db
    .update(quickbooksConnectionsTable)
    .set({ id: connectionId })
    .where(eq(quickbooksConnectionsTable.id, priorConnectionId));
  await assert.rejects(
    processJobCostExport(blockedApproval.export.id, { allowSubmit: true }),
    /fresh owner approval/,
  );
  assert.equal(writes.length, 4);
  await cancelJobCost(blockedApproval.export.id, connectionId, actor);
  await db
    .update(quickbooksConnectionsTable)
    .set({ realmId: "different" })
    .where(eq(quickbooksConnectionsTable.id, connectionId));
  await assert.rejects(
    processJobCostExport(approvals[0].export.id),
    /original QuickBooks company/,
  );
  assert.equal(writes.length, 4);
  console.log("Job accounting PostgreSQL/router/provider simulation passed");
} finally {
  globalThis.fetch = originalFetch;
  const attempts = await db
    .select({ queueId: quickbooksJobCostExportsTable.queueId })
    .from(quickbooksJobCostExportsTable)
    .where(inArray(quickbooksJobCostExportsTable.connectionId, connectionIds));
  await db
    .delete(quickbooksJobCostExportsTable)
    .where(inArray(quickbooksJobCostExportsTable.connectionId, connectionIds));
  if (attempts.length)
    await db.delete(quickbooksSyncJobsTable).where(
      inArray(
        quickbooksSyncJobsTable.id,
        attempts.map((row) => row.queueId),
      ),
    );
  await db
    .delete(jobExpensesTable)
    .where(inArray(jobExpensesTable.receiptDocumentId, documentIds));
  await db
    .delete(laborEntriesTable)
    .where(inArray(laborEntriesTable.id, laborIds));
  await db
    .delete(jobDocumentsTable)
    .where(inArray(jobDocumentsTable.id, documentIds));
  await db
    .delete(quickbooksEntityMappingsTable)
    .where(
      and(
        eq(quickbooksEntityMappingsTable.entityType, "customer"),
        eq(quickbooksEntityMappingsTable.localId, jobId),
        eq(quickbooksEntityMappingsTable.realmId, "777"),
      ),
    );
  await db
    .delete(quickbooksConnectionsTable)
    .where(eq(quickbooksConnectionsTable.id, connectionId));
  await pool.end();
}
function sqlIncrement() {
  return sql`${jobsTable.revision}+1`;
}
import { sql } from "drizzle-orm";
