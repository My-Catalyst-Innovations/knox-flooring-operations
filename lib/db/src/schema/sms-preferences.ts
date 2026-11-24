import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { usersTable } from "./security";

export type SmsPreferenceEventKind =
  | "evidence_recorded"
  | "suppressed_manual"
  | "suppressed_inbound"
  | "inbound_start_request"
  | "legacy_stop";
export const smsRecipientPreferencesTable = pgTable(
  "sms_recipient_preferences",
  {
    recipient: text("recipient").primaryKey(),
    revision: integer("revision").notNull().default(0),
    suppressed: boolean("suppressed").notNull().default(false),
    suppressedAt: text("suppressed_at"),
    lastSuppressionEventId: text("last_suppression_event_id"),
    consentEventId: text("consent_event_id"),
    consentBinding: text("consent_binding"),
    consentSynthetic: boolean("consent_synthetic").notNull().default(false),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "sms_preferences_last_event_fk",
      columns: [table.lastSuppressionEventId],
      foreignColumns: [eventId()],
    }).onDelete("restrict"),
    foreignKey({
      name: "sms_preferences_consent_event_fk",
      columns: [table.consentEventId],
      foreignColumns: [eventId()],
    }).onDelete("restrict"),
    check(
      "sms_preferences_recipient_check",
      sql`${table.recipient} ~ '^[+][1-9][0-9]{7,14}$'`,
    ),
    check("sms_preferences_revision_check", sql`${table.revision} >= 0`),
    check(
      "sms_preferences_suppression_check",
      sql`NOT ${table.suppressed} OR (${table.suppressedAt} IS NOT NULL AND ${table.lastSuppressionEventId} IS NOT NULL)`,
    ),
    index("sms_preferences_consent_event_idx").on(table.consentEventId),
    index("sms_preferences_suppression_event_idx").on(
      table.lastSuppressionEventId,
    ),
  ],
);
export const smsPreferenceEventsTable = pgTable(
  "sms_preference_events",
  {
    id: text("id").primaryKey(),
    requestKey: text("request_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    recipient: text("recipient").notNull(),
    kind: text("kind").$type<SmsPreferenceEventKind>().notNull(),
    actorId: text("actor_id").references(() => usersTable.id, {
      onDelete: "restrict",
    }),
    binding: jsonb("binding").$type<Record<string, unknown>>(),
    bindingFingerprint: text("binding_fingerprint"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    occurredAt: text("occurred_at"),
    recordedAt: text("recorded_at").notNull(),
    note: text("note").notNull(),
    synthetic: boolean("synthetic").notNull().default(false),
    releasedSuppression: boolean("released_suppression")
      .notNull()
      .default(false),
    providerMessageId: text("provider_message_id"),
  },
  (table) => [
    foreignKey({
      name: "sms_events_recipient_fk",
      columns: [table.recipient],
      foreignColumns: [smsRecipientPreferencesTable.recipient],
    }).onDelete("restrict"),
    uniqueIndex("sms_preference_event_request_unique").on(table.requestKey),
    index("sms_preference_event_recipient_idx").on(
      table.recipient,
      table.recordedAt,
    ),
    index("sms_preference_event_actor_idx").on(table.actorId),
    check(
      "sms_preference_event_kind_check",
      sql`${table.kind} IN ('evidence_recorded','suppressed_manual','suppressed_inbound','inbound_start_request','legacy_stop')`,
    ),
    check(
      "sms_preference_event_hash_check",
      sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$' AND (${table.bindingFingerprint} IS NULL OR ${table.bindingFingerprint} ~ '^[a-f0-9]{64}$')`,
    ),
    check(
      "sms_preference_event_binding_check",
      sql`(${table.binding} IS NULL AND ${table.bindingFingerprint} IS NULL) OR (${table.binding} IS NOT NULL AND ${table.bindingFingerprint} IS NOT NULL AND ${table.binding}->>'fingerprint' = ${table.bindingFingerprint})`,
    ),
    check(
      "sms_preference_event_release_check",
      sql`NOT ${table.releasedSuppression} OR (${table.kind} = 'evidence_recorded' AND NOT ${table.synthetic} AND ${table.bindingFingerprint} IS NOT NULL)`,
    ),
  ],
);
function eventId(): AnyPgColumn {
  return smsPreferenceEventsTable.id;
}
