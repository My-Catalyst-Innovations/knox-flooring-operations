import { describe, expect, it } from "vitest";
import {
  candidatePolicy,
  policyReviewPacket,
  publishedPolicy,
} from "./product-policies";
import { completePublication } from "./policy-review-fixture";
describe("deployment-only complete document approval", () => {
  it.each([undefined, "", "{}", "not-json", '{"approved":true}'])(
    "withholds both policies for absent/invalid configuration %s",
    (raw) => {
      expect(publishedPolicy("privacy", raw)).toBeNull();
      expect(publishedPolicy("terms", raw)).toBeNull();
    },
  );
  it("requires complete reviewed public values and independent exact approvals", () => {
    const config = completePublication();
    expect(
      publishedPolicy("privacy", JSON.stringify(config))?.unresolved,
    ).toEqual([]);
    expect(
      publishedPolicy("terms", JSON.stringify(config))?.unresolved,
    ).toEqual([]);
    config.documents.terms.approved = false;
    expect(publishedPolicy("privacy", JSON.stringify(config))).not.toBeNull();
    expect(publishedPolicy("terms", JSON.stringify(config))).toBeNull();
  });
  it.each([
    "legalEntity",
    "privacyContact",
    "retentionAndDeletion",
    "backupRetention",
    "processorsAndLocations",
    "rightsAndRequests",
  ])("cannot publish Privacy with an unresolved %s", (field) => {
    const config = completePublication();
    config.fields[field] = "TBD";
    config.documents.privacy.contentSha256 = candidatePolicy(
      "privacy",
      config.fields,
    ).contentSha256;
    expect(publishedPolicy("privacy", JSON.stringify(config))).toBeNull();
  });
  it.each([
    "feesAndBilling",
    "supportTerms",
    "lawAndDisputes",
    "liabilityAndWarranties",
    "terminationTerms",
  ])("cannot publish Terms with an unresolved %s", (field) => {
    const config = completePublication();
    config.fields[field] = "";
    config.documents.terms.contentSha256 = candidatePolicy(
      "terms",
      config.fields,
    ).contentSha256;
    expect(publishedPolicy("terms", JSON.stringify(config))).toBeNull();
  });
  it("invalidates prior approval after any published wording field changes", () => {
    const config = completePublication();
    config.fields.retentionAndDeletion += " Changed period.";
    expect(publishedPolicy("privacy", JSON.stringify(config))).toBeNull();
    expect(publishedPolicy("terms", JSON.stringify(config))).not.toBeNull();
  });
  it.each(["approved", "version", "contentSha256", "approvedBy", "approvedAt"])(
    "rejects missing/tampered approval field %s",
    (key) => {
      const config = completePublication();
      delete (config.documents.privacy as Record<string, unknown>)[key];
      expect(publishedPolicy("privacy", JSON.stringify(config))).toBeNull();
    },
  );
  it("refuses future approval and oversized or control-character content", () => {
    const config = completePublication();
    config.documents.privacy.approvedAt = "2099-01-01T00:00:00Z";
    expect(publishedPolicy("privacy", JSON.stringify(config))).toBeNull();
    config.fields.legalEntity = "Fictional\u0000Entity";
    config.documents.privacy.approvedAt = "2026-11-22T00:00:00Z";
    config.documents.privacy.contentSha256 = candidatePolicy(
      "privacy",
      config.fields,
    ).contentSha256;
    expect(publishedPolicy("privacy", JSON.stringify(config))).toBeNull();
    expect(publishedPolicy("privacy", " ".repeat(100_001))).toBeNull();
  });
  it("does not accept an invalid approval calendar date normalized by JavaScript", () => {
    const config = completePublication();
    config.documents.privacy.approvedAt = "2026-02-30T00:00:00Z";
    expect(publishedPolicy("privacy", JSON.stringify(config))).toBeNull();
  });
  it("produces a draft packet with explicit unknown decisions and no fabricated attestation", () => {
    const packet = policyReviewPacket();
    expect(packet.status).toBe("draft_for_operator_review_not_published");
    expect(packet.documents.privacy.unresolved).toContain(
      "retentionAndDeletion",
    );
    expect(packet.documents.terms.unresolved).toContain("lawAndDisputes");
    expect(packet.automaticErasureImplemented).toBe(false);
    expect(packet.documents.privacy.body).toContain("OPERATOR REVIEW REQUIRED");
    expect(packet.documents.terms.body).toContain("private quote");
    expect(packet.documents.privacy.body).not.toContain("30 days");
    expect(publishedPolicy("privacy", JSON.stringify(packet))).toBeNull();
  });
});
