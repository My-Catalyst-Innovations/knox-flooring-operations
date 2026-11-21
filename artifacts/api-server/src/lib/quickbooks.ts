import { workspaceEnvironment } from "@workspace/db/workspace";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, quickbooksConnectionsTable } from "@workspace/db";

const getKey = () => {
  const value = workspaceEnvironment().QUICKBOOKS_ENCRYPTION_KEY;
  if (!value) throw new Error("QUICKBOOKS_ENCRYPTION_KEY is not configured");
  return createHash("sha256").update(value).digest();
};

export function encryptSecret(value: string) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(value: string) {
  const [iv, tag, data] = value.split(".");
  if (!iv || !tag || !data) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export function signOAuthState(value: string) { return `${value}.${createHmac("sha256", getKey()).update(value).digest("base64url")}`; }
export function verifyOAuthState(signed: string) { const pos = signed.lastIndexOf("."); if (pos < 1) return null; const value = signed.slice(0, pos); return signOAuthState(value) === signed ? value : null; }

const apiBase = () => workspaceEnvironment().QUICKBOOKS_ENVIRONMENT === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";

async function refresh(connection: typeof quickbooksConnectionsTable.$inferSelect) {
  const auth = Buffer.from(`${workspaceEnvironment().QUICKBOOKS_CLIENT_ID}:${workspaceEnvironment().QUICKBOOKS_CLIENT_SECRET}`).toString("base64");
  const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", { method: "POST", headers: { Authorization: `Basic ${auth}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: decryptSecret(connection.encryptedRefreshToken) }) });
  if (!response.ok) { await db.update(quickbooksConnectionsTable).set({ status: "reconnect_required", updatedAt: new Date().toISOString() }).where(eq(quickbooksConnectionsTable.id, connection.id)); throw new Error("QuickBooks authorization expired; reconnect required"); }
  const tokens = await response.json() as { access_token: string; refresh_token: string; expires_in: number; x_refresh_token_expires_in: number };
  const now = Date.now(); const [updated] = await db.update(quickbooksConnectionsTable).set({ encryptedAccessToken: encryptSecret(tokens.access_token), encryptedRefreshToken: encryptSecret(tokens.refresh_token), accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000).toISOString(), refreshTokenExpiresAt: new Date(now + tokens.x_refresh_token_expires_in * 1000).toISOString(), status: "connected", updatedAt: new Date().toISOString() }).where(and(eq(quickbooksConnectionsTable.id, connection.id), eq(quickbooksConnectionsTable.status, "connected"))).returning();
  if (!updated) throw new Error("QuickBooks disconnected while renewing authorization.");
  return updated;
}

export async function getConnection() { const [row] = await db.select().from(quickbooksConnectionsTable).limit(1); return row ?? null; }

export class QuickBooksRequestError extends Error {
  constructor(message: string, readonly status: number, readonly faultType?: string, readonly faultCode?: string) {
    super(message);
  }
}

export async function qboRequest(path: string, init: RequestInit = {}, expectedConnectionId?: string) {
  let connection = await getConnection();
  if (connection?.status !== "connected") throw new Error("QuickBooks is not connected");
  if (expectedConnectionId && connection.id !== expectedConnectionId) throw new Error("The QuickBooks connection changed. Confirm the company and try again.");
  const send = (current: typeof quickbooksConnectionsTable.$inferSelect) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${decryptSecret(current.encryptedAccessToken)}`);
    headers.set("Accept", "application/json");
    headers.set("Content-Type", "application/json");
    return fetch(`${apiBase()}/v3/company/${current.realmId}${path}${path.includes("?") ? "&" : "?"}minorversion=75`, { ...init, headers });
  };
  if (new Date(connection.accessTokenExpiresAt).getTime() < Date.now() + 60_000) connection = await refresh(connection);
  let response = await send(connection);
  if (response.status === 401) response = await send(await refresh(connection));
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fault = (body as any)?.Fault;
    const error = fault?.Error?.[0];
    throw new QuickBooksRequestError(
      error?.Detail ?? error?.Message ?? `QuickBooks request failed (${response.status})`,
      response.status, fault?.type, error?.code === undefined ? undefined : String(error.code),
    );
  }
  return body as any;
}

export async function qboQuery(query: string, expectedConnectionId?: string) { return qboRequest(`/query?query=${encodeURIComponent(query)}`, {}, expectedConnectionId); }
