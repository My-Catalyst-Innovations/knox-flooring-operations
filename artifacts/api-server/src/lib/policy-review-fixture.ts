import {
  candidatePolicy,
  policyDrafts,
  policyFieldPrompts,
} from "./product-policies";
/** Fictional test approval only. Never deployment configuration or an actual approval. */
export function completePublication() {
  const fields = Object.fromEntries(
    Object.keys(policyFieldPrompts).map((key) => [
      key,
      `Fictional reviewed public ${key}.`,
    ]),
  );
  const documents = Object.fromEntries(
    (["privacy", "terms"] as const).map((kind) => [
      kind,
      {
        approved: true,
        version: policyDrafts[kind].version,
        contentSha256: candidatePolicy(kind, fields).contentSha256,
        approvedBy: "Fictional operator reviewer",
        approvedAt: "2026-11-22T00:00:00Z",
      },
    ]),
  );
  return { publicationVersion: 1, fields, documents };
}
