/** Actual disposable PostgreSQL routes + simulated private Azure Blob only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { db, pool, jobsTable, tasksTable, jobPhotosTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import installerBoundary from "../src/routes/installer-access";
import storageRouter from "../src/routes/storage";
import { saveFile } from "../src/lib/file-store";

const source = new URL(process.env.DATABASE_URL!);
assert.ok(
  ["127.0.0.1", "localhost"].includes(source.hostname) &&
    /^\/catalyst_release_/.test(source.pathname),
  "Installer storage fixtures refuse non-disposable databases.",
);
const tag = randomUUID(),
  actor = `installer-${tag}`,
  otherActor = `other-${tag}`;
const jobIds = [`assigned-${tag}`, `unassigned-${tag}`],
  taskId = `task-${tag}`;
const now = new Date().toISOString(),
  bytes = Buffer.from([255, 216, 255, 217]);
const blobs = new Map<
  string,
  { bytes: Buffer; headers: Record<string, string> }
>();
const calls: { method: string; pathname: string }[] = [];
let providerWrites = 0,
  unexpectedProviderCalls = 0;
let uploadStarted: (() => void) | undefined,
  uploadRelease: Promise<void> | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, options: RequestInit = {}) => {
  const url = new URL(String(input)),
    method = options.method ?? "GET";
  if (url.origin === "http://127.0.0.1:8181")
    return Response.json({
      access_token: "synthetic-local-token",
      expires_on: Math.floor(Date.now() / 1000) + 3600,
    });
  if (url.origin !== "https://fixtureaccount.blob.core.windows.net") {
    unexpectedProviderCalls++;
    throw new Error("Unexpected provider call in installer fixture");
  }
  calls.push({ method, pathname: url.pathname });
  if (method === "PUT") {
    uploadStarted?.();
    if (uploadRelease) await uploadRelease;
    const headers = new Headers(options.headers);
    assert.equal(headers.get("If-None-Match"), "*");
    assert.equal(blobs.has(url.pathname), false);
    blobs.set(url.pathname, {
      bytes: Buffer.from(options.body as Uint8Array),
      headers: Object.fromEntries(headers),
    });
    providerWrites++;
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

// Test harness identity is not a deployed bypass; the normal release HTTP
// suite independently exercises the real cookie, CSRF and role-preview guards.
const app = express()
  .use(express.json())
  .use((req, _res, next) => {
    req.auth = {
      userId: actor,
      role: "installer",
      actualRole: "installer",
      previewRole: null,
      email: "fixture@example.invalid",
      name: "Fixture installer",
      csrfToken: "synthetic-csrf",
    };
    req.log = { error() {}, warn() {} } as any;
    next();
  })
  .use("/api", installerBoundary, storageRouter);
const upload = (jobId: string) =>
  request(app)
    .post(`/api/storage/files/job-photo?recordId=${encodeURIComponent(jobId)}`)
    .set("Content-Type", "application/octet-stream")
    .set("X-File-Name", "Floor.jpg")
    .send(bytes);
const photoIds: string[] = [];
try {
  await db
    .insert(jobsTable)
    .values(
      jobIds.map((id, index) => ({
        id,
        jobNumber: id,
        customerName: `Fixture ${index}`,
        flooringType: "Tile",
        materialStatus: "Ordered",
        priorityLevel: "Low",
        riskLevel: "Low",
        status: "Approved",
        createdAt: now,
        updatedAt: now,
      })),
    );
  await db
    .insert(tasksTable)
    .values({
      id: taskId,
      title: "Personal assignment",
      assigneeId: actor,
      relatedJobId: jobIds[0],
      startAt: now,
      endAt: now,
      createdAt: now,
      updatedAt: now,
    });
  assert.equal((await upload(jobIds[1])).status, 404);
  assert.equal(
    providerWrites,
    0,
    "An unauthorized upload must never reach Blob storage",
  );
  assert.equal(
    (
      await request(app)
        .post(`/api/storage/files/portal-photo?recordId=${jobIds[0]}`)
        .send({})
    ).status,
    403,
  );
  const accepted = await upload(jobIds[0]);
  assert.equal(accepted.status, 201);
  const path = accepted.body.objectPath;
  assert.equal(
    (await request(app).get(`/api/storage${path}`)).status,
    200,
    "Own preview requires current assignment",
  );
  await db
    .update(tasksTable)
    .set({ assigneeId: otherActor })
    .where(eq(tasksTable.id, taskId));
  const readsBefore = calls.filter((call) => call.method === "GET").length;
  assert.equal((await request(app).get(`/api/storage${path}`)).status, 404);
  assert.equal(
    calls.filter((call) => call.method === "GET").length,
    readsBefore,
    "Revoked uploader may not retrieve bytes through preview",
  );

  await db
    .update(tasksTable)
    .set({ assigneeId: actor })
    .where(eq(tasksTable.id, taskId));
  const foreign = await saveFile(
    "job-photo",
    bytes,
    actor,
    jobIds[1],
    "Foreign.jpg",
  );
  for (const [jobId, objectPath] of [
    [jobIds[0], path],
    [jobIds[1], foreign],
  ]) {
    const id = randomUUID();
    photoIds.push(id);
    await db
      .insert(jobPhotosTable)
      .values({
        id,
        jobId,
        objectPath,
        stage: "In Progress",
        caption: "Fixture",
        createdAt: now,
      });
  }
  assert.equal(
    (await request(app).get(`/api/storage${foreign}`)).status,
    404,
    "Uploader ownership never grants the other job",
  );
  assert.equal((await request(app).get(`/api/storage${path}`)).status, 200);
  const legacy = `/objects/uploads/${randomUUID()}`;
  blobs.set(`/fixture-private/${legacy.slice("/objects/".length)}`, {
    bytes,
    headers: { "content-type": "image/jpeg" },
  });
  const legacyId = randomUUID();
  photoIds.push(legacyId);
  await db
    .insert(jobPhotosTable)
    .values({
      id: legacyId,
      jobId: jobIds[1],
      objectPath: legacy,
      stage: "Before",
      createdAt: now,
    });
  assert.equal(
    (await request(app).get(`/api/storage${legacy}`)).status,
    404,
    "Legacy file references must also be assigned",
  );
  await db
    .update(jobPhotosTable)
    .set({ jobId: jobIds[0] })
    .where(eq(jobPhotosTable.id, legacyId));
  assert.equal((await request(app).get(`/api/storage${legacy}`)).status, 200);
  const attachment = await request(app)
    .post(`/api/jobs/${jobIds[0]}/photos`)
    .send({ objectPath: foreign, stage: "In Progress" });
  assert.equal(
    attachment.status,
    400,
    "A photo cannot be attached to a different job",
  );
  const privateAttachment = await request(app)
    .post(`/api/jobs/${jobIds[0]}/photos`)
    .send({
      objectPath: path,
      stage: "In Progress",
      caption: "Real assigned work",
    });
  assert.equal(privateAttachment.status, 201);
  photoIds.push(privateAttachment.body.id);

  // Mutation blocked behind a prior reassignment re-evaluates the committed row.
  const rival = await pool.connect();
  try {
    await rival.query("BEGIN");
    await rival.query("UPDATE tasks SET assignee_id=$1 WHERE id=$2", [
      otherActor,
      taskId,
    ]);
    const before = providerWrites;
    const pending = upload(jobIds[0]).then((result) => result);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await rival.query("COMMIT");
    assert.equal((await pending).status, 404);
    assert.equal(
      providerWrites,
      before,
      "A grant revoked before the write lock cannot create a Blob",
    );
  } finally {
    await rival.query("ROLLBACK");
    rival.release();
  }

  // Conversely, a currently authorized write holds its grant through the
  // external private object write. Revocation takes effect when it commits.
  await db
    .update(tasksTable)
    .set({ assigneeId: actor })
    .where(eq(tasksTable.id, taskId));
  let releaseUpload!: () => void, markStarted!: () => void;
  const began = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  uploadStarted = markStarted;
  uploadRelease = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const pendingUpload = upload(jobIds[0]).then((result) => result);
  await began;
  let reassigned = false;
  const pendingReassignment = db
    .update(tasksTable)
    .set({ assigneeId: otherActor })
    .where(eq(tasksTable.id, taskId))
    .then(() => {
      reassigned = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(
    reassigned,
    false,
    "Reassignment cannot commit while an authorized private upload holds its grant",
  );
  releaseUpload();
  const finished = await pendingUpload;
  assert.equal(finished.status, 201);
  await pendingReassignment;
  uploadStarted = undefined;
  uploadRelease = undefined;
  assert.equal(
    (await request(app).get(`/api/storage${finished.body.objectPath}`)).status,
    404,
  );
  assert.equal(
    unexpectedProviderCalls,
    0,
    "Installer actions cannot touch accounting, mail or calendars",
  );
  console.log(
    "Installer PostgreSQL/storage simulation passed: assigned and foreign previews, private uploads, legacy photos, attachment ownership, revoked grants, both lock-order outcomes and no messaging/calendar/accounting calls",
  );
} finally {
  globalThis.fetch = originalFetch;
  await db.delete(jobPhotosTable).where(inArray(jobPhotosTable.id, photoIds));
  await db.delete(tasksTable).where(eq(tasksTable.id, taskId));
  await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  await pool.end();
}
