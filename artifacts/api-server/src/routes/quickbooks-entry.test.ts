import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  retryAvailable: vi.fn(),
  getSession: vi.fn(),
  environment: {} as Record<string, string>,
}));
vi.mock("../lib/quickbooks", () => ({
  getConnection: mocks.getConnection,
  quickBooksRevocationRetryAvailable: mocks.retryAvailable,
}));
vi.mock("../lib/auth", () => ({
  getSession: mocks.getSession,
  SESSION_COOKIE: "knox_session",
}));
vi.mock("@workspace/db/workspace", () => ({
  workspaceEnvironment: () => mocks.environment,
}));
import { requireAuth } from "../middlewares/auth";
import { apiSecurity } from "../middlewares/api-security";
import router from "./quickbooks-entry";

const app = express()
  .use(apiSecurity)
  .use(cookieParser())
  .use("/api", requireAuth, router);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.retryAvailable.mockReturnValue(false);
  mocks.environment = {
    QUICKBOOKS_CLIENT_ID: "FICTIONAL-CLIENT",
    QUICKBOOKS_CLIENT_SECRET: "SENTINEL-SECRET",
    QUICKBOOKS_REDIRECT_URI:
      "https://fictional.invalid/api/quickbooks/callback",
    QUICKBOOKS_ENCRYPTION_KEY: "SENTINEL-KEY",
  };
  mocks.getSession.mockImplementation(async (cookie: string) =>
    cookie && ["owner", "preview", "sales"].includes(cookie)
      ? {
          user: {
            id: "fictional-" + cookie,
            email: cookie + "@example.invalid",
            name: cookie,
            role: cookie === "sales" ? "sales" : "owner",
          },
          session: {
            csrfToken: "FICTIONAL-CSRF",
            previewRole: cookie === "preview" ? "sales" : null,
          },
        }
      : null,
  );
  mocks.getConnection.mockResolvedValue(null);
});
it.each([
  ["", 401],
  ["sales", 403],
  ["preview", 403],
])(
  "requires a real current owner outside preview, cookie=%s",
  async (cookie, status) => {
    await request(app)
      .get("/api/quickbooks/entry-status")
      .set("Cookie", `knox_session=${cookie}`)
      .expect(Number(status));
    expect(mocks.getConnection).not.toHaveBeenCalled();
  },
);
it("shows only local safe owner state and rejects every query selector before the DB read", async () => {
  const response = await request(app)
    .get("/api/quickbooks/entry-status")
    .set("Cookie", "knox_session=owner")
    .expect(200);
  expect(response.body).toEqual({
    configured: true,
    connection: {
      connected: false,
      status: "not_connected",
      localUseStopped: false,
      revocationRetryAvailable: false,
      companyName: null,
      environment: null,
      revocation: "not_connected",
    },
  });
  expect(response.headers["cache-control"]).toBe(
    "no-store, no-cache, must-revalidate",
  );
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  mocks.getConnection.mockClear();
  for (const query of [
    "realmId=SENTINEL",
    "connectionId=foreign",
    "environment=production",
    "retryRevocation=true",
  ]) {
    await request(app)
      .get("/api/quickbooks/entry-status?" + query)
      .set("Cookie", "knox_session=owner")
      .expect(400);
  }
  expect(mocks.getConnection).not.toHaveBeenCalled();
});
it.each(["pending", "unknown", "failed", "confirmed"])(
  "reports actual local-stop and revocation %s without exposing stored secrets",
  async (state) => {
    mocks.getConnection.mockResolvedValue({
      status: "disconnected",
      readinessStatus: `revocation_${state}`,
      companyName: "Fictional Company",
      environment: "sandbox",
      realmId: "SENTINEL-REALM",
      encryptedRefreshToken: "SENTINEL-TOKEN",
      id: "SENTINEL-CONNECTION",
    });
    const response = await request(app)
      .get("/api/quickbooks/entry-status")
      .set("Cookie", "knox_session=owner")
      .expect(200);
    expect(response.body.connection).toEqual({
      connected: false,
      status: "disconnected",
      localUseStopped: true,
      revocationRetryAvailable: false,
      companyName: "Fictional Company",
      environment: "sandbox",
      revocation: state,
    });
    expect(JSON.stringify(response.body)).not.toContain("SENTINEL");
  },
);
it("fails closed on inconsistent saved connection state", async () => {
  mocks.getConnection.mockResolvedValue({
    status: "connected",
    readinessStatus: "revocation_pending",
    environment: "production",
  });
  const response = await request(app)
    .get("/api/quickbooks/entry-status")
    .set("Cookie", "knox_session=owner")
    .expect(200);
  expect(response.body.connection.connected).toBe(false);
  expect(response.body.connection.status).toBe("error");
  expect(response.body.connection.localUseStopped).toBe(false);
});
it("does not infer provider revocation from a legacy local stop without an outcome", async () => {
  mocks.getConnection.mockResolvedValue({
    status: "disconnected",
    readinessStatus: "legacy",
    environment: "sandbox",
  });
  const response = await request(app)
    .get("/api/quickbooks/entry-status")
    .set("Cookie", "knox_session=owner")
    .expect(200);
  expect(response.body.connection).toMatchObject({
    connected: false,
    status: "disconnected",
    localUseStopped: true,
    revocation: "not_requested",
    revocationRetryAvailable: false,
  });
});
