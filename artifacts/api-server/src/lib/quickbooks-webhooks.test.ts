import { createHash, createHmac } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../app";
import { quickBooksWebhookChanges, quickBooksWebhookEntries, verifyQuickBooksWebhookSignature } from "./quickbooks-webhooks";

const mocks = vi.hoisted(() => ({ getConnection: vi.fn(), values: vi.fn() }));
vi.mock("@workspace/db", () => ({
  db: { insert: () => ({ values: mocks.values }) },
  quickbooksWebhookEventsTable: {},
}));
vi.mock("./quickbooks", () => ({ getConnection: mocks.getConnection }));
vi.mock("../routes", async () => {
  const { Router } = await import("express");
  const { quickBooksWebhook } = await import("../routes/quickbooks");
  return { default: Router().post("/quickbooks/webhook", quickBooksWebhook) };
});

// CloudEvents attributes from Intuit's documented batch payload.
const invoiceEvent = {
  specversion: "1.0",
  id: "88cd52aa-33b6-4351-9aa4-47572edbd068",
  source: "intuit.dsnBgbseACLLRZNxo2dfc4evmEJdxde58xeeYcZliOU=",
  type: "qbo.invoice.updated.v1",
  datacontenttype: "application/json",
  time: "2025-09-10T21:31:25.179851517Z",
  intuitentityid: "1234",
  intuitaccountid: "310687",
  data: {},
};
const realmId = invoiceEvent.intuitaccountid;

function entries(payload: unknown) {
  return quickBooksWebhookEntries(payload, Buffer.from(JSON.stringify(payload)), realmId);
}

describe("QuickBooks webhook intake", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the signed batch media type through the server and queues only matched events", async () => {
    vi.stubEnv("QUICKBOOKS_WEBHOOK_VERIFIER", "test-only-verifier");
    vi.stubEnv("READ_ONLY_RECOVERY", "false");
    mocks.getConnection.mockResolvedValue({ realmId, status: "connected" });
    mocks.values.mockReturnValue({ onConflictDoNothing: async () => undefined });
    const raw = JSON.stringify([{ ...invoiceEvent, intuitaccountid: "99999" }, invoiceEvent], null, 2);
    const signature = createHmac("sha256", "test-only-verifier").update(raw).digest("base64");
    const post = (signatureValue: string) => request(app).post("/api/quickbooks/webhook")
      .set("Content-Type", "application/cloudevents-batch+json; charset=utf-8")
      .set("intuit-signature", signatureValue).send(raw);

    expect((await post("invalid")).status).toBe(401);
    expect(mocks.getConnection).not.toHaveBeenCalled();
    mocks.getConnection.mockResolvedValueOnce({ realmId, status: "disconnected" });
    expect((await post(signature)).status).toBe(200);
    expect(mocks.values).not.toHaveBeenCalled();
    expect((await post(signature)).status).toBe(200);
    expect(mocks.values).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ realmId, payload: { cloudEvent: invoiceEvent } }),
    ]);
  });

  it("verifies the signature against the raw request and rejects malformed header bytes", () => {
    const raw = Buffer.from(JSON.stringify([invoiceEvent], null, 2));
    const verifier = "test-only-verifier";
    const signature = createHmac("sha256", verifier).update(raw).digest("base64");
    expect(verifyQuickBooksWebhookSignature(raw, signature, verifier)).toBe(true);
    expect(verifyQuickBooksWebhookSignature(Buffer.from(JSON.stringify([invoiceEvent])), signature, verifier)).toBe(false);
    expect(verifyQuickBooksWebhookSignature(raw, `é${signature.slice(1)}`, verifier)).toBe(false);
  });

  it("enqueues invoice and payment events only for the connected realm in a mixed-realm batch", () => {
    const payment = { ...invoiceEvent, id: "payment-event", type: "qbo.payment.created.v1", intuitentityid: "5678" };
    const otherCompany = { ...invoiceEvent, id: "other-company", intuitaccountid: "910110" };
    const invalid = { ...invoiceEvent, id: "invalid", intuitentityid: "1234/5678" };
    const unrelated = { ...invoiceEvent, id: "unrelated", type: "qbo.account.created.v1" };
    const received = entries([otherCompany, invoiceEvent, invalid, payment, unrelated]);
    expect(received).toHaveLength(2);
    expect(received.map((entry) => entry.realmId)).toEqual([realmId, realmId]);
    expect(received.flatMap(({ payload }) => quickBooksWebhookChanges(payload, realmId))).toEqual([
      { entity: "Invoice", id: "1234", deleted: false },
      { entity: "Payment", id: "5678", deleted: false },
    ]);
    expect(quickBooksWebhookChanges(received[0].payload, otherCompany.intuitaccountid)).toEqual([]);
    expect(entries([payment])[0].eventKey).toBe(received[1].eventKey);
    expect(entries([{ ...payment, source: "intuit.different-source" }])[0].eventKey).not.toBe(received[1].eventKey);
  });

  it("recognizes deletes without classifying voided documents as deleted", () => {
    const received = entries([
      { ...invoiceEvent, type: "qbo.invoice.deleted.v1" },
      { ...invoiceEvent, id: "payment-deleted", type: "qbo.payment.deleted.v1" },
      { ...invoiceEvent, id: "invoice-voided", type: "qbo.invoice.voided.v1" },
    ]);
    expect(received.flatMap(({ payload }) => quickBooksWebhookChanges(payload, realmId))).toEqual([
      { entity: "Invoice", id: "1234", deleted: true },
      { entity: "Payment", id: "1234", deleted: true },
      { entity: "Invoice", id: "1234", deleted: false },
    ]);
  });

  it("consumes previously queued legacy payloads and preserves their delivery hash", () => {
    const payload = {
      eventNotifications: [
        { realmId, dataChangeEvent: { entities: [{ name: "Invoice", id: "14", operation: "Update" }, { name: "Payment", id: "15", operation: "Delete" }] } },
        { realmId: "910110", dataChangeEvent: { entities: [{ name: "Invoice", id: "16", operation: "Update" }] } },
      ],
    };
    const received = entries(payload);
    const changes = [{ entity: "Invoice", id: "14", deleted: false }, { entity: "Payment", id: "15", deleted: true }];
    expect(received).toHaveLength(1);
    expect(received[0].eventKey).toBe(createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
    expect(quickBooksWebhookChanges(payload, realmId)).toEqual(changes);
    expect(quickBooksWebhookChanges(received[0].payload, realmId)).toEqual(changes);
    expect(quickBooksWebhookChanges(received[0].payload, "910110")).toEqual([]);
  });
});
