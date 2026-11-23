import { Router } from "express";
import { z } from "zod";
import { requireOwner, requireRole } from "../middlewares/auth";
import { domainRoute, id, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { storedFilePath } from "../lib/file-store";
import { attachJobDocument, browseMicrosoftFolders,disconnectMicrosoftFiles, finishMicrosoftFilesConnection, jobFiles, microsoftFilesStatus, selectMicrosoftFilesFolder,selectMicrosoftFilesTarget, syncJobMicrosoftFile } from "../lib/microsoft-files";
import { getMicrosoftFilesAuthorization, getMicrosoftFilesConfig, startMicrosoftFilesAuthorization } from "../lib/microsoft-files-graph";

const router = Router(), base = "/microsoft/files", cookieName = "catalyst_microsoft_files_authorization";
const cookies = (secure: boolean) => ({ httpOnly: true, secure, sameSite: "lax" as const, path: `/api${base}/callback` });
const key = z.string().min(8).max(180), identifier = z.string().min(1).max(256).refine((value) => !/[\u0000-\u0020\u007f]/.test(value), "Choose a valid Microsoft resource ID.");
router.use(base, requireOwner);
router.get(`${base}/status`, domainRoute(async (_req, res) => { res.setHeader("Cache-Control", "no-store"); res.json(await microsoftFilesStatus()); }));
router.get(`${base}/folders`,domainRoute(async(req,res)=>{
  const input=parse(z.object({path:z.string().max(6000).optional()}).strict(),req.query);
  let value:unknown=[];try{value=input.path===undefined?[]:JSON.parse(input.path);}catch{throw new DomainError(400,"Choose a valid approved folder path.");}
  const folderPath=parse(z.array(identifier).max(20),value);res.setHeader("Cache-Control","no-store");res.json(await browseMicrosoftFolders(folderPath));
}));
router.post(`${base}/connect`, domainRoute(async (req, res) => {
  const config = getMicrosoftFilesConfig(); if (!config) throw new DomainError(503, "Microsoft file storage is not configured on this company server.");
  const auth = startMicrosoftFilesAuthorization(config, req.auth!.userId, req.auth!.csrfToken);
  res.cookie(cookieName, auth.cookie, { ...cookies(config.redirectUri.startsWith("https:")), maxAge: auth.maxAge }); res.json({ authorizationUrl: auth.authorizationUrl });
}));
router.get(`${base}/callback`, domainRoute(async (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  const config = getMicrosoftFilesConfig(), cookie = req.cookies?.[cookieName], { state, code } = req.query;
  res.clearCookie(cookieName, cookies(config?.redirectUri.startsWith("https:") ?? req.secure));
  const auth = config && typeof cookie === "string" && typeof state === "string" ? getMicrosoftFilesAuthorization(config, cookie, state, req.auth!.userId, req.auth!.csrfToken) : null;
  if (!auth || typeof code !== "string" || !code) { res.redirect("/settings?microsoftFiles=invalid"); return; }
  try { await finishMicrosoftFilesConnection(code, auth.verifier, auth.scope); res.redirect("/settings?microsoftFiles=connected"); }
  catch { res.redirect("/settings?microsoftFiles=failed"); }
}));
router.put(`${base}/target`, domainRoute(async (req, res) => {
  const data = parse(z.union([z.object({folderPath:z.array(identifier).max(20),rootKey:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),z.object({ driveId: identifier, folderId: identifier }).strict()]), req.body);
  res.json("folderPath" in data?await selectMicrosoftFilesFolder(data.folderPath,data.rootKey,req.auth!.userId):await selectMicrosoftFilesTarget(data.driveId, data.folderId, req.auth!.userId));
}));
router.post(`${base}/disconnect`, domainRoute(async (_req, res) => { await disconnectMicrosoftFiles(); res.status(204).end(); }));
const readers = requireRole("owner", "sales", "operations");
router.get("/jobs/:id/files", readers, domainRoute(async (req, res) => { res.setHeader("Cache-Control", "no-store"); res.json(await jobFiles(id(req))); }));
router.post("/jobs/:id/documents", readers, domainRoute(async (req, res) => {
  const data = parse(z.object({ objectPath: z.string().min(1).max(512), idempotencyKey: key }).strict(), req.body);
  res.status(201).json(await attachJobDocument(id(req), storedFilePath(data.objectPath), data.idempotencyKey, req.auth!.userId));
}));
router.post("/jobs/:id/microsoft-files/sync", requireRole("owner", "operations"), domainRoute(async (req, res) => {
  const data = parse(z.object({ sourceType: z.enum(["document", "photo"]), sourceId: identifier, idempotencyKey: key }).strict(), req.body);
  res.json(await syncJobMicrosoftFile(id(req), data.sourceType, data.sourceId, data.idempotencyKey, req.auth!.userId));
}));
export default router;
