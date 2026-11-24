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
  outlookSend: vi.fn(),
  outlookCapability: vi.fn(),
  authorizeSms: vi.fn(),
  recheckSms: vi.fn(),
  inboundPreference: vi.fn(),
}));

// This suite isolates message/provider mechanics. The real durable permission
// ledger and signed STOP/START races are covered by the PostgreSQL workflow.
vi.mock("../lib/sms-preferences",()=>({
  currentSmsSenderBinding:()=>({fingerprint:"synthetic-binding"}),
  authorizeSmsDispatch:state.authorizeSms,
  recheckSmsDispatch:state.recheckSms,
  recordInboundSmsPreference:state.inboundPreference,
}));

vi.mock("../lib/outlook-calendar", () => ({
  sendOutlookEmail: state.outlookSend,
  outlookEmailCapability: state.outlookCapability,
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
import { OutlookError } from "../lib/outlook-graph";
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
  vi.stubEnv("COMMS_SMS_DELIVERY_MODE", "live");
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
  state.outlookSend.mockReset();
  state.outlookCapability.mockReset();
  state.authorizeSms.mockReset().mockResolvedValue({});
  state.recheckSms.mockReset().mockResolvedValue(undefined);
  state.inboundPreference.mockReset().mockResolvedValue(undefined);
  state.outlookCapability.mockResolvedValue({
    connected: false,
    mailboxEmail: null,
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("DEMO_ACCESS_ENABLED", "false");
  vi.stubEnv("COMMS_DELIVERY_MODE", "live");
  vi.stubEnv("COMMS_SMS_DELIVERY_MODE", "");
  vi.stubEnv("COMMS_SMS_ALLOWLIST", "");
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

it("submits through the selected Outlook mailbox once without claiming delivery or a provider ID", async () => {
  state.outlookSend.mockResolvedValue({
    accepted: true,
    mailboxEmail: "owner@example.com",
  });
  const input = { ...email, provider: "outlook" };
  const first = await request(app)
    .post("/communications/email")
    .send(input)
    .expect(201);
  const repeat = await request(app)
    .post("/communications/email")
    .send(input)
    .expect(200);
  expect(first.body).toMatchObject({
    status: "sent",
    emailProvider: "outlook",
    fromAddress: "owner@example.com",
  });
  expect(first.body.providerMessageId).toBeUndefined();
  expect(repeat.body).toEqual(first.body);
  await request(app)
    .post("/communications/email")
    .send({ ...input, provider: "resend" })
    .expect(409);
  expect(state.outlookSend).toHaveBeenCalledExactlyOnceWith({
    to: "customer@example.com",
    subject: email.subject,
    body: email.body,
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("does not silently change a Resend claim to Outlook, including older rows without a provider", async () => {
  fetch.mockResolvedValue(Response.json({ id: "mocked-message" }));
  await request(app).post("/communications/email").send(email).expect(201);
  state.row = { ...state.row!, emailProvider: null };
  await request(app)
    .post("/communications/email")
    .send({ ...email, provider: "outlook" })
    .expect(409);
  await request(app).post("/communications/email").send(email).expect(200);
  expect(state.outlookSend).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("retains an ambiguous Outlook submission on retry and never falls back to another sender", async () => {
  const error = new OutlookError(
    "Microsoft did not confirm submission. Check Sent Items before sending again.",
    502,
  );
  Object.assign(error, { submissionUnknown: true });
  state.outlookSend.mockRejectedValue(error);
  const input = { ...email, provider: "outlook" };
  const first = await request(app)
    .post("/communications/email")
    .send(input)
    .expect(201);
  expect(first.body.status).toBe("unknown");
  const repeat = await request(app)
    .post("/communications/email")
    .send(input)
    .expect(200);
  expect(repeat.body).toEqual(first.body);
  expect(state.outlookSend).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});

it("records a definitive Outlook permission rejection as failed", async () => {
  state.outlookSend.mockRejectedValue(
    new OutlookError("Reconnect Microsoft and allow email sending.", 403),
  );
  const result = await request(app)
    .post("/communications/email")
    .send({ ...email, provider: "outlook" })
    .expect(201);
  expect(result.body).toMatchObject({
    status: "failed",
    emailProvider: "outlook",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps Outlook inside capture and allowlist protection and validates the provider", async () => {
  await request(app)
    .post("/communications/email")
    .send({ ...email, provider: "unrecognized" })
    .expect(400);
  vi.stubEnv("COMMS_DELIVERY_MODE", "allowlist");
  vi.stubEnv("COMMS_ALLOWLIST", "owner@example.com");
  const result = await request(app)
    .post("/communications/email")
    .send({ ...email, provider: "outlook" })
    .expect(201);
  expect(result.body).toMatchObject({
    status: "captured",
    emailProvider: "outlook",
  });
  expect(state.outlookSend).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("applies email suppression to Outlook and exposes only safe sender readiness", async () => {
  state.suppression = true;
  const result = await request(app)
    .post("/communications/email")
    .send({ ...email, provider: "outlook" })
    .expect(201);
  expect(result.body.status).toBe("failed");
  expect(state.outlookSend).not.toHaveBeenCalled();
  state.outlookCapability.mockResolvedValue({
    connected: true,
    mailboxEmail: "owner@example.com",
  });
  await request(app)
    .get("/communications/email/status")
    .expect(200, {
      mode: "live",
      resend: { configured: true },
      outlook: { connected: true, mailboxEmail: "owner@example.com" },
    });
  vi.stubEnv("READ_ONLY_RECOVERY", "true");
  const readiness = await request(app)
    .get("/communications/email/status")
    .expect(200);
  expect(readiness.body.resend.configured).toBe(false);
  expect(readiness.body.outlook.connected).toBe(false);
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
  const capability = await request(app).get("/communications/sms/status").expect(200);
  expect(capability.body).toMatchObject({
    mode: "live",
    provider: "signalwire",
    serverSendAvailable: true,
    readiness: "ready",
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
    vi.stubEnv("COMMS_SMS_DELIVERY_MODE", "capture");
    await postCallback(path, event).expect(200);
    vi.stubEnv("COMMS_SMS_DELIVERY_MODE", "live");
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

it("keeps newly configured SignalWire paused under live email policy without restricting email", async () => {
  signalWire();
  vi.stubEnv("COMMS_SMS_DELIVERY_MODE", "");
  vi.stubEnv("COMMS_ALLOWLIST", to);
  const capability=await request(app).get("/communications/sms/status").expect(200);
  expect(capability.body).toMatchObject({mode:"capture",provider:"signalwire",serverSendAvailable:false,readiness:"capture",detail:expect.stringContaining("paused")});
  const text=await request(app).post("/communications/sms").send({to,body:"Do not deliver",idempotencyKey:"sms-independent-default"}).expect(201);
  expect(text.body.status).toBe("captured");expect(fetch).not.toHaveBeenCalled();
  vi.stubEnv("COMMS_SMS_DELIVERY_MODE", "allowlist");
  vi.stubEnv("COMMS_SMS_ALLOWLIST", to);
  fetch.mockResolvedValueOnce(Response.json({id:"email-still-live"}));
  const emailResult=await request(app).post("/communications/email").send(email).expect(201);
  expect(emailResult.body).toMatchObject({status:"queued",providerMessageId:"email-still-live"});
  expect(fetch).toHaveBeenCalledTimes(1);expect(String(fetch.mock.calls[0][0])).toBe("https://api.resend.com/emails");
});

it("submits only the independent SMS allowlist and never inherits global recipients", async () => {
  signalWire();
  vi.stubEnv("COMMS_SMS_DELIVERY_MODE", "allowlist");
  vi.stubEnv("COMMS_SMS_ALLOWLIST", "(865) 555-0122");
  vi.stubEnv("COMMS_ALLOWLIST", "+18655550133");
  fetch.mockResolvedValueOnce(Response.json({account_sid:project,sid,from,to,status:"queued"}));
  const allowed=await request(app).post("/communications/sms").send({to,body:"Internal consenting test",idempotencyKey:"sms-independent-approved"}).expect(201);
  expect(allowed.body.status).toBe("queued");
  const other=await request(app).post("/communications/sms").send({to:"+18655550133",body:"Blocked by SMS policy",idempotencyKey:"sms-independent-blocked"}).expect(201);
  expect(other.body.status).toBe("captured");expect(fetch).toHaveBeenCalledTimes(1);
  vi.stubEnv("COMMS_SMS_ALLOWLIST", "owner@example.com,invalid");
  const empty=await request(app).get("/communications/sms/status").expect(200);
  expect(empty.body).toMatchObject({mode:"allowlist",serverSendAvailable:false,readiness:"allowlist_required",detail:expect.stringContaining("approved test number")});
});

it("gates unconfigured company texting without a provider call", async () => {
  vi.stubEnv("COMMS_SMS_DELIVERY_MODE", "live");
  vi.stubEnv("COMMS_SMS_PROVIDER", "signalwire");
  vi.stubEnv("SIGNALWIRE_API_TOKEN", "");
  const capability=await request(app).get("/communications/sms/status").expect(200);
  expect(capability.body).toMatchObject({provider:null,serverSendAvailable:false,readiness:"configuration_required",detail:expect.stringContaining("approved sender")});
  const result=await request(app).post("/communications/sms").send({to,body:"Cannot send yet",idempotencyKey:"sms-unconfigured-policy"}).expect(201);
  expect(result.body.status).toBe("failed");expect(fetch).not.toHaveBeenCalled();
});

it("continues authenticating and saving inbound STOP while outbound SMS is paused",async()=>{
  signalWire();vi.stubEnv("COMMS_SMS_DELIVERY_MODE","capture");
  const event={AccountSid:project,MessageSid:sid,From:to,To:from,Body:"STOP",NumMedia:"0"};
  fetch.mockResolvedValueOnce(Response.json({account_sid:project,sid,from:to,to:from,body:"STOP",direction:"inbound",date_created:"Mon, 16 Nov 2026 13:00:00 +0000"}));
  await postCallback(`${hook}/inbound`,event).expect(200);
  expect([...state.inbound.values()][0]).toMatchObject({subject:"SMS opt-out",body:"STOP"});
  expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0][1]?.method).toBeUndefined();
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

it("records signed STOP before a timestamp lookup and never treats START as permission", async () => {
  signalWire();
  const path = `${hook}/inbound`;
  let suppressed = false;
  state.inboundPreference.mockImplementation(async input => { if (input.command === "stop") suppressed = true; });
  state.recheckSms.mockImplementation(async row => {
    if (row.toAddress === to && suppressed) {
      const { DomainError } = await import("../lib/operations-rules");
      throw new DomainError(409, "This recipient has opted out; owner review is required.");
    }
  });
  const stop = { AccountSid: project, MessageSid: sid, From: to, To: from, Body: "STOP", NumMedia: "0" };
  const start = { ...stop, MessageSid: "1a059168-ead0-41af-9d1f-343dae832527", Body: "START" };
  fetch.mockImplementation(async (target, options) => {
    if (options?.method === "POST") return Response.json({ account_sid: project, sid, from, to: (options.body as URLSearchParams).get("To"), status: "queued" });
    if (String(target).endsWith(start.MessageSid)) return Response.json({ account_sid: project, sid: start.MessageSid, from: to, to: from, body: "START", direction: "inbound", date_created: "Mon, 16 Nov 2026 13:03:00 +0000" });
    return new Response(null, { status: 503 });
  });
  await postCallback(path, stop).expect(503);
  expect(state.inboundPreference).toHaveBeenCalledWith(expect.objectContaining({ to, sender: from, command: "stop" }));
  expect(state.inboundPreference.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0]);
  const send = (idempotencyKey: string, recipient = to) => request(app).post("/communications/sms").send({ to: recipient, body: "Arrival update", idempotencyKey });
  expect((await send("pending-stop-blocked").expect(201)).body.status).toBe("failed");
  await postCallback(path, start).expect(200);
  expect((await send("start-still-blocked").expect(201)).body.status).toBe("failed");
  expect((await send("other-recipient-safe", "+18655550133").expect(201)).body.status).toBe("queued");
  expect(fetch.mock.calls.filter(([,options])=>options?.method==="POST")).toHaveLength(1);
});