import { workspaceEnvironment, workspaceScopeKey } from "@workspace/db/workspace";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { AppRole } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { DomainError } from "./operations-rules";

export const fileRoles = {
  "job-photo": ["owner", "sales", "operations", "installer"],
  "portal-photo": ["owner", "sales", "operations", "installer"],
  "lead-document": ["owner", "sales"],
  "product-image": ["owner", "operations"],
  "company-logo": ["owner"],
} satisfies Record<string, AppRole[]>;
export type FilePurpose = keyof typeof fileRoles;

const legacyStorage = new ObjectStorageService();
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const managedPath = new RegExp(`^/objects/files/([a-z-]+)/(${uuid})$`);
const legacyPath = new RegExp(`^/objects/uploads/${uuid}$`);
export const maxFileBytes = 15 * 1024 * 1024;
const previewMs = 20 * 60_000;
const inlineTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function isFilePurpose(value: string): value is FilePurpose {
  return Object.hasOwn(fileRoles, value);
}

export function canUploadFile(purpose: FilePurpose, role: AppRole): boolean {
  const roles: readonly AppRole[] = fileRoles[purpose];
  return roles.includes(role);
}

export function filePurpose(path: string): FilePurpose | null {
  const match = managedPath.exec(path);
  return match && isFilePurpose(match[1]) ? match[1] : null;
}

export function isLegacyFilePath(path: string): boolean {
  return legacyPath.test(path);
}

export function storedFilePath(value: string): string {
  return value.startsWith("/api/storage/objects/") ? value.slice("/api/storage".length) : value;
}

export function isPortalPhoto(path: string): boolean {
  return filePurpose(path) === "portal-photo";
}

export function externalImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function publishedLogoUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const path = storedFilePath(value);
  if (filePurpose(path) === "company-logo" || isLegacyFilePath(path)) return "/api/public/company-logo";
  return externalImageUrl(value) ? value : null;
}

export function uploadContentType(purpose: FilePurpose, bytes: Buffer): string {
  if (purpose === "lead-document") return "application/octet-stream";
  if (bytes.length >= 4 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  throw new DomainError(415, "Choose a JPEG, PNG, WebP or GIF image.");
}

interface StoredFileMeta {
  uploader: string;
  recordId: string;
  name: string;
  uploadedAt: string;
}

interface FileStore {
  put(key: string, bytes: Buffer, type: string, metadata: StoredFileMeta): Promise<void>;
  metadata(key: string): Promise<StoredFileMeta | null>;
  get(key: string): Promise<FileDownload | null>;
}

export interface FileDownload {
  body: Readable;
  type: string;
  length?: string;
  name?: string;
}

const metaKeys = ["uploader", "recordId", "name", "uploadedAt"] as const;
const encoded = (value: string) => Buffer.from(value).toString("base64url");
const decoded = (value: string) => Buffer.from(value, "base64url").toString("utf8");

function decodeMetadata(read: (key: string) => string | null | undefined): StoredFileMeta | null {
  const [uploader, recordId, name, uploadedAt] = metaKeys.map((key) => decoded(read(key.toLowerCase()) ?? ""));
  return uploader && name && Number.isFinite(Date.parse(uploadedAt)) ? { uploader, recordId, name, uploadedAt } : null;
}

export function createAzureFileStore(account: string, container: string, identityEndpoint: string, identityHeader: string, request = fetch): FileStore {
  const accountUrl = new URL(account);
  if (accountUrl.origin !== accountUrl.href.replace(/\/$/, "") || !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(accountUrl.origin) || !/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(container)) {
    throw new Error("Invalid Azure Blob account URL or container name.");
  }
  const tokenUrl = new URL(identityEndpoint);
  tokenUrl.searchParams.set("resource", "https://storage.azure.com/");
  tokenUrl.searchParams.set("api-version", "2019-08-01");
  let cachedToken: { token: string; expiresAt: number } | undefined;
  let refreshing: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const response = await request(tokenUrl, {
      headers: { "X-IDENTITY-HEADER": identityHeader },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Azure managed identity request failed with HTTP ${response.status}.`);
    const metadata = await response.json() as { access_token?: string; expires_on?: string | number };
    if (typeof metadata.access_token !== "string" || !metadata.access_token) throw new Error("Azure managed identity returned no token.");
    const seconds = Number(metadata.expires_on);
    if (Number.isFinite(seconds)) cachedToken = { token: metadata.access_token, expiresAt: seconds * 1000 };
    return metadata.access_token;
  }

  async function call(key: string, method: string, headers: Record<string, string> = {}, bytes?: Buffer): Promise<Response> {
    const token = cachedToken && cachedToken.expiresAt > Date.now() + 60_000
      ? cachedToken.token
      : await (refreshing ??= fetchToken().finally(() => { refreshing = undefined; }));
    const blobUrl = `${accountUrl.origin}/${container}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const response = await request(blobUrl, {
      method,
      headers: { Authorization: `Bearer ${token}`, "x-ms-version": "2023-11-03", "x-ms-date": new Date().toUTCString(), ...headers },
      body: bytes as NonNullable<Parameters<typeof fetch>[1]>["body"],
      redirect: "error",
      signal: AbortSignal.timeout(method === "HEAD" ? 10_000 : 60_000),
    });
    const errorCode = response.headers.get("x-ms-error-code");
    if (response.ok || (response.status === 404 && errorCode === "BlobNotFound")) return response;
    if (response.status === 401) cachedToken = undefined;
    await response.body?.cancel();
    if (method === "PUT" && (response.status === 409 || response.status === 412)) throw new DomainError(409, "Please retry with a new upload.");
    throw new Error(`Azure Blob ${method} failed with HTTP ${response.status}${errorCode ? ` (${errorCode})` : ""}.`);
  }

  return {
    async put(key, bytes, type, metadata) {
      const headers: Record<string, string> = {
        "Content-Type": type,
        "x-ms-blob-type": "BlockBlob",
        "If-None-Match": "*",
      };
      for (const field of metaKeys) {
        if (metadata[field]) headers[`x-ms-meta-${field.toLowerCase()}`] = encoded(metadata[field]);
      }
      const response = await call(key, "PUT", headers, bytes);
      if (!response.ok) throw new Error("Azure Blob container could not be written.");
    },
    async metadata(key) {
      const response = await call(key, "HEAD");
      return response.ok ? decodeMetadata((field) => response.headers.get(`x-ms-meta-${field}`)) : null;
    },
    async get(key) {
      const response = await call(key, "GET");
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return null;
      }
      return {
        body: Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        type: response.headers.get("content-type") ?? "application/octet-stream",
        length: response.headers.get("content-length") ?? undefined,
        name: decoded(response.headers.get("x-ms-meta-name") ?? ""),
      };
    },
  };
}

const replitFileStore: FileStore = {
  async put(key, bytes, type, metadata) {
    const file = legacyStorage.getPrivateObjectFile(key);
    await file.save(bytes, {
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { contentType: type, metadata: Object.fromEntries(metaKeys.map((field) => [field.toLowerCase(), encoded(metadata[field])])) },
    });
  },
  async metadata(key) {
    const file = legacyStorage.getPrivateObjectFile(key);
    try {
      const [data] = await file.getMetadata();
      return decodeMetadata((field) => typeof data.metadata?.[field] === "string" ? data.metadata[field] : undefined);
    } catch (error) {
      if ((error as { code?: number }).code === 404) return null;
      throw error;
    }
  },
  async get(key) {
    const file = legacyStorage.getPrivateObjectFile(key);
    try {
      const [data] = await file.getMetadata();
      return {
        body: file.createReadStream(),
        type: data.contentType ?? "application/octet-stream",
        length: data.size === undefined ? undefined : String(data.size),
        name: typeof data.metadata?.name === "string" ? decoded(data.metadata.name) : undefined,
      };
    } catch (error) {
      if ((error as { code?: number }).code === 404) return null;
      throw error;
    }
  },
};

const azureFileStores = new Map<string, FileStore>();
function configuredStore(): FileStore {
  const { AZURE_STORAGE_ACCOUNT_URL, AZURE_STORAGE_CONTAINER, IDENTITY_ENDPOINT, IDENTITY_HEADER, PRIVATE_OBJECT_DIR } = workspaceEnvironment();
  if (AZURE_STORAGE_ACCOUNT_URL || AZURE_STORAGE_CONTAINER) {
    if (!AZURE_STORAGE_ACCOUNT_URL || !AZURE_STORAGE_CONTAINER || !IDENTITY_ENDPOINT || !IDENTITY_HEADER) {
      throw new DomainError(503, "File storage is waiting for Azure managed identity configuration.");
    }
    const key = workspaceScopeKey();
    let store = azureFileStores.get(key);
    if (!store) {
      store = createAzureFileStore(AZURE_STORAGE_ACCOUNT_URL, AZURE_STORAGE_CONTAINER, IDENTITY_ENDPOINT, IDENTITY_HEADER);
      azureFileStores.set(key, store);
    }
    return store;
  }
  if (PRIVATE_OBJECT_DIR) return replitFileStore;
  throw new DomainError(503, "File storage is not configured.");
}

export async function saveFile(purpose: FilePurpose, bytes: Buffer, uploader: string, recordId: string, name: string): Promise<string> {
  if (bytes.length < 1 || bytes.length > maxFileBytes) throw new DomainError(400, "Choose a file up to 15 MB.");
  const type = uploadContentType(purpose, bytes);
  const key = `files/${purpose}/${randomUUID()}`;
  await configuredStore().put(key, bytes, type, { uploader, recordId, name, uploadedAt: new Date().toISOString() });
  return `/objects/${key}`;
}

export function getFileMetadata(path: string): Promise<StoredFileMeta | null> {
  return filePurpose(path) ? configuredStore().metadata(path.slice("/objects/".length)) : Promise.resolve(null);
}

export async function assertOwnedFile(path: string, purposes: FilePurpose[], uploader: string, recordId: string): Promise<void> {
  const purpose = filePurpose(path);
  const metadata = purpose && purposes.includes(purpose) ? await getFileMetadata(path) : null;
  if (!metadata || metadata.uploader !== uploader || metadata.recordId !== recordId) {
    throw new DomainError(400, "Select and upload the file for this record before saving it.");
  }
}

export function isUploaderPreview(metadata: StoredFileMeta, uploader: string): boolean {
  return metadata.uploader === uploader && Date.now() - Date.parse(metadata.uploadedAt) < previewMs;
}

export function getFile(path: string): Promise<FileDownload | null> {
  if (filePurpose(path)) return configuredStore().get(path.slice("/objects/".length));
  const env = workspaceEnvironment();
  if (isLegacyFilePath(path) && (env.AZURE_STORAGE_ACCOUNT_URL || env.AZURE_STORAGE_CONTAINER || env.PRIVATE_OBJECT_DIR)) {
    return configuredStore().get(path.slice("/objects/".length));
  }
  return Promise.resolve(null);
}

export function safeFileHeaders(file: FileDownload, attachment: boolean): Record<string, string> {
  const inline = !attachment && inlineTypes.has(file.type);
  const name = Buffer.from(file.name || "download").toString("utf8").replace(/[\u0000-\u001f\u007f/\\]/g, "_");
  const encodedName = encodeURIComponent(name).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    "Content-Type": inline ? file.type : "application/octet-stream",
    "Content-Disposition": inline ? "inline" : `attachment; filename*=UTF-8''${encodedName}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    ...(file.length ? { "Content-Length": file.length } : {}),
  };
}
