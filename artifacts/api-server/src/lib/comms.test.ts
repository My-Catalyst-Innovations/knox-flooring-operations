import { describe, expect, it, vi } from "vitest";
import {
  availableCommunicationProviders,
  canSendCommunication,
  communicationMode,
  emailAddress,
  passwordResetLink,
  sendEmail,
  sendPasswordResetEmail,
  sendSms,
  smsNumber,
} from "./comms";

const emailEnv = {
  RESEND_API_KEY: "fake_send_only_key",
  RESEND_FROM_EMAIL: "Catalyst Works <service@example.com>",
  RESEND_REPLY_TO_EMAIL: "help@example.com",
};
const smsEnv = {
  TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${"b".repeat(32)}`,
  TWILIO_API_KEY_SECRET: "fake_api_key_secret",
  TWILIO_MESSAGING_SERVICE_SID: `MG${"c".repeat(32)}`,
};

describe("outbound delivery controls", () => {
  it("keeps demo and default deployments capture-only unless explicitly enabled", () => {
    const allowlist = { COMMS_ALLOWLIST: "To@Example.com, (865) 555-0123" };
    expect(
      communicationMode({ ...emailEnv, COMMS_DELIVERY_MODE: "live" }),
    ).toBe("capture");
    expect(
      canSendCommunication("email", "to@example.com", {
        ...allowlist,
        DEMO_MODE: "true",
        COMMS_DELIVERY_MODE: "live",
      }),
    ).toBe(false);
    expect(
      canSendCommunication("email", "to@example.com", { DEMO_MODE: "false" }),
    ).toBe(false);
    expect(
      canSendCommunication("email", "to@example.com", {
        ...allowlist,
        DEMO_MODE: "false",
      }),
    ).toBe(true);
    expect(
      canSendCommunication("sms", "+18655550123", {
        ...allowlist,
        DEMO_MODE: "false",
      }),
    ).toBe(true);
    expect(
      canSendCommunication("email", "other@example.com", {
        DEMO_MODE: "false",
        COMMS_DELIVERY_MODE: "live",
      }),
    ).toBe(true);
  });

  it("validates individual recipients and sender settings", () => {
    expect(emailAddress(" Staff+floor@Example.com ")).toBe(
      "staff+floor@example.com",
    );
    expect(emailAddress("staff@example.com\r\nBcc: x@example.com")).toBeNull();
    expect(emailAddress("a@example.com, b@example.com")).toBeNull();
    expect(smsNumber("+44 7700 900123")).toBe("+447700900123");
    expect(smsNumber("865-555-0123 ext. 4")).toBeNull();
    expect(availableCommunicationProviders({ ...emailEnv, ...smsEnv })).toEqual(
      { email: true, sms: true },
    );
    expect(
      availableCommunicationProviders({
        ...emailEnv,
        ...smsEnv,
        RESEND_FROM_EMAIL: "Bad sender",
        TWILIO_FROM_NUMBER: "+18655550123",
      }),
    ).toEqual({ email: false, sms: false });
  });
});

describe("direct provider requests", () => {
  it("submits escaped email over HTTPS and reports an accepted request as queued", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ id: "message" }));
    const result = await sendEmail(
      {
        to: "TO@example.com",
        subject: "Flooring update",
        body: "Use <sample> & tile",
        idempotencyKey: "outbound/request",
      },
      emailEnv,
      fetch,
    );
    expect(result).toEqual({
      status: "queued",
      providerMessageId: "message",
      fromAddress: emailEnv.RESEND_FROM_EMAIL,
    });
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(request).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer fake_send_only_key",
        "Idempotency-Key": "outbound/request",
      },
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      from: emailEnv.RESEND_FROM_EMAIL,
      to: ["to@example.com"],
      reply_to: "help@example.com",
      text: "Use <sample> & tile",
      html: expect.stringContaining("Use &lt;sample&gt; &amp; tile"),
    });
  });

  it("submits SMS with the API key and only the selected sender", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ sid: "SMS-1", status: "accepted" }));
    expect(
      await sendSms({ to: "865-555-0123", body: "Crew update" }, smsEnv, fetch),
    ).toMatchObject({ status: "queued", providerMessageId: "SMS-1" });
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${smsEnv.TWILIO_ACCOUNT_SID}/Messages.json`,
    );
    const auth = Buffer.from(
      `${smsEnv.TWILIO_API_KEY_SID}:${smsEnv.TWILIO_API_KEY_SECRET}`,
    ).toString("base64");
    expect(request).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Basic ${auth}` },
    });
    expect(Object.fromEntries(request?.body as URLSearchParams)).toEqual({
      To: "+18655550123",
      Body: "Crew update",
      MessagingServiceSid: smsEnv.TWILIO_MESSAGING_SERVICE_SID,
    });
  });

  it("distinguishes rejected and ambiguous submissions without retrying them", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockResolvedValueOnce(
      new Response("provider error body", { status: 503 }),
    );
    await expect(
      sendSms({ to: "865-555-0123", body: "Crew update" }, smsEnv, fetch),
    ).rejects.toMatchObject({ ambiguous: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(
      new Response("provider error body", { status: 401 }),
    );
    await expect(
      sendSms({ to: "865-555-0123", body: "Crew update" }, smsEnv, fetch),
    ).rejects.toMatchObject({ ambiguous: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it("uses a private HTTPS fragment for reset tokens and a unique provider submission key", async () => {
  expect(passwordResetLink("http://demo.example.com", "token")).toBeNull();
  expect(
    passwordResetLink("https://user:pass@demo.example.com", "token"),
  ).toBeNull();
  const resetUrl = passwordResetLink(
    "https://works.example.com/",
    "example-reset-token",
  )!;
  expect(resetUrl).toBe(
    "https://works.example.com/welcome#reset=example-reset-token",
  );
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ id: "reset-email" }));
  await sendPasswordResetEmail(
    "staff@example.com",
    resetUrl,
    "reset-1",
    emailEnv,
    fetch,
  );
  const [, request] = fetch.mock.calls[0];
  expect(request).toMatchObject({
    headers: { "Idempotency-Key": "password-reset/reset-1" },
  });
  expect(JSON.parse(String(request?.body))).toMatchObject({
    to: ["staff@example.com"],
    text: expect.stringContaining(resetUrl),
    html: expect.stringContaining(`href="${resetUrl}"`),
  });
});
