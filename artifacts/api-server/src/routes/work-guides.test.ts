import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: null as any,
  list: vi.fn(),
  read: vi.fn(),
  workOrder: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../lib/auth", () => ({
  SESSION_COOKIE: "session",
  getSession: async () => state.session,
}));
vi.mock("../lib/work-guides", () => ({
  listGuideJobs: state.list,
  readWorkGuide: state.read,
  guideWorkOrder: state.workOrder,
  saveGuideUpdate: state.save,
}));
import { requireAuth, enforceRoleAccess } from "../middlewares/auth";
import router from "./work-guides";
const app = express().use(
  express.json(),
  cookieParser(),
  (req, _res, next) => {
    req.log = { error: vi.fn() } as any;
    next();
  },
  requireAuth,
  enforceRoleAccess,
  router,
);
function session(role = "installer", previewRole: string | null = null) {
  state.session = {
    user: {
      id: "named-user",
      email: "fixture@example.invalid",
      name: "Named user",
      role,
    },
    session: { csrfToken: "csrf", previewRole },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  session();
  state.list.mockResolvedValue({ jobs: [], hasMore: false });
  state.read.mockResolvedValue({ installation: [], warehouse: null });
  state.workOrder.mockResolvedValue({ job: { id: "job-a" } });
  state.save.mockResolvedValue({ status: 201, update: { id: "update" } });
});

it("requires a real session and honors effective preview role without an owner bypass", async () => {
  state.session = null;
  await request(app).get("/work-guides/jobs").expect(401);
  session("sales");
  await request(app).get("/work-guides/jobs").expect(403);
  expect(state.list).not.toHaveBeenCalled();
  await request(app).get("/work-guides/jobs/job-a/work-order").expect(200);
  session("owner", "installer");
  await request(app).get("/work-guides/jobs/job-a").expect(200);
  expect(state.read).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: "named-user",
      role: "installer",
      actualRole: "owner",
    }),
    "job-a",
    undefined,
  );
});
it("opening, selecting and refreshing only calls the read services and forbids injected tenant/role/completion input", async () => {
  for (const path of [
    "/work-guides/jobs",
    "/work-guides/jobs?q=001",
    "/work-guides/jobs/job-a",
    "/work-guides/jobs/job-a/work-order",
  ]) {
    const response = await request(app).get(path).expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  }
  for (const query of [
    "companyId=other",
    "role=owner",
    "complete=true",
    "userId=other",
  ])
    await request(app).get(`/work-guides/jobs?${query}`).expect(400);
  await request(app)
    .post("/work-guides/jobs/job-a/complete")
    .set("x-csrf-token", "csrf")
    .send({})
    .expect(404);
  expect(state.save).not.toHaveBeenCalled();
});
it("saves only an explicit CSRF-protected normal update, with server actor and no submitted actor fields", async () => {
  const body = {
    id: "d320f199-d6fd-4eec-9055-812181aee33f",
    message: "Actual field handoff",
  };
  await request(app)
    .post("/work-guides/jobs/job-a/updates")
    .send(body)
    .expect(403);
  await request(app)
    .post("/work-guides/jobs/job-a/updates")
    .set("x-csrf-token", "csrf")
    .send({ ...body, authorId: "owner" })
    .expect(400);
  expect(state.save).not.toHaveBeenCalled();
  await request(app)
    .post("/work-guides/jobs/job-a/updates")
    .set("x-csrf-token", "csrf")
    .send(body)
    .expect(201);
  expect(state.save).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "named-user", role: "installer" }),
    "job-a",
    body,
  );
});
