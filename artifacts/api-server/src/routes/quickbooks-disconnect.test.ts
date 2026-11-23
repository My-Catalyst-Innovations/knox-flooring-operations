import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: null as any,
  company: null as any,
  disconnect: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("../lib/auth", () => ({ SESSION_COOKIE: "test_session", getSession: async () => state.session, audit: state.audit }));
vi.mock("@workspace/db", async () => {
  const db: any = {
    execute: async () => {},
    select: () => ({ from: () => ({ where: () => ({ for: async () => state.company ? [structuredClone(state.company)] : [] }) }) }),
    delete: async () => { state.company = null; },
    insert: () => ({ values: async (values: unknown) => { state.company = structuredClone(values); } }),
  };
  db.transaction = async (work: (tx: any) => Promise<unknown>) => work(db);
  return { ...(await import("../../../../lib/db/src/schema/index")), db };
});
vi.mock("@workspace/db/workspace", () => ({ workspaceEnvironment: () => process.env, workspaceScopeKey: () => "test" }));
vi.mock("../lib/quickbooks", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getConnection: async () => state.company,
  consumeQuickBooksOAuthState: async () => true,
  disconnectQuickBooks: state.disconnect,
}));
import { createQuickBooksOAuthState } from "../lib/quickbooks";
import { enforceRoleAccess, requireAuth } from "../middlewares/auth";
import router from "./quickbooks";

const app = express().use(express.json(), cookieParser(), (req, _res, next) => {
  req.log = { error: vi.fn() } as any;
  next();
}, requireAuth, enforceRoleAccess, router);
const disconnect = (body: Record<string, unknown> = {}) => request(app).post("/quickbooks/disconnect").set("x-csrf-token", "csrf").send(body);

beforeEach(() => {
  vi.resetAllMocks();
  state.session = { user: { id: "owner", role: "owner", email: "owner@example.test", name: "Owner" }, session: { csrfToken: "csrf", previewRole: null } };
  state.company = { id: "connection", readinessStatus: "revocation_unknown", status: "disconnected" };
  state.disconnect.mockResolvedValue({ locallyDisconnected: true, revocation: "unknown", message: "Intuit did not confirm revocation." });
  vi.stubEnv("QUICKBOOKS_CLIENT_ID", "test");
  vi.stubEnv("QUICKBOOKS_CLIENT_SECRET", "test");
  vi.stubEnv("QUICKBOOKS_REDIRECT_URI", "https://works.example.test/api/quickbooks/callback");
  vi.stubEnv("QUICKBOOKS_ENCRYPTION_KEY", "synthetic-test-key");
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("returns the actual unconfirmed outcome and records only its safe revocation state", async () => {
  const result = await disconnect({ retryRevocation: true }).expect(200);
  expect(result.body).toEqual({ locallyDisconnected: true, revocation: "unknown", message: "Intuit did not confirm revocation." });
  expect(state.disconnect).toHaveBeenCalledWith(true);
  expect(state.audit).toHaveBeenCalledWith("quickbooks.disconnected", expect.objectContaining({ details: { revocation: "unknown" } }));
  expect(JSON.stringify(result.body)).not.toMatch(/refreshToken|encrypted|clientSecret/);
});

it("keeps initial disconnect distinct from an explicit stopped-grant retry", async () => {
  await disconnect().expect(200);
  expect(state.disconnect).toHaveBeenCalledWith(false);
  await disconnect({ retryRevocation: true }).expect(200);
  expect(state.disconnect).toHaveBeenLastCalledWith(true);
});

it("requires a signed-in owner outside role preview and valid session CSRF", async () => {
  state.session = null;
  await disconnect().expect(401);
  state.session = { user: { id: "staff", role: "sales" }, session: { csrfToken: "csrf" } };
  await disconnect().expect(403);
  state.session = { user: { id: "owner", role: "owner" }, session: { csrfToken: "csrf", previewRole: "owner" } };
  await disconnect().expect(403);
  state.session.session.previewRole = null;
  await request(app).post("/quickbooks/disconnect").send({}).expect(403);
  expect(state.disconnect).not.toHaveBeenCalled();
});

it("rejects client-injected credentials or an invalid retry flag", async () => {
  await disconnect({ retryRevocation: "true" }).expect(400);
  await disconnect({ retryRevocation: true, token: "different-grant" }).expect(400);
  expect(state.disconnect).not.toHaveBeenCalled();
});

it("blocks both beginning and completing OAuth while the old saved grant is unresolved", async () => {
  await request(app).get("/quickbooks/connect").expect(409);
  const signed = createQuickBooksOAuthState("owner", "csrf");
  await request(app).get("/quickbooks/callback").set("Cookie", `qbo_oauth_state=${encodeURIComponent(signed)}`).query({ state: signed, code: "unused-code", realmId: "123" }).expect(409);
  expect(fetch).not.toHaveBeenCalled();
});

it("refuses a stale pre-disconnect consent callback after confirmed revocation, while fresh consent still connects", async () => {
  state.company = { id: "original", status: "connected", readinessStatus: "ready" };
  const beforeStop = await request(app).get("/quickbooks/connect").expect(200);
  const staleState = new URL(beforeStop.body.authorizationUrl).searchParams.get("state")!;
  state.company.status = "disconnected";
  state.company.readinessStatus = "revocation_confirmed";
  await request(app).get("/quickbooks/callback").set("Cookie", `qbo_oauth_state=${encodeURIComponent(staleState)}`).query({ state: staleState, code: "old-consent", realmId: "123" }).expect(409);
  expect(fetch).not.toHaveBeenCalled();
  expect(state.company.status).toBe("disconnected");
  const afterStop = await request(app).get("/quickbooks/connect").expect(200);
  const freshState = new URL(afterStop.body.authorizationUrl).searchParams.get("state")!;
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, x_refresh_token_expires_in: 86400 }));
  await request(app).get("/quickbooks/callback").set("Cookie", `qbo_oauth_state=${encodeURIComponent(freshState)}`).query({ state: freshState, code: "new-consent", realmId: "123" }).expect(302).expect("Location", "/settings?quickbooks=connected");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(state.company).toMatchObject({ status: "connected", realmId: "123", readinessStatus: "reconciliation_required" });
});
