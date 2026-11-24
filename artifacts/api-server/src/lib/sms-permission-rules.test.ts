import { expect, it } from "vitest";
import {
  mayReleaseSmsSuppression,
  smsPermission,
  smsSenderBinding,
  validateSmsEvidence,
  type SmsPermissionRecord,
  type SmsConsentEvidence,
} from "./sms-permission-rules";

const input = {
  companyKey: "company-a",
  companyOrigin: "https://a.example.invalid",
  provider: "signalwire" as const,
  project: "11111111-1111-1111-1111-111111111111",
  sender: "+15005550006",
  providerHost: "fictional.signalwire.com",
};
const binding = smsSenderBinding(input)!;
const consent: SmsPermissionRecord = {
  revision: 2,
  suppressed: false,
  suppressedAt: null,
  consentEventId: "reviewed-evidence",
  consentBinding: binding.fingerprint,
  consentSynthetic: false,
};
const evidence: SmsConsentEvidence = {
  source: "written",
  occurredAt: "2026-11-23T10:00:00Z",
  note: "Fictional test evidence only",
  reference: "Fictional paper form",
  synthetic: false,
};

it("requires recorded evidence and exact sender binding for provider sends", () => {
  expect(smsPermission(null, binding).canSendLive).toBe(false);
  expect(smsPermission(consent, binding).canSendLive).toBe(true);
  expect(smsPermission(consent, null).status).toBe("sender_changed");
});
it.each([
  "companyKey",
  "companyOrigin",
  "project",
  "sender",
  "providerHost",
] as const)("invalidates permission when %s changes", (field) => {
  const changed = {
    ...input,
    [field]:
      field === "sender"
        ? "+15005550007"
        : field === "project"
          ? "22222222-2222-2222-2222-222222222222"
          : field === "companyOrigin"
            ? "https://b.example.invalid"
            : field === "providerHost"
              ? "other.signalwire.com"
              : "company-b",
  };
  expect(smsPermission(consent, smsSenderBinding(changed)).canSendLive).toBe(
    false,
  );
});
it("keeps suppression across sender/project/host changes and prevents device sharing", () => {
  const blocked = { ...consent, suppressed: true };
  expect(smsPermission(blocked, null)).toMatchObject({
    status: "suppressed",
    canSendLive: false,
    canDeviceShare: false,
  });
  expect(
    smsPermission(
      blocked,
      smsSenderBinding({ ...input, sender: "+15005550007" }),
    ).status,
  ).toBe("suppressed");
});
it("never treats fictional or unbound evidence as permission", () => {
  expect(
    smsPermission({ ...consent, consentSynthetic: true }, binding).status,
  ).toBe("test_only");
  expect(
    smsPermission({ ...consent, consentBinding: null }, binding).status,
  ).toBe("unbound_evidence");
});
it("does not accept arbitrary URLs, service senders or incomplete project identity", () => {
  expect(
    smsSenderBinding({ ...input, companyOrigin: "http://a.example.invalid" }),
  ).toBeNull();
  expect(
    smsSenderBinding({
      ...input,
      companyOrigin: "https://a.example.invalid/path",
    }),
  ).toBeNull();
  expect(
    smsSenderBinding({ ...input, providerHost: "evil.invalid" }),
  ).toBeNull();
  expect(
    smsSenderBinding({ ...input, sender: "messaging-service" }),
  ).toBeNull();
});
it("requires explicit usable evidence and a nonfuture actual timestamp", () => {
  const now = Date.parse("2026-11-23T11:00:00Z");
  expect(validateSmsEvidence(evidence, now)).toBe(true);
  expect(
    validateSmsEvidence(
      { ...evidence, occurredAt: "2026-11-24T10:00:00Z" },
      now,
    ),
  ).toBe(false);
  expect(
    validateSmsEvidence({ ...evidence, occurredAt: "2026-11-23 10:00" }, now),
  ).toBe(false);
  expect(validateSmsEvidence({ ...evidence, note: "yes" }, now)).toBe(false);
  expect(
    validateSmsEvidence(
      { ...evidence, occurredAt: "2026-02-31T10:00:00Z" },
      now,
    ),
  ).toBe(false);
  expect(
    validateSmsEvidence(
      { ...evidence, occurredAt: "2026-11-22T24:00:00Z" },
      now,
    ),
  ).toBe(false);
});
it("requires renewed real evidence AFTER the recorded suppression for owner release", () => {
  const blocked = {
    ...consent,
    suppressed: true,
    suppressedAt: "2026-11-23T09:00:00Z",
  };
  expect(mayReleaseSmsSuppression(blocked, evidence, binding)).toBe(true);
  expect(
    mayReleaseSmsSuppression(
      blocked,
      { ...evidence, synthetic: true },
      binding,
    ),
  ).toBe(false);
  expect(
    mayReleaseSmsSuppression(
      blocked,
      { ...evidence, occurredAt: blocked.suppressedAt },
      binding,
    ),
  ).toBe(false);
  expect(mayReleaseSmsSuppression(blocked, evidence, null)).toBe(false);
});
