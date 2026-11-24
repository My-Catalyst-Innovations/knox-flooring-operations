import { workspaceEnvironment } from "@workspace/db/workspace";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { auditEventsTable, db, quickbooksConnectionsTable } from "@workspace/db";
import { QuickBooksProjectsError, graphData } from "./quickbooks-projects-graph";
import { DomainError } from "./operations-rules";

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
export function verifyOAuthState(signed: string) { const pos = signed.lastIndexOf("."); if (pos < 1) return null; const value = signed.slice(0, pos), expected=Buffer.from(signOAuthState(value)), received=Buffer.from(signed); return expected.length===received.length&&timingSafeEqual(expected,received) ? value : null; }

export const accountingScope="com.intuit.quickbooks.accounting";
export const projectsScope="project-management.project";
export function grantedQuickBooksScopes(returned:unknown,requested:readonly string[]) {
  const allowed=new Set(requested);
  // Intuit omits scope in its documented token response. Only a successful exchange may
  // use the exact immutable request bound to OAuth state; refresh retains its saved grant.
  if(returned===undefined)return [...allowed];
  if(typeof returned!=="string")throw new Error("QuickBooks returned invalid authorization scopes.");
  const scopes=[...new Set(returned.split(/\s+/).filter(Boolean))];
  if(scopes.some(scope=>!allowed.has(scope)))throw new Error("QuickBooks returned an unrequested authorization scope.");
  return scopes;
}
export type QuickBooksOAuthLifecycle = { connectionId: string; status: string; revocationStatus: string | null } | null;
export function quickBooksConnectionLifecycle(connection: Pick<typeof quickbooksConnectionsTable.$inferSelect, "id" | "status" | "readinessStatus"> | null | undefined): QuickBooksOAuthLifecycle {
  return connection ? { connectionId: connection.id, status: connection.status, revocationStatus: connection.readinessStatus?.startsWith("revocation_") ? connection.readinessStatus : null } : null;
}
export function createQuickBooksOAuthState(userId:string,csrfToken:string,now=Date.now(),requestedScopes:readonly string[]=[accountingScope],connectionLifecycle:QuickBooksOAuthLifecycle=null) {
  if(!requestedScopes.includes(accountingScope)||requestedScopes.some(scope=>![accountingScope,projectsScope].includes(scope)))throw new Error("Invalid QuickBooks requested scopes.");
  return signOAuthState(JSON.stringify({userId,sessionHash:createHash("sha256").update(csrfToken).digest("hex"),issuedAt:now,nonce:randomBytes(24).toString("hex"),requestedScopes:[...new Set(requestedScopes)],connectionLifecycle}));
}
export function quickBooksOAuthRequestedScopes(state:string) {
  const value=verifyOAuthState(state);if(!value)throw new Error("Invalid QuickBooks authorization state.");
  const data=JSON.parse(value);const scopes=data.requestedScopes??[accountingScope];
  if(!Array.isArray(scopes)||!scopes.includes(accountingScope)||scopes.some(scope=>![accountingScope,projectsScope].includes(scope)))throw new Error("Invalid QuickBooks authorization scopes.");
  return scopes as string[];
}
export function quickBooksOAuthConnectionLifecycle(state:string):QuickBooksOAuthLifecycle {
  const value=verifyOAuthState(state);if(!value)throw new Error("Invalid QuickBooks authorization state.");
  const data=JSON.parse(value);
  if(!Object.prototype.hasOwnProperty.call(data,"connectionLifecycle"))throw new Error("Start a new QuickBooks connection.");
  const lifecycle=data.connectionLifecycle;
  if(lifecycle===null)return null;
  if(typeof lifecycle!=="object"||typeof lifecycle.connectionId!=="string"||!lifecycle.connectionId||typeof lifecycle.status!=="string"||!lifecycle.status||!(lifecycle.revocationStatus===null||typeof lifecycle.revocationStatus==="string"&&lifecycle.revocationStatus.startsWith("revocation_")))throw new Error("Invalid QuickBooks connection lifecycle.");
  return {connectionId:lifecycle.connectionId,status:lifecycle.status,revocationStatus:lifecycle.revocationStatus};
}
export function validQuickBooksOAuthState(state:string,userId:string,csrfToken:string,now=Date.now()) {
  const value=verifyOAuthState(state);if(!value)return false;
  try{const data=JSON.parse(value);quickBooksOAuthRequestedScopes(state);quickBooksOAuthConnectionLifecycle(state);return data.userId===userId&&data.sessionHash===createHash("sha256").update(csrfToken).digest("hex")&&Number.isSafeInteger(data.issuedAt)&&data.issuedAt<=now&&now-data.issuedAt<=600_000&&typeof data.nonce==="string"&&data.nonce.length===48;}catch{return false;}
}
export async function consumeQuickBooksOAuthState(state:string,userId:string) {
  // The immutable audit primary key also provides a durable, single-use nonce across instances.
  const [claimed]=await db.insert(auditEventsTable).values({id:`qbo-oauth:${createHash("sha256").update(state).digest("hex")}`,actorUserId:userId,action:"quickbooks.oauth_state_consumed",entityType:"quickbooks",createdAt:new Date().toISOString()}).onConflictDoNothing().returning({id:auditEventsTable.id});
  return Boolean(claimed);
}
export const quickBooksProjectReadiness=()=>({verified:false,readiness:"blocked",legacySubcustomersPreserved:true,detail:"True QuickBooks Projects API access is not verified. Existing legacy subcustomer links remain intact, but new Project exports are blocked; a subcustomer is not a QuickBooks Project."});
export function requireQuickBooksProjects():never {throw new Error(quickBooksProjectReadiness().detail);}

const apiBase = (environment:string) => environment === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";

async function refresh(connection: typeof quickbooksConnectionsTable.$inferSelect) {
  const outcome=await db.transaction(async tx=>{
  const [current]=await tx.select().from(quickbooksConnectionsTable).where(eq(quickbooksConnectionsTable.id,connection.id)).for("update");
  if(current?.status!=="connected")throw new Error("QuickBooks disconnected while renewing authorization.");
  // Another process may have rotated this token while this request waited for its row lock.
  if(current.encryptedAccessToken!==connection.encryptedAccessToken&&Date.parse(current.accessTokenExpiresAt)>Date.now()+60_000)return {connection:current};
  const auth = Buffer.from(`${workspaceEnvironment().QUICKBOOKS_CLIENT_ID}:${workspaceEnvironment().QUICKBOOKS_CLIENT_SECRET}`).toString("base64");
  const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", { method: "POST", signal:AbortSignal.timeout(20_000), headers: { Authorization: `Basic ${auth}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: decryptSecret(current.encryptedRefreshToken) }) });
  if (!response.ok) {
    if(response.status===400||response.status===401){await tx.update(quickbooksConnectionsTable).set({status:"reconnect_required",updatedAt:new Date().toISOString()}).where(eq(quickbooksConnectionsTable.id,current.id));return {error:new QuickBooksRequestError("QuickBooks authorization expired; reconnect required",response.status)};}
    throw new QuickBooksRequestError(`QuickBooks token service is unavailable (${response.status}); retry later`,response.status);
  }
  const tokens = await response.json() as { access_token: string; refresh_token: string; expires_in: number; x_refresh_token_expires_in: number;scope?:unknown };
  if(typeof tokens?.access_token!=="string"||!tokens.access_token||typeof tokens?.refresh_token!=="string"||!tokens.refresh_token||!Number.isFinite(tokens.expires_in)||tokens.expires_in<=0||!Number.isFinite(tokens.x_refresh_token_expires_in)||tokens.x_refresh_token_expires_in<=0)throw new QuickBooksRequestError("QuickBooks returned incomplete token rotation; retry or reconnect",502);
  const grantedScopes=grantedQuickBooksScopes(tokens.scope,current.grantedScopes??[]);
  const now = Date.now(); const [updated] = await tx.update(quickbooksConnectionsTable).set({ grantedScopes,encryptedAccessToken: encryptSecret(tokens.access_token), encryptedRefreshToken: encryptSecret(tokens.refresh_token), accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000).toISOString(), refreshTokenExpiresAt: new Date(now + tokens.x_refresh_token_expires_in * 1000).toISOString(), status: "connected", updatedAt: new Date().toISOString() }).where(and(eq(quickbooksConnectionsTable.id, connection.id), eq(quickbooksConnectionsTable.status, "connected"))).returning();
  if (!updated) throw new Error("QuickBooks disconnected while renewing authorization.");
  return {connection:updated};
  });
  if(outcome.error)throw outcome.error;
  return outcome.connection!;
}

export async function replaceQuickBooksConnection(valuesOrExchange:typeof quickbooksConnectionsTable.$inferInsert | (() => Promise<typeof quickbooksConnectionsTable.$inferInsert>),expectedLifecycle?:QuickBooksOAuthLifecycle) {
  await db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
    const [previous]=await tx.select().from(quickbooksConnectionsTable).where(sql`TRUE`).for("update");
    assertQuickBooksRevocationResolved(previous);
    if(typeof valuesOrExchange==="function"&&expectedLifecycle===undefined)throw new DomainError(409,"Start a new QuickBooks connection before authorizing this company.");
    if(expectedLifecycle!==undefined&&JSON.stringify(quickBooksConnectionLifecycle(previous))!==JSON.stringify(expectedLifecycle))throw new DomainError(409,"This QuickBooks authorization began before the connection changed or was stopped. Start a new connection from settings.");
    // Serialize OAuth token exchange too: an already-open consent tab must not mint
    // an untracked replacement grant while the previous grant is being revoked.
    const values=typeof valuesOrExchange==="function"?await valuesOrExchange():valuesOrExchange;
    await tx.delete(quickbooksConnectionsTable);
    await tx.insert(quickbooksConnectionsTable).values(values);
  });
}

export async function getConnection() { const [row] = await db.select().from(quickbooksConnectionsTable).limit(1); return row ?? null; }

type QuickBooksConnection = typeof quickbooksConnectionsTable.$inferSelect;
type RevocationState = "pending" | "unknown" | "failed" | "confirmed" | "not_connected" | "not_requested";
export type QuickBooksDisconnectResult = { locallyDisconnected: true; revocation: RevocationState; message: string };
const revocationMessage: Record<RevocationState, string> = {
  pending: "Works has stopped using this connection. Intuit has not confirmed revocation yet. Wait briefly, then retry revocation if needed.",
  unknown: "Works has stopped using this connection, but Intuit did not confirm revocation. Retry revocation for this same saved grant before reconnecting.",
  failed: "Works has stopped using this connection. Intuit did not confirm revocation. Review the connection configuration, then retry revocation for this same saved grant.",
  confirmed: "Works is disconnected and Intuit confirmed that access was revoked.",
  not_connected: "Works has no active connection. Intuit revocation has not been verified for a previously disconnected grant.",
  not_requested: "Works is locally stopped, but no provider revocation outcome is recorded. An owner must explicitly retry the retained grant before reconnecting. If the original grant or configuration is unavailable, operator review is required.",
};
const revocationResult = (revocation: RevocationState): QuickBooksDisconnectResult => ({ locallyDisconnected: true, revocation, message: revocationMessage[revocation] });
type RevocationConnection = Pick<QuickBooksConnection, "readinessStatus"> & Partial<Pick<QuickBooksConnection, "status">>;
export function unresolvedQuickBooksRevocation(connection: RevocationConnection | null | undefined) {
  return (connection?.status === "disconnected" && connection.readinessStatus !== "revocation_confirmed") || ["revocation_pending", "revocation_unknown", "revocation_failed"].includes(connection?.readinessStatus ?? "");
}
export function assertQuickBooksRevocationResolved(connection: RevocationConnection | null | undefined) {
  if (unresolvedQuickBooksRevocation(connection)) throw new DomainError(409, "Finish revoking the previous QuickBooks grant before connecting again. Retry revocation in QuickBooks settings.");
}
/** Local retry feasibility only; this does not verify a provider grant or its outcome. */
export function quickBooksRevocationRetryAvailable(connection: Pick<QuickBooksConnection, "encryptedRefreshToken" | "readinessStatus"> | null | undefined) {
  if (!connection || connection.readinessStatus === "revocation_confirmed" || !workspaceEnvironment().QUICKBOOKS_CLIENT_ID || !workspaceEnvironment().QUICKBOOKS_CLIENT_SECRET) return false;
  try { const token=decryptSecret(connection.encryptedRefreshToken); return Boolean(token.trim() && token !== "revoked"); } catch { return false; }
}

export async function disconnectQuickBooks(retryRevocation = false): Promise<QuickBooksDisconnectResult> {
  // The committed local stop prevents token refresh and new accounting calls before the
  // external request. Retain encrypted credentials until Intuit confirms revocation.
  const claim = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
    const [current] = await tx.select().from(quickbooksConnectionsTable).where(sql`TRUE`).for("update");
    if (!current) return { result: revocationResult("not_connected") };
    const unresolved = unresolvedQuickBooksRevocation(current);
    if (current.status === "disconnected" && !unresolved) return { result: revocationResult("confirmed") };
    if (unresolved && (!retryRevocation || (current.readinessStatus === "revocation_pending" && Date.parse(current.updatedAt) > Date.now() - 30_000))) {
      const state = ["revocation_pending","revocation_unknown","revocation_failed"].includes(current.readinessStatus) ? current.readinessStatus.slice("revocation_".length) as "pending" | "unknown" | "failed" : "not_requested";
      return { result: revocationResult(state) };
    }
    if (unresolved && !quickBooksRevocationRetryAvailable(current)) {
      const state = ["revocation_pending","revocation_unknown","revocation_failed"].includes(current.readinessStatus) ? current.readinessStatus.slice("revocation_".length) as "pending" | "unknown" | "failed" : "not_requested";
      return { result: { ...revocationResult(state), message: "Works remains locally stopped. The retained grant cannot currently be retried with the available configuration. Operator review is required; no new authorization or provider revocation is confirmed." } };
    }
    const claimedAt = new Date(Math.max(Date.now(), (Date.parse(current.updatedAt) || 0) + 1)).toISOString();
    await tx.update(quickbooksConnectionsTable).set({ status: "disconnected", readinessStatus: "revocation_pending", updatedAt: claimedAt }).where(eq(quickbooksConnectionsTable.id, current.id));
    return { connection: current, claimedAt };
  });
  if (claim.result) return claim.result;
  const connection = claim.connection!;
  let state: "confirmed" | "unknown" | "failed" = "failed";
  const clientId = workspaceEnvironment().QUICKBOOKS_CLIENT_ID;
  const clientSecret = workspaceEnvironment().QUICKBOOKS_CLIENT_SECRET;
  if (clientId && clientSecret) {
    let token: string | undefined;
    try { token = decryptSecret(connection.encryptedRefreshToken); } catch { /* Keep the local stop if the configured key is unavailable or changed. */ }
    if (token && token !== "revoked") {
      try {
        const response = await fetch("https://developer.api.intuit.com/v2/oauth2/tokens/revoke", {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
          headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        state = response.status === 200 ? "confirmed" : response.status >= 400 && response.status < 500 && response.status !== 408 ? "failed" : "unknown";
      } catch { state = "unknown"; }
    }
  }
  try {
    const persisted = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
      const [current] = await tx.select().from(quickbooksConnectionsTable).where(eq(quickbooksConnectionsTable.id, connection.id)).for("update");
      // A late response cannot overwrite a subsequent explicit retry's outcome.
      if (!current || current.updatedAt !== claim.claimedAt || current.readinessStatus !== "revocation_pending") return false;
      await tx.update(quickbooksConnectionsTable).set({ status: "disconnected", readinessStatus: `revocation_${state}`, updatedAt: new Date().toISOString(),
        ...(state === "confirmed" ? { encryptedAccessToken: encryptSecret("revoked"), encryptedRefreshToken: encryptSecret("revoked"), grantedScopes: [] } : {}),
      }).where(eq(quickbooksConnectionsTable.id, connection.id));
      return true;
    });
    return persisted ? revocationResult(state) : revocationResult("pending");
  } catch {
    throw new DomainError(503, "Works stopped this connection, but could not save Intuit's revocation result. Reload settings and retry this same grant; do not reconnect yet.");
  }
}

export class QuickBooksRequestError extends Error {
  constructor(message: string, readonly status: number, readonly faultType?: string, readonly faultCode?: string) {
    super(message);
  }
}

export async function qboRequest(path: string, init: RequestInit = {}, expectedConnectionId?: string) {
  if(!path.startsWith("/")||path.startsWith("//")||path.includes("\\"))throw new Error("Invalid QuickBooks request path");
  let connection = await getConnection();
  if (connection?.status !== "connected") throw new Error("QuickBooks is not connected");
  if (expectedConnectionId && connection.id !== expectedConnectionId) throw new Error("The QuickBooks connection changed. Confirm the company and try again.");
  if(workspaceEnvironment().DEMO_MODE==="true"&&connection.environment!=="sandbox")throw new Error("A demonstration cannot use a live QuickBooks company.");
  const send = (current: typeof quickbooksConnectionsTable.$inferSelect) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${decryptSecret(current.encryptedAccessToken)}`);
    headers.set("Accept", "application/json");
    headers.set("Content-Type", "application/json");
    return fetch(`${apiBase(current.environment)}/v3/company/${encodeURIComponent(current.realmId)}${path}${path.includes("?") ? "&" : "?"}minorversion=75`, { ...init, signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(25_000)]):AbortSignal.timeout(25_000), headers });
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

export async function qboProjectsGraph(operation:"query"|"mutation",query:string,variables:Record<string,unknown>,expectedConnectionId:string) {
  if(!query.trimStart().startsWith(`${operation} `))throw new Error("Invalid Projects operation.");
  let connection=await getConnection();
  if(connection?.status!=="connected"||connection.id!==expectedConnectionId)throw new QuickBooksProjectsError("The QuickBooks connection changed. Refresh this company.");
  if(!connection.grantedScopes?.includes(projectsScope))throw new QuickBooksProjectsError("Reconnect QuickBooks with the Projects permission before using true Projects.");
  if(workspaceEnvironment().DEMO_MODE==="true"&&connection.environment!=="sandbox")throw new QuickBooksProjectsError("A demonstration cannot use live QuickBooks Projects.");
  if(Date.parse(connection.accessTokenExpiresAt)<Date.now()+60_000)connection=await refresh(connection);
  if(!connection.grantedScopes?.includes(projectsScope))throw new QuickBooksProjectsError("The renewed QuickBooks grant does not include Projects.");
  const send=(current:typeof connection)=>fetch(current!.environment==="production"?"https://qb.api.intuit.com/graphql":"https://qb-sandbox.api.intuit.com/graphql",{method:"POST",redirect:"error",signal:AbortSignal.timeout(25_000),headers:{Authorization:`Bearer ${decryptSecret(current!.encryptedAccessToken)}`,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify({query,variables})});
  let response:Response;
  try { response=await send(connection);if(response.status===401&&operation==="query") {connection=await refresh(connection);if(!connection.grantedScopes?.includes(projectsScope))throw new QuickBooksProjectsError("The renewed QuickBooks grant does not include Projects.");response=await send(connection);} }
  catch(error){if(error instanceof QuickBooksProjectsError)throw error;throw new QuickBooksProjectsError("QuickBooks Projects did not confirm the request. Reconcile before continuing.",operation==="mutation");}
  if(!response.ok)throw new QuickBooksProjectsError(`QuickBooks Projects refused the request (${response.status}). Review access and reconcile before continuing.`,operation==="mutation"&&(response.status>=500||response.status===408),response.status);
  const body=await response.json().catch(()=>null);graphData(body);return body;
}
