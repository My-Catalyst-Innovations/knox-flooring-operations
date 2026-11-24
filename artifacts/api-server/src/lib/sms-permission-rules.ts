import { createHash } from "node:crypto";

export type SmsSenderBinding = {
  fingerprint: string;
  companyKey: string;
  companyOrigin: string;
  provider: "signalwire" | "twilio";
  project: string;
  sender: string;
  providerHost: string;
};
export type SmsEvidenceSource =
  | "written"
  | "web_form"
  | "verbal"
  | "inbound_request";
export type SmsConsentEvidence = {
  source: SmsEvidenceSource;
  occurredAt: string;
  note: string;
  reference: string;
  synthetic: boolean;
};
export type SmsPermissionRecord = {
  revision: number;
  suppressed: boolean;
  suppressedAt: string | null;
  consentEventId: string | null;
  consentBinding: string | null;
  consentSynthetic: boolean;
};
export type SmsPermissionStatus =
  | "unknown"
  | "consented"
  | "suppressed"
  | "sender_changed"
  | "test_only"
  | "unbound_evidence";

export const smsPermissionHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Secrets, company display names and editable contact records are not identity.
 * Suppression belongs to the company database independently of this binding. */
export function smsSenderBinding(
  input: Omit<SmsSenderBinding, "fingerprint">,
): SmsSenderBinding | null {
  let origin: URL;
  try {
    origin = new URL(input.companyOrigin);
  } catch {
    return null;
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== input.companyOrigin ||
    !input.companyKey ||
    !/^[\w:.-]{1,160}$/.test(input.companyKey) ||
    !/^\+[1-9]\d{7,14}$/.test(input.sender) ||
    !input.project ||
    !["signalwire", "twilio"].includes(input.provider)
  )
    return null;
  if (
    input.provider === "signalwire" &&
    (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/.test(input.project) ||
      !/^[a-z\d][a-z\d-]{0,62}\.signalwire\.com$/.test(input.providerHost))
  )
    return null;
  if (
    input.provider === "twilio" &&
    (!/^AC[a-f\d]{32}$/i.test(input.project) ||
      input.providerHost !== "api.twilio.com")
  )
    return null;
  return {
    ...input,
    fingerprint: smsPermissionHash([
      1,
      "operational",
      input.companyKey,
      input.companyOrigin,
      input.provider,
      input.project,
      input.sender,
      input.providerHost,
    ]),
  };
}

export function smsPermission(
  record: SmsPermissionRecord | null,
  binding: SmsSenderBinding | null,
) {
  let status: SmsPermissionStatus;
  if (record?.suppressed) status = "suppressed";
  else if (!record?.consentEventId) status = "unknown";
  else if (record.consentSynthetic) status = "test_only";
  else if (!record.consentBinding) status = "unbound_evidence";
  else if (!binding || record.consentBinding !== binding.fingerprint)
    status = "sender_changed";
  else status = "consented";
  const reason: Record<SmsPermissionStatus, string> = {
    unknown: "No owner-reviewed operational text permission is recorded.",
    consented:
      "Operational text evidence is recorded for this company and sender. Provider acceptance remains separate.",
    suppressed:
      "This recipient is opted out for this company. Use another contact channel; renewed evidence requires explicit owner review.",
    sender_changed:
      "The sender or company connection changed. An owner must review and bind the evidence again.",
    test_only:
      "This is fictional/test evidence and cannot authorize provider sends.",
    unbound_evidence:
      "Evidence is saved without a configured sender. An owner must bind it after sender setup.",
  };
  return {
    status,
    canSendLive: status === "consented",
    canDeviceShare: status !== "suppressed",
    reason: reason[status],
  };
}

/** This is evidence validation, not a claim of legal or carrier compliance. */
export function validateSmsEvidence(
  evidence: SmsConsentEvidence,
  now = Date.now(),
) {
  const time = Date.parse(evidence.occurredAt);
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      evidence.occurredAt,
    );
  const calendar = parts ? parts.slice(1, 7).map(Number) : [];
  const [year, month, day, hour, minute, second] = calendar;
  const validCalendar =
    !!parts &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59;
  return (
    ["written", "web_form", "verbal", "inbound_request"].includes(
      evidence.source,
    ) &&
    validCalendar &&
    Number.isFinite(time) &&
    time <= now &&
    time >= Date.UTC(2000, 0, 1) &&
    evidence.note.trim().length >= 10 &&
    evidence.note.length <= 1500 &&
    evidence.reference.length <= 500 &&
    typeof evidence.synthetic === "boolean"
  );
}

export function mayReleaseSmsSuppression(
  record: SmsPermissionRecord,
  evidence: SmsConsentEvidence,
  binding: SmsSenderBinding | null,
) {
  return (
    record.suppressed &&
    !!binding &&
    !evidence.synthetic &&
    !!record.suppressedAt &&
    Date.parse(evidence.occurredAt) > Date.parse(record.suppressedAt)
  );
}
