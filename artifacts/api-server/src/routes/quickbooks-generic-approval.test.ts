import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import {
  genericExportAttempt,
  genericExportRecord,
  reconcileGenericExport,
} from "../lib/quickbooks-generic-export";

const state = vi.hoisted(() => ({
  queue: [] as any[],
  links: [] as any[],
  company: null as any,
  job: null as any,
  proposal: null as any,
  process: vi.fn(),
}));
vi.mock("@workspace/db", async () => {
  const schema = await import("../../../../lib/db/src/schema/index");
  const { getTableName } = await import("drizzle-orm");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const rows = (table: any, params: unknown[]) => {
    switch (getTableName(table)) {
      case "quickbooks_connections":
        return state.company?.status === "connected"
          ? [structuredClone(state.company)]
          : [];
      case "quickbooks_sync_jobs":
        return state.queue
          .filter(
            (row) =>
              params.includes(row.id) && row.status === "pending_approval",
          )
          .map((row) => structuredClone(row));
      case "jobs":
        return state.job ? [structuredClone(state.job)] : [];
      case "proposals":
        return state.proposal ? [structuredClone(state.proposal)] : [];
      case "quickbooks_entity_mappings":
        return state.links.filter(
          (row) =>
            params.includes(row.entityType) && params.includes(row.localId),
        );
      default:
        return [];
    }
  };
  const db: any = {
    select: () => ({
      from: (table: any) => ({
        where: (condition: any) => {
          const params = dialect.sqlToQuery(condition).params;
          return {
            for: async () => rows(table, params),
            limit: async () => rows(table, params),
          };
        },
      }),
    }),
    execute: async () => {},
    update: (table: any) => ({
      set: (values: any) => ({
        where: (condition: any) => ({
          returning: async () => {
            const params = dialect.sqlToQuery(condition).params;
            const row =
              getTableName(table) === "quickbooks_sync_jobs"
                ? state.queue.find((row) => params.includes(row.id))
                : null;
            if (!row) return [];
            Object.assign(row, structuredClone(values));
            return [structuredClone(row)];
          },
        }),
      }),
    }),
  };
  db.transaction = async (work: (tx: any) => Promise<unknown>) => {
    const previous = structuredClone(state.queue);
    try {
      return await work(db);
    } catch (error) {
      state.queue = previous;
      throw error;
    }
  };
  return { ...schema, db };
});
vi.mock("../lib/auth", () => ({ audit: vi.fn() }));
vi.mock("../lib/quickbooks-worker", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  processQuickBooksQueue: state.process,
}));
import router from "./quickbooks";
const app = express().use(
  express.json(),
  (req, _res, next) => {
    req.auth = {
      userId: "owner",
      email: "owner@example.test",
      name: "Owner",
      role: "owner",
      actualRole: "owner",
      previewRole: null,
      csrfToken: "csrf",
    };
    req.log = { error: vi.fn() } as any;
    next();
  },
  router,
);
beforeEach(() => {
  state.process.mockReset();
  state.company = {
    id: "connection-1",
    realmId: "123",
    environment: "sandbox",
    status: "connected",
  };
  state.queue = [
    {
      id: "customer-queue",
      entityType: "customer",
      localId: "job-1",
      status: "pending_approval",
      payload: {},
    },
  ];
  state.job = {
    id: "job-1",
    customerName: "Approved customer",
    email: "owner@example.test",
    phone: "",
    address: "",
    city: "",
  };
  state.proposal = {
    id: "proposal-1",
    convertedJobId: "job-1",
    estimatedPrice: 48,
    scopeOfWork: "Floor replacement",
    flooringType: "LVP",
  };
  state.links = [
    {
      id: "customer-link",
      entityType: "customer",
      localId: "job-1",
      quickbooksId: "7",
      syncToken: "0",
      status: "linked",
      realmId: "123",
      environment: "sandbox",
    },
    {
      entityType: "invoice-service",
      localId: JSON.stringify(["sandbox", "123", "Labor"]),
      quickbooksId: "9",
      status: "linked",
      realmId: "123",
      environment: "sandbox",
    },
  ];
});
it("freezes the actual source and original company at owner approval, then exports that snapshot after a local edit", async () => {
  state.links = [];
  await request(app)
    .post("/quickbooks/queue/approve")
    .send({ ids: ["customer-queue"] })
    .expect(200);
  const attempt = genericExportAttempt.parse(
    state.queue[0].payload[genericExportRecord],
  );
  expect(attempt).toMatchObject({
    connectionId: "connection-1",
    realmId: "123",
    environment: "sandbox",
    document: { DisplayName: "Approved customer" },
    state: "prepared",
  });
  state.job.customerName = "Edited after approval";
  let submitted: any;
  await reconcileGenericExport(
    attempt,
    {
      query: async () => ({ QueryResponse: {} }),
      request: async (_path, init) => {
        submitted = JSON.parse(init!.body as string);
        return { Customer: { ...submitted, Id: "42" } };
      },
    },
    async () => {},
    async () => {},
  );
  expect(submitted.DisplayName).toBe("Approved customer");
  expect(state.process).toHaveBeenCalledOnce();
});
it("rejects client-injected durable attempts before any queue or provider action", async () => {
  await request(app)
    .post("/quickbooks/queue")
    .send({
      entityType: "customer",
      localId: "job-1",
      payload: { [genericExportRecord]: { state: "confirmed" } },
    })
    .expect(400);
  expect(state.queue[0].status).toBe("pending_approval");
  expect(state.process).not.toHaveBeenCalled();
});
it("requires an explicit estimate category and freezes its company-scoped mapped service item", async () => {
  state.queue = [
    {
      id: "estimate-queue",
      entityType: "estimate",
      localId: "proposal-1",
      status: "pending_approval",
      payload: {},
    },
  ];
  await request(app)
    .post("/quickbooks/queue/approve")
    .send({ ids: ["estimate-queue"] })
    .expect(409);
  expect(state.queue[0].status).toBe("pending_approval");
  const response = await request(app)
    .post("/quickbooks/queue/approve")
    .send({
      ids: ["estimate-queue"],
      estimateCategories: { "estimate-queue": "Labor" },
    })
    .expect(200);
  expect(
    response.body[0].payload[genericExportRecord].document.Line[0]
      .SalesItemLineDetail.ItemRef.value,
  ).toBe("9");
  expect(response.body[0].payload.estimateServiceCategory).toBe("Labor");
});
it("refuses approval without a connected company and never rewrites a previously submitted attempt", async () => {
  state.company.status = "disconnected";
  await request(app)
    .post("/quickbooks/queue/approve")
    .send({ ids: ["customer-queue"] })
    .expect(409);
  expect(state.queue[0].status).toBe("pending_approval");
  state.company.status = "connected";
  state.links = [];
  await request(app)
    .post("/quickbooks/queue/approve")
    .send({ ids: ["customer-queue"] })
    .expect(200);
  state.queue[0].status = "pending_approval";
  state.queue[0].payload[genericExportRecord].state = "submitting";
  state.job.customerName = "Changed";
  await request(app)
    .post("/quickbooks/queue/approve")
    .send({ ids: ["customer-queue"] })
    .expect(409);
  expect(state.queue[0].payload[genericExportRecord].document.DisplayName).toBe(
    "Approved customer",
  );
});
