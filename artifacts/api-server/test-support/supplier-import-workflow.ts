/** Actual app/auth/tenant/PostgreSQL; every provider request is blocked. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db, pool, usersTable, closeWorkspaceConnections } from "@workspace/db";
import { inWorkspace, workspaceConfigs } from "@workspace/db/workspace";
import { hashPassword } from "../src/lib/auth";
import app from "../src/app";
import type {
  SupplierImportBatch,
  SupplierImportDecision,
} from "@workspace/domain";
assert.equal(workspaceConfigs.length, 2);
for (const workspace of workspaceConfigs) {
  const url = new URL(workspace.databaseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.pathname, /^\/supplier_contacts_[a-f0-9]{32}_[ab]$/);
}
const checks: string[] = [];
let unexpectedProviderCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  unexpectedProviderCalls++;
  throw new Error("No provider IO is allowed in supplier importer");
}) as typeof fetch;
const context = <T>(index: number, work: () => Promise<T>) =>
    inWorkspace(workspaceConfigs[index], work),
  password = "Fictional-archive-fixture-password";
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
  expected = 200,
) {
  const response = await (input === undefined
    ? http(actor, method, path)
    : http(actor, method, path).send(input));
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: HTTP${response.status} ${String(response.body?.error ?? "").slice(0, 180)}`,
  );
  return response.body;
}
async function binary(actor: Actor, path: string, expected = 200) {
  const response = await http(actor, "GET", path)
    .buffer(true)
    .parse((res: any, done: any) => {
      const parts: Buffer[] = [];
      res.on("data", (part: Buffer) => parts.push(part));
      res.on("end", () => done(null, Buffer.concat(parts)));
      res.on("error", done);
    });
  assert.equal(response.status, expected, `${path}: HTTP${response.status}`);
  return response;
}
async function login(index: number, role: string) {
  const host = `${index ? "b" : "a"}.supplier.test`,
    response = await request(app)
      .post("/api/auth/login")
      .set("Host", host)
      .set("Origin", "https://" + host)
      .send({ email: `${role}@supplier.example.invalid`, password });
  assert.equal(response.status, 200);
  return {
    host,
    cookie: response.headers["set-cookie"][0].split(";")[0],
    csrf: response.body.csrfToken,
  };
}
const input = (
  batchKey: string,
  csv = "\uFEFFsource_id,name,email,phone,notes\r\n000081,Original Supply,source@example.invalid,000001,=1+1\r\n",
) => ({
  sourceSystem: "fictional-suppliers",
  batchKey,
  fileName: 'Original "invoice" export.csv',
  delimiter: "," as const,
  csv,
});
const path = (batch: SupplierImportBatch, action: string) =>
  `/supplier-imports/${batch.id}/${action}`;
async function approve(
  actor: Actor,
  batch: SupplierImportBatch,
  decisions: SupplierImportDecision[] = batch.rows.map((row) => ({
    line: row.line,
    action: "create",
    note: "Reviewed distinct source supplier",
  })),
) {
  const reviewed = await call(actor, "POST", path(batch, "review"), {
    revision: batch.revision,
    previewFingerprint: batch.previewFingerprint,
    note: "Verified original history; no active records or balances",
    decisions,
  });
  return call(actor, "POST", path(reviewed, "approve"), {
    revision: reviewed.revision,
    reviewFingerprint: reviewed.reviewFingerprint,
    confirmContactsOnly: true,
  }) as Promise<SupplierImportBatch>;
}
const commitBody = (batch: SupplierImportBatch) => ({
  revision: batch.revision,
  approvalId: batch.approval!.id,
  approvalFingerprint: batch.approval!.fingerprint,
  confirmContactsOnly: true,
});
async function coreSnapshot() {
  const result: Record<string, unknown> = {};
  for (const row of (
    await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows) {
    const table = String(row.tablename);
    if (
      table.startsWith("supplier_import_") ||
      table === "suppliers" ||
      table === "audit_events"
    )
      continue;
    assert.match(table, /^[a-z_]+$/);
    result[table] = (
      await pool.query(
        `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
      )
    ).rows;
  }
  return result;
}
try {
  const encoded = await hashPassword(password);
  for (let index = 0; index < 2; index++)
    await context(index, async () => {
      for (const role of [
        "owner",
        "sales",
        "operations",
        "installer",
        "other-owner",
      ])
        await db.insert(usersTable).values({
          id: role,
          email: `${role}@supplier.example.invalid`,
          name: role,
          role: role === "other-owner" ? "owner" : role,
          passwordHash: encoded,
          createdAt: "2026-11-23",
          updatedAt: "2026-11-23",
        });
      await pool.query(
        "INSERT INTO products(id,name,category,unit,supplier,cost,price,quantity_on_hand,created_at,updated_at) VALUES('old-product','Retained product','Other','sqft','Original Supply',1.45,2.90,12,'2026-11-23','2026-11-23')",
      );
      await pool.query(
        "INSERT INTO supplier_product_aliases(id,product_id,supplier,supplier_key,supplier_sku,supplier_sku_key,approved_by,approved_at) VALUES('old-alias','old-product','Original Supply','original supply','000001','000001','owner','2026-11-23')",
      );
      await pool.query(
        "INSERT INTO supplier_buy_prices(id,alias_id,unit,unit_cost,effective_on,source,approved_by,approved_at) VALUES('old-price','old-alias','sqft',1.45,'2026-11-23','Retained approved source','owner','2026-11-23')",
      );
      await pool.query(
        "INSERT INTO customers(id,name,created_at,updated_at) VALUES('old-customer','Retained customer','2026-11-23','2026-11-23')",
      );
      await pool.query(
        "INSERT INTO jobs(id,job_number,customer_name,flooring_type,material_status,priority_level,risk_level,status,actual_revenue,created_at,updated_at) VALUES('old-job','OLD-JOB','Retained customer','Other','Received','Low','Low','In Progress',430.10,'2026-11-23','2026-11-23')",
      );
      await pool.query(
        "INSERT INTO invoices(id,invoice_number,job_id,customer_name,total,paid_amount,balance_amount,status,created_at,updated_at) VALUES('old-invoice','OLD-INV','old-job','Retained customer',430.10,100.01,330.09,'Partial','2026-11-23','2026-11-23')",
      );
    });
  const owner = await login(0, "owner"),
    other = await login(1, "owner"),
    coOwner = await login(0, "other-owner"),
    sales = await login(0, "sales"),
    operations = await login(0, "operations"),
    installer = await login(0, "installer");
  const baseline = await context(0, coreSnapshot),
    otherBaseline = await context(1, coreSnapshot);
  assert.equal(
    (await request(app).get("/api/suppliers").set("Host", owner.host)).status,
    401,
  );
  for (const actor of [sales, operations, installer]) {
    await call(actor, "GET", "/suppliers", undefined, 403);
    await call(actor, "POST", "/suppliers", { name: "Denied" }, 403);
    await call(actor, "GET", "/supplier-imports", undefined, 403);
    await call(
      actor,
      "POST",
      "/supplier-imports/preview",
      input("denied"),
      403,
    );
  }
  for (const role of ["sales", "operations", "installer"]) {
    await call(owner, "POST", "/auth/persona", { role });
    await call(owner, "GET", "/suppliers", undefined, 403);
    await call(
      owner,
      "POST",
      "/supplier-imports/preview",
      input("preview-denied"),
      403,
    );
    await call(owner, "POST", "/auth/persona", { role: null });
  }
  await call(
    { ...owner, csrf: "wrong" },
    "POST",
    "/suppliers",
    { name: "Bad csrf" },
    403,
  );
  await call(
    { ...owner, host: other.host },
    "GET",
    "/suppliers",
    undefined,
    401,
  );
  assert.equal(
    (
      await request(app)
        .get("/api/suppliers")
        .set("Host", "unknown.supplier.test")
    ).status,
    421,
  );
  await call(owner, "GET", "/suppliers?company=other", undefined, 400);
  checks.push(
    "actual owner, role-preview, CSRF and trusted tenant host boundaries deny writes before side effects",
  );
  const beforeReads = await context(0, async () => ({
    core: await coreSnapshot(),
    suppliers: (await pool.query("SELECT count(*)::int n FROM suppliers"))
      .rows[0].n,
    imports: (
      await pool.query("SELECT count(*)::int n FROM supplier_import_batches")
    ).rows[0].n,
  }));
  assert.deepEqual(await call(owner, "GET", "/suppliers"), {
    suppliers: [],
    page: 0,
    hasMore: false,
  });
  await call(owner, "GET", "/supplier-imports");
  const template = await binary(owner, "/supplier-imports/template");
  assert.match(template.headers["content-disposition"], /^attachment;/);
  assert.deepEqual(
    await context(0, async () => ({
      core: await coreSnapshot(),
      suppliers: (await pool.query("SELECT count(*)::int n FROM suppliers"))
        .rows[0].n,
      imports: (
        await pool.query("SELECT count(*)::int n FROM supplier_import_batches")
      ).rows[0].n,
    })),
    beforeReads,
  );
  checks.push(
    "directory, template and saved-import reads never seed supplier or operational data",
  );
  let existing = await call(
    owner,
    "POST",
    "/suppliers",
    {
      name: "Existing Supply",
      email: "retained@example.invalid",
      phone: "000009",
      notes: "Original manual note",
    },
    201,
  );
  await call(owner, "POST", "/suppliers", { name: " EXISTING SUPPLY " }, 409);
  await call(owner, "POST", "/suppliers", { name: "   " }, 400);
  assert.equal(existing.phone, "000009");
  assert.equal(existing.revision, 1);
  checks.push(
    "manual add preserves text contacts and unique trimmed case-insensitive canonical names",
  );
  existing = await call(owner, "PATCH", `/suppliers/${existing.id}`, {
    revision: existing.revision,
    phone: "000008",
  });
  assert.equal(existing.phone, "000008");
  assert.equal(existing.email, "retained@example.invalid");
  await call(
    owner,
    "PATCH",
    `/suppliers/${existing.id}`,
    { revision: 1, email: "lost@example.invalid" },
    409,
  );
  await call(
    owner,
    "PATCH",
    `/suppliers/${existing.id}`,
    { revision: existing.revision, name: "Renamed" },
    400,
  );
  await call(
    owner,
    "PATCH",
    `/suppliers/${existing.id}`,
    { revision: existing.revision, active: false },
    400,
  );
  await call(owner, "DELETE", `/suppliers/${existing.id}`, undefined, 409);
  await call(owner, "POST", `/suppliers/${existing.id}/merge`, {}, 409);
  checks.push(
    "contact edits are revision-checked and cannot rename, delete, merge or change activation through hidden fields",
  );
  existing = await call(owner, "POST", `/suppliers/${existing.id}/activation`, {
    revision: existing.revision,
    active: false,
    reason: "Temporarily unavailable supplier",
  });
  assert.equal(existing.active, false);
  await call(owner, "POST", "/suppliers", { name: "Existing Supply" }, 409);
  assert.equal(
    (await call(owner, "GET", "/suppliers?active=active")).suppliers.length,
    0,
  );
  existing = await call(owner, "POST", `/suppliers/${existing.id}/activation`, {
    revision: existing.revision,
    active: true,
    reason: "Owner reactivated verified supplier",
  });
  assert.equal(existing.active, true);
  checks.push(
    "audited deactivation and reactivation retain canonical identity and do not free a duplicate name",
  );
  const source = input("original"),
    first = (await call(
      owner,
      "POST",
      "/supplier-imports/preview",
      source,
      201,
    )) as SupplierImportBatch;
  assert.equal(first.rows[0].data.sourceId, "000081");
  assert.equal(first.rows[0].data.phone, "000001");
  assert.equal(first.rows[0].data.notes, "=1+1");
  assert.deepEqual(first.rows[0].legacyNames, ["Original Supply"]);
  assert.equal(
    first.sourceSha256,
    createHash("sha256").update(Buffer.from(source.csv, "utf8")).digest("hex"),
  );
  const downloaded = await binary(owner, path(first, "source"));
  assert.deepEqual(downloaded.body, Buffer.from(source.csv, "utf8"));
  assert.match(
    downloaded.headers["content-disposition"],
    /attachment;.*catalyst-supplier-source-v1.csv/,
  );
  assert.equal(
    (await call(owner, "POST", "/supplier-imports/preview", source, 201)).id,
    first.id,
  );
  await call(
    owner,
    "POST",
    "/supplier-imports/preview",
    { ...source, csv: source.csv + "000082,Changed,,,,\r\n" },
    409,
  );
  checks.push(
    "exact UTF8 BOM CRLF source bytes, leading-zero IDs, inert notes and immutable source file identity are preserved",
  );
  await call(
    owner,
    "POST",
    path(first, "review"),
    {
      revision: first.revision,
      previewFingerprint: first.previewFingerprint,
      note: "Reviewed source",
      decisions: [],
    },
    400,
  );
  await call(
    owner,
    "POST",
    path(first, "commit"),
    {
      revision: first.revision,
      approvalId: randomUUID(),
      approvalFingerprint: "a".repeat(64),
      confirmContactsOnly: true,
    },
    409,
  );
  const approved = await approve(owner, first);
  await call(
    owner,
    "POST",
    path(approved, "commit"),
    { ...commitBody(approved), confirmContactsOnly: false },
    400,
  );
  const [committed, replayed] = await Promise.all([
    call(owner, "POST", path(approved, "commit"), commitBody(approved)),
    call(coOwner, "POST", path(approved, "commit"), commitBody(approved)),
  ]);
  assert.deepEqual(committed.result, replayed.result);
  assert.equal(committed.result.created, 1);
  const createdId = committed.result.supplierIds[0];
  checks.push(
    "every row and owner confirmation are required; concurrent exact commit replay creates one supplier and source binding",
  );
  let detail = await call(owner, "GET", `/suppliers/${createdId}`);
  assert.equal(detail.provenance[0].record.sourceData.name, "Original Supply");
  assert.equal(detail.provenance[0].record.supplierSnapshot.phone, "000001");
  const updatedCreated = await call(owner, "PATCH", `/suppliers/${createdId}`, {
    revision: detail.supplier.revision,
    phone: "000002",
  });
  detail = await call(owner, "GET", `/suppliers/${createdId}`);
  assert.equal(detail.supplier.phone, "000002");
  assert.equal(detail.provenance[0].record.supplierSnapshot.phone, "000001");
  checks.push(
    "ordinary contact correction preserves immutable accepted source and original linked contact snapshot",
  );
  const linkBatch = (await call(
    owner,
    "POST",
    "/supplier-imports/preview",
    input(
      "link-new-source",
      "source_id,name,email,phone\n000082,Historical alternate label,new-source@example.invalid,000099",
    ),
    201,
  )) as SupplierImportBatch;
  const linked = await approve(owner, linkBatch, [
    {
      line: 2,
      action: "link",
      supplierId: existing.id,
      supplierRevision: existing.revision,
      note: "Owner explicitly selected existing legal supplier",
    },
  ]);
  const linkResult = await call(
    owner,
    "POST",
    path(linked, "commit"),
    commitBody(linked),
  );
  assert.equal(linkResult.result.linked, 1);
  assert.equal(linkResult.result.created, 0);
  detail = await call(owner, "GET", `/suppliers/${existing.id}`);
  assert.equal(detail.supplier.email, "retained@example.invalid");
  assert.equal(detail.supplier.phone, "000008");
  assert.equal(
    detail.provenance[0].record.sourceData.name,
    "Historical alternate label",
  );
  checks.push(
    "explicit owner link may use a reviewed different source label but never overwrites contacts or creates a SKU or bill alias",
  );
  const collision = (await call(
    owner,
    "POST",
    "/supplier-imports/preview",
    input("name-collision", "source_id,name\n000083, original supply "),
    201,
  )) as SupplierImportBatch;
  await call(
    owner,
    "POST",
    path(collision, "review"),
    {
      revision: collision.revision,
      previewFingerprint: collision.previewFingerprint,
      note: "Do not duplicate",
      decisions: [
        {
          line: 2,
          action: "create",
          note: "Even with a reason duplicate canonical name is blocked",
        },
      ],
    },
    409,
  );
  await call(
    owner,
    "POST",
    path(collision, "review"),
    {
      revision: collision.revision,
      previewFingerprint: collision.previewFingerprint,
      note: "Do not misattribute",
      decisions: [
        {
          line: 2,
          action: "link",
          supplierId: existing.id,
          supplierRevision: existing.revision,
          note: "Wrong supplier must be blocked",
        },
      ],
    },
    409,
  );
  const collisionApproved = await approve(owner, collision, [
    {
      line: 2,
      action: "link",
      supplierId: createdId,
      supplierRevision: updatedCreated.revision,
      note: "Verified same canonical supplier name",
    },
  ]);
  await call(
    owner,
    "POST",
    path(collisionApproved, "commit"),
    commitBody(collisionApproved),
  );
  checks.push(
    "canonical name collisions require the exact active existing supplier, not a duplicate or unrelated linked contact",
  );
  const stale = (await call(
    owner,
    "POST",
    "/supplier-imports/preview",
    input("stale", "source_id,name\n000084,Another historical label"),
    201,
  )) as SupplierImportBatch;
  let staleApproved = await approve(owner, stale, [
    {
      line: 2,
      action: "link",
      supplierId: existing.id,
      supplierRevision: existing.revision,
      note: "Reviewed explicit target identity",
    },
  ]);
  existing = await call(owner, "PATCH", `/suppliers/${existing.id}`, {
    revision: existing.revision,
    notes: "Corrected contact after approval",
  });
  await call(
    owner,
    "POST",
    path(staleApproved, "commit"),
    commitBody(staleApproved),
    409,
  );
  let refreshed = await call(owner, "POST", path(staleApproved, "refresh"), {
    revision: staleApproved.revision,
  });
  assert.equal(refreshed.approval, null);
  staleApproved = await approve(owner, refreshed, [
    {
      line: 2,
      action: "link",
      supplierId: existing.id,
      supplierRevision: existing.revision,
      note: "Reviewed corrected active target",
    },
  ]);
  await call(
    owner,
    "POST",
    path(staleApproved, "commit"),
    commitBody(staleApproved),
  );
  checks.push(
    "arbitrary selected target snapshot and revision are rechecked at commit; changed contacts force a new review and retain old approval",
  );
  const reused = (await call(
    owner,
    "POST",
    "/supplier-imports/preview",
    input("cannot-rebind", "source_id,name\n000081,Different source label"),
    201,
  )) as SupplierImportBatch;
  assert.equal(reused.rows[0].imported?.supplierId, createdId);
  await call(
    owner,
    "POST",
    path(reused, "review"),
    {
      revision: reused.revision,
      previewFingerprint: reused.previewFingerprint,
      note: "Cannot change source binding",
      decisions: [
        {
          line: 2,
          action: "link",
          supplierId: existing.id,
          supplierRevision: existing.revision,
          note: "Attempt source reassignment",
        },
      ],
    },
    409,
  );
  const skipped = await approve(owner, reused, [
    {
      line: 2,
      action: "skip",
      note: "Retain the original supplier source binding",
    },
  ]);
  assert.equal(
    (await call(owner, "POST", path(skipped, "commit"), commitBody(skipped)))
      .result.skipped,
    1,
  );
  checks.push(
    "retained source identities cannot be rebound by a new batch; explicit skipped rows remain auditable",
  );
  const duplicate = (await call(
    owner,
    "POST",
    "/supplier-imports/preview",
    input(
      "duplicate-names",
      "source_id,name\nD1,Double Supply\nD2,DOUBLE SUPPLY",
    ),
    201,
  )) as SupplierImportBatch;
  await call(
    owner,
    "POST",
    path(duplicate, "review"),
    {
      revision: duplicate.revision,
      previewFingerprint: duplicate.previewFingerprint,
      note: "Review duplicate names",
      decisions: duplicate.rows.map((row) => ({
        line: row.line,
        action: "create",
        note: "Two different IDs must not create duplicate names",
      })),
    },
    409,
  );
  const invalid = (await call(
    owner,
    "POST",
    "/supplier-imports/preview",
    input(
      "invalid",
      "source_id,name,email\nBAD,,invalid email\nDUP,One,\nDUP,Two,",
    ),
    201,
  )) as SupplierImportBatch;
  assert.ok(invalid.rows[0].errors.length);
  assert.ok(invalid.rows[1].fileDuplicates.length);
  checks.push(
    "duplicate file names and source IDs, invalid contacts and ambiguous creates remain visible for correction or reasoned skip",
  );
  const rollback = (await call(
      owner,
      "POST",
      "/supplier-imports/preview",
      input(
        "rollback",
        "source_id,name\nATOMIC1,Atomic One\nATOMIC2,Atomic Two",
      ),
      201,
    )) as SupplierImportBatch,
    rollbackApproved = await approve(owner, rollback);
  const supplierCount = await context(
    0,
    async () =>
      (await pool.query("SELECT count(*)::int n FROM suppliers")).rows[0].n,
  );
  await context(0, () =>
    pool.query(
      "CREATE FUNCTION supplier_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_id='ATOMIC2' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER supplier_fixture_fail BEFORE INSERT ON supplier_import_records FOR EACH ROW EXECUTE FUNCTION supplier_fixture_fail();",
    ),
  );
  await call(
    owner,
    "POST",
    path(rollbackApproved, "commit"),
    commitBody(rollbackApproved),
    500,
  );
  assert.equal(
    await context(
      0,
      async () =>
        (await pool.query("SELECT count(*)::int n FROM suppliers")).rows[0].n,
    ),
    supplierCount,
  );
  assert.equal(
    (await call(owner, "GET", `/supplier-imports/${rollback.id}`)).status,
    "approved",
  );
  await context(0, () =>
    pool.query(
      "DROP TRIGGER supplier_fixture_fail ON supplier_import_records; DROP FUNCTION supplier_fixture_fail();",
    ),
  );
  assert.equal(
    (
      await call(
        owner,
        "POST",
        path(rollbackApproved, "commit"),
        commitBody(rollbackApproved),
      )
    ).result.created,
    2,
  );
  checks.push(
    "a late source-binding failure atomically rolls back all new suppliers and audit changes; exact original approval can safely retry",
  );
  await call(other, "GET", `/suppliers/${createdId}`, undefined, 404);
  await call(other, "GET", `/supplier-imports/${first.id}`, undefined, 404);
  await binary(other, path(first, "source"), 404);
  const foreign = (await call(
    other,
    "POST",
    "/supplier-imports/preview",
    input("foreign-link", "source_id,name\nF1,Foreign target"),
    201,
  )) as SupplierImportBatch;
  await call(
    other,
    "POST",
    path(foreign, "review"),
    {
      revision: foreign.revision,
      previewFingerprint: foreign.previewFingerprint,
      note: "Foreign ID refused",
      decisions: [
        {
          line: 2,
          action: "link",
          supplierId: createdId,
          supplierRevision: 1,
          note: "Foreign company target must fail",
        },
      ],
    },
    409,
  );
  checks.push(
    "source downloads, target IDs and contacts remain isolated to the authenticated company database",
  );
  const racers = await Promise.all(
    ["race-one", "race-two"].map(async (key, index) =>
      approve(
        owner,
        await call(
          owner,
          "POST",
          "/supplier-imports/preview",
          input(key, `source_id,name\nRACE${index},Racing Supply`),
          201,
        ),
      ),
    ),
  );
  const raceResults = await Promise.all(
    racers.map((batch) =>
      http(owner, "POST", path(batch, "commit")).send(commitBody(batch)),
    ),
  );
  assert.deepEqual(raceResults.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    await context(
      0,
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM suppliers WHERE name_key='racing supply'",
          )
        ).rows[0].n,
    ),
    1,
  );
  checks.push(
    "concurrent separate source batches cannot create duplicate canonical supplier identities",
  );
  const quoteCell = '"' + '""'.repeat(2000) + '"';
  const large =
    "source_id,name,notes\n" +
    Array.from(
      { length: 200 },
      (_, i) => `L${i},Bounded Supplier ${i},${quoteCell}`,
    ).join("\n");
  assert.ok(Buffer.byteLength(large) < 1048576);
  assert.ok(Buffer.byteLength(JSON.stringify(input("large", large))) > 1048576);
  assert.equal(
    (
      await call(
        owner,
        "POST",
        "/supplier-imports/preview",
        input("large", large),
        201,
      )
    ).rows.length,
    200,
  );
  await call(
    owner,
    "POST",
    "/supplier-imports/preview",
    input("oversize", "source_id,name\n1," + "x".repeat(1048576)),
    400,
  );
  await call(
    owner,
    "POST",
    "/suppliers",
    { name: "Large transport", notes: "x".repeat(1048577) },
    413,
  );
  checks.push(
    "bounded UTF8 source and row count work through supplier-only escaped JSON transport; ordinary JSON limits remain unchanged",
  );
  await context(0, async () => {
    for (const [table, field, id] of [
      ["supplier_import_records", "source_id", detail.provenance[0].record.id],
      ["supplier_import_approvals", "review_note", approved.approval!.id],
      ["supplier_import_batches", "source_csv", first.id],
    ])
      await assert.rejects(
        pool.query(`UPDATE ${table} SET ${field}='tampered' WHERE id=$1`, [id]),
        /immutable/,
      );
    await assert.rejects(
      pool.query("DELETE FROM suppliers WHERE id=$1", [existing.id]),
      /deactivate/,
    );
    await assert.rejects(
      pool.query("UPDATE suppliers SET name='Changed' WHERE id=$1", [
        existing.id,
      ]),
      /Canonical supplier/,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM audit_events WHERE action='supplier_import.committed' AND entity_id=$1",
          [first.id],
        )
      ).rows[0].n,
      1,
    );
  });
  checks.push(
    "accepted sources, approvals and bindings remain immutable; retained directory identity has actionable delete and rename guards",
  );
  assert.deepEqual(await context(0, coreSnapshot), baseline);
  assert.deepEqual(await context(1, coreSnapshot), otherBaseline);
  assert.equal(unexpectedProviderCalls, 0);
  checks.push(
    "all pre-existing financial, stock, product, supplier-alias, customer, communications and auth records remain exact; provider calls zero",
  );
  console.log(
    JSON.stringify({
      supplierImport: "passed",
      checks,
      unexpectedProviderCalls,
      nonSupplierRecordsChanged: false,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  await closeWorkspaceConnections();
}
