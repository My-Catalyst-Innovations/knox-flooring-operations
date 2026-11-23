import { check, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type CommunicationChannel = "email" | "sms";
export type CommunicationDirection = "outbound" | "inbound";
export type CommunicationEmailProvider = "resend" | "outlook";
export type CommunicationStatus =
  | "captured"
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "unknown"
  | "received";

export const communicationsTable = pgTable(
  "communications",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id"),
    customerKey: text("customer_key"),
    customerName: text("customer_name").notNull().default(""),
    channel: text("channel").$type<CommunicationChannel>().notNull(),
    direction: text("direction").$type<CommunicationDirection>().notNull(),
    toAddress: text("to_address").notNull().default(""),
    fromAddress: text("from_address").notNull().default(""),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    status: text("status").$type<CommunicationStatus>().notNull(),
    providerMessageId: text("provider_message_id"),
    emailProvider: text("email_provider").$type<CommunicationEmailProvider>(),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check(
      "communications_email_provider_check",
      sql`${table.emailProvider} IN ('resend','outlook')`,
    ),
  ],
);

export type CommunicationRow = typeof communicationsTable.$inferSelect;
export type CommunicationInsert = typeof communicationsTable.$inferInsert;
