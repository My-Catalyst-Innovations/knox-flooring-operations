import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import {
  db,
  communicationsTable,
  settingsTable,
  usersTable,
  smsRecipientPreferencesTable as preferences,
  smsPreferenceEventsTable as events,
  type CommunicationRow,
} from "@workspace/db";
import {
  workspaceEnvironment,
  workspaceScopeKey,
} from "@workspace/db/workspace";
import { smsConfig, smsNumber } from "./comms";
import { DomainError } from "./operations-rules";
import type { Transaction } from "./estimate-service";
import {
  mayReleaseSmsSuppression,
  smsPermission,
  smsPermissionHash,
  smsSenderBinding,
  validateSmsEvidence,
  type SmsConsentEvidence,
  type SmsSenderBinding,
} from "./sms-permission-rules";

export function currentSmsSenderBinding(
  config = smsConfig(),
): SmsSenderBinding | null {
  const env = workspaceEnvironment();
  if (!config?.from || (config.provider === "twilio" && config.service))
    return null;
  let origin: string;
  try {
    const base = new URL(env.APP_BASE_URL ?? "");
    if (
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      base.username ||
      base.password
    )
      return null;
    origin = base.origin;
  } catch {
    return null;
  }
  return smsSenderBinding({
    companyKey: workspaceScopeKey() || "default",
    companyOrigin: origin,
    provider: config.provider,
    project: config.account,
    sender: config.from,
    providerHost:
      config.provider === "signalwire" ? config.host : "api.twilio.com",
  });
}
function recipient(value: string) {
  const normalized = smsNumber(value);
  if (!normalized)
    throw new DomainError(400, "Enter one valid recipient phone number.");
  return normalized;
}
async function lock(tx: Transaction, to: string) {
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await tx
    .insert(preferences)
    .values({ recipient: to, updatedAt: new Date().toISOString() })
    .onConflictDoNothing({ target: preferences.recipient });
  const [row] = await tx
    .select()
    .from(preferences)
    .where(eq(preferences.recipient, to))
    .for("update");
  return row;
}
async function replay(
  tx: Transaction,
  requestKey: string,
  fingerprint: string,
) {
  const [prior] = await tx
    .select()
    .from(events)
    .where(eq(events.requestKey, requestKey));
  if (prior && prior.requestFingerprint !== fingerprint)
    throw new DomainError(
      409,
      "This preference request was already used for different evidence or a different recipient.",
    );
  return prior;
}
async function officeActor(tx: Transaction, actorId: string, owner = false) {
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  const [actor] = await tx
    .select({
      role: usersTable.role,
      active: usersTable.active,
      lockedUntil: usersTable.lockedUntil,
    })
    .from(usersTable)
    .where(eq(usersTable.id, actorId))
    .for("share");
  if (
    !actor?.active ||
    (actor.lockedUntil && Date.parse(actor.lockedUntil) > Date.now()) ||
    (owner
      ? actor.role !== "owner"
      : !["owner", "sales", "operations"].includes(actor.role))
  )
    throw new DomainError(
      403,
      "The current staff role cannot change this text preference.",
    );
}
async function unseenLegacyStops(tx: Transaction | typeof db, to: string) {
  const m = communicationsTable;
  const rows = await tx
    .select({
      id: m.id,
      providerMessageId: m.providerMessageId,
      createdAt: m.createdAt,
      subject: m.subject,
    })
    .from(m)
    .where(
      and(
        eq(m.channel, "sms"),
        eq(m.direction, "inbound"),
        eq(m.status, "received"),
        eq(m.fromAddress, to),
        like(m.providerMessageId, "signalwire:%"),
        inArray(m.subject, [
          "SMS opt-out",
          "SMS opt-out pending provider timestamp",
        ]),
        sql`NOT EXISTS (SELECT 1 FROM sms_preference_events e WHERE e.request_key = 'inbound:' || ${m.providerMessageId}
        AND e.recipient = ${m.fromAddress} AND e.kind IN ('legacy_stop','suppressed_inbound'))`,
      ),
    )
    .orderBy(desc(m.createdAt), desc(m.id))
    .limit(1001);
  if (rows.length > 1000)
    throw new DomainError(
      409,
      "Extensive retained opt-out history requires review. This recipient remains blocked from messaging shortcuts and provider sends.",
    );
  return rows;
}
async function retainLegacyStops(
  tx: Transaction,
  row: typeof preferences.$inferSelect,
) {
  const stops = await unseenLegacyStops(tx, row.recipient);
  if (!stops.length) return row;
  const now = new Date().toISOString();
  const inserted = await tx
    .insert(events)
    .values(
      stops.map((stop) => ({
        id: `legacy-stop:${stop.id}`,
        requestKey: `inbound:${stop.providerMessageId}`,
        requestFingerprint: smsPermissionHash([
          "legacy_stop",
          stop.id,
          stop.providerMessageId,
          row.recipient,
        ]),
        recipient: row.recipient,
        kind: "legacy_stop" as const,
        recordedAt: now,
        occurredAt: stop.subject === "SMS opt-out" ? stop.createdAt : null,
        note: "Reconciled retained signed STOP evidence. No positive permission was inferred.",
        providerMessageId: stop.providerMessageId,
        evidence: {
          communicationId: stop.id,
          sourceCreatedAt: stop.createdAt,
          sourceSubject: stop.subject,
        },
      })),
    )
    .onConflictDoNothing({ target: events.requestKey })
    .returning();
  if (inserted.length !== stops.length)
    throw new DomainError(
      409,
      "Conflicting retained preference evidence requires owner review; no provider was called.",
    );
  const [updated] = await tx
    .update(preferences)
    .set({
      revision: row.revision + 1,
      suppressed: true,
      suppressedAt: now,
      lastSuppressionEventId: inserted[0].id,
      updatedAt: now,
    })
    .where(eq(preferences.recipient, row.recipient))
    .returning();
  return updated;
}
export async function readSmsPreference(value: string) {
  const to = recipient(value),
    binding = currentSmsSenderBinding();
  let [row] = await db
    .select()
    .from(preferences)
    .where(eq(preferences.recipient, to));
  // Read-through reconciliation only retains already-saved negative evidence.
  // It never invents consent, calls a provider or changes the source message.
  if ((await unseenLegacyStops(db, to)).length)
    row = await db.transaction(async (tx) =>
      retainLegacyStops(tx, await lock(tx, to)),
    );
  const history = await db
    .select({
      id: events.id,
      kind: events.kind,
      actorId: events.actorId,
      recordedAt: events.recordedAt,
      occurredAt: events.occurredAt,
      note: events.note,
      synthetic: events.synthetic,
      releasedSuppression: events.releasedSuppression,
      evidence: events.evidence,
      bindingFingerprint: events.bindingFingerprint,
    })
    .from(events)
    .where(eq(events.recipient, to))
    .orderBy(desc(events.recordedAt), desc(events.id))
    .limit(51);
  const [company] = await db
    .select({ name: settingsTable.companyName })
    .from(settingsTable)
    .where(eq(settingsTable.id, 1));
  return {
    to,
    revision: row?.revision ?? 0,
    permission: smsPermission(row ?? null, binding),
    binding: binding
      ? {
          fingerprint: binding.fingerprint,
          provider: binding.provider,
          sender: binding.sender,
          companyLabel: company?.name || "This company",
          projectLabel: `${binding.provider} project ending ${binding.project.slice(-8)}`,
        }
      : null,
    history: history.slice(0, 50),
    hasMore: history.length > 50,
  };
}
type OfficeInput = { to: string; revision: number; requestKey: string };
export async function recordSmsConsent(
  actorId: string,
  input: OfficeInput & {
    bindingFingerprint: string | null;
    evidence: SmsConsentEvidence;
    releaseSuppression: boolean;
  },
) {
  const to = recipient(input.to),
    binding = currentSmsSenderBinding();
  if (!validateSmsEvidence(input.evidence))
    throw new DomainError(
      400,
      "Record actual operational text evidence with a past timestamp, source and explanatory note.",
    );
  if (input.bindingFingerprint !== (binding?.fingerprint ?? null))
    throw new DomainError(
      409,
      "The company sender changed. Refresh and review the exact sender before recording evidence.",
    );
  const requestKey = `office:${actorId}:${input.requestKey}`;
  const fingerprint = smsPermissionHash([
    "evidence_recorded",
    actorId,
    to,
    input.revision,
    input.bindingFingerprint,
    input.evidence,
    input.releaseSuppression,
  ]);
  await db.transaction(async (tx) => {
    await officeActor(tx, actorId, true);
    if (await replay(tx, requestKey, fingerprint)) return;
    const row = await retainLegacyStops(tx, await lock(tx, to));
    if (await replay(tx, requestKey, fingerprint)) return;
    if (row.revision !== input.revision)
      throw new DomainError(
        409,
        "Text preferences changed. Refresh and review the latest evidence.",
      );
    if (
      row.suppressedAt &&
      Date.parse(input.evidence.occurredAt) <= Date.parse(row.suppressedAt)
    )
      throw new DomainError(
        409,
        "Renewed evidence must be later than the last recorded opt-out.",
      );
    if (
      input.releaseSuppression &&
      !mayReleaseSmsSuppression(row, input.evidence, binding)
    )
      throw new DomainError(
        409,
        "Only renewed real evidence for the configured sender can explicitly release an existing opt-out.",
      );
    const now = new Date().toISOString(),
      id = randomUUID();
    await tx
      .insert(events)
      .values({
        id,
        requestKey,
        requestFingerprint: fingerprint,
        recipient: to,
        kind: "evidence_recorded",
        actorId,
        binding: binding ? { ...binding } : null,
        bindingFingerprint: binding?.fingerprint ?? null,
        evidence: { ...input.evidence },
        occurredAt: new Date(input.evidence.occurredAt).toISOString(),
        recordedAt: now,
        note: input.evidence.note,
        synthetic: input.evidence.synthetic,
        releasedSuppression: input.releaseSuppression,
      });
    await tx
      .update(preferences)
      .set({
        revision: row.revision + 1,
        updatedAt: now,
        consentEventId: id,
        consentBinding: binding?.fingerprint ?? null,
        consentSynthetic: input.evidence.synthetic,
        ...(input.releaseSuppression ? { suppressed: false } : {}),
      })
      .where(eq(preferences.recipient, to));
  });
  return readSmsPreference(to);
}
export async function suppressSmsRecipient(
  actorId: string,
  input: OfficeInput & { note: string },
) {
  const to = recipient(input.to),
    requestKey = `office:${actorId}:${input.requestKey}`;
  const fingerprint = smsPermissionHash([
    "suppressed_manual",
    actorId,
    to,
    input.revision,
    input.note,
  ]);
  await db.transaction(async (tx) => {
    await officeActor(tx, actorId);
    if (await replay(tx, requestKey, fingerprint)) return;
    const row = await retainLegacyStops(tx, await lock(tx, to));
    if (await replay(tx, requestKey, fingerprint)) return;
    const now = new Date().toISOString(),
      id = randomUUID();
    await tx
      .insert(events)
      .values({
        id,
        requestKey,
        requestFingerprint: fingerprint,
        recipient: to,
        kind: "suppressed_manual",
        actorId,
        recordedAt: now,
        occurredAt: now,
        note: input.note,
        evidence: {
          reviewedRevision: input.revision,
          previousRevision: row.revision,
        },
      });
    await tx
      .update(preferences)
      .set({
        revision: row.revision + 1,
        suppressed: true,
        suppressedAt: now,
        lastSuppressionEventId: id,
        updatedAt: now,
      })
      .where(eq(preferences.recipient, to));
  });
  return readSmsPreference(to);
}

/** Called only AFTER the existing exact-project/signature/recipient validation.
 * A STOP takes effect before provider timestamp lookup. START is an observation,
 * never initial consent and never an automatic release of company suppression. */
export async function recordInboundSmsPreference(input: {
  to: string;
  sender: string;
  providerMessageId: string;
  command: "stop" | "start";
}) {
  const to = recipient(input.to),
    requestKey = `inbound:${input.providerMessageId}`;
  const fingerprint = smsPermissionHash([
    input.command,
    to,
    input.sender,
    input.providerMessageId,
  ]);
  await db.transaction(async (tx) => {
    // Legacy backfill deliberately uses this same immutable provider request key.
    const [previous] = await tx
      .select()
      .from(events)
      .where(eq(events.requestKey, requestKey));
    if (previous) {
      if (
        previous.recipient !== to ||
        previous.providerMessageId !== input.providerMessageId ||
        (previous.kind !== "legacy_stop" &&
          previous.requestFingerprint !== fingerprint) ||
        (previous.kind === "legacy_stop" && input.command !== "stop")
      )
        throw new DomainError(
          409,
          "This signed message identifier already has different preference evidence.",
        );
      return;
    }
    const row = await lock(tx, to);
    const [duplicate] = await tx
      .select()
      .from(events)
      .where(eq(events.requestKey, requestKey));
    if (duplicate) {
      if (
        duplicate.recipient !== to ||
        duplicate.providerMessageId !== input.providerMessageId ||
        (duplicate.kind !== "legacy_stop" &&
          duplicate.requestFingerprint !== fingerprint) ||
        (duplicate.kind === "legacy_stop" && input.command !== "stop")
      )
        throw new DomainError(
          409,
          "This signed message identifier already has different preference evidence.",
        );
      return;
    }
    const now = new Date().toISOString(),
      id = randomUUID();
    await tx
      .insert(events)
      .values({
        id,
        requestKey,
        requestFingerprint: fingerprint,
        recipient: to,
        kind:
          input.command === "stop"
            ? "suppressed_inbound"
            : "inbound_start_request",
        recordedAt: now,
        note:
          input.command === "stop"
            ? "Signed inbound opt-out; suppressed immediately without assuming provider time."
            : "Signed inbound opt-in request; owner review and evidence are still required.",
        providerMessageId: input.providerMessageId,
      });
    await tx
      .update(preferences)
      .set({
        revision: row.revision + 1,
        updatedAt: now,
        ...(input.command === "stop"
          ? { suppressed: true, suppressedAt: now, lastSuppressionEventId: id }
          : {}),
      })
      .where(eq(preferences.recipient, to));
  });
}

/** Claim is serialized with opt-outs and saved with the actual communication.
 * A later opt-out cannot unsend a provider request already in flight. */
export async function authorizeSmsDispatch(
  tx: Transaction,
  to: string,
  binding: SmsSenderBinding | null,
) {
  const row = await retainLegacyStops(tx, await lock(tx, to));
  const permission = smsPermission(row, binding);
  if (!permission.canSendLive) throw new DomainError(409, permission.reason);
  return {
    smsConsentEventId: row.consentEventId!,
    smsBindingFingerprint: binding!.fingerprint,
    smsPermissionRevision: row.revision,
  };
}
export async function recheckSmsDispatch(row: CommunicationRow) {
  await db.transaction(async (tx) => {
    const authorized = await authorizeSmsDispatch(
      tx,
      row.toAddress,
      currentSmsSenderBinding(),
    );
    if (
      authorized.smsConsentEventId !== row.smsConsentEventId ||
      authorized.smsBindingFingerprint !== row.smsBindingFingerprint ||
      authorized.smsPermissionRevision !== row.smsPermissionRevision
    )
      throw new DomainError(
        409,
        "Text preferences changed after this dispatch was prepared. The provider was not called.",
      );
  });
}
