import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, jobsTable, jobDocumentsTable, jobPhotosTable, microsoftFilesConnectionTable as connections, microsoftJobFoldersTable as folders, microsoftFileMirrorsTable as mirrors } from "@workspace/db";
import { workspaceScopeKey } from "@workspace/db/workspace";
import { assertOwnedFile, filePurpose, getFile, getFileMetadata, isLegacyFilePath, maxFileBytes } from "./file-store";
import { fetchOutlookToken, normalizeOutlookScopes, openOutlookSecret, sealOutlookSecret, OutlookError } from "./outlook-graph";
import { getMicrosoftFilesConfig, hasSelectedFilesScope, MicrosoftFilesError, microsoftFilesGraph, safeMicrosoftName, safeMicrosoftWebUrl, verifyMirroredItem } from "./microsoft-files-graph";
import { DomainError } from "./operations-rules";
import { audit } from "./auth";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Connection = typeof connections.$inferSelect;
type Mirror = typeof mirrors.$inferSelect;
const nowIso = () => new Date().toISOString();
const tokenPurpose = (id: string, type: string) => `microsoft-files:${id}:${type}`;
function openMicrosoftToken(config: NonNullable<ReturnType<typeof getMicrosoftFilesConfig>>, value: string, purpose: string) {
  try { return openOutlookSecret(config, value, purpose); }
  catch { throw new MicrosoftFilesError(401, "The Microsoft file credential can no longer be opened. Reconnect this account in Settings."); }
}
const configRequired = () => { const config = getMicrosoftFilesConfig(); if (!config) throw new DomainError(503, "Microsoft file storage is not configured on this company server."); return config; };
const targetKey = (connection: Connection) => createHash("sha256").update(JSON.stringify([workspaceScopeKey(), connection.clientId, connection.accountId, connection.driveId, connection.folderId])).digest("hex");
const mirrorResult = (row: Mirror) => {
  const interrupted = row.status === "syncing" && (!row.leaseUntil || row.leaseUntil <= nowIso());
  return { id: row.id, sourceType: row.sourceType, sourceId: row.sourceId, name: row.name, status: interrupted ? "unknown" as const : row.status,
    webUrl: row.webUrl, lastError: interrupted ? "The previous copy did not finish. Check it before retrying." : row.lastError, updatedAt: row.updatedAt };
};

export async function finishMicrosoftFilesConnection(code: string, verifier: string, scope: string) {
  const config = configRequired();
  if (scope !== config.scope) throw new DomainError(400, "The requested Microsoft file permissions changed. Start a new connection.");
  const tokens = await fetchOutlookToken(config, { code, verifier, scope });
  if (!tokens.refresh_token || !hasSelectedFilesScope(tokens.scope)) throw new DomainError(403, "Microsoft did not grant offline access and the selected-files permission. Complete administrator consent first.");
  const account = await microsoftFilesGraph(tokens.access_token).account();
  const email = [account.mail, account.userPrincipalName].map((value) => z.string().email().safeParse(value)).find((result) => result.success)?.data;
  if (!email) throw new DomainError(502, "Microsoft did not confirm the connected account's email address.");
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('catalyst:microsoft-files'))`);
    const [existing] = await tx.select().from(connections).where(eq(connections.id, 1));
    const [used] = await tx.select({ id: folders.jobId }).from(folders).limit(1);
    if (existing && used && (existing.accountId !== account.id || existing.clientId !== config.clientId)) throw new DomainError(409, "Reconnect the original Microsoft file account. Existing job folders are bound to that account and app.");
    const fields = { accountId: account.id, accountEmail: email, clientId: config.clientId, grantedScopes: normalizeOutlookScopes(tokens.scope), status: "connected",
      accessToken: sealOutlookSecret(config, tokens.access_token, tokenPurpose(account.id, "access")), refreshToken: sealOutlookSecret(config, tokens.refresh_token!, tokenPurpose(account.id, "refresh")),
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(), updatedAt: nowIso(),
      ...(!existing || existing.accountId !== account.id || existing.clientId !== config.clientId ? { driveId: null, folderId: null, folderName: null, folderWebUrl: null, verifiedAt: null } : {}),
    };
    await tx.insert(connections).values({ id: 1, ...fields }).onConflictDoUpdate({ target: connections.id, set: fields });
  });
}

async function graphConnection(forceRefresh = false) {
  const config = configRequired();
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('catalyst:microsoft-files'))`);
    const [connection] = await tx.select().from(connections).where(eq(connections.id, 1));
    if (!connection || connection.status !== "connected" || connection.clientId !== config.clientId || !connection.accessToken || !connection.refreshToken || !hasSelectedFilesScope(connection.grantedScopes))
      throw new DomainError(409, "Connect the Microsoft file account in Settings first.");
    try {
      if (!forceRefresh && Date.parse(connection.expiresAt ?? "") > Date.now() + 120000) return { connection, token: openMicrosoftToken(config, connection.accessToken, tokenPurpose(connection.accountId, "access")) };
      const tokens = await fetchOutlookToken(config, { refreshToken: openMicrosoftToken(config, connection.refreshToken, tokenPurpose(connection.accountId, "refresh")), scope: config.scope });
      const grantedScopes = tokens.scope === undefined ? connection.grantedScopes : normalizeOutlookScopes(tokens.scope);
      if (!hasSelectedFilesScope(grantedScopes)) throw new MicrosoftFilesError(401, "Microsoft selected-files permission expired. Reconnect the file account.");
      await tx.update(connections).set({ accessToken: sealOutlookSecret(config, tokens.access_token, tokenPurpose(connection.accountId, "access")),
        refreshToken: tokens.refresh_token ? sealOutlookSecret(config, tokens.refresh_token, tokenPurpose(connection.accountId, "refresh")) : connection.refreshToken,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(), grantedScopes, updatedAt: nowIso() }).where(eq(connections.id, 1));
      return { connection, token: tokens.access_token };
    } catch (error) {
      if ((error instanceof OutlookError || error instanceof MicrosoftFilesError) && error.status === 401) await tx.update(connections).set({ status: "reconnect_required", updatedAt: nowIso() }).where(eq(connections.id, 1));
      return { error };
    }
  });
  if (outcome.error) throw outcome.error;
  return { graph: microsoftFilesGraph(outcome.token!), connection: outcome.connection!, config };
}
async function withGraph<T>(action: (context: Awaited<ReturnType<typeof graphConnection>>) => Promise<T>) {
  try { return await action(await graphConnection()); }
  catch (error) { if (!(error instanceof MicrosoftFilesError) || error.status !== 401) throw error; return action(await graphConnection(true)); }
}

export async function microsoftFilesStatus() {
  const config = getMicrosoftFilesConfig(), [connection] = await db.select().from(connections).where(eq(connections.id, 1));
  const connected = !!config && connection?.clientId === config.clientId && connection.status === "connected" && !!connection.accessToken && !!connection.refreshToken && hasSelectedFilesScope(connection.grantedScopes);
  return { configured: !!config, status: !config ? "not_configured" : connected ? "connected" : connection?.status === "reconnect_required" ? "reconnect_required" : "disconnected",
    appClientId: config?.clientId ?? null, accountEmail: connection?.accountEmail ?? null,
    target: connection?.driveId && connection.folderId ? { driveId: connection.driveId, folderId: connection.folderId, name: connection.folderName!, webUrl: connection.folderWebUrl, verifiedAt: connection.verifiedAt! } : null };
}
export async function selectMicrosoftFilesTarget(driveId: string, folderId: string, actorUserId: string) {
  return withGraph(async ({ graph, connection, config }) => {
    const item = await graph.target(driveId, folderId, config.clientId);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('catalyst:microsoft-files'))`);
      const [current] = await tx.select().from(connections).where(eq(connections.id, 1)).for("update");
      if (!current || current.accountId !== connection.accountId || current.clientId !== connection.clientId) throw new DomainError(409, "The Microsoft file connection changed. Refresh and choose the target again.");
      const [used] = await tx.select({ id: folders.jobId }).from(folders).limit(1);
      if (used && (current.driveId !== driveId || current.folderId !== folderId)) throw new DomainError(409, "Existing job folders are bound to the current Microsoft target. Review a storage migration before changing that target.");
      const now = nowIso();
      await tx.update(connections).set({ driveId, folderId, folderName: item.name, folderWebUrl: safeMicrosoftWebUrl(item.webUrl), verifiedAt: now, updatedAt: now }).where(eq(connections.id, 1));
      await audit("microsoft_files.target_selected", { userId: actorUserId, details: { driveId, folderId } }, tx);
    });
    return microsoftFilesStatus();
  });
}
export async function disconnectMicrosoftFiles() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('catalyst:microsoft-files'))`);
    await tx.update(connections).set({ accessToken: null, refreshToken: null, expiresAt: null, grantedScopes: "", status: "disconnected", updatedAt: nowIso() }).where(eq(connections.id, 1));
  });
}

async function fileBytes(path: string, jobId: string) {
  if (!["job-document", "job-photo", "portal-photo"].includes(filePurpose(path) ?? "") && !isLegacyFilePath(path)) throw new DomainError(400, "Choose a private attachment uploaded for this job.");
  const metadata = await getFileMetadata(path);
  if (!isLegacyFilePath(path) && (!metadata || metadata.recordId !== jobId)) throw new DomainError(409, "The stored attachment does not belong to this job.");
  const file = await getFile(path); if (!file) throw new DomainError(404, "The private attachment was not found.");
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of file.body) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part); size += bytes.length;
    if (size > maxFileBytes) { file.body.destroy(); throw new DomainError(413, "The stored attachment exceeds 15 MB."); }
    chunks.push(bytes);
  }
  if (!size) throw new DomainError(400, "The stored attachment is empty.");
  const bytes = Buffer.concat(chunks);
  return { bytes, name: metadata?.name ?? file.name ?? "attachment", sha256: createHash("sha256").update(bytes).digest("hex") };
}
export async function attachJobDocument(jobId: string, objectPath: string, requestKey: string, actorUserId: string) {
  await assertOwnedFile(objectPath, ["job-document"], actorUserId, jobId);
  const source = await fileBytes(objectPath, jobId);
  return db.transaction(async (tx) => {
    const [job] = await tx.select({ id: jobsTable.id }).from(jobsTable).where(eq(jobsTable.id, jobId)).for("update");
    if (!job) throw new DomainError(404, "Job not found.");
    const [prior] = await tx.select().from(jobDocumentsTable).where(eq(jobDocumentsTable.requestKey, requestKey));
    if (prior) {
      if (prior.jobId !== jobId || prior.objectPath !== objectPath || prior.actorUserId !== actorUserId || prior.sha256 !== source.sha256) throw new DomainError(409, "This attachment request key was used for another file.");
      return prior;
    }
    const [same] = await tx.select().from(jobDocumentsTable).where(eq(jobDocumentsTable.objectPath, objectPath));
    if (same) return same;
    const [row] = await tx.insert(jobDocumentsTable).values({ id: randomUUID(), jobId, objectPath, name: source.name, size: source.bytes.length, sha256: source.sha256, actorUserId, requestKey, createdAt: nowIso() }).returning();
    await audit("job.document_attached", { userId: actorUserId, entityType: "job", entityId: jobId, details: { documentId: row.id, name: row.name } }, tx);
    return row;
  });
}
export async function jobFiles(jobId: string) {
  const [job] = await db.select({ id: jobsTable.id }).from(jobsTable).where(eq(jobsTable.id, jobId));
  if (!job) throw new DomainError(404, "Job not found.");
  const [documents, photos, savedMirrors, folder, status] = await Promise.all([
    db.select().from(jobDocumentsTable).where(eq(jobDocumentsTable.jobId, jobId)).orderBy(asc(jobDocumentsTable.createdAt)),
    db.select().from(jobPhotosTable).where(eq(jobPhotosTable.jobId, jobId)).orderBy(asc(jobPhotosTable.createdAt)),
    db.select().from(mirrors).where(eq(mirrors.jobId, jobId)).orderBy(asc(mirrors.createdAt)),
    db.select().from(folders).where(eq(folders.jobId, jobId)), microsoftFilesStatus(),
  ]);
  return { documents: documents.map(({ id, jobId, name, objectPath, size, sha256, createdAt }) => ({ id, jobId, name, objectPath, size, sha256, createdAt })),
    photos: photos.map(({ id, objectPath, caption, createdAt }) => ({ id, objectPath, name: caption || `Photo ${id}`, caption, createdAt })),
    microsoft: { connected: status.status === "connected", targetReady: status.status === "connected" && !!status.target, folderUrl: folder[0]?.webUrl ?? null, mirrors: savedMirrors.map(mirrorResult) } };
}

export async function syncJobMicrosoftFile(jobId: string, sourceType: "document" | "photo", sourceId: string, requestKey: string, actorUserId: string) {
  const table = sourceType === "document" ? jobDocumentsTable : jobPhotosTable;
  const [source] = await db.select().from(table).where(and(eq(table.id, sourceId), eq(table.jobId, jobId)));
  if (!source) throw new DomainError(404, "Job attachment not found.");
  const content = await fileBytes(source.objectPath, jobId);
  if ("sha256" in source && source.sha256 !== content.sha256) throw new DomainError(409, "The stored document content changed after attachment. Review the original file before syncing.");
  const context = await graphConnection(), { connection } = context;
  if (!connection.driveId || !connection.folderId) throw new DomainError(409, "Choose and verify a Microsoft target folder in Settings first.");
  const key = targetKey(connection), attemptId = randomUUID(), now = nowIso();
  const claimed = await db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobsTable).where(eq(jobsTable.id, jobId)).for("update");
    if (!job) throw new DomainError(404, "Job not found.");
    const [current] = await tx.select().from(connections).where(eq(connections.id, 1)).for("update");
    if (!current || current.status !== "connected" || targetKey(current) !== key) throw new DomainError(409, "The Microsoft target changed. Refresh before syncing.");
    const [priorKey] = await tx.select().from(mirrors).where(eq(mirrors.requestKey, requestKey));
    if (priorKey && (priorKey.sourceType !== sourceType || priorKey.sourceId !== sourceId || priorKey.jobId !== jobId || priorKey.actorUserId !== actorUserId)) throw new DomainError(409, "This sync request key belongs to another attachment.");
    const [existing] = await tx.select().from(mirrors).where(and(eq(mirrors.sourceType, sourceType), eq(mirrors.sourceId, sourceId)));
    if (existing && (existing.targetKey !== key || existing.objectPath !== source.objectPath || existing.sha256 !== content.sha256)) throw new DomainError(409, "This attachment's source or Microsoft target changed. Review the original mirror first.");
    if (existing?.status === "synced") return { done: existing };
    if (existing?.leaseUntil && existing.leaseUntil > now) throw new DomainError(409, "This attachment is already syncing. Wait for the current attempt before retrying.");
    let [folder] = await tx.select().from(folders).where(eq(folders.jobId, jobId));
    if (folder && folder.targetKey !== key) throw new DomainError(409, "This job is bound to a different Microsoft folder target.");
    if (!folder) [folder] = await tx.insert(folders).values({ jobId, targetKey: key, driveId: connection.driveId!, parentId: connection.folderId!, name: `CW-${safeMicrosoftName(job.jobNumber, 24)}-${createHash("sha256").update(`${workspaceScopeKey()}\0${jobId}`).digest("hex").slice(0, 32)}`, createdAt: now, updatedAt: now }).returning();
    const fields = { status: "syncing" as const, attemptId, leaseUntil: new Date(Date.now() + 300000).toISOString(), lastError: null, updatedAt: now };
    let row: Mirror;
    if (existing) [row] = await tx.update(mirrors).set(fields).where(eq(mirrors.id, existing.id)).returning();
    else {
      const id = randomUUID();
      [row] = await tx.insert(mirrors).values({ id, jobId, sourceType, sourceId, objectPath: source.objectPath, targetKey: key, name: content.name,
        remoteName: `CW-${id}-${content.sha256}-${safeMicrosoftName(content.name)}`, sha256: content.sha256, size: content.bytes.length,
        actorUserId, requestKey, createdAt: now, ...fields }).returning();
    }
    return { row, folder };
  });
  if (claimed.done) return mirrorResult(claimed.done);
  const { row, folder } = claimed;
  try {
    const result = await withGraph(async ({ graph, connection: current, config }) => {
      if (targetKey(current) !== key) throw new DomainError(409, "The Microsoft target changed before this attachment was submitted.");
      await graph.target(folder.driveId, folder.parentId, config.clientId);
      let remoteFolder = folder.itemId ? await graph.item(folder.driveId, folder.itemId) : await graph.child(folder.driveId, folder.parentId, folder.name);
      if (!remoteFolder) {
        try { remoteFolder = await graph.folder(folder.driveId, folder.parentId, folder.name); }
        catch (error) { if (!(error instanceof MicrosoftFilesError) || error.status !== 409) throw error; remoteFolder = await graph.child(folder.driveId, folder.parentId, folder.name); if (!remoteFolder) throw error; }
      }
      if (!remoteFolder.folder || remoteFolder.remoteItem || remoteFolder.parentReference?.id !== folder.parentId || remoteFolder.parentReference?.driveId !== folder.driveId) throw new DomainError(409, "The job folder moved outside the selected target. It will not be replaced or written elsewhere.");
      await db.update(folders).set({ itemId: remoteFolder.id, webUrl: safeMicrosoftWebUrl(remoteFolder.webUrl), updatedAt: nowIso() }).where(and(eq(folders.jobId, jobId), eq(folders.targetKey, key)));
      let item = await graph.child(folder.driveId, remoteFolder.id, row.remoteName);
      if (!item) {
        try { item = await graph.upload(folder.driveId, remoteFolder.id, row.remoteName, content.bytes); }
        catch (error) { if (!(error instanceof MicrosoftFilesError) || error.status !== 409 || error.uncertain) throw error; item = await graph.child(folder.driveId, remoteFolder.id, row.remoteName); if (!item) throw error; }
      }
      verifyMirroredItem(item, remoteFolder.id, folder.driveId, row.remoteName, content.bytes);
      return item;
    });
    const [saved] = await db.update(mirrors).set({ status: "synced", itemId: result.id, webUrl: safeMicrosoftWebUrl(result.webUrl), leaseUntil: null, lastError: null, updatedAt: nowIso() })
      .where(and(eq(mirrors.id, row.id), eq(mirrors.attemptId, attemptId))).returning();
    if (!saved) throw new DomainError(409, "A newer sync attempt is reconciling this file. Refresh its status.");
    await audit("microsoft_files.attachment_synced", { userId: actorUserId, entityType: "job", entityId: jobId, details: { mirrorId: saved.id, sourceType, sourceId } });
    return mirrorResult(saved);
  } catch (error) {
    const message = error instanceof DomainError ? error.message : "Microsoft could not confirm this attachment. Retry to reconcile its immutable filename.";
    const [saved] = await db.update(mirrors).set({ status: error instanceof MicrosoftFilesError && error.uncertain ? "unknown" : "error", itemId: null, webUrl: null, leaseUntil: null, lastError: message, updatedAt: nowIso() })
      .where(and(eq(mirrors.id, row.id), eq(mirrors.attemptId, attemptId), eq(mirrors.status, "syncing"))).returning();
    if (!saved) throw new DomainError(409, "The attachment's sync status changed. Refresh before retrying.");
    return mirrorResult(saved);
  }
}
