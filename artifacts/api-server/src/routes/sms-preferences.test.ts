import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  role: "owner",
  actualRole: "owner",
  previewRole: null as string | null,
  read: vi.fn(),
  consent: vi.fn(),
  suppress: vi.fn(),
}));
vi.mock("../lib/sms-preferences", () => ({
  readSmsPreference: state.read,
  recordSmsConsent: state.consent,
  suppressSmsRecipient: state.suppress,
}));
vi.mock("../middlewares/auth", () => ({
  requireOwner: (req: Request, res: Response, next: NextFunction) => {
    if (req.auth?.actualRole !== "owner" || req.auth.previewRole) {
      res.status(403).json({ error: "Exit role preview" });
      return;
    }
    next();
  },
}));
import router from "./sms-preferences";
const app = express().use(
  express.json(),
  (req, _res, next) => {
    req.auth = {
      userId: "actor",
      email: "fixture@example.invalid",
      name: "Fixture",
      role: state.role as "owner",
      actualRole: state.actualRole as "owner",
      previewRole: state.previewRole as null,
      csrfToken: "fixture",
    };
    next();
  },
  router,
);
const base = {
  to: "(500) 555-0006",
  revision: 0,
  requestKey: "11111111-1111-4111-8111-111111111111",
};
const evidence = {
  source: "written",
  occurredAt: "2026-11-23T10:00:00Z",
  note: "Fictional evidence for unit test",
  reference: "Fictional form",
  synthetic: true,
};
beforeEach(() => {
  state.role = "owner";
  state.actualRole = "owner";
  state.previewRole = null;
  vi.clearAllMocks();
  state.read.mockResolvedValue({ revision: 0 });
  state.consent.mockResolvedValue({ revision: 1 });
  state.suppress.mockResolvedValue({ revision: 1 });
});
it.each(["owner", "sales", "operations"])(
  "allows %s office lookup with no-store",
  async (role) => {
    state.role = role;
    state.actualRole = role;
    const response = await request(app)
      .get("/sms-preferences/recipient")
      .query({ to: base.to })
      .expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(state.read).toHaveBeenCalledWith(base.to);
  },
);
it("denies installers even when actual owner is previewing that role", async () => {
  state.role = "installer";
  state.previewRole = "installer";
  await request(app)
    .get("/sms-preferences/recipient")
    .query({ to: base.to })
    .expect(403);
  expect(state.read).not.toHaveBeenCalled();
});
it.each(["sales", "operations"])(
  "allows %s suppression but not positive permission",
  async (role) => {
    state.role = role;
    state.actualRole = role;
    await request(app)
      .post("/sms-preferences/suppress")
      .send({ ...base, note: "Customer requested no texts" })
      .expect(200);
    await request(app)
      .post("/sms-preferences/consent")
      .send({
        ...base,
        bindingFingerprint: null,
        evidence,
        releaseSuppression: false,
      })
      .expect(403);
    expect(state.consent).not.toHaveBeenCalled();
    expect(state.suppress).toHaveBeenCalledOnce();
  },
);
it("requires owner outside preview for consent and explicit release", async () => {
  await request(app)
    .post("/sms-preferences/consent")
    .send({
      ...base,
      bindingFingerprint: null,
      evidence,
      releaseSuppression: false,
    })
    .expect(200);
  expect(state.consent).toHaveBeenCalledWith(
    "actor",
    expect.objectContaining({ evidence }),
  );
  state.role = "sales";
  state.previewRole = "sales";
  await request(app)
    .post("/sms-preferences/consent")
    .send({
      ...base,
      bindingFingerprint: null,
      evidence,
      releaseSuppression: true,
    })
    .expect(403);
  await request(app)
    .post("/sms-preferences/suppress")
    .send({ ...base, note: "Fictional optout" })
    .expect(403);
});
it("rejects extra inferred consent fields and incomplete evidence", async () => {
  await request(app)
    .post("/sms-preferences/consent")
    .send({
      ...base,
      bindingFingerprint: null,
      evidence: { ...evidence, consentFromImport: true },
      releaseSuppression: false,
    })
    .expect(400);
  await request(app)
    .post("/sms-preferences/consent")
    .send({
      ...base,
      bindingFingerprint: null,
      evidence: { ...evidence, note: "yes" },
      releaseSuppression: false,
    })
    .expect(400);
  expect(state.consent).not.toHaveBeenCalled();
});
