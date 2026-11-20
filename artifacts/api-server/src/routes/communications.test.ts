import express from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommunicationInsert } from "@workspace/db";

const state = vi.hoisted(() => ({
  row: undefined as CommunicationInsert | undefined,
  capture: vi.fn(),
}));

vi.mock("@workspace/db", async () => {
  const { communicationsTable } =
    await import("../../../../lib/db/src/schema/communications");
  const { demoOutboxTable } =
    await import("../../../../lib/db/src/schema/demo");
  const client = {
    insert: (table: unknown) => ({
      values: (values: CommunicationInsert) => {
        if (table === demoOutboxTable) return state.capture(values);
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              if (state.row?.id === values.id) return [];
              state.row = values;
              return [values];
            },
          }),
        };
      },
    }),
    select: () => ({ from: () => ({ where: async () => [state.row] }) }),
    update: () => ({
      set: (values: Partial<CommunicationInsert>) => ({
        where: () => ({
          returning: async () => {
            if (!state.row) return [];
            state.row = { ...state.row, ...values };
            return [state.row];
          },
        }),
      }),
    }),
  };
  const db = {
    ...client,
    transaction: (fn: (tx: typeof client) => Promise<unknown>) => fn(client),
  };
  return { db, communicationsTable, demoOutboxTable };
});

import communicationsRouter from "./communications";

const app = express().use(
  express.json(),
  (req, _res, next) => {
    req.auth = {
      userId: "user-id",
      email: "staff@example.com",
      name: "Staff",
      role: "owner",
      actualRole: "owner",
      previewRole: null,
      csrfToken: "unused",
    };
    next();
  },
  communicationsRouter,
);
const fetch = vi.fn<typeof globalThis.fetch>();
const email = {
  to: "Customer@Example.com",
  subject: "Arrival update",
  body: "Your order has arrived.",
  idempotencyKey: "submission-1",
};

beforeEach(() => {
  state.row = undefined;
  state.capture.mockReset();
  fetch.mockReset();
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("COMMS_DELIVERY_MODE", "live");
  vi.stubEnv("RESEND_API_KEY", "fake");
  vi.stubEnv("RESEND_FROM_EMAIL", "sender@example.com");
  vi.stubEnv("RESEND_REPLY_TO_EMAIL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("captures demo messages once, even with externally enabled delivery settings", async () => {
  vi.stubEnv("DEMO_MODE", "true");
  const first = await request(app)
    .post("/communications/email")
    .send(email)
    .expect(201);
  const repeat = await request(app)
    .post("/communications/email")
    .send(email)
    .expect(200);
  expect(first.body).toMatchObject({
    status: "captured",
    toAddress: "customer@example.com",
  });
  expect(repeat.body).toEqual(first.body);
  expect(state.capture).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ status: "captured", externalDelivery: false }),
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("submits one send per idempotency key and rejects a changed message using that key", async () => {
  fetch.mockResolvedValue(Response.json({ id: "mocked-message" }));
  const first = await request(app)
    .post("/communications/email")
    .send(email)
    .expect(201);
  const repeat = await request(app)
    .post("/communications/email")
    .send(email)
    .expect(200);
  await request(app)
    .post("/communications/email")
    .send({ ...email, body: "Changed message" })
    .expect(409);
  expect(first.body).toMatchObject({
    status: "queued",
    providerMessageId: "mocked-message",
  });
  expect(repeat.body).toEqual(first.body);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("requires a request identifier for external delivery and preserves an unconfirmed response on retry", async () => {
  fetch.mockRejectedValue(new Error("fake timeout"));
  await request(app)
    .post("/communications/email")
    .send({ ...email, idempotencyKey: undefined })
    .expect(400);
  expect(fetch).not.toHaveBeenCalled();
  const first = await request(app)
    .post("/communications/email")
    .send(email)
    .expect(201);
  const repeat = await request(app)
    .post("/communications/email")
    .send(email)
    .expect(200);
  expect(first.body).toMatchObject({
    status: "unknown",
    errorMessage: expect.stringContaining("did not confirm"),
  });
  expect(repeat.body).toEqual(first.body);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("reports old interrupted submissions as unconfirmed and keeps the original claim", async () => {
  fetch.mockResolvedValue(Response.json({ id: "mocked-message" }));
  const first = await request(app)
    .post("/communications/email")
    .send(email)
    .expect(201);
  state.row = {
    ...state.row!,
    status: "queued",
    providerMessageId: null,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
  };
  const repeat = await request(app)
    .post("/communications/email")
    .send(email)
    .expect(200);
  expect(repeat.body).toMatchObject({ id: first.body.id, status: "unknown" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
