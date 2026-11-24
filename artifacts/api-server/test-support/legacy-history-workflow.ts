/** Actual app/auth/tenant/PostgreSQL with strictly simulated private Blob only. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db, pool, usersTable, closeWorkspaceConnections } from "@workspace/db";
import { inWorkspace, workspaceConfigs } from "@workspace/db/workspace";
import { hashPassword } from "../src/lib/auth";
import app from "../src/app";
import type {
  LegacyArchiveBatch,
  LegacyArchiveDecision,
} from "@workspace/domain";
assert.equal(workspaceConfigs.length, 2);
for (const workspace of workspaceConfigs) {
  const url = new URL(workspace.databaseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.pathname, /^\/legacy_archive_[a-f0-9]{32}_[ab]$/);
}
const checks: string[] = [],
  blobs = new Map<string, { bytes: Buffer; headers: Record<string, string> }>(),
  calls: { method: string; path: string }[] = [];
let unexpectedProviderCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, options: RequestInit = {}) => {
  const url = new URL(String(input)),
    method = options.method ?? "GET";
  if (url.origin === "http://127.0.0.1:8181")
    return Response.json({
      access_token: "synthetic-archive-storage",
      expires_on: Math.floor(Date.now() / 1000) + 3600,
    });
  if (url.origin !== "https://fixtureaccount.blob.core.windows.net") {
    unexpectedProviderCalls++;
    throw new Error("Unexpected provider in archived history fixture");
  }
  calls.push({ method, path: url.pathname });
  if (method === "PUT") {
    const headers = new Headers(options.headers);
    assert.equal(headers.get("If-None-Match"), "*");
    assert.equal(blobs.has(url.pathname), false);
    blobs.set(url.pathname, {
      bytes: Buffer.from(options.body as Uint8Array),
      headers: Object.fromEntries(headers),
    });
    return new Response(null, { status: 201 });
  }
  const blob = blobs.get(url.pathname);
  if (!blob)
    return new Response(null, {
      status: 404,
      headers: { "x-ms-error-code": "BlobNotFound" },
    });
  if (method === "HEAD") return new Response(null, { headers: blob.headers });
  assert.equal(method, "GET");
  return new Response(blob.bytes, {
    headers: { ...blob.headers, "content-length": String(blob.bytes.length) },
  });
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
  const host = `${index ? "b" : "a"}.archive.test`,
    response = await request(app)
      .post("/api/auth/login")
      .set("Host", host)
      .set("Origin", "https://" + host)
      .send({ email: `${role}@archive.example.invalid`, password });
  assert.equal(response.status, 200);
  return {
    host,
    cookie: response.headers["set-cookie"][0].split(";")[0],
    csrf: response.body.csrfToken,
  };
}
const input = (
  batchKey: string,
  csv = "\uFEFFsource_id,type,title,reference,party_name,occurred_on,status,summary\r\n000081,invoice,Original invoice,000123,Original party,,Paid,Original total $4.46\r\n000082,quote,=1+1,000124,Original party,2026-01-02,Draft,Historical quoted text\r\n",
) => ({
  sourceSystem: "fictional-legacy",
  batchKey,
  fileName: 'Original "invoice" export.csv',
  delimiter: "," as const,
  csv,
});
const path = (batch: LegacyArchiveBatch, action: string) =>
  `/legacy-history/imports/${batch.id}/${action}`;
async function approve(
  actor: Actor,
  batch: LegacyArchiveBatch,
  decisions: LegacyArchiveDecision[] = batch.rows.map((row) => ({
    line: row.line,
    action: "archive",
    note: "",
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
    confirmReadOnly: true,
  }) as Promise<LegacyArchiveBatch>;
}
const commitBody = (batch: LegacyArchiveBatch) => ({
  revision: batch.revision,
  approvalId: batch.approval!.id,
  approvalFingerprint: batch.approval!.fingerprint,
  confirmReadOnly: true,
});
async function coreSnapshot() {
  const result: Record<string, unknown> = {};
  for (const row of (
    await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows) {
    const table = String(row.tablename);
    if (table.startsWith("legacy_archive_") || table === "audit_events")
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
const pdf = Buffer.from(
  "%PDF-1.7\nFictional historical original. No live customer data.\n%%EOF",
);
async function upload(
  actor: Actor,
  recordId: string,
  name = "Original invoice.pdf",
  bytes = pdf,
  expected = 201,
) {
  const response = await http(
    actor,
    "POST",
    `/storage/files/legacy-document?recordId=${encodeURIComponent(recordId)}`,
  )
    .set("Content-Type", "application/octet-stream")
    .set("x-file-name", encodeURIComponent(name))
    .send(bytes);
  assert.equal(
    response.status,
    expected,
    `upload HTTP${response.status} ${response.body?.error ?? ""}`,
  );
  return response.body.objectPath as string;
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
          email: `${role}@archive.example.invalid`,
          name: role,
          role: role === "other-owner" ? "owner" : role,
          passwordHash: encoded,
          createdAt: "2026-11-23",
          updatedAt: "2026-11-23",
        });
      await pool.query(
        "INSERT INTO customers(id,name,created_at,updated_at) VALUES('retained-customer','Retained active customer','2026-11-23','2026-11-23')",
      );
      await pool.query(
        "INSERT INTO jobs(id,job_number,customer_id,customer_name,flooring_type,material_status,priority_level,risk_level,status,actual_revenue,created_at,updated_at) VALUES('retained-job','ACTIVE-1','retained-customer','Retained active customer','Tile','Received','Low','Low','In Progress',430.10,'2026-11-23','2026-11-23')",
      );
      await pool.query(
        "INSERT INTO invoices(id,invoice_number,job_id,customer_name,total,paid_amount,balance_amount,status,created_at,updated_at) VALUES('retained-invoice','ACTIVE-1','retained-job','Retained active customer',430.10,100.01,330.09,'Partial','2026-11-23','2026-11-23')",
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
    (await request(app).get("/api/legacy-history").set("Host", owner.host))
      .status,
    401,
  );
  for (const actor of [sales, operations, installer]) {
    await call(actor, "GET", "/legacy-history", undefined, 403);
    await call(
      actor,
      "POST",
      "/legacy-history/imports/preview",
      input("denied"),
      403,
    );
    await upload(actor, randomUUID(), "Original.pdf", pdf, 403);
  }
  for (const role of ["sales", "operations", "installer"]) {
    await call(owner, "POST", "/auth/persona", { role });
    await call(owner, "GET", "/legacy-history", undefined, 403);
    await call(
      owner,
      "POST",
      "/legacy-history/imports/preview",
      input("preview-denied"),
      403,
    );
    await call(owner, "POST", "/auth/persona", { role: null });
  }
  await call(owner, "GET", "/legacy-history?company=other", undefined, 400);
  await call(
    { ...owner, host: other.host },
    "GET",
    "/legacy-history",
    undefined,
    401,
  );
  assert.equal(
    (
      await request(app)
        .get("/api/legacy-history")
        .set("Host", "unknown.archive.test")
    ).status,
    421,
  );
  checks.push(
    "real owner cookie/CSRF, preview roles, installer storage and exact tenant host boundaries",
  );
  const beforeReads = await context(0, async () => ({
    tables: await coreSnapshot(),
    batches: (
      await pool.query("SELECT count(*)::int n FROM legacy_archive_batches")
    ).rows[0].n,
  }));
  assert.deepEqual(await call(owner, "GET", "/legacy-history"), {
    records: [],
    hasMore: false,
    page: 0,
  });
  assert.deepEqual(await call(owner, "GET", "/legacy-history/imports"), []);
  const template = await binary(owner, "/legacy-history/template");
  assert.match(template.headers["content-disposition"], /^attachment;/);
  assert.match(template.body.toString("utf8"), /^source_id,type,title,/);
  assert.deepEqual(
    await context(0, async () => ({
      tables: await coreSnapshot(),
      batches: (
        await pool.query("SELECT count(*)::int n FROM legacy_archive_batches")
      ).rows[0].n,
    })),
    beforeReads,
  );
  checks.push(
    "opening/search/template reads never seed or alter business/archive records",
  );
  const source = input("original-source"),
    first = (await call(
      owner,
      "POST",
      "/legacy-history/imports/preview",
      source,
      201,
    )) as LegacyArchiveBatch;
  assert.equal(first.rows[0].data.sourceId, "000081");
  assert.equal(first.rows[0].data.reference, "000123");
  assert.equal(first.rows[0].data.occurredOn, null);
  assert.equal(first.rows[1].data.title, "=1+1");
  assert.equal(
    first.sourceSha256,
    createHash("sha256").update(Buffer.from(source.csv, "utf8")).digest("hex"),
  );
  const downloadedSource = await binary(owner, path(first, "source"));
  assert.deepEqual(downloadedSource.body, Buffer.from(source.csv, "utf8"));
  assert.match(
    downloadedSource.headers["content-disposition"],
    /catalyst-legacy-source-v1.csv/,
  );
  assert.equal(
    downloadedSource.headers["content-type"].split(";")[0],
    "application/octet-stream",
  );
  assert.equal(
    (await call(owner, "POST", "/legacy-history/imports/preview", source, 201))
      .id,
    first.id,
  );
  await call(
    owner,
    "POST",
    "/legacy-history/imports/preview",
    { ...source, csv: source.csv + "000083,job,Changed,,,,,\r\n" },
    409,
  );
  checks.push(
    "UTF8 BOM/CRLF source bytes, leading-zero IDs, inert formulas, unknown dates and immutable source identity",
  );
  const quoteCell = '"' + '""'.repeat(2000) + '"';
  const large =
    "source_id,type,title,summary\n" +
    Array.from(
      { length: 200 },
      (_, index) => `large-${index},other,Historical,${quoteCell}`,
    ).join("\n");
  assert.ok(Buffer.byteLength(large) < 1048576);
  assert.ok(
    Buffer.byteLength(JSON.stringify(input("escaped-large", large))) > 1048576,
  );
  const largeBatch = await call(
    owner,
    "POST",
    "/legacy-history/imports/preview",
    input("escaped-large", large),
    201,
  );
  assert.equal(largeBatch.rows.length, 200);
  assert.ok(largeBatch.rows.every((row: any) => row.errors.length === 0));
  await call(
    owner,
    "POST",
    "/legacy-history/imports/preview",
    input("too-large", "source_id,type,title\n1,other," + "x".repeat(1048576)),
    400,
  );
  assert.equal(
    (
      await http(owner, "POST", "/customers").send({
        name: "Too large",
        notes: "x".repeat(1100000),
      })
    ).status,
    413,
  );
  checks.push(
    "source1MiB/200row bounds work through the narrow3MiB escaped JSON transport; other API limits unchanged",
  );
  await call(
    { ...owner, csrf: "wrong" },
    "POST",
    path(first, "review"),
    {},
    403,
  );
  await call(
    owner,
    "POST",
    path(first, "commit"),
    {
      revision: first.revision,
      approvalId: randomUUID(),
      approvalFingerprint: "0".repeat(64),
      confirmReadOnly: true,
    },
    409,
  );
  await call(
    owner,
    "POST",
    path(first, "review"),
    {
      revision: first.revision,
      previewFingerprint: first.previewFingerprint,
      note: "Verified source",
      decisions: first.rows.map((row) => ({
        line: row.line,
        action: "archive",
        note: "",
        customerId: "retained-customer",
      })),
    },
    400,
  );
  let approved = await approve(owner, first);
  await call(
    owner,
    "POST",
    path(approved, "commit"),
    { ...commitBody(approved), confirmReadOnly: false },
    400,
  );
  await call(
    owner,
    "POST",
    path(approved, "commit"),
    { ...commitBody(approved), approvalFingerprint: "f".repeat(64) },
    409,
  );
  const committed = await Promise.all([
    call(owner, "POST", path(approved, "commit"), commitBody(approved)),
    call(owner, "POST", path(approved, "commit"), commitBody(approved)),
  ]);
  assert.deepEqual(committed[0].result, committed[1].result);
  assert.equal(committed[0].result.archived, 2);
  checks.push(
    "explicit exact owner review/approval/read-only confirmation, source-only fields and concurrent commit replay",
  );
  const recordId = committed[0].result.recordIds[0],
    record = await call(owner, "GET", `/legacy-history/${recordId}`);
  assert.equal(record.record.sourceId, "000081");
  assert.equal(record.batch.sourceSha256, first.sourceSha256);
  assert.equal(record.approval.id, approved.approval!.id);
  assert.deepEqual(record.documents, []);
  const result = await call(
    owner,
    "GET",
    "/legacy-history?q=000081&type=invoice",
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, recordId);
  assert.equal(
    (await call(owner, "GET", "/legacy-history?type=payment")).records.length,
    0,
  );
  const exported = await binary(owner, `/legacy-history/${recordId}/export`),
    json = JSON.parse(exported.body.toString("utf8"));
  assert.equal(json.historicalOnly, true);
  assert.equal(json.activeRecordsCreated, false);
  for (const key of ["jobId", "customerId", "stockMovementId", "balanceAmount"])
    assert.equal(key in json.record, false);
  assert.match(exported.headers["content-disposition"], /^attachment;/);
  checks.push(
    "search/detail/JSON export preserve provenance and never invent active customer/job/balance links",
  );
  await call(other, "GET", `/legacy-history/${recordId}`, undefined, 404);
  await call(
    other,
    "GET",
    `/legacy-history/imports/${first.id}`,
    undefined,
    404,
  );
  await call(
    other,
    "POST",
    path(approved, "commit"),
    commitBody(approved),
    404,
  );
  const otherBatch = await call(
    other,
    "POST",
    "/legacy-history/imports/preview",
    source,
    201,
  );
  const otherApproved = await approve(other, otherBatch);
  const otherCommitted = await call(
    other,
    "POST",
    path(otherApproved, "commit"),
    commitBody(otherApproved),
  );
  assert.equal(otherCommitted.result.archived, 2);
  assert.notEqual(otherCommitted.result.recordIds[0], recordId);
  checks.push(
    "same source IDs and batch keys remain isolated in two real company databases",
  );
  const conflict = (await call(
    owner,
    "POST",
    "/legacy-history/imports/preview",
    input(
      "changed-history",
      source.csv.replace("Original invoice", "Changed invoice"),
    ),
    201,
  )) as LegacyArchiveBatch;
  assert.equal(conflict.rows[0].existing?.id, recordId);
  await call(
    owner,
    "POST",
    path(conflict, "review"),
    {
      revision: conflict.revision,
      previewFingerprint: conflict.previewFingerprint,
      note: "Try replacing history",
      decisions: conflict.rows.map((row) => ({
        line: row.line,
        action: "archive",
        note: "",
      })),
    },
    409,
  );
  const skipped = await approve(
    owner,
    conflict,
    conflict.rows.map((row) => ({
      line: row.line,
      action: "skip",
      note: "Retain the existing original source identity",
    })),
  );
  const skippedResult = await call(
    owner,
    "POST",
    path(skipped, "commit"),
    commitBody(skipped),
  );
  assert.deepEqual(skippedResult.result, {
    archived: 0,
    skipped: 2,
    recordIds: [],
  });
  assert.equal(
    (await call(owner, "GET", `/legacy-history/${recordId}`)).record.title,
    "Original invoice",
  );
  checks.push(
    "conflicting source identities cannot overwrite/link; explicit reviewed skips remain durable",
  );
  const bad = (await call(
    owner,
    "POST",
    "/legacy-history/imports/preview",
    input(
      "invalid-rows",
      "source_id,type,title,occurred_on\nDUP,invoice,One,2026-02-30\nDUP,invoice,Two,\nBAD,__proto__,Three,\nZERO,job,No year zero,0000-01-01",
    ),
    201,
  )) as LegacyArchiveBatch;
  assert.ok(bad.rows[0].errors.length);
  assert.ok(bad.rows[0].fileDuplicates.length);
  assert.ok(bad.rows[3].errors.some((error) => /date/.test(error)));
  await call(
    owner,
    "POST",
    path(bad, "review"),
    {
      revision: bad.revision,
      previewFingerprint: bad.previewFingerprint,
      note: "Review invalid records",
      decisions: bad.rows.map((row) => ({
        line: row.line,
        action: "archive",
        note: "",
      })),
    },
    409,
  );
  await call(
    owner,
    "POST",
    path(bad, "review"),
    {
      revision: bad.revision,
      previewFingerprint: bad.previewFingerprint,
      note: "Review invalid records",
      decisions: bad.rows.map((row) => ({
        line: row.line,
        action: "skip",
        note: "",
      })),
    },
    400,
  );
  checks.push(
    "invalid dates/types and duplicate rows need correction or explicit reasoned skips",
  );
  const raceCsv = "source_id,type,title\nRACE,other,One historical source",
    races = await Promise.all(
      ["race-a", "race-b"].map((key) =>
        call(
          owner,
          "POST",
          "/legacy-history/imports/preview",
          input(key, raceCsv),
          201,
        ).then((batch) => approve(owner, batch)),
      ),
    );
  await call(owner, "POST", path(races[0], "commit"), commitBody(races[0]));
  await call(
    owner,
    "POST",
    path(races[1], "commit"),
    commitBody(races[1]),
    409,
  );
  const refreshed = await call(owner, "POST", path(races[1], "refresh"), {
    revision: races[1].revision,
  });
  assert.ok(refreshed.rows[0].existing);
  assert.equal(
    (
      await context(0, () =>
        pool.query(
          "SELECT count(*)::int n FROM legacy_archive_approvals WHERE batch_id=$1",
          [races[1].id],
        ),
      )
    ).rows[0].n,
    1,
  );
  checks.push(
    "new concurrent identities invalidate stale approval and refresh retains immutable original approvals",
  );
  const atomic = await approve(
    owner,
    await call(
      owner,
      "POST",
      "/legacy-history/imports/preview",
      input(
        "atomic",
        "source_id,type,title\nOK-ATOMIC,job,Good\nFAIL-ATOMIC,job,Fail",
      ),
      201,
    ),
  );
  await context(0, () =>
    pool.query(
      "ALTER TABLE legacy_archive_records ADD CONSTRAINT fixture_atomic CHECK (source_id <> 'FAIL-ATOMIC')",
    ),
  );
  try {
    await call(owner, "POST", path(atomic, "commit"), commitBody(atomic), 500);
    assert.equal(
      (
        await context(0, () =>
          pool.query(
            "SELECT count(*)::int n FROM legacy_archive_records WHERE source_id='OK-ATOMIC'",
          ),
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await call(owner, "GET", `/legacy-history/imports/${atomic.id}`)).status,
      "approved",
    );
  } finally {
    await context(0, () =>
      pool.query(
        "ALTER TABLE legacy_archive_records DROP CONSTRAINT fixture_atomic",
      ),
    );
  }
  assert.equal(
    (await call(owner, "POST", path(atomic, "commit"), commitBody(atomic)))
      .result.archived,
    2,
  );
  checks.push(
    "a late database failure rolls back every row/audit/commit and retries the same approved source atomically",
  );
  const writes = () => calls.filter((item) => item.method === "PUT").length;
  const beforeDenied = writes();
  await upload(owner, randomUUID(), "Original.pdf", pdf, 404);
  await upload(
    owner,
    recordId,
    "HTML.svg",
    Buffer.from("<svg>untrusted</svg>"),
    415,
  );
  await upload(owner, recordId, "Mismatched.jpg", pdf, 415);
  await upload(
    owner,
    recordId,
    "Invalid.pdf",
    Buffer.from("%PDF-1.7 incomplete"),
    415,
  );
  await upload(owner, recordId, "../Unsafe.pdf", pdf, 400);
  assert.equal(writes(), beforeDenied);
  const objectPath = await upload(owner, recordId);
  assert.equal((await http(owner, "GET", `/storage${objectPath}`)).status, 404);
  await call(
    owner,
    "POST",
    `/legacy-history/${recordId}/documents`,
    { objectPath, requestKey: randomUUID() },
    400,
  );
  await call(
    owner,
    "POST",
    `/legacy-history/${recordId}/documents`,
    {
      objectPath: "https://example.invalid/private.pdf",
      requestKey: randomUUID(),
      confirmOriginal: true,
    },
    400,
  );
  await call(
    coOwner,
    "POST",
    `/legacy-history/${recordId}/documents`,
    { objectPath, requestKey: randomUUID(), confirmOriginal: true },
    400,
  );
  checks.push(
    "only committed same-company records accept supported-size/type private uploads; arbitrary URLs and foreign uploaders cannot claim them",
  );
  const claim = { objectPath, requestKey: randomUUID(), confirmOriginal: true },
    claimResponses = await Promise.all([
      http(owner, "POST", `/legacy-history/${recordId}/documents`).send(claim),
      http(owner, "POST", `/legacy-history/${recordId}/documents`).send(claim),
    ]);
  assert.deepEqual(
    claimResponses.map((response) => response.status).sort(),
    [200, 201],
  );
  const claims = claimResponses.map((response) => response.body);
  assert.equal(claims[0].id, claims[1].id);
  assert.equal(
    claims[0].sha256,
    createHash("sha256").update(pdf).digest("hex"),
  );
  assert.equal("objectPath" in claims[0], false);
  const doc = claims[0];
  assert.match(
    doc.downloadUrl,
    new RegExp(`^/api/legacy-history/documents/${doc.id}/download$`),
  );
  const downloaded = await binary(coOwner, doc.downloadUrl.slice(4));
  assert.deepEqual(downloaded.body, pdf);
  assert.equal(
    downloaded.headers["content-type"].split(";")[0],
    "application/octet-stream",
  );
  assert.match(downloaded.headers["content-disposition"], /^attachment;/);
  assert.match(downloaded.headers["cache-control"], /no-store/);
  checks.push(
    "original-file explicit confirmation, ownership, immutable checksum, attachment-only co-owner download and concurrent exact claim replay",
  );
  await call(
    owner,
    "POST",
    `/legacy-history/${committed[0].result.recordIds[1]}/documents`,
    claim,
    400,
  );
  const duplicatePath = await upload(owner, recordId);
  await call(
    owner,
    "POST",
    `/legacy-history/${recordId}/documents`,
    {
      objectPath: duplicatePath,
      requestKey: randomUUID(),
      confirmOriginal: true,
    },
    409,
  );
  await call(
    owner,
    "POST",
    `/legacy-history/${recordId}/documents`,
    { ...claim, objectPath: duplicatePath },
    409,
  );
  assert.equal(
    (await call(owner, "GET", `/legacy-history/${recordId}`)).documents.length,
    1,
  );
  checks.push(
    "original request keys cannot change files/record binding and duplicate content never creates an unbound successful replay",
  );
  const beforeForeignReads = calls.filter(
    (item) => item.method === "GET",
  ).length;
  await call(other, "GET", doc.downloadUrl.slice(4), undefined, 404);
  assert.equal(
    calls.filter((item) => item.method === "GET").length,
    beforeForeignReads,
  );
  await call(
    other,
    "POST",
    `/legacy-history/${otherCommitted.result.recordIds[0]}/documents`,
    claim,
    400,
  );
  assert.ok(calls.some((item) => item.path.startsWith("/archive-b-private/")));
  for (const actor of [sales, operations, installer])
    await call(actor, "GET", doc.downloadUrl.slice(4), undefined, 403);
  checks.push(
    "document UUID/path possession, another tenant container and non-owner roles never grant original download access",
  );
  const blob = blobs.get(
    "/archive-a-private/" + objectPath.slice("/objects/".length),
  )!;
  const originalBytes = blob.bytes;
  blob.bytes = Buffer.from("%PDF-1.7\nChanged original content.\n%%EOF");
  await call(owner, "GET", doc.downloadUrl.slice(4), undefined, 409);
  blob.bytes = originalBytes;
  checks.push(
    "changed private bytes fail immutable claim verification before any replacement is streamed",
  );
  await context(0, async () => {
    for (const [table, field, id] of [
      ["legacy_archive_records", "title", recordId],
      ["legacy_archive_approvals", "review_note", approved.approval!.id],
      ["legacy_archive_documents", "name", doc.id],
    ] as const) {
      await assert.rejects(
        pool.query(`UPDATE ${table} SET ${field}='tampered' WHERE id=$1`, [id]),
        /immutable/,
      );
      await assert.rejects(
        pool.query(`DELETE FROM ${table} WHERE id=$1`, [id]),
        /immutable/,
      );
    }
    await assert.rejects(
      pool.query(
        "UPDATE legacy_archive_batches SET source_csv='tampered' WHERE id=$1",
        [first.id],
      ),
      /immutable/,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM audit_events WHERE action='legacy_archive.original_attached' AND entity_id=$1",
          [recordId],
        )
      ).rows[0].n,
      1,
    );
  });
  checks.push(
    "accepted records, approvals, sources and document claims are immutable with one durable accepted-file audit",
  );
  assert.deepEqual(await context(0, coreSnapshot), baseline);
  assert.deepEqual(await context(1, coreSnapshot), otherBaseline);
  assert.equal(unexpectedProviderCalls, 0);
  checks.push(
    "all original operational/financial/stock/customer/supplier/auth tables remain identical; no accounting/calendar/message provider called",
  );
  console.log(
    JSON.stringify({
      legacyHistory: "passed",
      checks,
      unexpectedProviderCalls,
      activeRecordsChanged: false,
      simulatedBlobWrites: writes(),
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  await closeWorkspaceConnections();
}
