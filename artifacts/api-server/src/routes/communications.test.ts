import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommunicationInsert } from "@workspace/db";

const state = vi.hoisted(() => ({
  row: undefined as CommunicationInsert | undefined,
  suppression: false,
  candidates: [] as Array<
    Pick<CommunicationInsert, "leadId" | "customerKey" | "customerName">
  >,
  inbound: new Map<string, CommunicationInsert>(),
  capture: vi.fn(),
}));

vi.mock("@workspace/db", async () => {
  const { communicationsTable } =
    await import("../../../../lib/db/src/schema/communications");
  const { demoOutboxTable } =
    await import("../../../../lib/db/src/schema/demo");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const client = {
    insert: (table: unknown) => ({
      values: (values: CommunicationInsert) => {
        if (table === demoOutboxTable) return state.capture(values);
        return {
          onConflictDoNothing: () => {
            if (values.direction === "inbound") {
              const id = values.id;
              if (!state.inbound.has(id)) state.inbound.set(id, values);
            }
            return {
              returning: async () => {
                if (state.row?.id === values.id) return [];
                state.row = values;
                return [values];
              },
            };
          },
        };
      },
    }),
    select: (projection?: unknown) => ({
      from: () => ({
        where: (condition: Parameters<typeof dialect.sqlToQuery>[0]) => {
          const query = dialect.sqlToQuery(condition);
          const matches = [state.row];
          return Object.assign(Promise.resolve(matches), {
            limit: async () => {
              const inbound = state.inbound.get(String(query.params[0]));
              if (inbound && query.params.includes(inbound.subject))
                return [{ id: inbound.id }];
              return projection && state.suppression
                ? [{ id: "suppressed" }]
                : [];
            },
            orderBy: () => ({
              limit: async () =>
                [...state.inbound.values()]
                  .filter(
                    (entry) =>
                      query.params.includes(entry.fromAddress) &&
                      query.params.includes(entry.toAddress) &&
                      query.params.includes(entry.subject),
                  )
                  .sort(
                    (a, b) =>
                      b.createdAt.localeCompare(a.createdAt) ||
                      Number(a.subject === "SMS opt-in") -
                        Number(b.subject === "SMS opt-in"),
                  )
                  .slice(0, 1),
            }),
            for: async () =>
              query.params.length === 1
                ? matches
                : state.row &&
                    query.params.includes(state.row.id) &&
                    query.params.includes(state.row.toAddress) &&
                    query.params.includes(state.row.fromAddress) &&
                    query.params.includes(state.row.providerMessageId)
                  ? matches
                  : [],
          });
        },
      }),
    }),
    selectDistinctOn: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => state.candidates }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Partial<CommunicationInsert>) => ({
        where: (condition: Parameters<typeof dialect.sqlToQuery>[0]) => {
          const query = dialect.sqlToQuery(condition);
          const saved = Promise.resolve().then(() => {
            const inbound = state.inbound.get(String(query.params[0]));
            if (inbound) {
              if (query.params.includes(inbound.subject))
                state.inbound.set(inbound.id, { ...inbound, ...values });
              return [];
            }
            if (!state.row) return [];
            state.row = { ...state.row, ...values };
            return [state.row];
          });
          return Object.assign(saved, { returning: () => saved });
        },
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
import {
  signalWireInboundWebhook,
  signalWireStatusWebhook,
} from "./sms-webhooks";

const hook = "/api/communications/webhooks/signalwire";
const app = express()
  .use(express.urlencoded({ extended: true }))
  .post(`${hook}/status/:id`, signalWireStatusWebhook)
  .post(`${hook}/inbound`, signalWireInboundWebhook)
  .use(
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
const project = "ea108133-d6b3-407c-9536-9fad8a929a6a";
const key = "synthetic-signing-key";
const sid = "0a059168-ead0-41af-9d1f-343dae832527";
const origin = "https://knox.example.com";
const from = "+18655550100";
const to = "+18655550122";

function signalWire() {
  vi.stubEnv("COMMS_SMS_PROVIDER", "signalwire");
  vi.stubEnv("APP_BASE_URL", origin);
  vi.stubEnv("SIGNALWIRE_SPACE_URL", "https://mock.signalwire.com");
  vi.stubEnv("SIGNALWIRE_API_TOKEN", "synthetic-api-token");
  vi.stubEnv("SIGNALWIRE_PROJECT_ID", project);
  vi.stubEnv("SIGNALWIRE_SIGNING_KEY", key);
  vi.stubEnv("SIGNALWIRE_FROM_NUMBER", from);
}

function signature(url: string, fields: Record<string, string>) {
  const signed = Object.keys(fields)
    .sort()
    .reduce((value, name) => value + name + fields[name], url);
  return createHmac("sha1", key).update(signed).digest("base64");
}

function postCallback(
  path: string,
  fields: Record<string, string>,
  signed = signature(`${origin}${path}`, fields),
) {
  return request(app)
    .post(path)
    .type("form")
    .set("x-signalwire-signature", signed)
    .send(fields);
}

beforeEach(() => {
  state.row = undefined;
  state.suppression = false;
  state.candidates = [];
  state.inbound.clear();
  state.capture.mockReset();
  fetch.mockReset();
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("DEMO_ACCESS_ENABLED", "false");
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

it("checks suppression for live email without calling Resend", async () => {
  state.suppression = true;
  const result = await request(app)
    .post("/communications/email")
    .send(email)
    .expect(201);
  expect(result.body).toMatchObject({
    status: "failed",
    errorMessage: expect.stringContaining("suppressed"),
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps a signed delivery received before the SignalWire send response and ignores older or unrelated callbacks", async () => {
  signalWire();
  await request(app).get("/communications/sms/status").expect(200, {
    mode: "live",
    provider: "signalwire",
    serverSendAvailable: true,
  });
  const event = {
    AccountSid: project,
    MessageSid: sid,
    From: from,
    To: to,
    MessageStatus: "delivered",
  };
  let path = "";
  fetch.mockImplementationOnce(async (_url, init) => {
    const callback = (init?.body as URLSearchParams).get("StatusCallback");
    expect(callback).toContain(origin);
    const url = new URL(callback!);
    path = `${url.pathname}${url.search}`;
    await postCallback(path, event).expect(200);
    return Response.json({
      account_sid: project,
      sid,
      from,
      to,
      status: "queued",
    });
  });
  const sms = {
    to,
    body: "Your order has arrived.",
    idempotencyKey: "sms-submission-1",
  };
  const submitted = await request(app)
    .post("/communications/sms")
    .send(sms)
    .expect(201);
  expect(submitted.body).toMatchObject({
    status: "delivered",
    providerMessageId: `signalwire:${project}:${sid}`,
  });
  await postCallback(path, event).expect(200);
  await postCallback(path, { ...event, MessageStatus: "sent" }).expect(200);
  await postCallback(path, { ...event, MessageStatus: "undelivered" }).expect(
    200,
  );
  await postCallback(path, {
    ...event,
    MessageStatus: "failed",
    To: "+18655550123",
  }).expect(401);
  await postCallback(
    path.replace(/proof=.*/, `proof=${"0".repeat(64)}`),
    event,
  ).expect(401);
  await postCallback(
    path,
    event,
    signature(`https://other.example.com${path}`, event),
  ).expect(401);
  await postCallback(path, {
    ...event,
    AccountSid: "a3118133-d6b3-407c-9536-9fad8a929a6a",
  }).expect(401);
  await postCallback(
    path,
    { ...event, MessageStatus: "failed" },
    signature(`${origin}${path}`, event),
  ).expect(401);
  const replay = await request(app)
    .post("/communications/sms")
    .send(sms)
    .expect(200);
  expect(replay.body).toEqual(submitted.body);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("accepts signed replies once and leaves a conflicting conversation unassigned", async () => {
  signalWire();
  const path = `${hook}/inbound`;
  const event = {
    AccountSid: project,
    MessageSid: sid,
    From: to,
    To: from,
    Body: "Yes, Thursday works. 🚪",
    NumMedia: "0",
  };
  state.candidates = [
    {
      leadId: "lead-1",
      customerKey: "customer-1",
      customerName: "Fixture Home",
    },
  ];
  const first = await postCallback(path, event).expect(200);
  expect(first.text).toBe(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
  );
  await postCallback(path, event).expect(200);
  expect(state.inbound.size).toBe(1);
  expect([...state.inbound.values()][0]).toMatchObject({
    direction: "inbound",
    status: "received",
    body: event.Body,
    leadId: "lead-1",
    customerKey: "customer-1",
  });
  await postCallback(path, { ...event, To: "+18655550199" }).expect(403);
  await postCallback(
    path,
    event,
    signature(`https://other.example.com${path}`, event),
  ).expect(401);
  state.candidates.push({
    leadId: "lead-2",
    customerKey: "customer-2",
    customerName: "Other Home",
  });
  const media = {
    ...event,
    MessageSid: "1a059168-ead0-41af-9d1f-343dae832527",
    NumMedia: "1",
    Body: "",
    MediaUrl0: "https://ignored.example.com/media",
  };
  await postCallback(
    path,
    media,
    signature(`https://knox.example.com:443${path}`, media),
  ).expect(200);
  expect([...state.inbound.values()][1]).toMatchObject({
    customerKey: null,
    leadId: null,
    body: "Media message received.",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects signed outbound receipts on the inbound URL before saving a reply or an opt-out", async () => {
  signalWire();
  const path = `${hook}/inbound`;
  const event = {
    AccountSid: project,
    MessageSid: sid,
    From: to,
    To: from,
    Body: "STOP",
    NumMedia: "0",
  };
  await postCallback(path, {
    ...event,
    MessageStatus: "sent",
    SmsStatus: "sent",
  }).expect(400);
  await postCallback(path, { ...event, MessageStatus: "delivered" }).expect(
    400,
  );
  await postCallback(path, { ...event, SmsStatus: "failed" }).expect(400);
  expect(state.inbound.size).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  await postCallback(path, {
    ...event,
    Body: "Yes",
    SmsStatus: "received",
  }).expect(200);
  expect(state.inbound.size).toBe(1);
});

it("orders consent by the authenticated message record and blocks future sends while opt-out is active", async () => {
  signalWire();
  const path = `${hook}/inbound`;
  const oldest = {
    AccountSid: project,
    MessageSid: sid,
    From: to,
    To: from,
    Body: "  stop  ",
    NumMedia: "0",
  };
  const restored = {
    ...oldest,
    MessageSid: "1a059168-ead0-41af-9d1f-343dae832527",
    Body: "UNSTOP",
  };
  const revoked = {
    ...oldest,
    MessageSid: "2a059168-ead0-41af-9d1f-343dae832527",
    Body: "REVOKE",
  };
  const retryStart = {
    ...oldest,
    MessageSid: "3a059168-ead0-41af-9d1f-343dae832527",
    Body: "START",
  };
  function verified(event: typeof oldest, date: string) {
    return {
      account_sid: project,
      sid: event.MessageSid,
      from: event.From,
      to: event.To,
      body: event.Body,
      date_created: date,
      direction: "inbound",
    };
  }
  const timeline = new Map([
    [oldest.MessageSid, verified(oldest, "Mon, 16 Nov 2026 13:00:00 +0000")],
    [
      restored.MessageSid,
      verified(restored, "Mon, 16 Nov 2026 13:01:00 +0000"),
    ],
    [revoked.MessageSid, verified(revoked, "Mon, 16 Nov 2026 13:02:00 +0000")],
  ]);
  fetch.mockImplementation(async (target, options) => {
    if (options?.method === "POST") {
      const destination = (options.body as URLSearchParams).get("To");
      return Response.json({
        account_sid: project,
        sid,
        from,
        to: destination,
        status: "queued",
      });
    }
    const result = timeline.get(String(target).split("/").at(-1)!);
    return result ? Response.json(result) : new Response(null, { status: 503 });
  });

  await postCallback(path, restored).expect(200);
  await postCallback(path, oldest).expect(200);
  const send = (idempotencyKey: string, recipient = to) =>
    request(app)
      .post("/communications/sms")
      .send({ to: recipient, body: "Arrival update", idempotencyKey });
  expect((await send("sms-consent-before").expect(201)).body.status).toBe(
    "queued",
  );
  await postCallback(path, revoked).expect(200);
  await postCallback(path, revoked).expect(200);
  expect(
    fetch.mock.calls.filter(([target]) =>
      String(target).endsWith(revoked.MessageSid),
    ),
  ).toHaveLength(1);
  const blocked = await send("sms-consent-blocked").expect(201);
  expect(blocked.body).toMatchObject({
    status: "failed",
    errorMessage: expect.stringContaining("opted out"),
  });
  expect(
    (await send("sms-different-recipient", "+18655550133").expect(201)).body
      .status,
  ).toBe("queued");

  await postCallback(path, retryStart).expect(503);
  expect((await send("sms-consent-unverified").expect(201)).body.status).toBe(
    "failed",
  );
  timeline.set(
    retryStart.MessageSid,
    verified(retryStart, "Mon, 16 Nov 2026 13:03:00 +0000"),
  );
  await postCallback(path, retryStart).expect(200);
  expect((await send("sms-consent-resumed").expect(201)).body.status).toBe(
    "queued",
  );
  expect(
    fetch.mock.calls.filter(([, options]) => options?.method === "POST"),
  ).toHaveLength(3);
});
