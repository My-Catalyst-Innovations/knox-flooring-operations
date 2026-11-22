import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  availableCommunicationProviders,
  canSendCommunication,
  communicationMode,
  emailAddress,
  passwordResetLink,
  sendEmail,
  sendPasswordResetEmail,
  sendSms,
  smsDeliveryCapability,
  smsNumber,
} from "./comms";

const emailEnv = {
  RESEND_API_KEY: "fake_send_only_key",
  RESEND_FROM_EMAIL: "Catalyst Works <service@example.com>",
  RESEND_REPLY_TO_EMAIL: "help@example.com",
  RESEND_WEBHOOK_SECRET: "whsec_fixture",
};
const smsEnv = {
  TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${"b".repeat(32)}`,
  TWILIO_API_KEY_SECRET: "fake_api_key_secret",
  TWILIO_MESSAGING_SERVICE_SID: `MG${"c".repeat(32)}`,
};
const companySms = {
  DEMO_MODE: "false",
  COMMS_DELIVERY_MODE: "allowlist",
  APP_BASE_URL: "https://knox.example.com",
  SIGNALWIRE_SPACE_URL: "https://knox-space.signalwire.com",
  SIGNALWIRE_PROJECT_ID: "ea108133-d6b3-407c-9536-9fad8a929a6a",
  SIGNALWIRE_API_TOKEN: "mock-signalwire-token",
  SIGNALWIRE_SIGNING_KEY: "mock-signing-key",
  SIGNALWIRE_FROM_NUMBER: "+18655550100",
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

  it.each(["allowlist", "live"])(
    "blocks %s delivery when password-free demo access is enabled",
    (mode) => {
      const env = {
        DEMO_MODE: "false",
        DEMO_ACCESS_ENABLED: "true",
        COMMS_DELIVERY_MODE: mode,
        COMMS_ALLOWLIST: "to@example.com,+18655550123",
      };
      expect(communicationMode(env)).toBe("capture");
      expect(canSendCommunication("email", "to@example.com", env)).toBe(false);
      expect(canSendCommunication("sms", "+18655550123", env)).toBe(false);
    },
  );

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

  it("prefers configured SignalWire and keeps capture and provider selection explicit", () => {
    expect(smsDeliveryCapability({ ...smsEnv, ...companySms })).toEqual({
      mode: "allowlist",
      provider: "signalwire",
      serverSendAvailable: true,
    });
    expect(
      smsDeliveryCapability({
        ...smsEnv,
        ...companySms,
        COMMS_SMS_PROVIDER: "twilio",
      }),
    ).toMatchObject({ provider: "twilio", serverSendAvailable: true });
    expect(
      smsDeliveryCapability({
        ...smsEnv,
        ...companySms,
        COMMS_DELIVERY_MODE: "capture",
      }),
    ).toMatchObject({ provider: "signalwire", serverSendAvailable: false });
    expect(
      smsDeliveryCapability({
        ...smsEnv,
        ...companySms,
        DEMO_ACCESS_ENABLED: "true",
        COMMS_DELIVERY_MODE: "live",
      }),
    ).toEqual({ mode: "capture", provider: null, serverSendAvailable: false });
    expect(
      smsDeliveryCapability({
        ...smsEnv,
        ...companySms,
        SIGNALWIRE_SIGNING_KEY: undefined,
      }),
    ).toMatchObject({ provider: null, serverSendAvailable: false });
    expect(
      smsDeliveryCapability({
        ...companySms,
        SIGNALWIRE_SPACE_URL:
          "https://attacker.example/knox-space.signalwire.com",
      }),
    ).toMatchObject({ provider: null, serverSendAvailable: false });
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
        communicationId: "a".repeat(64),
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
      tags: [
        { name: "communication_id", value: "a".repeat(64) },
        {
          name: "communication_signature",
          value: createHmac("sha256", emailEnv.RESEND_WEBHOOK_SECRET)
            .update("a".repeat(64))
            .digest("hex"),
        },
      ],
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

  it("uses SignalWire project authentication and an exact outbound callback URL", async () => {
    const id = "a".repeat(64);
    const sid = "0a059168-ead0-41af-9d1f-343dae832527";
    const from = companySms.SIGNALWIRE_FROM_NUMBER;
    const to = "+18655550122";
    const response = {
      account_sid: companySms.SIGNALWIRE_PROJECT_ID,
      sid,
      from,
      to,
      status: "queued",
    };
    const send = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(response));
    await expect(
      sendSms(
        { to, body: "SignalWire test", communicationId: id },
        companySms,
        send,
      ),
    ).resolves.toEqual({
      providerMessageId: `signalwire:${response.account_sid}:${sid}`,
      fromAddress: from,
      status: "queued",
    });
    const [url, options] = send.mock.calls[0];
    expect(url).toBe(
      `${companySms.SIGNALWIRE_SPACE_URL}/api/laml/2010-04-01/Accounts/${response.account_sid}/Messages`,
    );
    expect(options?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`${response.account_sid}:${companySms.SIGNALWIRE_API_TOKEN}`).toString("base64")}`,
    });
    expect(Object.fromEntries(options?.body as URLSearchParams)).toEqual({
      To: to,
      From: from,
      Body: "SignalWire test",
      StatusCallback: expect.stringMatching(
        new RegExp(`/status/${id}\\?proof=[a-f0-9]{64}$`),
      ),
    });
    send.mockResolvedValueOnce(
      Response.json({ ...response, to: "+18655550990" }),
    );
    await expect(
      sendSms(
        { to, body: "SignalWire test", communicationId: id },
        companySms,
        send,
      ),
    ).rejects.toMatchObject({ ambiguous: true });
    await expect(
      sendSms({ to, body: "Missing saved record" }, companySms, send),
    ).rejects.toMatchObject({ status: 400 });
    expect(send).toHaveBeenCalledTimes(2);
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
