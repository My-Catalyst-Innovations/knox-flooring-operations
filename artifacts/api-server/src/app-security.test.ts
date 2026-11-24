import express from "express";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./routes", async () => {
  const router = express.Router();
  router.get("/auth/session", (_req, res) =>
    res.status(401).json({ error: "Authentication required" }),
  );
  router.post("/fixture", (_req, res) => res.json({ accepted: true }));
  return { default: router };
});
vi.mock("./platform", async () => {
  const router = express.Router();
  router.get("/fixture", (_req, res) => res.json({ status: "fixture" }));
  return { platform: { router } };
});
vi.mock("./middlewares/workspace", () => ({
  workspaceBoundary: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.get("host") === "unknown.fixture.invalid")
      res.status(421).json({ error: "Unknown company" });
    else next(); // The unregistered/default workspace path intentionally adds no cache policy.
  },
}));
vi.mock("@workspace/db/workspace", () => ({
  workspaceEnvironment: () => ({ APP_BASE_URL: "https://fixture.invalid" }),
}));
vi.mock("./lib/logger", async () => ({
  logger: (await import("pino")).default({ enabled: false }),
}));
import app from "./app";

afterEach(() => vi.restoreAllMocks());
function assertPrivate(response: request.Response) {
  expect(response.headers["cache-control"]).toBe(
    "no-store, no-cache, must-revalidate",
  );
  expect(response.headers.pragma).toBe("no-cache");
  expect(response.headers.expires).toBe("0");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
}
it("installs private API headers before platform, default-workspace auth, unknown host and404 routes", async () => {
  assertPrivate(await request(app).get("/api/platform/fixture").expect(200));
  assertPrivate(await request(app).get("/api/auth/session").expect(401));
  assertPrivate(
    await request(app)
      .get("/api/auth/session")
      .set("Host", "unknown.fixture.invalid")
      .expect(421),
  );
  assertPrivate(await request(app).get("/api/unknown-fixture").expect(404));
});
it("keeps parser failures private before any application route executes", async () => {
  // Suppress Express's test-only default handler output while verifying header placement.
  vi.spyOn(console, "error").mockImplementation(() => {});
  assertPrivate(
    await request(app)
      .post("/api/fixture")
      .set("Content-Type", "application/json")
      .send('{"bad":')
      .expect(400),
  );
});
