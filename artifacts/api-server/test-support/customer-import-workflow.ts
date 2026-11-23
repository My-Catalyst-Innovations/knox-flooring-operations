/** Fictional fixtures only. Actual tenant selection, auth, owner routes and PostgreSQL. */
import assert from "node:assert/strict";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  customersTable,
  customerImportApprovalsTable,
  closeWorkspaceConnections,
} from "@workspace/db";
import { inWorkspace, workspaceConfigs } from "@workspace/db/workspace";
import { hashPassword } from "../src/lib/auth";
import app from "../src/app";
import type {
  CustomerImportBatch,
  CustomerImportDecision,
} from "@workspace/domain";
for (const workspace of workspaceConfigs) {
  const url = new URL(workspace.databaseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.pathname, /^\/customer_import_[a-f0-9]{32}_[ab]$/);
}
assert.equal(workspaceConfigs.length, 2);
const checks: string[] = [];
let providerCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  providerCalls++;
  throw new Error(
    "Provider calls are forbidden in customer migration fixtures.",
  );
};
const password = "Fictional-customer-import-fixture-password";
const context = (index: number, work: () => Promise<any>) =>
  inWorkspace(workspaceConfigs[index], work);
type Actor = { host: string; cookie: string; csrf: string };
async function call(
  actor: Actor,
  method: string,
  path: string,
  input?: unknown,
  status = 200,
) {
  let req = (request(app) as any)
    [method.toLowerCase()]("/api" + path)
    .set("Host", actor.host)
    .set("Origin", "https://" + actor.host)
    .set("Cookie", actor.cookie);
  if (method !== "GET") req = req.set("x-csrf-token", actor.csrf);
  if (input !== undefined) req = req.send(input);
  const response = await req;
  assert.equal(
    response.status,
    status,
    JSON.stringify({ path, status: response.status, body: response.body }),
  );
  return response.body;
}
async function login(index: number, role: string): Promise<Actor> {
  const host = `${index ? "b" : "a"}.import.test`;
  const response = await request(app)
    .post("/api/auth/login")
    .set("Host", host)
    .set("Origin", "https://" + host)
    .send({ email: `${role}@fictional.example.invalid`, password });
  assert.equal(response.status, 200);
  return {
    host,
    csrf: response.body.csrfToken,
    cookie: response.headers["set-cookie"][0].split(";")[0],
  };
}
const mapping = {
  sourceId: "ID",
  name: "Name",
  email: "Email",
  address: "Address",
};
const input = (
  batchKey: string,
  rows = "00001,Fictional New Household,new@example.invalid,100 Fictional Lane",
) => ({
  sourceSystem: "fictional-legacy",
  batchKey,
  fileName: "Fictional Customer Records.csv",
  csv:
    "ID,Name,Email,Address,Balance\n" +
    rows
      .split("\n")
      .map((row) => row + ",99999")
      .join("\n"),
  mapping,
});
async function preview(actor: Actor, data: ReturnType<typeof input>) {
  return call(
    actor,
    "POST",
    "/customer-imports/preview",
    data,
    201,
  ) as Promise<CustomerImportBatch>;
}
const path = (batch: CustomerImportBatch, action: string) =>
  `/customer-imports/${batch.id}/${action}`;
async function reviewed(
  actor: Actor,
  batch: CustomerImportBatch,
  decisions: CustomerImportDecision[],
) {
  return call(actor, "POST", path(batch, "review"), {
    revision: batch.revision,
    previewFingerprint: batch.previewFingerprint,
    note: "Owner reviewed fictional migration records",
    decisions,
  }) as Promise<CustomerImportBatch>;
}
async function approved(actor: Actor, batch: CustomerImportBatch) {
  return call(actor, "POST", path(batch, "approve"), {
    revision: batch.revision,
    reviewFingerprint: batch.reviewFingerprint,
    confirm: true,
  }) as Promise<CustomerImportBatch>;
}
const commitBody = (batch: CustomerImportBatch) => ({
  revision: batch.revision,
  approvalId: batch.approval!.id,
  approvalFingerprint: batch.approval!.fingerprint,
});
async function authorize(
  actor: Actor,
  batch: CustomerImportBatch,
  decisions: CustomerImportDecision[],
) {
  return approved(actor, await reviewed(actor, batch, decisions));
}
async function protectedSnapshot() {
  const tables = [
    "jobs",
    "invoices",
    "products",
    "inventory_movements",
    "inventory_reservations",
    "purchase_orders",
    "purchase_receipts",
    "quickbooks_sync_jobs",
    "quickbooks_job_cost_exports",
    "supplier_buy_prices",
    "communications",
  ];
  const result: Record<string, unknown> = {};
  for (const table of tables)
    result[table] = (
      await pool.query(
        `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
      )
    ).rows;
  return result;
}
try {
  for (let index = 0; index < 2; index++)
    await context(index, async () => {
      for (const role of ["owner", "sales"])
        await db.insert(usersTable).values({
          id: `${role}-fixture`,
          email: `${role}@fictional.example.invalid`,
          name: "Fictional migration " + role,
          role,
          active: true,
          passwordHash: await hashPassword(password),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
    });
  const owner = await login(0, "owner"),
    otherOwner = await login(1, "owner"),
    sales = await login(0, "sales");
  await request(app)
    .post("/api/customer-imports/inspect")
    .set("Host", owner.host)
    .set("Origin", "https://b.import.test")
    .set("Cookie", owner.cookie)
    .set("x-csrf-token", owner.csrf)
    .send({ csv: "ID,Name\n1,Fictional" })
    .expect(403);
  await request(app)
    .get("/api/customer-imports")
    .set("Host", "unknown.import.test")
    .expect(421);
  checks.push(
    "actual Host and Origin company boundaries reject cross-site requests",
  );
  await request(app)
    .get("/api/customer-imports")
    .set("Host", owner.host)
    .expect(401);
  await call(sales, "GET", "/customer-imports", undefined, 403);
  await call(
    sales,
    "POST",
    "/customer-imports/inspect",
    { csv: "ID,Name\n1,Fictional" },
    403,
  );
  await request(app)
    .post("/api/customer-imports/inspect")
    .set("Host", owner.host)
    .set("Cookie", owner.cookie)
    .send({ csv: "ID,Name\n1,Fictional" })
    .expect(403);
  checks.push("real authentication, owner-only access and CSRF");
  await call(owner, "POST", "/auth/persona", { role: "sales" });
  await call(owner, "GET", "/customer-imports", undefined, 403);
  await call(owner, "POST", "/auth/persona", { role: null });
  checks.push("owner role preview cannot approve imports");
  await context(0, async () => {
    await pool.query(
      "INSERT INTO jobs (id,job_number,customer_name,address,city,flooring_type,material_status,priority_level,risk_level,status,share_token,est_revenue,created_at,updated_at) VALUES ('fictional-history-job','FICTIONAL-100','Fictional historical household','Historical fictional address','Knoxville','Tile','Ordered','Medium','Low','Scheduled','fictional-history-token',900,'2020-01-01','2020-01-01')",
    );
    await pool.query(
      "INSERT INTO invoices (id,invoice_number,job_id,customer_name,total,paid_amount,balance_amount,status,created_at,updated_at) VALUES ('fictional-history-invoice','FICTIONAL-I-100','fictional-history-job','Fictional historical household',900,100,800,'Partial','2020-01-01','2020-01-01')",
    );
    await pool.query(
      "INSERT INTO products (id,name,category,unit,cost,price,quantity_on_hand,created_at,updated_at) VALUES ('fictional-history-product','Fictional historical material','Tile','sqft',2,4,17,'2020-01-01','2020-01-01')",
    );
  });
  const protectedBefore = await context(0, protectedSnapshot);
  const initial = await preview(owner, input("fictional-first"));
  assert.equal(initial.rows[0].data.sourceId, "00001");
  assert.equal((await call(owner, "GET", "/customers")).length, 0);
  assert.equal(initial.approval, null);
  checks.push("preview preserves source IDs without creating customers");
  await call(
    owner,
    "POST",
    path(initial, "review"),
    {
      revision: initial.revision,
      previewFingerprint: "f".repeat(64),
      note: "Fictional owner review",
      decisions: [{ line: 2, action: "create", note: "" }],
    },
    409,
  );
  await call(
    owner,
    "POST",
    path(initial, "review"),
    {
      revision: initial.revision,
      previewFingerprint: initial.previewFingerprint,
      note: "Fictional owner review",
      decisions: [],
      customer: { name: "Tampered" },
    },
    400,
  );
  await call(
    owner,
    "POST",
    path(initial, "approve"),
    {
      revision: initial.revision,
      reviewFingerprint: "a".repeat(64),
      confirm: true,
    },
    409,
  );
  checks.push(
    "tampered preview, unexpected fields and unreviewed approval refused",
  );
  const first = await authorize(owner, initial, [
    { line: 2, action: "create", note: "" },
  ]);
  await call(
    owner,
    "POST",
    path(first, "commit"),
    { ...commitBody(first), approvalFingerprint: "f".repeat(64) },
    409,
  );
  const commits = await Promise.all([
    call(owner, "POST", path(first, "commit"), commitBody(first)),
    call(owner, "POST", path(first, "commit"), commitBody(first)),
  ]);
  assert.deepEqual(commits[0].result, commits[1].result);
  assert.equal(commits[0].result.created, 1);
  const importedId = commits[0].result.customerIds[0];
  assert.equal((await call(owner, "GET", "/customers")).length, 1);
  const sites = await call(owner, "GET", `/customers/${importedId}/sites`);
  assert.equal(sites[0].address, "100 Fictional Lane");
  checks.push("concurrent exact approval commit creates one customer and site");
  assert.deepEqual(
    (await preview(owner, input("fictional-first"))).result,
    commits[0].result,
  );
  await call(
    owner,
    "POST",
    "/customer-imports/preview",
    {
      ...input("fictional-first"),
      csv: input("fictional-first").csv.replace(
        "Fictional New",
        "Changed Fictional",
      ),
    },
    409,
  );
  checks.push(
    "batch replay is durable and changed files cannot reuse batch identity",
  );
  const existing = await call(
    owner,
    "POST",
    "/customers",
    {
      name: "Fictional Existing Household",
      email: "existing@example.invalid",
      notes: "Keep existing original details",
    },
    201,
  );
  const dup = await preview(
    owner,
    input(
      "fictional-link",
      "00002,Fictional Existing Household,existing@example.invalid,",
    ),
  );
  assert.equal(dup.rows[0].candidates[0].id, existing.id);
  await call(
    owner,
    "POST",
    path(dup, "review"),
    {
      revision: dup.revision,
      previewFingerprint: dup.previewFingerprint,
      note: "Fictional duplicate review",
      decisions: [{ line: 2, action: "create", note: "" }],
    },
    400,
  );
  const linked = await authorize(owner, dup, [
    {
      line: 2,
      action: "link",
      customerId: existing.id,
      customerRevision: existing.revision,
      note: "Same fictional contact confirmed by owner",
    },
  ]);
  await call(owner, "POST", path(linked, "commit"), commitBody(linked));
  assert.deepEqual(
    await call(owner, "GET", `/customers/${existing.id}`),
    existing,
  );
  checks.push(
    "duplicate links are explicit and never overwrite customer details",
  );
  const stale = await authorize(
    owner,
    await preview(
      owner,
      input(
        "fictional-stale",
        "00003,Fictional Future Duplicate,future@example.invalid,",
      ),
    ),
    [{ line: 2, action: "create", note: "" }],
  );
  await call(
    owner,
    "POST",
    "/customers",
    { name: "Fictional Future Duplicate", email: "future@example.invalid" },
    201,
  );
  await call(owner, "POST", path(stale, "commit"), commitBody(stale), 409);
  const refreshed = await call(owner, "POST", path(stale, "refresh"), {
    revision: stale.revision,
  });
  assert.equal(refreshed.status, "preview");
  assert.equal(refreshed.approval, null);
  const savedApproval = await context(
    0,
    async () =>
      (
        await db
          .select()
          .from(customerImportApprovalsTable)
          .where(eq(customerImportApprovalsTable.id, stale.approval!.id))
      )[0],
  );
  assert.equal(savedApproval.fingerprint, stale.approval!.fingerprint);
  checks.push(
    "new duplicates invalidate commit; refresh preserves original immutable approval",
  );
  const pendingMerge = await preview(
    owner,
    input(
      "fictional-pending-merge",
      "00005,Fictional New Household,new@example.invalid,",
    ),
  );
  const pendingMergeApproved = await authorize(owner, pendingMerge, [
    {
      line: 2,
      action: "link",
      customerId: importedId,
      customerRevision: 1,
      note: "Owner reviewed original fictional contact",
    },
  ]);
  const merged = await call(owner, "POST", `/customers/${importedId}/merge`, {
    targetId: existing.id,
    revision: 1,
  });
  assert.equal(merged.customer.id, existing.id);
  await call(
    owner,
    "POST",
    path(pendingMergeApproved, "commit"),
    commitBody(pendingMergeApproved),
    409,
  );
  const mergeRefreshed = await call(
    owner,
    "POST",
    path(pendingMergeApproved, "refresh"),
    { revision: pendingMergeApproved.revision },
  );
  assert.equal(mergeRefreshed.rows[0].candidates[0].id, existing.id);
  const mergeReapproved = await authorize(owner, mergeRefreshed, [
    {
      line: 2,
      action: "link",
      customerId: existing.id,
      customerRevision: existing.revision,
      note: "Retained fictional customer verified after merge",
    },
  ]);
  await call(
    owner,
    "POST",
    path(mergeReapproved, "commit"),
    commitBody(mergeReapproved),
  );
  checks.push(
    "pending links detect merges; retired contact details require explicit retained-record reapproval",
  );
  const provenance = await call(
    owner,
    "GET",
    `/customer-imports/provenance/${existing.id}`,
  );
  assert.ok(
    provenance.records.some(
      (record: any) =>
        record.originalCustomerId === importedId && record.sourceId === "00001",
    ),
  );
  assert.equal(provenance.effectiveCustomerId, existing.id);
  const repeatSource = await preview(owner, input("fictional-after-merge"));
  assert.equal(repeatSource.rows[0].imported?.effectiveCustomerId, existing.id);
  await call(
    owner,
    "POST",
    path(repeatSource, "review"),
    {
      revision: repeatSource.revision,
      previewFingerprint: repeatSource.previewFingerprint,
      note: "Fictional source duplicate",
      decisions: [
        { line: 2, action: "create", note: "Would duplicate old source" },
      ],
    },
    409,
  );
  checks.push(
    "merge preserves original source provenance and forbids recreating its identity",
  );
  const skip = await authorize(owner, repeatSource, [
    {
      line: 2,
      action: "skip",
      note: "Already imported; original identity retained",
    },
  ]);
  const skipped = await call(
    owner,
    "POST",
    path(skip, "commit"),
    commitBody(skip),
  );
  assert.equal(skipped.result.skipped, 1);
  assert.equal(skipped.result.created, 0);
  checks.push("reviewed skip is durable without duplicating source aliases");
  const invalidRows = await preview(
    owner,
    input(
      "fictional-correct-and-skip",
      "00006,Fictional Reviewed Household,reviewed@example.invalid,\n00007,Fictional Invalid Email,not-an-email,",
    ),
  );
  assert.ok(invalidRows.rows[1].errors.length);
  const invalidApproved = await authorize(owner, invalidRows, [
    { line: 2, action: "create", note: "" },
    {
      line: 3,
      action: "skip",
      note: "Invalid fictional email will be corrected separately",
    },
  ]);
  const invalidCommit = await call(
    owner,
    "POST",
    path(invalidApproved, "commit"),
    commitBody(invalidApproved),
  );
  assert.equal(invalidCommit.result.created, 1);
  assert.equal(invalidCommit.result.skipped, 1);
  checks.push(
    "invalid rows require explicit skip while reviewed valid rows can commit",
  );
  const rollbackBatch = await authorize(
    owner,
    await preview(
      owner,
      input(
        "fictional-rollback",
        "ROLLBACK-ONE,Fictional Atomic First,atomic-first@example.invalid,\nFAIL-ROLLBACK,Fictional Atomic Second,atomic-second@example.invalid,",
      ),
    ),
    [
      { line: 2, action: "create", note: "" },
      { line: 3, action: "create", note: "" },
    ],
  );
  const customersBeforeRollback = await call(owner, "GET", "/customers");
  await context(0, async () => {
    await pool.query(
      "ALTER TABLE customer_import_records ADD CONSTRAINT fictional_atomic_failure CHECK (source_id <> 'FAIL-ROLLBACK')",
    );
  });
  try {
    await call(
      owner,
      "POST",
      path(rollbackBatch, "commit"),
      commitBody(rollbackBatch),
      500,
    );
    assert.deepEqual(
      await call(owner, "GET", "/customers"),
      customersBeforeRollback,
    );
    assert.equal(
      (await call(owner, "GET", `/customer-imports/${rollbackBatch.id}`))
        .status,
      "approved",
    );
  } finally {
    await context(0, async () => {
      await pool.query(
        "ALTER TABLE customer_import_records DROP CONSTRAINT fictional_atomic_failure",
      );
    });
  }
  checks.push(
    "a real mid-transaction constraint failure rolls back all customer and source writes",
  );
  const raceRows = "00004,Fictional Concurrent Identity,race@example.invalid,";
  const raceA = await authorize(
    owner,
    await preview(owner, input("fictional-race-a", raceRows)),
    [{ line: 2, action: "create", note: "" }],
  );
  const raceB = await authorize(
    owner,
    await preview(owner, input("fictional-race-b", raceRows)),
    [{ line: 2, action: "create", note: "" }],
  );
  const race = await Promise.all([
    request(app)
      .post("/api" + path(raceA, "commit"))
      .set("Host", owner.host)
      .set("Cookie", owner.cookie)
      .set("x-csrf-token", owner.csrf)
      .send(commitBody(raceA)),
    request(app)
      .post("/api" + path(raceB, "commit"))
      .set("Host", owner.host)
      .set("Cookie", owner.cookie)
      .set("x-csrf-token", owner.csrf)
      .send(commitBody(raceB)),
  ]);
  assert.deepEqual(race.map((result) => result.status).sort(), [200, 409]);
  checks.push(
    "concurrent different batches cannot recreate one source identity",
  );
  await call(
    otherOwner,
    "GET",
    `/customer-imports/${first.id}`,
    undefined,
    404,
  );
  await request(app)
    .get("/api/customer-imports")
    .set("Host", otherOwner.host)
    .set("Cookie", owner.cookie)
    .expect(401);
  const independent = await preview(otherOwner, input("fictional-first"));
  const independentApproval = await authorize(otherOwner, independent, [
    { line: 2, action: "create", note: "" },
  ]);
  const independentCommit = await call(
    otherOwner,
    "POST",
    path(independentApproval, "commit"),
    commitBody(independentApproval),
  );
  assert.notEqual(independentCommit.result.customerIds[0], importedId);
  checks.push(
    "two real tenant databases isolate sessions, batch IDs and source identities",
  );
  const historicNamespace = await preview(
    owner,
    input(
      "fictional-historic-label",
      "HISTORIC-001,Fictional Historic Namespace,historic@example.invalid,",
    ),
  );
  // Simulate an old/default workspace label retained when the same company DB
  // is adopted under a hosted company hostname. No source identities may vanish.
  await context(0, async () => {
    await pool.query(
      "UPDATE customer_import_batches SET workspace_key='historical-default-host' WHERE id=$1",
      [historicNamespace.id],
    );
  });
  assert.equal(
    (await call(owner, "GET", `/customer-imports/${historicNamespace.id}`)).id,
    historicNamespace.id,
  );
  const historicRefresh = await call(
    owner,
    "POST",
    path(historicNamespace, "refresh"),
    { revision: historicNamespace.revision },
  );
  const historicApproved = await authorize(owner, historicRefresh, [
    { line: 2, action: "create", note: "" },
  ]);
  await call(
    owner,
    "POST",
    path(historicApproved, "commit"),
    commitBody(historicApproved),
  );
  const sameSourceNewLabel = await preview(
    owner,
    input(
      "fictional-current-label",
      "HISTORIC-001,Fictional Historic Namespace,historic@example.invalid,",
    ),
  );
  assert.ok(sameSourceNewLabel.rows[0].imported);
  assert.equal(
    (
      await preview(
        owner,
        input(
          "fictional-historic-label",
          "HISTORIC-001,Fictional Historic Namespace,historic@example.invalid,",
        ),
      )
    ).status,
    "committed",
  );
  checks.push(
    "company database identity preserves imports across default or historical workspace labels",
  );
  const busyBatch = await authorize(
    owner,
    await preview(
      owner,
      input(
        "fictional-busy",
        "LOCK-ONE,Fictional Busy Directory,busy@example.invalid,",
      ),
    ),
    [{ line: 2, action: "create", note: "" }],
  );
  const holder = await context(0, async () => pool.connect());
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM customers WHERE id=$1 FOR UPDATE", [
      existing.id,
    ]);
    const busy = await call(
      owner,
      "POST",
      path(busyBatch, "commit"),
      commitBody(busyBatch),
      409,
    );
    assert.match(busy.error, /being edited/);
    assert.equal(
      (await call(owner, "GET", `/customer-imports/${busyBatch.id}`)).status,
      "approved",
    );
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  const afterBusy = await call(
    owner,
    "POST",
    path(busyBatch, "commit"),
    commitBody(busyBatch),
  );
  assert.equal(afterBusy.result.created, 1);
  checks.push(
    "ordinary customer row locks cause bounded safe rollback and the same approved request can resume",
  );
  await context(0, async () => {
    await assert.rejects(
      pool.query(
        "UPDATE customer_import_approvals SET review_note='tampered' WHERE id=$1",
        [first.approval!.id],
      ),
      (error: any) => error.code === "23514",
    );
    await assert.rejects(
      pool.query("DELETE FROM customer_import_records WHERE source_id='00001'"),
      (error: any) => error.code === "23514",
    );
  });
  checks.push(
    "database triggers prohibit approval and source-history rewriting",
  );
  assert.deepEqual(await context(0, protectedSnapshot), protectedBefore);
  assert.equal(providerCalls, 0);
  checks.push(
    "stock, financial documents, export queues and communications unchanged",
  );
  console.log(
    JSON.stringify({ customerMigration: "passed", checks, providerCalls }),
  );
} finally {
  globalThis.fetch = originalFetch;
  await closeWorkspaceConnections();
}
