/** Disposable PostgreSQL fixture with simulated Azure Blob and Microsoft Graph.
 * No real identity endpoints, files or Microsoft accounts are contacted. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, jobDocumentsTable, jobPhotosTable, microsoftFilesConnectionTable as connections, microsoftFileMirrorsTable as mirrors, microsoftJobFoldersTable as folders, outlookCalendarConnectionTable } from "@workspace/db";
import { attachJobDocument, disconnectMicrosoftFiles, finishMicrosoftFilesConnection, jobFiles, microsoftFilesStatus, selectMicrosoftFilesTarget, syncJobMicrosoftFile } from "../src/lib/microsoft-files";
import { quickXorHash } from "../src/lib/microsoft-files-graph";
import { saveFile } from "../src/lib/file-store";

const databaseUrl = new URL(process.env.DATABASE_URL!);
assert.ok(["127.0.0.1", "localhost"].includes(databaseUrl.hostname) && /^\/catalyst_release_/.test(databaseUrl.pathname), "Microsoft Files fixtures refuse every non-disposable database");
const jobId = "other-job", actor = "files-fixture-owner", driveId = "approved-drive", rootId = "approved-root";
const blobs = new Map<string, { bytes: Buffer; headers: Record<string, string> }>();
const items = new Map<string, any>();
const root = { id: rootId, name: "Company job files", folder: {}, parentReference: { driveId }, webUrl: "https://fixture.sharepoint.com/sites/Works/CompanyFiles" };
let grants = false, serial = 0, uploads = 0, folderCreates = 0, loseUploadResponse = false, loseFolderResponse = false, corruptHash = false;
let oauthScope = "", callsOutsideSelectedDrive = 0;
const selectedScope = "User.Read Files.SelectedOperations.Selected";
items.set(root.id, root);
globalThis.fetch = (async (input: any, options: RequestInit = {}) => {
  const url = new URL(String(input)), method = options.method ?? "GET", headers = new Headers(options.headers);
  if (url.origin === "http://127.0.0.1:8181") return Response.json({ access_token: "synthetic-azure-token", expires_on: Math.floor(Date.now()/1000) + 3600 });
  if (url.origin === "https://fixtureaccount.blob.core.windows.net") {
    if (method === "PUT") {
      assert.equal(headers.get("If-None-Match"), "*");
      if (blobs.has(url.pathname)) return new Response(null, { status: 412 });
      blobs.set(url.pathname, { bytes: Buffer.from(options.body as Uint8Array), headers: Object.fromEntries(headers) });
      return new Response(null, { status: 201 });
    }
    const blob = blobs.get(url.pathname);
    if (!blob) return new Response(null, { status: 404, headers: { "x-ms-error-code": "BlobNotFound" } });
    if (method === "HEAD") return new Response(null, { headers: blob.headers });
    assert.equal(method, "GET");
    return new Response(blob.bytes, { headers: { ...blob.headers, "content-length": String(blob.bytes.length) } });
  }
  if (url.origin === "https://login.microsoftonline.com") {
    assert.equal(url.pathname, "/organizations/oauth2/v2.0/token");
    oauthScope = (options.body as URLSearchParams).get("scope")!;
    assert.equal(oauthScope, "offline_access User.Read Files.SelectedOperations.Selected");
    return Response.json({ access_token: "synthetic-selected-file-token", refresh_token: "synthetic-selected-file-refresh", expires_in: 3600, scope: selectedScope });
  }
  assert.equal(url.origin, "https://graph.microsoft.com", "No external file URL or arbitrary host may be fetched");
  if (url.pathname === "/v1.0/me") return Response.json({ id: "fixture-files-account", mail: "owner@fixture.invalid" });
  if (!url.pathname.startsWith(`/v1.0/drives/${driveId}/items/`)) { callsOutsideSelectedDrive++; throw new Error("Unexpected resource outside selected drive"); }
  const relative = decodeURIComponent(url.pathname.slice(`/v1.0/drives/${driveId}/items/`.length));
  if (relative === `${rootId}/permissions`) {
    assert.equal(method, "GET", "The connector must never grant itself access");
    return Response.json({ value: grants ? [{ roles: ["write"], grantedToV2: { application: { id: "files-fixture-app" } } }] : [] });
  }
  if (relative.endsWith("/children") && method === "POST") {
    const parentId = relative.slice(0, -9), body = JSON.parse(String(options.body));
    assert.equal(body["@microsoft.graph.conflictBehavior"], "fail");
    if ([...items.values()].some((item) => item.parentReference?.id === parentId && item.name === body.name)) return new Response(null, { status: 409 });
    const item = { id: `provider-folder-${++serial}`, name: body.name, folder: {}, parentReference: { id: parentId, driveId }, webUrl: `https://fixture.sharepoint.com/sites/Works/${serial}` };
    items.set(item.id, item); folderCreates++;
    if (loseFolderResponse) { loseFolderResponse = false; throw new Error("Folder creation response lost"); }
    return Response.json(item, { status: 201 });
  }
  if (relative.includes(":/")) {
    const [parentId, rawName] = relative.split(":/"), upload = rawName.endsWith(":/content"), name = upload ? rawName.slice(0, -9) : rawName;
    const existing = [...items.values()].find((item) => item.parentReference?.id === parentId && item.name === name);
    if (method === "GET") return existing ? Response.json(existing) : new Response(null, { status: 404 });
    assert.equal(method, "PUT"); assert.equal(headers.get("If-None-Match"), "*"); assert.equal(url.searchParams.get("@microsoft.graph.conflictBehavior"), "fail");
    if (existing) return new Response(null, { status: 409 });
    const bytes = Buffer.from(options.body as Uint8Array);
    const item = { id: `provider-file-${++serial}`, name, size: bytes.length, parentReference: { id: parentId, driveId }, file: { hashes: { quickXorHash: corruptHash ? "wrong-checksum" : quickXorHash(bytes) } }, webUrl: `https://fixture.sharepoint.com/sites/Works/${serial}` };
    items.set(item.id, item); uploads++;
    if (loseUploadResponse) { loseUploadResponse = false; throw new Error("Upload response lost after provider commit"); }
    return Response.json(item, { status: 201 });
  }
  assert.equal(method, "GET");
  return items.has(relative) ? Response.json(items.get(relative)) : new Response(null, { status: 404 });
}) as typeof fetch;
const copy = (sourceType: "document" | "photo", sourceId: string, key = randomUUID()) => syncJobMicrosoftFile(jobId, sourceType, sourceId, key, actor);
const bytes = Buffer.from("%PDF-1.7\nFictional fixture quote only. No customer data.");
const savedDocuments: string[] = [], photoIds: string[] = [];
const outlookBefore = await db.select().from(outlookCalendarConnectionTable);
try {
  assert.equal((await microsoftFilesStatus()).status, "disconnected");
  const path = await saveFile("job-document", bytes, actor, jobId, "Fixture quote.pdf"), requestKey = randomUUID();
  const [document, replay] = await Promise.all([attachJobDocument(jobId, path, requestKey, actor), attachJobDocument(jobId, path, requestKey, actor)]);
  savedDocuments.push(document.id); assert.equal(document.id, replay.id);
  await assert.rejects(attachJobDocument(jobId, path, randomUUID(), "different-uploader"), /upload the file/);
  assert.equal((await jobFiles(jobId)).documents.filter(({ id }) => id === document.id).length, 1);
  await assert.rejects(copy("document", document.id), /Connect the Microsoft file account/);
  await finishMicrosoftFilesConnection("synthetic-code", "synthetic-verifier", "offline_access User.Read Files.SelectedOperations.Selected");
  assert.equal(oauthScope, "offline_access User.Read Files.SelectedOperations.Selected");
  assert.equal((await microsoftFilesStatus()).accountEmail, "owner@fixture.invalid");
  const persisted = (await db.select().from(connections))[0];
  assert.notEqual(persisted.accessToken, "synthetic-selected-file-token"); assert.notEqual(persisted.refreshToken, "synthetic-selected-file-refresh");
  await assert.rejects(selectMicrosoftFilesTarget(driveId, rootId, actor), /No matching selected-folder write grant/);
  assert.equal((await microsoftFilesStatus()).target, null);
  grants = true; await selectMicrosoftFilesTarget(driveId, rootId, actor);
  loseFolderResponse = true;
  const folderUnknown = await copy("document", document.id); assert.equal(folderUnknown.status, "unknown"); assert.equal(folderCreates, 1); assert.equal(uploads, 0);
  const attempts = await Promise.allSettled([copy("document", document.id), copy("document", document.id)]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  const result = (attempts.find(({ status }) => status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof copy>>>).value;
  assert.equal(result.status, "synced"); assert.equal(uploads, 1); assert.equal(folderCreates, 1);
  assert.equal((await copy("document", document.id)).id, result.id); assert.equal(uploads, 1);
  const [mirror] = await db.select().from(mirrors).where(eq(mirrors.id, result.id));
  assert.equal(mirror.itemId, "provider-file-2"); assert.ok(mirror.remoteName.includes(document.sha256));
  assert.equal((await jobFiles(jobId)).microsoft.folderUrl, "https://fixture.sharepoint.com/sites/Works/1");
  await assert.rejects(selectMicrosoftFilesTarget(driveId, "changed-target", actor), /not found|different|bound/);

  // Existing actual job photos use their normal private source and share one job folder.
  const photoPath = await saveFile("job-photo", Buffer.from([255,216,255,217]), actor, jobId, "Measured floor.jpg"), photoId = randomUUID(); photoIds.push(photoId);
  await db.insert(jobPhotosTable).values({ id: photoId, jobId, stage: "Before", objectPath: photoPath, createdAt: new Date().toISOString() });
  loseUploadResponse = true;
  const unknown = await copy("photo", photoId); assert.equal(unknown.status, "unknown"); assert.equal(uploads, 2);
  const recovered = await copy("photo", photoId); assert.equal(recovered.status, "synced"); assert.equal(uploads, 2); assert.equal(folderCreates, 1);
  assert.equal(recovered.id, unknown.id);

  const otherPath = await saveFile("job-document", Buffer.from("Another fixture document"), actor, jobId, "Another.txt");
  const second = await attachJobDocument(jobId, otherPath, randomUUID(), actor); savedDocuments.push(second.id);
  grants = false; const denied = await copy("document", second.id); assert.equal(denied.status, "error"); assert.equal(uploads, 2);
  grants = true; corruptHash = true; const corrupt = await copy("document", second.id); corruptHash = false;
  assert.equal(corrupt.status, "error"); assert.equal(uploads, 3);
  const failedAgain = await copy("document", second.id); assert.equal(failedAgain.status, "error"); assert.equal(uploads, 3, "A mismatched existing file must never be overwritten");
  const expiredPath = await saveFile("job-document", Buffer.from("Interrupted fixture document"), actor, jobId, "Interrupted.txt");
  const interrupted = await attachJobDocument(jobId, expiredPath, randomUUID(), actor); savedDocuments.push(interrupted.id);
  const existingFolder = (await db.select().from(folders).where(eq(folders.jobId, jobId)))[0];
  const interruptedId = randomUUID(), now = new Date().toISOString();
  await db.insert(mirrors).values({ id: interruptedId, jobId, sourceType: "document", sourceId: interrupted.id, objectPath: expiredPath,
    targetKey: existingFolder.targetKey, name: interrupted.name, remoteName: `interrupted-${interrupted.sha256}.txt`, sha256: interrupted.sha256, size: interrupted.size,
    status: "syncing", actorUserId: actor, requestKey: randomUUID(), attemptId: randomUUID(), leaseUntil: "2020-01-01T00:00:00Z", createdAt: now, updatedAt: now });
  assert.equal((await jobFiles(jobId)).microsoft.mirrors.find(({ id }) => id === interruptedId)!.status, "unknown");
  assert.equal((await copy("document", interrupted.id)).status, "synced");
  assert.equal(callsOutsideSelectedDrive, 0);
  assert.deepEqual(await db.select().from(outlookCalendarConnectionTable), outlookBefore, "Microsoft files must not modify working Outlook tokens, scopes or calendar choice");
  await disconnectMicrosoftFiles(); assert.equal((await microsoftFilesStatus()).status, "disconnected");
  assert.equal((await jobFiles(jobId)).documents.length >= savedDocuments.length, true);
  console.log("Microsoft files PostgreSQL/Blob/Graph simulation passed: private documents, actual selected grant, encrypted connection, stable job folders, photo mirrors, lost-response reconciliation, immutable hash mismatch and interrupted lease recovery");
} finally {
  await db.delete(mirrors).where(eq(mirrors.jobId, jobId));
  await db.delete(folders).where(eq(folders.jobId, jobId));
  for (const id of photoIds) await db.delete(jobPhotosTable).where(eq(jobPhotosTable.id, id));
  for (const id of savedDocuments) await db.delete(jobDocumentsTable).where(eq(jobDocumentsTable.id, id));
  await db.delete(connections).where(eq(connections.accountId, "fixture-files-account"));
  await pool.end();
}
