import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  role: "owner",
  actualRole: "owner",
  previewRole: null as string | null,
  preview: vi.fn(),
  review: vi.fn(),
  approve: vi.fn(),
  commit: vi.fn(),
  read: vi.fn(),
  source: vi.fn(),
  options: vi.fn(),
  list: vi.fn(),
  refresh: vi.fn(),
  provenance: vi.fn(),
}));
vi.mock("../lib/auth", () => ({
  getSession: vi.fn(),
  SESSION_COOKIE: "fixture_session",
}));
vi.mock("../lib/open-po-imports", () => ({
  previewOpenPoImport: state.preview,
  reviewOpenPoImport: state.review,
  approveOpenPoImport: state.approve,
  commitOpenPoImport: state.commit,
  readOpenPoImport: state.read,
  readOpenPoSource: state.source,
  openPoImportOptions: state.options,
  listOpenPoImports: state.list,
  refreshOpenPoImport: state.refresh,
  openPoImportProvenance: state.provenance,
}));
vi.mock("../lib/file-store", () => ({
  safeFileHeaders: () => ({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": "attachment",
  }),
}));
import router from "./open-po-imports";
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.auth = {
    role: state.role as any,
    actualRole: state.actualRole as any,
    previewRole: state.previewRole as any,
    userId: "owner",
    name: "Owner",
    email: "fixture@example.test",
    csrfToken: "fixture",
  };
  next();
});
app.use(router);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status ?? 500).json({ error: error.message }),
);
const id = "11111111-1111-4111-8111-111111111111",
  fp = "a".repeat(64);
beforeEach(() => {
  vi.clearAllMocks();
  state.role = "owner";
  state.actualRole = "owner";
  state.previewRole = null;
  state.list.mockResolvedValue([]);
  state.options.mockResolvedValue({ items: [] });
  state.source.mockResolvedValue("\uFEFFsource_po_id\r\n00001\r\n");
  state.preview.mockResolvedValue({ id });
  state.approve.mockResolvedValue({ id });
  state.commit.mockResolvedValue({ id });
});
it.each(["sales", "operations", "installer"])(
  "refuses every import route for %s",
  async (role) => {
    state.role = role;
    state.actualRole = role;
    await request(app).get("/open-po-imports").expect(403);
    await request(app)
      .get("/open-po-imports/options?kind=supplier")
      .expect(403);
    await request(app)
      .post(`/open-po-imports/${id}/commit`)
      .send({})
      .expect(403);
    expect(state.list).not.toHaveBeenCalled();
    expect(state.options).not.toHaveBeenCalled();
    expect(state.commit).not.toHaveBeenCalled();
  },
);
it("rejects owner role preview before loading source bytes or accepting approval", async () => {
  state.previewRole = "sales";
  await request(app).get(`/open-po-imports/${id}/source`).expect(403);
  await request(app)
    .post(`/open-po-imports/${id}/approve`)
    .send({ revision: 1, reviewFingerprint: fp, confirmOutstandingOnly: true })
    .expect(403);
  expect(state.source).not.toHaveBeenCalled();
  expect(state.approve).not.toHaveBeenCalled();
});
it("provides bounded strict local options without accepting company selectors", async () => {
  await request(app)
    .get("/open-po-imports/options?kind=product&q=000012&page=2")
    .expect(200);
  expect(state.options).toHaveBeenCalledWith("product", "000012", 2);
  await request(app)
    .get("/open-po-imports/options?kind=product&company=other")
    .expect(400);
  await request(app)
    .get("/open-po-imports/options?kind=product&page=-1")
    .expect(400);
  expect(state.options).toHaveBeenCalledOnce();
});
it("requires explicit outstanding-only approval and exact immutable identifiers on commit", async () => {
  await request(app)
    .post(`/open-po-imports/${id}/approve`)
    .send({ revision: 2, reviewFingerprint: fp })
    .expect(400);
  expect(state.approve).not.toHaveBeenCalled();
  await request(app)
    .post(`/open-po-imports/${id}/approve`)
    .send({ revision: 2, reviewFingerprint: fp, confirmOutstandingOnly: true })
    .expect(200);
  expect(state.approve).toHaveBeenCalledWith(id, 2, fp, "owner");
  await request(app)
    .post(`/open-po-imports/${id}/commit`)
    .send({
      revision: 3,
      approvalId: id,
      approvalFingerprint: fp,
      confirmOutstandingOnly: true,
      receiveStock: true,
    })
    .expect(400);
  expect(state.commit).not.toHaveBeenCalled();
  await request(app)
    .post(`/open-po-imports/${id}/commit`)
    .send({
      revision: 3,
      approvalId: id,
      approvalFingerprint: fp,
      confirmOutstandingOnly: true,
    })
    .expect(200);
  expect(state.commit).toHaveBeenCalledWith(id, 3, id, fp, "owner");
});
it("downloads the exact retained source as an authenticated attachment with no remote URL input", async () => {
  const response = await request(app)
    .get(`/open-po-imports/${id}/source`)
    .expect(200);
  expect(Buffer.from(response.body).toString("utf8")).toBe(
    "\uFEFFsource_po_id\r\n00001\r\n",
  );
  expect(response.headers["content-disposition"]).toBe("attachment");
  expect(response.headers["cache-control"]).toBe("no-store");
  await request(app)
    .get(`/open-po-imports/${id}/source?url=https://remote.invalid`)
    .expect(400);
  expect(state.source).toHaveBeenCalledOnce();
});
