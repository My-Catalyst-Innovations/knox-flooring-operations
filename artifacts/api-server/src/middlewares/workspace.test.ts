import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  resolve: vi.fn(),
  ready: vi.fn(),
  release: vi.fn(),
  lease: vi.fn(),
  legacy: vi.fn(),
  reached: vi.fn(),
}));
vi.mock("@workspace/db/workspace", () => ({
  workspaceConfigs: [],
  resolveWorkspaceForHost: mock.resolve,
  isDynamicWorkspace: () => true,
  inWorkspace: (_workspace: unknown, action: () => unknown) => action(),
}));
vi.mock("@workspace/db", () => ({ leaseWorkspaceConnection: mock.lease }));
vi.mock("../platform", () => ({
  platform: { enabled: true },
  isLegacyPlatformHost: mock.legacy,
}));
vi.mock("../lib/workspace-readiness", () => ({
  assertWorkspaceReady: mock.ready,
}));
import { workspaceBoundary } from "./workspace";

describe("dynamic company schema and host boundary", () => {
  const company = {
    key: "t_fixture",
    host: "indigo.works.example.test",
    origin: "https://indigo.works.example.test",
  };
  beforeEach(() => {
    vi.clearAllMocks();
    mock.resolve.mockResolvedValue(company);
    mock.ready.mockResolvedValue(undefined);
    mock.lease.mockResolvedValue(mock.release);
    mock.legacy.mockReturnValue(false);
  });
  function app() {
    const server = express();
    server.use(workspaceBoundary);
    server.get("/api/jobs", (_req, res) => {
      mock.reached();
      res.json({ jobs: [] });
    });
    return server;
  }
  it("rejects an old or wrongly bound tenant schema before application routes", async () => {
    mock.ready.mockRejectedValue(
      new Error("Database identity or migration fingerprint differs"),
    );
    const response = await request(app())
      .get("/api/jobs")
      .set("Host", company.host);
    expect(response.status).toBe(503);
    expect(mock.reached).not.toHaveBeenCalled();
    expect(mock.release).toHaveBeenCalledTimes(1);
    expect(response.text).not.toContain("fingerprint");
  });
  it("rejects unknown hosts rather than falling back to the existing company", async () => {
    mock.resolve.mockResolvedValue(null);
    expect(
      (
        await request(app())
          .get("/api/jobs")
          .set("Host", "unknown.example.test")
      ).status,
    ).toBe(421);
    expect(mock.lease).not.toHaveBeenCalled();
    expect(mock.reached).not.toHaveBeenCalled();
  });
  it("preserves protected existing-company access independently of platform readiness", async () => {
    mock.legacy.mockReturnValue(true);
    expect(
      (await request(app()).get("/api/jobs").set("Host", "works.example.test"))
        .status,
    ).toBe(200);
    expect(mock.resolve).not.toHaveBeenCalled();
    expect(mock.ready).not.toHaveBeenCalled();
  });
});
