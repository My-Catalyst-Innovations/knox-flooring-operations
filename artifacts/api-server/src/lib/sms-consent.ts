import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { communicationsTable, db } from "@workspace/db";

const optedOut = "SMS opt-out";
const optedIn = "SMS opt-in";
const pendingStop = "SMS opt-out pending provider timestamp";
const pendingStart = "SMS opt-in awaiting verification";

const stop = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
]);
const start = new Set(["START", "UNSTOP"]);

export function smsConsentCommand(body: string) {
  const word = body.trim().toUpperCase();
  return stop.has(word) ? "stop" : start.has(word) ? "start" : null;
}

export function smsConsentSubject(
  command: "stop" | "start",
  verified: boolean,
) {
  return command === "stop"
    ? verified
      ? optedOut
      : pendingStop
    : verified
      ? optedIn
      : pendingStart;
}

export async function smsRecipientSuppressed(
  sender: string,
  recipient: string,
) {
  const messages = communicationsTable;
  const [latest] = await db
    .select({ subject: messages.subject })
    .from(messages)
    .where(
      and(
        eq(messages.channel, "sms"),
        eq(messages.direction, "inbound"),
        eq(messages.status, "received"),
        eq(messages.fromAddress, recipient),
        eq(messages.toAddress, sender),
        like(messages.providerMessageId, "signalwire:%"),
        inArray(messages.subject, [optedOut, optedIn, pendingStop]),
      ),
    )
    .orderBy(
      desc(messages.createdAt),
      sql`case when ${messages.subject} = ${optedIn} then 1 else 0 end`,
    )
    .limit(1);
  return !!latest && latest.subject !== optedIn;
}
