import express from "express";
import cookieParser from "cookie-parser";
import { Readable } from "node:stream";
import { PgDialect } from "drizzle-orm/pg-core";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enforceRoleAccess, requireAuth } from "../middlewares/auth";
import storageRouter, { publicMediaRouter } from "./storage";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  session: vi.fn(),
  save: vi.fn(),
  metadata: vi.fn(),
  download: vi.fn(),
}));

vi.mock("@workspace/db", async () => {
  const { pgTable, text, integer, jsonb } = await import("drizzle-orm/pg-core");
  return {
    db: { select: mocks.select },
    jobsTable: pgTable("jobs", { id: text("id"), shareToken: text("share_token") }),
    jobPhotosTable: pgTable("job_photos", { id: text("id"), jobId: text("job_id"), objectPath: text("object_path") }),
    leadsTable: pgTable("leads", { id: text("id"), documents: jsonb("documents") }),
    productsTable: pgTable("products", { id: text("id"), imageUrl: text("image_url") }),
    settingsTable: pgTable("settings", { id: integer("id"), companyLogoUrl: text("company_logo_url") }),
  };
});
vi.mock("../lib/auth", () => ({ SESSION_COOKIE: "test_session", getSession: mocks.session }));
vi.mock("../lib/file-store", async (original) => ({
  ...await original<typeof import("../lib/file-store")>(),
  saveFile: mocks.save,
  getFileMetadata: mocks.metadata,
  getFile: mocks.download,
}));

const app = express().use(cookieParser()).use("/api", publicMediaRouter)
  .use("/api", requireAuth, enforceRoleAccess, storageRouter);
const fileId = "62d2b13f-4ca2-4a89-b5ae-29cbd61f2df6";
const jobPhoto = `/objects/files/job-photo/${fileId}`;
const sharedPhoto = `/objects/files/portal-photo/${fileId}`;
const leadDocument = `/objects/files/lead-document/${fileId}`;
const companyLogo = `/objects/files/company-logo/${fileId}`;
const requestPhoto = (purpose: string) => request(app).post(`/api/storage/files/${purpose}?recordId=job-1`)
  .set("Content-Type", "application/octet-stream")
  .set("X-File-Name", "Floor.jpg");
const signIn = (role: string, userId = "user-1") => mocks.session.mockResolvedValue({
  user: { id: userId, name: "Test", email: "test@example.com", role },
  session: { csrfToken: "test-csrf", previewRole: null },
});

function selectRows(rows: unknown[], joins = false) {
  const where = vi.fn().mockReturnValue({ limit: async () => rows, then: (resolve: (result: unknown[]) => unknown) => resolve(rows) });
  const innerJoin = vi.fn().mockReturnValue({ where });
  mocks.select.mockReturnValue({ from: () => joins ? { innerJoin } : { where } });
  return where;
}

function prepareImage(path: string) {
  mocks.metadata.mockResolvedValue({ uploader: "user-1", recordId: "job-1", uploadedAt: new Date().toISOString() });
  mocks.download.mockImplementation(async (requestedPath) => {
    if (requestedPath !== path) return null;
    return { type: "image/jpeg", body: Readable.from(Buffer.from([0xff, 0xd8, 0xff, 0xd9])) };
  });
}

describe("private storage HTTP boundaries", () => {
  beforeEach(() => vi.resetAllMocks());

  it("requires authentication, CSRF and an allowed file purpose before accepting a body", async () => {
    expect((await requestPhoto("job-photo").send(Buffer.from("photo"))).status).toBe(401);
    signIn("operations");
    expect((await requestPhoto("job-photo").send(Buffer.from("photo"))).status).toBe(403);
    expect((await requestPhoto("lead-document").set("X-CSRF-Token", "test-csrf").send(Buffer.from("photo"))).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("accepts an operations user upload only for an existing job and enforces the size limit", async () => {
    signIn("operations");
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    selectRows([]);
    expect((await requestPhoto("job-photo").set("X-CSRF-Token", "test-csrf").send(bytes)).status).toBe(404);
    selectRows([{ id: "job-1" }]);
    mocks.save.mockResolvedValue(jobPhoto);
    const response = await requestPhoto("job-photo").set("X-CSRF-Token", "test-csrf").send(bytes);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ objectPath: jobPhoto });
    expect(mocks.save).toHaveBeenCalledWith("job-photo", bytes, "user-1", "job-1", "Floor.jpg");
    expect((await requestPhoto("job-photo").set("X-CSRF-Token", "test-csrf").send(Buffer.alloc(15 * 1024 * 1024 + 1))).status).toBe(413);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("keeps an unattached upload private to the uploader and hides lead files from installers", async () => {
    prepareImage(jobPhoto);
    signIn("owner", "other-user");
    selectRows([]);
    expect((await request(app).get(`/api/storage${jobPhoto}`)).status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();
    signIn("operations");
    const response = await request(app).get(`/api/storage${jobPhoto}`);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    signIn("installer");
    mocks.metadata.mockClear();
    expect((await request(app).get(`/api/storage${leadDocument}`)).status).toBe(404);
    expect(mocks.metadata).not.toHaveBeenCalled();
  });

  it("checks a photo ID against the supplied job token and can only publish explicitly shared new photos", async () => {
    prepareImage(sharedPhoto);
    const privatePhoto = selectRows([{ path: jobPhoto, jobId: "job-1" }], true);
    const path = "/api/public/jobs/test-share-token/photos/photo-1";
    expect((await request(app).get(path)).status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();
    const query = new PgDialect().sqlToQuery(privatePhoto.mock.calls[0][0]);
    expect(query.sql).toContain('"jobs"."share_token"');
    expect(query.sql).toContain('"job_photos"."id"');
    expect(query.params).toEqual(["test-share-token", "photo-1"]);

    selectRows([{ path: sharedPhoto, jobId: "job-1" }], true);
    expect((await request(app).get(path)).status).toBe(200);
    selectRows([{ path: sharedPhoto, jobId: "another-job" }], true);
    expect((await request(app).get(path)).status).toBe(404);
  });

  it("publishes only the workspace's configured branding image", async () => {
    prepareImage(companyLogo);
    selectRows([{ logo: `/api/storage${jobPhoto}` }]);
    expect((await request(app).get("/api/public/company-logo")).status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();
    selectRows([{ logo: `/api/storage${companyLogo}` }]);
    expect((await request(app).get("/api/public/company-logo")).status).toBe(200);
  });
});
