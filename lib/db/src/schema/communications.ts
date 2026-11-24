import { check, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { smsPreferenceEventsTable } from "./sms-preferences";

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
    smsConsentEventId: text("sms_consent_event_id").references(() => smsPreferenceEventsTable.id,{onDelete:"restrict"}),
    smsBindingFingerprint: text("sms_binding_fingerprint"),
    smsPermissionRevision: integer("sms_permission_revision"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("communications_sms_stop_recipient_idx").on(table.fromAddress,table.createdAt)
      .where(sql`${table.channel} = 'sms' AND ${table.direction} = 'inbound' AND ${table.status} = 'received' AND ${table.providerMessageId} LIKE 'signalwire:%' AND ${table.subject} IN ('SMS opt-out','SMS opt-out pending provider timestamp')`),
    index("communications_sms_consent_event_idx").on(table.smsConsentEventId),
    check("communications_sms_permission_check",sql`(${table.smsConsentEventId} IS NULL AND ${table.smsBindingFingerprint} IS NULL AND ${table.smsPermissionRevision} IS NULL) OR (${table.channel} = 'sms' AND ${table.smsConsentEventId} IS NOT NULL AND ${table.smsBindingFingerprint} ~ '^[a-f0-9]{64}$' AND ${table.smsPermissionRevision} > 0)`),
    check(
      "communications_email_provider_check",
      sql`${table.emailProvider} IN ('resend','outlook')`,
    ),
  ],
);

export type CommunicationRow = typeof communicationsTable.$inferSelect;
export type CommunicationInsert = typeof communicationsTable.$inferInsert;
