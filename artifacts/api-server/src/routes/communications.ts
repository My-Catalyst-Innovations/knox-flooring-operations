import { Router, type IRouter, type Request } from "express";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  communicationsTable,
  demoOutboxTable,
  type CommunicationChannel,
  type CommunicationInsert,
  type CommunicationRow,
} from "@workspace/db";
import {
  ListCommunicationsQueryParams,
  ListCommunicationsResponse,
  ListCommunicationsResponseItem,
  SendEmailBody,
  SendSmsBody,
} from "@workspace/api-zod";
import { stripNulls } from "../lib/strip-nulls";
import {
  canSendCommunication,
  CommsError,
  emailAddress,
  sendEmail,
  sendSms,
  smsNumber,
} from "../lib/comms";
import { customerKey } from "../lib/customer-key";
import { domainRoute, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";

const router: IRouter = Router();

function presentCommunication(row: CommunicationRow) {
  if (
    row.status === "queued" &&
    !row.providerMessageId &&
    Date.now() - Date.parse(row.createdAt) > 60_000
  ) {
    return stripNulls({
      ...row,
      status: "unknown",
      errorMessage:
        "The provider did not confirm the submission. Check the provider before sending again.",
    });
  }
  return stripNulls(row);
}

router.get(
  "/communications",
  domainRoute(async (req, res) => {
    const query = parse(ListCommunicationsQueryParams, req.query);
    const filters = [];
    if (query.leadId)
      filters.push(eq(communicationsTable.leadId, query.leadId));
    if (query.customerKey)
      filters.push(eq(communicationsTable.customerKey, query.customerKey));
    const rows = await db
      .select()
      .from(communicationsTable)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(communicationsTable.createdAt));
    res.json(ListCommunicationsResponse.parse(rows.map(presentCommunication)));
  }),
);

function messageFields(req: Request, channel: CommunicationChannel) {
  const input =
    channel === "email"
      ? parse(SendEmailBody, req.body)
      : parse(SendSmsBody, req.body);
  const recipient =
    channel === "email" ? emailAddress(input.to) : smsNumber(input.to);
  if (!recipient)
    throw new DomainError(
      400,
      channel === "email"
        ? "Enter a valid email address for one recipient."
        : "Enter a valid phone number with a country code, or a ten-digit US number.",
    );
  const subject =
    "subject" in input && typeof input.subject === "string"
      ? input.subject.trim()
      : "";
  const rawSubject =
    "subject" in input && typeof input.subject === "string"
      ? input.subject
      : "";
  if (
    channel === "email" &&
    (!subject || subject.length > 512 || /[\r\n]/.test(rawSubject))
  )
    throw new DomainError(
      400,
      "Enter a one-line email subject of no more than 512 characters.",
    );
  if (
    !input.body.trim() ||
    input.body.length > (channel === "email" ? 12_000 : 1600)
  )
    throw new DomainError(
      400,
      "Enter a message within the channel’s length limit.",
    );
  const { leadId, customerName, customerKey: explicitCustomerKey } = input;
  const capture = !canSendCommunication(channel, recipient);
  const requestKey = input.idempotencyKey;
  if (requestKey !== undefined && !/^[a-zA-Z0-9._:-]{8,128}$/.test(requestKey))
    throw new DomainError(400, "Invalid send request identifier.");
  if (!capture && !requestKey)
    throw new DomainError(
      400,
      "A send request identifier is required. Reload the app and try again.",
    );
  const id = requestKey
    ? createHash("sha256")
        .update(JSON.stringify([req.auth!.userId, channel, requestKey]))
        .digest("hex")
    : randomUUID();
  return {
    id,
    capture,
    fields: {
      leadId: leadId || null,
      customerKey:
        explicitCustomerKey ||
        (customerName ? customerKey(customerName) : null),
      customerName: customerName ?? "",
      channel,
      direction: "outbound" as const,
      toAddress: recipient,
      subject,
      body: input.body,
    },
  };
}

function matchesFields(
  row: CommunicationRow,
  fields: Pick<
    CommunicationInsert,
    | "leadId"
    | "customerKey"
    | "customerName"
    | "channel"
    | "direction"
    | "toAddress"
    | "subject"
    | "body"
  >,
) {
  return (
    row.leadId === fields.leadId &&
    row.customerKey === fields.customerKey &&
    row.customerName === fields.customerName &&
    row.channel === fields.channel &&
    row.direction === fields.direction &&
    row.toAddress === fields.toAddress &&
    row.subject === fields.subject &&
    row.body === fields.body
  );
}

function submit(channel: CommunicationChannel) {
  return domainRoute(async (req, res) => {
    const { id, capture, fields } = messageFields(req, channel);
    const now = new Date().toISOString();
    const claimed = await db.transaction(async (tx) => {
      const [first] = await tx
        .insert(communicationsTable)
        .values({
          id,
          ...fields,
          fromAddress: capture ? "Demo Outbox" : "",
          status: capture ? "captured" : "queued",
          providerMessageId: capture ? `demo:${id}` : null,
          createdAt: now,
        })
        .onConflictDoNothing({ target: communicationsTable.id })
        .returning();
      if (!first) return null;
      if (capture)
        await tx.insert(demoOutboxTable).values({
          id,
          channel,
          recipient: fields.toAddress,
          subject: fields.subject,
          body: fields.body,
          status: "captured",
          externalDelivery: false,
          createdBy: req.auth!.userId,
          createdAt: now,
        });
      return first;
    });
    if (!claimed) {
      const [previous] = await db
        .select()
        .from(communicationsTable)
        .where(eq(communicationsTable.id, id));
      if (!previous || !matchesFields(previous, fields))
        throw new DomainError(
          409,
          "This send request was already used for a different message.",
        );
      res.json(
        ListCommunicationsResponseItem.parse(presentCommunication(previous)),
      );
      return;
    }
    if (capture) {
      res
        .status(201)
        .json(ListCommunicationsResponseItem.parse(stripNulls(claimed)));
      return;
    }
    let outcome: Pick<
      CommunicationInsert,
      "status" | "providerMessageId" | "fromAddress" | "errorMessage"
    >;
    try {
      const response =
        channel === "email"
          ? await sendEmail({
              to: fields.toAddress,
              subject: fields.subject,
              body: fields.body,
              idempotencyKey: `outbound/${id}`,
            })
          : await sendSms({ to: fields.toAddress, body: fields.body });
      outcome = response;
    } catch (error) {
      outcome =
        error instanceof CommsError
          ? {
              status: error.ambiguous ? "unknown" : "failed",
              errorMessage: error.message,
            }
          : {
              status: "unknown",
              errorMessage:
                "The provider did not confirm the submission. Check the provider before sending again.",
            };
    }
    const [recorded] = await db
      .update(communicationsTable)
      .set(outcome)
      .where(eq(communicationsTable.id, id))
      .returning();
    res
      .status(201)
      .json(ListCommunicationsResponseItem.parse(stripNulls(recorded)));
  });
}

router.post("/communications/email", submit("email"));
router.post("/communications/sms", submit("sms"));

export default router;
