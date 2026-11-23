import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installerAssignment,
  installerJobAccess,
  installerJobDto,
} from "./installer-access";
import installerBoundary from "../routes/installer-access";
const mocks = vi.hoisted(() => ({ select: vi.fn(), transaction: vi.fn() }));
vi.mock("@workspace/db", async () => ({
  ...(await import("../../../../lib/db/src/schema")),
  db: { select: mocks.select, transaction: mocks.transaction },
}));
const dialect = new PgDialect();
describe("installer authorization boundary", () => {
  beforeEach(() => vi.clearAllMocks());
  it("binds a personal task to the job and both sides of a confirmed booking", () => {
    const query = dialect.sqlToQuery(
      installerJobAccess({ userId: "individual-1", role: "installer" }),
    );
    expect(query.params).toContain("individual-1");
    expect(query.params).toContain("Open");
    expect(query.params).toContain("Done");
    for (const field of [
      "assignee_id",
      "related_job_id",
      "booking_id",
      "task_id",
      "Confirmed",
    ])
      expect(query.sql).toContain(field);
    expect(query.sql).toContain('"tasks"."related_job_id" = "jobs"."id"');
    expect(query.sql).not.toContain("crew_assigned");
    const tasks = dialect.sqlToQuery(
      installerAssignment({ userId: "individual-1", role: "installer" })!,
    );
    expect(tasks.sql).toContain('"tasks"."related_job_id" IS NOT NULL');
  });
  it("whitelists top-level and nested stored JSON even if passed a full financial job", () => {
    const data = installerJobDto({
      id: "j",
      jobNumber: "J-1",
      customerName: "Customer",
      address: "Site",
      city: "Town",
      flooringType: "Tile",
      scopeOfWork: "Estimated price: $4.46; cost: $2.90",
      status: "Scheduled",
      estStartDate: null,
      estCompletionDate: null,
      rooms: [
        {
          id: "r",
          name: "Room",
          length: 1,
          width: 2,
          cost: 900,
          providerId: "private",
          scope: "Estimate: $4.46",
        },
        null,
        { secret: "private" },
      ],
      shareToken: "secret",
      notes: "private",
      actualRevenue: 1000,
    } as any);
    expect(data).toEqual({
      id: "j",
      jobNumber: "J-1",
      customerName: "Customer",
      address: "Site",
      city: "Town",
      flooringType: "Tile",
      scopeOfWork:
        "Flooring: Tile. 1 recorded room(s). Confirm installation instructions with the office.",
      status: "Scheduled",
      estStartDate: null,
      estCompletionDate: null,
      rooms: [{ id: "r", name: "Room", length: 1, width: 2 }],
    });
  });
  it.each([
    ["post", "/jobs"],
    ["delete", "/jobs/job"],
    ["patch", "/jobs/job"],
    ["post", "/tasks"],
    ["delete", "/tasks/task"],
    ["patch", "/tasks/task/assignment"],
    ["post", "/jobs/job/transition"],
    ["get", "/jobs/job/readiness"],
    ["post", "/jobs/job/materials"],
    ["post", "/jobs/job/material-usage"],
    ["patch", "/jobs/job/labor/entry"],
    ["delete", "/jobs/job/photos/photo"],
    ["get", "/jobs/job/accounting-costs"],
    ["post", "/storage/files/portal-photo"],
    ["get", "/storage/public-objects/private"],
    ["post", "/integrations/sync"],
  ])(
    "denies installer %s %s before a legacy handler or side effect runs",
    async (method, path) => {
      let legacyCalls = 0;
      const app = express()
        .use(express.json())
        .use((req, _res, next) => {
          req.auth = {
            userId: "u",
            role: "installer",
            actualRole: "owner",
            previewRole: "installer",
            email: "fixture@example.invalid",
            name: "Fixture",
            csrfToken: "x",
          };
          next();
        })
        .use(installerBoundary)
        .use((_req, res) => {
          legacyCalls++;
          res.status(299).json({ legacy: true });
        });
      const response = await (request(app) as any)[method](path).send({});
      expect(response.status).toBe(403);
      expect(legacyCalls).toBe(0);
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );
  it("leaves office handlers in place", async () => {
    const app = express()
      .use((req, _res, next) => {
        req.auth = {
          userId: "u",
          role: "operations",
          actualRole: "operations",
          previewRole: null,
          email: "fixture@example.invalid",
          name: "Fixture",
          csrfToken: "x",
        };
        next();
      })
      .use(installerBoundary)
      .use((_req, res) => res.status(299).json({ legacy: true }));
    expect((await request(app).post("/jobs/job/transition")).status).toBe(299);
  });
});
