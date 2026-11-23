import { workspaceEnvironment } from "@workspace/db/workspace";
import { raw, Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { pipeline } from "node:stream/promises";
import { and, eq, sql } from "drizzle-orm";
import { db, jobPhotosTable, jobDocumentsTable, microsoftFileMirrorsTable, jobsTable, leadsTable, productsTable, settingsTable, type AppRole } from "@workspace/db";
import { domainRoute } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { canUploadFile, filePurpose, getFile, getFileMetadata, isFilePurpose, isLegacyFilePath, isPortalPhoto, isUploaderPreview, maxFileBytes, safeFileHeaders, saveFile, storedFilePath, type FileDownload, type FilePurpose } from "../lib/file-store";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
export const publicMediaRouter: IRouter = Router();
const legacyStorage = new ObjectStorageService();
const uploadBody = raw({ type: "application/octet-stream", limit: maxFileBytes, inflate: false });
const productImageReaders: AppRole[] = ["owner", "operations", "sales"];

function authorizeUpload(req: Request, res: Response, next: NextFunction) {
  const purpose = String(req.params.purpose);
  const role = req.auth!.role;
  if (!isFilePurpose(purpose) || !canUploadFile(purpose, role)) {
    res.status(403).json({ error: "Your role cannot upload this type of file." });
    return;
  }
  uploadBody(req, res, (error) => {
    if (!error) return next();
    const status = error.status === 413 ? 413 : 400;
    res.status(status).json({ error: status === 413 ? "Choose a file up to 15 MB." : "The file could not be read." });
  });
}

router.post("/storage/files/:purpose", authorizeUpload, domainRoute(async (req, res) => {
  const purpose = req.params.purpose as FilePurpose;
  const recordId = req.query.recordId ?? "";
  const needsRecord = purpose === "job-photo" || purpose === "portal-photo" || purpose === "job-document" || purpose === "lead-document";
  if (typeof recordId !== "string" || (needsRecord ? !/^[a-zA-Z0-9_-]{1,128}$/.test(recordId) : recordId !== "")) {
    throw new DomainError(400, "Select the record for this upload.");
  }
  if (!Buffer.isBuffer(req.body)) throw new DomainError(415, "Send the file as application/octet-stream.");
  let name: string;
  try { name = decodeURIComponent(req.get("x-file-name") ?? "").trim(); }
  catch { throw new DomainError(400, "Choose a file with a valid name."); }
  if (!name || name.length > 255) throw new DomainError(400, "Choose a file with a name up to 255 characters.");

  if (needsRecord) {
    const table = purpose === "lead-document" ? leadsTable : jobsTable;
    const [record] = await db.select({ id: table.id }).from(table).where(eq(table.id, recordId));
    if (!record) throw new DomainError(404, "The record for this upload was not found.");
  }
  const objectPath = await saveFile(purpose, req.body, req.auth!.userId, recordId, name);
  res.status(201).json({ objectPath });
}));

router.post("/storage/uploads/request-url", (_req, res) => {
  res.status(410).json({ error: "This upload route has been replaced. Refresh the app to upload a file." });
});

async function streamFile(res: Response, file: FileDownload, attachment = false) {
  res.set(safeFileHeaders(file, attachment));
  await pipeline(file.body, res).catch((error: unknown) => {
    if (!res.destroyed) throw error;
  });
}

async function attachedToJob(path: string, jobId?: string) {
  const [photo] = await db.select({ id: jobPhotosTable.id }).from(jobPhotosTable)
    .where(and(eq(jobPhotosTable.objectPath, path), jobId ? eq(jobPhotosTable.jobId, jobId) : undefined)).limit(1);
  if (photo) return true;
  const [mirror] = await db.select({ id: microsoftFileMirrorsTable.id }).from(microsoftFileMirrorsTable).where(and(
    eq(microsoftFileMirrorsTable.sourceType, "photo"), eq(microsoftFileMirrorsTable.objectPath, path), jobId ? eq(microsoftFileMirrorsTable.jobId, jobId) : undefined,
  )).limit(1);
  return !!mirror;
}

async function attachedToLead(path: string, leadId?: string) {
  const [lead] = await db.select({ id: leadsTable.id }).from(leadsTable).where(and(
    sql`${leadsTable.documents} @> ${JSON.stringify([{ objectPath: path }])}::jsonb`,
    leadId ? eq(leadsTable.id, leadId) : undefined,
  )).limit(1);
  return !!lead;
}

async function attachedToProduct(path: string) {
  const [product] = await db.select({ id: productsTable.id }).from(productsTable).where(eq(productsTable.imageUrl, path)).limit(1);
  return !!product;
}

async function isConfiguredLogo(path: string) {
  const [settings] = await db.select({ logo: settingsTable.companyLogoUrl }).from(settingsTable).where(eq(settingsTable.id, 1));
  return !!settings?.logo && storedFilePath(settings.logo) === path;
}

function canReadFilePurpose(purpose: FilePurpose, role: AppRole) {
  if (purpose === "company-logo") return true;
  if (purpose === "product-image") return productImageReaders.includes(role);
  return canUploadFile(purpose, role);
}

async function isAttachedFile(path: string, purpose: FilePurpose, recordId: string) {
  switch (purpose) {
    case "job-document": {
      const [document] = await db.select({ id: jobDocumentsTable.id }).from(jobDocumentsTable).where(and(eq(jobDocumentsTable.jobId, recordId), eq(jobDocumentsTable.objectPath, path))).limit(1);
      return !!document;
    }
    case "job-photo":
    case "portal-photo":
      return !!recordId && attachedToJob(path, recordId);
    case "lead-document":
      return !!recordId && attachedToLead(path, recordId);
    case "product-image":
      return attachedToProduct(path);
    case "company-logo":
      return isConfiguredLogo(path);
  }
}

router.get("/storage/objects/*path", domainRoute(async (req, res) => {
  const raw = req.params.path;
  const path = `/objects/${Array.isArray(raw) ? raw.join("/") : raw}`;
  const { role, userId } = req.auth!;
  const purpose = filePurpose(path);
  let attachment = false;
  if (purpose) {
    if (!canReadFilePurpose(purpose, role)) throw new DomainError(404, "File not found.");

    const metadata = await getFileMetadata(path);
    const isPreview = metadata && canUploadFile(purpose, role) && isUploaderPreview(metadata, userId);
    if (!metadata || (!isPreview && !(await isAttachedFile(path, purpose, metadata.recordId)))) {
      throw new DomainError(404, "File not found.");
    }
    attachment = purpose === "lead-document" || purpose === "job-document";
  } else if (isLegacyFilePath(path)) {
    const canReadDocument = (role === "owner" || role === "sales") && await attachedToLead(path);
    if (!(await attachedToJob(path)) && !canReadDocument && !(productImageReaders.includes(role) && await attachedToProduct(path)) && !(await isConfiguredLogo(path))) {
      throw new DomainError(404, "File not found.");
    }
    attachment = canReadDocument;
  } else {
    throw new DomainError(404, "File not found.");
  }

  const file = await getFile(path);
  if (!file) throw new DomainError(404, "File not found.");
  await streamFile(res, file, attachment);
}));

router.get("/storage/public-objects/*filePath", domainRoute(async (req, res) => {
  const raw = req.params.filePath;
  const key = Array.isArray(raw) ? raw.join("/") : String(raw);
  if (!workspaceEnvironment().PUBLIC_OBJECT_SEARCH_PATHS || !key.split("/").every((part) => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part))) {
    throw new DomainError(404, "File not found.");
  }
  const legacy = await legacyStorage.searchPublicObject(key);
  if (!legacy) throw new DomainError(404, "File not found.");
  const [metadata] = await legacy.getMetadata();
  await streamFile(res, { body: legacy.createReadStream(), type: metadata.contentType ?? "application/octet-stream", length: String(metadata.size ?? "") });
}));

async function streamPublicImage(res: Response, path: string) {
  const file = await getFile(path);
  if (!file) throw new DomainError(404, "Image not found.");
  if (safeFileHeaders(file, false)["Content-Disposition"] !== "inline") {
    file.body.destroy();
    throw new DomainError(404, "Image not found.");
  }
  await streamFile(res, file);
}

publicMediaRouter.get("/public/jobs/:token/photos/:photoId", domainRoute(async (req, res) => {
  const [photo] = await db.select({ path: jobPhotosTable.objectPath, jobId: jobsTable.id }).from(jobPhotosTable)
    .innerJoin(jobsTable, eq(jobsTable.id, jobPhotosTable.jobId))
    .where(and(eq(jobsTable.shareToken, String(req.params.token)), eq(jobPhotosTable.id, String(req.params.photoId)))).limit(1);
  if (!photo || !isPortalPhoto(photo.path)) throw new DomainError(404, "Photo not found.");
  const metadata = await getFileMetadata(photo.path);
  if (!metadata || metadata.recordId !== photo.jobId) throw new DomainError(404, "Photo not found.");
  await streamPublicImage(res, photo.path);
}));

publicMediaRouter.get("/public/company-logo", domainRoute(async (_req, res) => {
  const [settings] = await db.select({ logo: settingsTable.companyLogoUrl }).from(settingsTable).where(eq(settingsTable.id, 1));
  const path = storedFilePath(settings?.logo ?? "");
  if (filePurpose(path) !== "company-logo" && !isLegacyFilePath(path)) throw new DomainError(404, "Logo not found.");
  await streamPublicImage(res, path);
}));

export default router;
