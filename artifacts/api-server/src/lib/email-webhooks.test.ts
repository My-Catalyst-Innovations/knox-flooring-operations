import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("@workspace/db", () => ({}));
import { emailReceiptOutcome, verifyEmailCorrelation, verifyEmailWebhook } from "./email-webhooks";

describe("email delivery event authenticity", () => {
  const now = 1_800_000_000_000;
  const timestamp = String(now / 1000);
  const id = "msg_synthetic_receipt";
  const key = Buffer.from("synthetic-email-signing-secret-32");
  const secret = `whsec_${key.toString("base64")}`;
  const raw = Buffer.from('{ "type": "email.delivered" }');
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(raw).digest("base64");

  it("accepts the signed raw bytes and key rotation", () => {
    expect(verifyEmailWebhook(raw, id, timestamp, `v1,invalid v1,${signature}`, secret, now)).toBe(true);
  });
  it("rejects changed bytes, event ids, stale timestamps and missing secrets", () => {
    expect(verifyEmailWebhook(Buffer.from('{}'), id, timestamp, `v1,${signature}`, secret, now)).toBe(false);
    expect(verifyEmailWebhook(raw, "another-id", timestamp, `v1,${signature}`, secret, now)).toBe(false);
    expect(verifyEmailWebhook(raw, id, timestamp, `v1,${signature}`, secret, now + 301_000)).toBe(false);
    expect(verifyEmailWebhook(raw, id, timestamp, `v1,${signature}`, undefined, now)).toBe(false);
  });
  it("keeps duplicate and reordered positive events from downgrading delivery", () => {
    expect(emailReceiptOutcome("email.sent", "delivered")).toBeNull();
    expect(emailReceiptOutcome("email.delivered", "failed")).toBeNull();
    expect(emailReceiptOutcome("email.delivered", "delivered")).toBeNull();
    expect(emailReceiptOutcome("email.opened", "queued")).toBeNull();
    expect(emailReceiptOutcome("email.delivered", "queued")?.status).toBe("delivered");
  });
  it("records bounces and complaints even after an initial delivery", () => {
    expect(emailReceiptOutcome("email.complained", "delivered")).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("suppressed") });
    expect(emailReceiptOutcome("email.bounced", "sent")?.status).toBe("failed");
    expect(emailReceiptOutcome("email.bounced", "sent", "Transient")?.errorMessage).not.toContain("suppressed");
    expect(emailReceiptOutcome("email.bounced", "sent", "Permanent")?.errorMessage).toContain("suppressed");
  });
  it("binds early delivery correlation to the configured company signing key", () => {
    const correlationId = "a".repeat(64);
    const token = createHmac("sha256", secret).update(correlationId).digest("hex");
    expect(verifyEmailCorrelation(correlationId, token, secret)).toBe(true);
    expect(verifyEmailCorrelation(correlationId, token, "another-company-secret")).toBe(false);
    expect(verifyEmailCorrelation(correlationId, undefined, secret)).toBe(false);
  });
});
