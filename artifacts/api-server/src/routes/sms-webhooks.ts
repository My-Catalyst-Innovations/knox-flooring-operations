import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, like, ne } from "drizzle-orm";
import { communicationsTable, db } from "@workspace/db";
import { reconcileCommunicationOutcome } from "../lib/communication-outcome";
import {
  readSignalWireMessageTime,
  signalWireMessageKey,
  signalWirePendingKey,
  signalWireStatusProof,
  signalWireWebhookConfig,
  signalWireWebhookPath,
} from "../lib/comms";
import { domainRoute } from "../lib/domain-http";
import {
  signalWireDeliveryStatus,
  signalWireInboundId,
  signalWireIncomingMessage,
  signalWireStatusCallback,
  verifiedSignalWireForm,
} from "../lib/signalwire-callback";
import { smsConsentCommand, smsConsentSubject } from "../lib/sms-consent";

const messages = communicationsTable;
const startsWithSignalWireProject = (account: string) =>
  like(messages.providerMessageId, `signalwire:${account}:%`);

function verifiedForm(req: Request, res: Response, route: string) {
  const config = signalWireWebhookConfig();
  if (!config) {
    res.status(404).end();
    return null;
  }
  const path = `/api${signalWireWebhookPath}${route}`;
  if (
    req.originalUrl !== path ||
    !req.is("application/x-www-form-urlencoded")
  ) {
    res.status(400).end();
    return null;
  }
  const signature = req.get("x-signalwire-signature");
  const compatibilitySignature = req.get("x-twilio-signature");
  const fields =
    !signature ||
    !compatibilitySignature ||
    signature === compatibilitySignature
      ? verifiedSignalWireForm(
          config.signingKey,
          signature ?? compatibilitySignature,
          `${config.callbackOrigin}${path}`,
          req.body,
        )
      : null;
  if (!fields || fields.AccountSid?.toLowerCase() !== config.account) {
    res.status(401).end();
    return null;
  }
  return { config, fields };
}

export const signalWireStatusWebhook = domainRoute(async (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-f\d]{64}$/.test(id)) {
    res.status(400).end();
    return;
  }
  const proof = req.query.proof;
  if (typeof proof !== "string" || !/^[a-f\d]{64}$/.test(proof)) {
    res.status(401).end();
    return;
  }
  const valid = verifiedForm(req, res, `/status/${id}?proof=${proof}`);
  if (!valid) return;
  const parsed = signalWireStatusCallback.safeParse(valid.fields);
  if (!parsed.success) {
    res.status(400).end();
    return;
  }
  const event = parsed.data;
  const { account, from } = valid.config;
  if (event.From !== from) {
    res.status(403).end();
    return;
  }
  const expectedProof = signalWireStatusProof(
    valid.config.signingKey,
    valid.config.callbackOrigin,
    account,
    from,
    event.To,
    id,
  );
  if (
    !timingSafeEqual(
      Buffer.from(proof, "hex"),
      Buffer.from(expectedProof, "hex"),
    )
  ) {
    res.status(401).end();
    return;
  }
  const providerMessageId = signalWireMessageKey(account, event.MessageSid);

  await db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.id, id),
          eq(messages.channel, "sms"),
          eq(messages.direction, "outbound"),
          eq(messages.toAddress, event.To),
          eq(messages.fromAddress, event.From),
          inArray(messages.providerMessageId, [
            signalWirePendingKey(account),
            providerMessageId,
          ]),
        ),
      )
      .for("update");
    if (!previous) return;
    const merged = reconcileCommunicationOutcome(previous, {
      ...signalWireDeliveryStatus(event.MessageStatus),
      providerMessageId,
    });
    if (
      merged.status &&
      (merged.status !== previous.status ||
        merged.providerMessageId !== previous.providerMessageId ||
        merged.errorMessage !== previous.errorMessage)
    )
      await tx.update(messages).set(merged).where(eq(messages.id, id));
  });
  res.status(200).end();
});

export const signalWireInboundWebhook = domainRoute(async (req, res) => {
  const valid = verifiedForm(req, res, "/inbound");
  if (!valid) return;
  const statuses = [valid.fields.MessageStatus, valid.fields.SmsStatus];
  if (
    statuses.some(
      (status) =>
        status !== undefined && status !== "receiving" && status !== "received",
    )
  ) {
    res.status(400).end();
    return;
  }
  const parsed = signalWireIncomingMessage.safeParse(valid.fields);
  if (!parsed.success) {
    res.status(400).end();
    return;
  }
  const event = parsed.data;
  const { account, from } = valid.config;
  if (event.To !== from) {
    res.status(403).end();
    return;
  }
  const media = Number(event.NumMedia);
  if (event.Body.trim() || media > 0) {
    const candidates = await db
      .selectDistinctOn([messages.leadId, messages.customerKey], {
        leadId: messages.leadId,
        customerKey: messages.customerKey,
        customerName: messages.customerName,
      })
      .from(messages)
      .where(
        and(
          eq(messages.channel, "sms"),
          eq(messages.direction, "outbound"),
          eq(messages.toAddress, event.From),
          eq(messages.fromAddress, event.To),
          inArray(messages.status, ["sent", "delivered", "queued"]),
          startsWithSignalWireProject(account),
          ne(messages.providerMessageId, signalWirePendingKey(account)),
        ),
      )
      .orderBy(messages.leadId, messages.customerKey, desc(messages.createdAt))
      .limit(2);
    const matched = candidates.length === 1 ? candidates[0] : undefined;
    const body = event.Body.trim() ? event.Body : "Media message received.";
    const consent = smsConsentCommand(event.Body);
    const record = {
      id: signalWireInboundId(account, event.MessageSid),
      providerMessageId: signalWireMessageKey(account, event.MessageSid),
      leadId: matched?.leadId ?? null,
      customerKey: matched?.customerKey ?? null,
      customerName: matched?.customerName ?? "",
      channel: "sms",
      direction: "inbound",
      status: "received",
      fromAddress: event.From,
      toAddress: event.To,
      body,
    } as const;
    const subject = consent ? smsConsentSubject(consent, false) : "";
    await db
      .insert(messages)
      .values({ ...record, subject, createdAt: new Date().toISOString() })
      .onConflictDoNothing({ target: messages.id });
    if (consent) {
      const samePendingCommand = and(
        eq(messages.id, record.id),
        eq(messages.subject, subject),
        eq(messages.providerMessageId, record.providerMessageId),
        eq(messages.fromAddress, record.fromAddress),
        eq(messages.toAddress, record.toAddress),
        eq(messages.body, body),
      );
      const [pending] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(samePendingCommand)
        .limit(1);
      if (pending) {
        const actualOn = await readSignalWireMessageTime(event);
        if (!actualOn) {
          res.status(503).end();
          return;
        }
        await db
          .update(messages)
          .set({
            subject: smsConsentSubject(consent, true),
            createdAt: actualOn,
          })
          .where(samePendingCommand);
      }
    }
  }
  res
    .status(200)
    .type("application/xml")
    .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});
