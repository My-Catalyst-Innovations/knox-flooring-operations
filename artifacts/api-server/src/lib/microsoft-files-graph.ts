import { createHash } from "node:crypto";
import { z } from "zod";
import { workspaceEnvironment, workspaceScopeKey } from "@workspace/db/workspace";
import { DomainError } from "./operations-rules";
import { getOutlookAuthorization, startOutlookAuthorization, type OutlookConfig } from "./outlook-graph";

export const microsoftFilesScope = "offline_access User.Read Files.SelectedOperations.Selected";
export function getMicrosoftFilesApprovedRoot(env = workspaceEnvironment()) {
  const driveId=env.MICROSOFT_FILES_ROOT_DRIVE_ID,folderId=env.MICROSOFT_FILES_ROOT_FOLDER_ID;
  if(!driveId&&!folderId)return null;
  if(!driveId||!folderId||[driveId,folderId].some(value=>value.length>256||/[\u0000-\u0020\u007f]/.test(value)))
    throw new MicrosoftFilesError(503,"The approved Microsoft company folder is not configured correctly. Ask the administrator to review it.");
  return {driveId,folderId};
}
export function getMicrosoftFilesConfig(env = workspaceEnvironment()): OutlookConfig | null {
  const clientId = env.MICROSOFT_FILES_CLIENT_ID, clientSecret = env.MICROSOFT_FILES_CLIENT_SECRET, secret = env.MICROSOFT_FILES_ENCRYPTION_KEY,
    redirectUri = env.MICROSOFT_FILES_REDIRECT_URI, tenant = env.MICROSOFT_FILES_TENANT_ID || "organizations";
  if (!clientId || !clientSecret || !secret || secret.length < 32 || !redirectUri || !/^(organizations|[0-9a-f-]{36}|[a-z0-9.-]+\.onmicrosoft\.com)$/i.test(tenant)) return null;
  try {
    const url = new URL(redirectUri);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.pathname !== "/api/microsoft/files/callback" || url.username || url.password || url.search || url.hash) return null;
  } catch { return null; }
  return { clientId, clientSecret, redirectUri, authority: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`, scope: microsoftFilesScope,
    encryptionKey: createHash("sha256").update(`microsoft-files\0${workspaceScopeKey()}\0${clientId}\0${redirectUri}\0${secret}`).digest() };
}
export const startMicrosoftFilesAuthorization = (config: OutlookConfig, userId: string, csrf: string) => startOutlookAuthorization(config, userId, csrf);
export function getMicrosoftFilesAuthorization(config: OutlookConfig, cookie: string, state: string, userId: string, csrf: string) {
  const saved = getOutlookAuthorization(config, cookie, state, userId, csrf);
  return saved?.scope === microsoftFilesScope ? saved : null;
}
export function hasSelectedFilesScope(scope: string | undefined | null) {
  return (scope ?? "").split(/\s+/).some((value) => value.replace(/^https:\/\/graph.microsoft.com\//i, "").toLowerCase() === "files.selectedoperations.selected");
}
export function safeMicrosoftWebUrl(value: string | undefined | null) {
  try { const url = new URL(value!); return url.protocol === "https:" && !url.username && !url.password && !url.port && (url.hostname.endsWith(".sharepoint.com") || url.hostname === "onedrive.live.com" || url.hostname.endsWith(".onedrive.com")) ? url.toString() : null; }
  catch { return null; }
}
export class MicrosoftFilesError extends DomainError {
  constructor(status: number, message: string, readonly uncertain = false) { super(status, message); }
}

/** Microsoft's documented QuickXor content checksum; SHA-256 separately fixes
 * local source identity and the immutable provider filename. */
export function quickXorHash(bytes: Buffer) {
  const hash = Buffer.alloc(20);
  for (let i = 0; i < bytes.length; i++) {
    const shift = (i % 160) * 11 % 160, index = Math.floor(shift / 8), bit = shift % 8;
    hash[index] ^= (bytes[i] << bit) & 255;
    hash[(index + 1) % 20] ^= bytes[i] >>> (8 - bit);
  }
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(bytes.length));
  for (let i = 0; i < 8; i++) hash[12 + i] ^= length[i];
  return hash.toString("base64");
}
export function safeMicrosoftName(name: string, max = 80) {
  return name.normalize("NFKC").replace(/[\u0000-\u001f\u007f"*:<>?\/\\|#%]/g, "_").replace(/^[ .]+|[ .]+$/g, "").slice(0, max).replace(/[\uD800-\uDBFF]$/g, "").replace(/[ .]+$/g, "") || "attachment";
}
const identity = z.object({ application: z.object({ id: z.string() }).optional() }).passthrough();
const permission = z.object({ roles: z.array(z.string()), grantedToV2: identity.optional(), grantedTo: identity.optional(), grantedToIdentitiesV2: z.array(identity).optional(), grantedToIdentities: z.array(identity).optional() });
export function permissionAllowsSelectedWrite(value: z.output<typeof permission>, clientId: string) {
  const principals = [value.grantedToV2, value.grantedTo, ...(value.grantedToIdentitiesV2 ?? []), ...(value.grantedToIdentities ?? [])];
  return value.roles.some((role) => ["write", "owner", "fullcontrol"].includes(role.toLowerCase())) && principals.some((principal) => principal?.application?.id.toLowerCase() === clientId.toLowerCase());
}
const itemModel = z.object({ id: z.string().min(1), name: z.string().min(1), size: z.number().int().nonnegative().optional(), webUrl: z.string().optional(),
  parentReference: z.object({ id: z.string().optional(), driveId: z.string().optional() }).optional(), folder: z.object({}).passthrough().optional(), remoteItem: z.unknown().optional(),
  file: z.object({ hashes: z.object({ quickXorHash: z.string().optional(), sha1Hash: z.string().optional() }).optional() }).passthrough().optional() });
export type MicrosoftDriveItem = z.output<typeof itemModel>;
export function verifyMirroredItem(item: MicrosoftDriveItem, folderId: string, driveId: string, name: string, bytes: Buffer) {
  if (item.name !== name || item.parentReference?.id !== folderId || item.parentReference?.driveId !== driveId || !item.file || item.remoteItem || item.size !== bytes.length)
    throw new MicrosoftFilesError(409, "The Microsoft item does not match this immutable attachment. Review it before retrying.");
  const hashes = item.file.hashes;
  if (hashes?.sha1Hash ? hashes.sha1Hash.toLowerCase() !== createHash("sha1").update(bytes).digest("hex") : hashes?.quickXorHash !== quickXorHash(bytes))
    throw new MicrosoftFilesError(409, "Microsoft has not confirmed matching file contents. Review the target file; it will not be overwritten.");
}

export function microsoftFilesGraph(token: string, fetchImpl = fetch) {
  async function request(resource: string, options: RequestInit = {}) {
    const url = new URL(resource.startsWith("/") ? `/v1.0${resource}` : resource, "https://graph.microsoft.com");
    if (url.origin !== "https://graph.microsoft.com" || !url.pathname.startsWith("/v1.0/") || url.username || url.password) throw new MicrosoftFilesError(502, "Microsoft returned an invalid file continuation.");
    const writing = options.method === "POST" || options.method === "PUT";
    const response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(writing ? 60_000 : 10_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...Object.fromEntries(new Headers(options.headers).entries()) } }).catch(() => {
      throw new MicrosoftFilesError(502, "Microsoft did not confirm this file operation. Retry to reconcile the exact attachment without overwriting files.", writing);
    });
    if (response.ok) return response;
    await response.body?.cancel();
    if (response.status === 401) throw new MicrosoftFilesError(401, "Reconnect the Microsoft file account in Settings.");
    if (response.status === 403) throw new MicrosoftFilesError(403, "The connected app and user need an administrator-approved selected-folder write grant. Catalyst cannot grant itself access.");
    if (response.status === 404) throw new MicrosoftFilesError(404, "The selected Microsoft folder or file was not found.");
    if ([409, 412].includes(response.status)) throw new MicrosoftFilesError(409, "The Microsoft name already exists. It will be verified without overwriting it.");
    throw new MicrosoftFilesError(response.status === 429 ? 429 : 502, "Microsoft files are temporarily unavailable. Retry this attachment later.", writing && (response.status >= 500 || response.status === 408));
  }
  async function read<T extends z.ZodType>(path: string, model: T, options?: RequestInit) {
    const response = await request(path, options), data = model.safeParse(await response.json().catch(() => null));
    if (!data.success) throw new MicrosoftFilesError(502, "Microsoft returned incomplete file information.", options?.method === "POST" || options?.method === "PUT");
    return { data: data.data, status: response.status };
  }
  const path = (driveId: string, itemId: string) => `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
  const selected = "$select=id,name,parentReference,folder,file,size,webUrl,remoteItem";
  return {
    async account() { return (await read("/me?$select=id,mail,userPrincipalName", z.object({ id: z.string().min(1), mail: z.string().nullish(), userPrincipalName: z.string().nullish() }))).data; },
    async item(driveId: string, itemId: string) { return (await read(`${path(driveId, itemId)}?${selected}`, itemModel)).data; },
    async target(driveId: string, itemId: string, clientId: string) {
      const item = (await read(`${path(driveId, itemId)}?${selected}`, itemModel)).data;
      if (item.id!==itemId || (item.parentReference?.driveId&&item.parentReference.driveId!==driveId) || !item.folder || item.remoteItem) throw new MicrosoftFilesError(400, "Choose an actual SharePoint or OneDrive folder, rather than a file or shortcut.");
      let next: string | undefined = `${path(driveId, itemId)}/permissions?$select=roles,grantedToV2,grantedTo,grantedToIdentitiesV2,grantedToIdentities`;
      let allowed = false;
      for (let page = 0; next && page < 10; page++) {
        const result: { value: z.output<typeof permission>[]; "@odata.nextLink"?: string } = (await read(next, z.object({ value: z.array(permission), "@odata.nextLink": z.string().optional() }))).data;
        allowed ||= result.value.some((entry) => permissionAllowsSelectedWrite(entry, clientId)); next = result["@odata.nextLink"];
      }
      if (next || !allowed) throw new MicrosoftFilesError(403, "No matching selected-folder write grant was confirmed for this app. Ask the Microsoft resource administrator to grant this app access to this folder.");
      return item;
    },
    async folders(driveId:string,parentId:string) {
      const resource=`${path(driveId,parentId)}/children`;
      let next:string|undefined=`${resource}?$select=id,name,folder,remoteItem,parentReference,webUrl&$top=100`;
      const seen=new Set<string>(),folders=new Map<string,MicrosoftDriveItem>();
      for(let page=0;next&&page<10;page++) {
        const continuation=new URL(next.startsWith("/")?`/v1.0${next}`:next,"https://graph.microsoft.com");
        if(continuation.origin!=="https://graph.microsoft.com"||continuation.pathname!==`/v1.0${resource}`||continuation.username||continuation.password||continuation.hash||seen.has(continuation.href))
          throw new MicrosoftFilesError(502,"Microsoft returned an invalid approved-folder continuation.");
        seen.add(continuation.href);
        const result:{value:MicrosoftDriveItem[];"@odata.nextLink"?:string}=(await read(next,z.object({value:z.array(itemModel).max(100),"@odata.nextLink":z.string().optional()}))).data;
        for(const item of result.value) {
          if(!item.folder||item.remoteItem)continue;
          if(item.parentReference?.id!==parentId||item.parentReference?.driveId!==driveId)throw new MicrosoftFilesError(409,"A folder moved outside the approved location. Refresh this folder.");
          if(folders.has(item.id))throw new MicrosoftFilesError(409,"Microsoft folders changed during browsing. Refresh the folder list.");
          folders.set(item.id,item);
        }
        next=result["@odata.nextLink"];
      }
      return {folders:[...folders.values()].sort((a,b)=>a.name.localeCompare(b.name)),complete:!next};
    },
    async child(driveId: string, parentId: string, name: string) {
      try { return (await read(`${path(driveId, parentId)}:/${encodeURIComponent(name)}?${selected}`, itemModel)).data; }
      catch (error) { if (error instanceof MicrosoftFilesError && error.status === 404) return null; throw error; }
    },
    async folder(driveId: string, parentId: string, name: string) {
      return (await read(`${path(driveId, parentId)}/children`, itemModel, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }) })).data;
    },
    async upload(driveId: string, parentId: string, name: string, bytes: Buffer) {
      const response = await read(`${path(driveId, parentId)}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`, itemModel, {
        method: "PUT", headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" }, body: bytes as NonNullable<RequestInit["body"]>,
      });
      if (response.status !== 201) throw new MicrosoftFilesError(409, "Microsoft did not confirm creation of a new file. Review the target; existing content will not be replaced.", true);
      return response.data;
    },
  };
}
