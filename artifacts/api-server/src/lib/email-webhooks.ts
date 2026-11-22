import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { and, eq, like, or } from "drizzle-orm";
import { communicationsTable, db } from "@workspace/db";
import { workspaceEnvironment } from "@workspace/db/workspace";
import { emailAddress } from "./comms";

export function verifyEmailWebhook(
  body: Buffer | undefined, id: string | undefined, timestamp: string | undefined,
  signatures: string | undefined, secret: string | undefined, now = Date.now(),
) {
  if (!body || !id || !timestamp || !signatures || !secret?.startsWith("whsec_") ||
    !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.slice(6), "base64");
  if (key.length < 16) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest();
  return signatures.split(" ").some((part) => {
    if (!part.startsWith("v1,")) return false;
    const candidate = Buffer.from(part.slice(3), "base64");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

const failureReasons: Record<string, string> = {
  "email.bounced": "Email recipient suppressed after a bounce. Check the address with the recipient.",
  "email.complained": "Email recipient suppressed after a spam complaint. Contact the recipient through another channel.",
  "email.suppressed": "Email recipient suppressed by the provider. Check the provider's suppression list.",
  "email.failed": "Email delivery failed. Check the provider before sending again.",
};

export function emailReceiptOutcome(event: string, previous: string, bounceType?: string) {
  if (event === "email.bounced" && bounceType !== "Permanent")
    return { status: "failed" as const, errorMessage: "Email bounced. Verify the address and provider details before retrying." };
  if (failureReasons[event]) return { status: "failed" as const, errorMessage: failureReasons[event] };
  if (previous === "failed" || previous === "delivered") return null;
  if (event === "email.delivered") return { status: "delivered" as const, errorMessage: null };
  if (event === "email.sent" && previous !== "sent") return { status: "sent" as const, errorMessage: null };
  return null;
}

export function verifyEmailCorrelation(id: unknown, signature: unknown, secret: string | undefined) {
  if (typeof id !== "string" || !/^[a-f\d]{64}$/.test(id) ||
    typeof signature !== "string" || !/^[a-f\d]{64}$/.test(signature) || !secret) return false;
  const expected = createHmac("sha256", secret).update(id).digest();
  return timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

export async function emailRecipientSuppressed(address: string) {
  const [blocked] = await db.select({ id: communicationsTable.id }).from(communicationsTable).where(and(
    eq(communicationsTable.channel, "email"), eq(communicationsTable.direction, "outbound"),
    eq(communicationsTable.toAddress, address), eq(communicationsTable.status, "failed"),
    like(communicationsTable.errorMessage, "Email recipient suppressed%"),
  )).limit(1);
  return !!blocked;
}

export const emailWebhook: RequestHandler = async (req, res, next) => {
  const env = workspaceEnvironment();
  if (!verifyEmailWebhook(req.rawBody, req.get("svix-id"), req.get("svix-timestamp"),
    req.get("svix-signature"), env.RESEND_WEBHOOK_SECRET)) {
    res.status(401).json({ error: "Invalid email event signature." });
    return;
  }
  const event = req.body;
  const data = event?.data;
  const providerId = data?.email_id;
  const communicationId = data?.tags?.communication_id;
  const recipient = Array.isArray(data?.to) && data.to.length === 1 && typeof data.to[0] === "string"
    ? emailAddress(data.to[0]) : null;
  if (typeof event?.type !== "string" || typeof providerId !== "string" || !recipient) {
    res.status(400).json({ error: "Invalid email event." });
    return;
  }
  if (!failureReasons[event.type] && !["email.sent", "email.delivered"].includes(event.type)) {
    res.sendStatus(204);
    return;
  }
  try {
    await db.transaction(async (tx) => {
      const candidates = [eq(communicationsTable.providerMessageId, providerId)];
      if (typeof communicationId === "string" && verifyEmailCorrelation(
        communicationId, data?.tags?.communication_signature, env.RESEND_WEBHOOK_SECRET,
      ))
        candidates.push(eq(communicationsTable.id, communicationId));
      const [record] = await tx.select().from(communicationsTable).where(and(
        eq(communicationsTable.channel, "email"), eq(communicationsTable.direction, "outbound"),
        eq(communicationsTable.toAddress, recipient), or(...candidates),
      )).for("update");
      if (!record || record.status === "captured" ||
        (record.providerMessageId && record.providerMessageId !== providerId)) return;
      const update = emailReceiptOutcome(event.type, record.status, data?.bounce?.type);
      if (update?.status === "failed" && record.errorMessage?.startsWith("Email recipient suppressed"))
        update.errorMessage = record.errorMessage;
      if (update) await tx.update(communicationsTable).set({ ...update, providerMessageId: providerId })
        .where(eq(communicationsTable.id, record.id));
    });
    res.sendStatus(204);
  } catch (error) { next(error); }
};
