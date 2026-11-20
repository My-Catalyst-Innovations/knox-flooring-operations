import { logger } from "./logger";

type Channel = "email" | "sms";
type ProviderStatus = "queued" | "sent" | "delivered" | "failed" | "unknown";

export class CommsError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = "CommsError";
  }
}

export function emailAddress(value: string) {
  const address = value.trim().toLowerCase();
  return address.length <= 254 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(
      address,
    ) &&
    !address.split("@")[0].startsWith(".") &&
    !address.split("@")[0].endsWith(".") &&
    !address.includes("..")
    ? address
    : null;
}

export function smsNumber(value: string) {
  const compact = value.trim().replace(/[().\s-]/g, "");
  const number = /^\d{10}$/.test(compact)
    ? `+1${compact}`
    : /^1\d{10}$/.test(compact)
      ? `+${compact}`
      : compact;
  return /^\+[1-9]\d{7,14}$/.test(number) ? number : null;
}

export function isDemoDeliveryEnvironment(env = process.env) {
  return env.DEMO_MODE !== "false" || env.DEMO_ACCESS_ENABLED === "true";
}

export function communicationMode(
  env = process.env,
): "capture" | "allowlist" | "live" {
  if (isDemoDeliveryEnvironment(env)) return "capture";
  const mode = env.COMMS_DELIVERY_MODE;
  if (!mode || mode === "allowlist") return "allowlist";
  return mode === "live" ? "live" : "capture";
}

export function canSendCommunication(
  channel: Channel,
  recipient: string,
  env = process.env,
) {
  const mode = communicationMode(env);
  if (mode !== "allowlist") return mode === "live";
  const normalize = channel === "email" ? emailAddress : smsNumber;
  return (env.COMMS_ALLOWLIST ?? "")
    .split(",")
    .some((value) => normalize(value) === recipient);
}

function emailConfig(env = process.env) {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.RESEND_FROM_EMAIL?.trim();
  if (!key || !from || from.length > 320 || /[\r\n]/.test(from)) return null;
  const sender = from.match(/^[^<>]+<([^<>]+)>$/)?.[1] ?? from;
  const replyTo = env.RESEND_REPLY_TO_EMAIL?.trim();
  if (!emailAddress(sender) || (replyTo && !emailAddress(replyTo))) return null;
  return { key, from, replyTo };
}

function smsConfig(env = process.env) {
  const account = env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const key = env.TWILIO_API_KEY_SID?.trim() ?? "";
  const secret = env.TWILIO_API_KEY_SECRET?.trim();
  const service = env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? "";
  const configuredFrom = env.TWILIO_FROM_NUMBER?.trim() ?? "";
  const from = smsNumber(configuredFrom);
  if (
    !/^AC[a-f\d]{32}$/i.test(account) ||
    !/^SK[a-f\d]{32}$/i.test(key) ||
    !secret
  )
    return null;
  if (
    service
      ? !/^MG[a-f\d]{32}$/i.test(service) || configuredFrom
      : !from || !configuredFrom.startsWith("+")
  )
    return null;
  return { account, key, secret, service, from };
}

export function availableCommunicationProviders(env = process.env) {
  return { email: !!emailConfig(env), sms: !!smsConfig(env) };
}

type Delivery = {
  providerMessageId: string;
  fromAddress: string;
  status: ProviderStatus;
  errorMessage?: string;
};

async function providerResponse(
  provider: string,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CommsError(
      `${provider} did not confirm the submission. Check the provider before sending again.`,
      502,
      true,
    );
  }
  if (response.ok) return response;
  logger.warn(
    { provider, status: response.status },
    "Communication provider returned an error",
  );
  if (response.status === 401 || response.status === 403)
    throw new CommsError(
      `${provider} authorization or sender verification failed.`,
      503,
    );
  if (response.status === 429)
    throw new CommsError(
      `${provider} is limiting submissions. Try again later.`,
      503,
    );
  if (response.status === 408 || response.status >= 500) {
    throw new CommsError(
      `${provider} did not confirm the submission. Check the provider before sending again.`,
      502,
      true,
    );
  }
  throw new CommsError(
    `${provider} rejected the message. Check the recipient, sender and message.`,
    422,
  );
}

function escapeHtml(input: string) {
  return input.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

export async function sendEmail(
  input: {
    to: string;
    subject: string;
    body: string;
    idempotencyKey: string;
    html?: string;
  },
  env = process.env,
  fetchImpl = fetch,
): Promise<Delivery> {
  const to = emailAddress(input.to);
  if (!to)
    throw new CommsError("Enter one valid recipient email address.", 400);
  if (
    !input.subject.trim() ||
    input.subject.length > 512 ||
    /[\r\n]/.test(input.subject) ||
    !input.body.trim() ||
    input.body.length > 12_000
  ) {
    throw new CommsError(
      "Enter a subject and a message within the email length limits.",
      400,
    );
  }
  const config = emailConfig(env);
  if (!config)
    throw new CommsError(
      "Resend email requires an API key and a verified sender address.",
      503,
    );
  const response = await providerResponse(
    "Resend",
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from: config.from,
        to: [to],
        subject: input.subject,
        text: input.body,
        html:
          input.html ??
          `<div style="font-family:system-ui,Arial,sans-serif;white-space:pre-wrap;line-height:1.5">${escapeHtml(input.body)}</div>`,
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
      }),
    },
    fetchImpl,
  );
  const result = (await response.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  if (typeof result?.id !== "string" || !result.id.trim())
    throw new CommsError(
      "Resend did not confirm the submission. Check the provider before sending again.",
      502,
      true,
    );
  return {
    providerMessageId: result.id,
    fromAddress: config.from,
    status: "queued",
  };
}

export async function sendSms(
  input: { to: string; body: string },
  env = process.env,
  fetchImpl = fetch,
): Promise<Delivery> {
  const to = smsNumber(input.to);
  if (!to)
    throw new CommsError(
      "Enter a valid phone number with a country code, or a ten-digit US number.",
      400,
    );
  if (!input.body.trim() || input.body.length > 1600)
    throw new CommsError(
      "Enter a text message of no more than 1,600 characters.",
      400,
    );
  const config = smsConfig(env);
  if (!config)
    throw new CommsError(
      "Twilio text messaging requires account and API key credentials and one registered sender.",
      503,
    );
  const body = new URLSearchParams({ To: to, Body: input.body });
  if (config.service) body.set("MessagingServiceSid", config.service);
  else if (config.from) body.set("From", config.from);
  const response = await providerResponse(
    "Twilio",
    `https://api.twilio.com/2010-04-01/Accounts/${config.account}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.key}:${config.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
    fetchImpl,
  );
  const result = (await response.json().catch(() => null)) as {
    sid?: unknown;
    from?: unknown;
    status?: unknown;
  } | null;
  if (typeof result?.sid !== "string" || !result.sid.trim())
    throw new CommsError(
      "Twilio did not confirm the submission. Check the provider before sending again.",
      502,
      true,
    );
  const from =
    (typeof result.from === "string" && smsNumber(result.from)) ||
    config.from ||
    "Twilio messaging service";
  const delivery = { providerMessageId: result.sid, fromAddress: from };
  switch (result.status) {
    case "accepted":
    case "queued":
    case "sending":
      return { ...delivery, status: "queued" };
    case "sent":
    case "delivered":
      return { ...delivery, status: result.status };
    case "failed":
    case "undelivered":
    case "canceled":
      return {
        ...delivery,
        status: "failed",
        errorMessage:
          "Twilio could not send this text. Check the recipient and sender in Twilio.",
      };
    default:
      return {
        ...delivery,
        status: "unknown",
        errorMessage:
          "Twilio returned an unrecognized status. Check the provider before sending again.",
      };
  }
}

export function passwordResetLink(base: string | undefined, token: string) {
  if (!base) return null;
  try {
    const origin = new URL(base);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash
    )
      return null;
    const url = new URL("/welcome", origin);
    url.hash = new URLSearchParams({ reset: token }).toString();
    return url.toString();
  } catch {
    return null;
  }
}

export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
  id: string,
  env = process.env,
  fetchImpl = fetch,
) {
  const introduction = "Use this link to reset your Catalyst Works password.";
  const ending =
    "The link expires in 30 minutes and can be used once. If you did not request a reset, you can ignore this message.";
  return sendEmail(
    {
      to,
      subject: "Reset your Catalyst Works password",
      idempotencyKey: `password-reset/${id}`,
      body: `${introduction}\n\n${resetUrl}\n\n${ending}`,
      html: `<html lang="en"><body><h1>Reset your password</h1><p>${introduction}</p><p><a href="${escapeHtml(resetUrl)}">Reset your password</a></p><p>${ending}</p></body></html>`,
    },
    env,
    fetchImpl,
  );
}
