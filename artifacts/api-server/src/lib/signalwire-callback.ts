import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { signalWireMessageSid } from "./comms";

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const message = z.object({
  AccountSid: z.string(),
  MessageSid: z.string().regex(signalWireMessageSid),
  From: phone,
  To: phone,
});
export const signalWireStatusCallback = message.extend({
  MessageStatus: z.enum([
    "accepted",
    "queued",
    "sending",
    "sent",
    "delivered",
    "failed",
    "undelivered",
    "canceled",
  ]),
});
export const signalWireIncomingMessage = message.extend({
  Body: z.string().max(6400),
  NumMedia: z.string().regex(/^\d{1,2}$/),
});

export function verifiedSignalWireForm(
  signingKey: string,
  signature: string | undefined,
  url: string,
  body: unknown,
) {
  if (
    !signature ||
    !/^[+/0-9A-Za-z]{27}=$/.test(signature) ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  )
    return null;
  const form = Object.entries(body);
  if (
    !form.length ||
    form.length > 60 ||
    !form.every(
      ([key, value]) =>
        /^[A-Za-z][\dA-Za-z]{0,40}$/.test(key) && typeof value === "string",
    )
  )
    return null;
  const fields = Object.fromEntries(form) as Record<string, string>;
  const bytes = Buffer.from(signature, "base64");
  const address = new URL(url);
  const signedFields = Object.keys(fields)
    .sort()
    .map((key) => key + fields[key])
    .join("");

  // Compatibility callbacks may sign the implicit HTTPS port explicitly.
  const candidates = address.port
    ? [url]
    : [url, `${address.origin}:443${address.pathname}${address.search}`];
  const matches = candidates.map((candidate) =>
    timingSafeEqual(
      bytes,
      createHmac("sha1", signingKey)
        .update(candidate + signedFields)
        .digest(),
    ),
  );
  return matches.some(Boolean) ? fields : null;
}

export function signalWireDeliveryStatus(
  status: z.infer<typeof signalWireStatusCallback>["MessageStatus"],
) {
  if (status === "sent" || status === "delivered") return { status };
  if (status === "failed" || status === "undelivered" || status === "canceled")
    return {
      status: "failed" as const,
      errorMessage:
        "SignalWire could not deliver this text. Check the recipient and sender in SignalWire.",
    };
  return { status: "queued" as const };
}

export function signalWireInboundId(account: string, messageSid: string) {
  return createHash("sha256")
    .update(JSON.stringify(["signalwire", account, messageSid.toLowerCase()]))
    .digest("hex");
}
