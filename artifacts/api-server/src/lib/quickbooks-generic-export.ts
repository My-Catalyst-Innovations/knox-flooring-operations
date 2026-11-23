import { createHash } from "node:crypto";
import { z } from "zod";

export const genericExportRecord = "quickBooksGenericExportAttempt";
export const genericExportAttempt = z
  .object({
    entityType: z.enum(["customer", "estimate"]),
    localId: z.string().min(1),
    connectionId: z.string().min(1),
    realmId: z.string().min(1),
    environment: z.enum(["sandbox", "production"]),
    requestId: z.string().regex(/^cwgen-[a-f0-9]{44}$/),
    document: z.record(z.string(), z.unknown()),
    state: z.enum(["prepared", "submitting", "confirmed"]),
    remoteId: z
      .string()
      .regex(/^\d{1,30}$/)
      .optional(),
  })
  .strict();
export type GenericExportAttempt = z.infer<typeof genericExportAttempt>;
export class GenericExportReviewRequired extends Error {
  constructor(
    message: string,
    readonly approvalRequired = false,
  ) {
    super(message);
  }
}

export function prepareGenericExport(
  queueId: string,
  entityType: GenericExportAttempt["entityType"],
  localId: string,
  company: { id: string; realmId: string; environment: string },
  document: Record<string, unknown>,
) {
  const hash = createHash("sha256")
    .update(JSON.stringify([company.environment, company.realmId, queueId]))
    .digest("hex");
  const requestId = `cwgen-${hash.slice(0, 44)}`;
  const frozen = JSON.parse(JSON.stringify(document)) as Record<
    string,
    unknown
  >;
  if (!frozen.Id) {
    if (entityType === "estimate") {
      frozen.DocNumber = `CW-${hash.slice(0, 18)}`;
      frozen.PrivateNote =
        `${String(frozen.PrivateNote ?? "")}\nCatalyst Works ${requestId}`.trim();
    } else frozen.Notes = `Catalyst Works ${requestId}`;
  }
  if (
    typeof frozen.PrivateNote === "string" &&
    frozen.PrivateNote.length > 4000
  )
    throw new GenericExportReviewRequired(
      "Shorten the estimate note before approving this QuickBooks export.",
    );
  return genericExportAttempt.parse({
    entityType,
    localId,
    connectionId: company.id,
    realmId: company.realmId,
    environment: company.environment,
    requestId,
    document: frozen,
    state: "prepared",
  });
}

export function assertGenericExportCompany(
  attempt: GenericExportAttempt,
  company: { id: string; realmId: string; environment: string; status: string },
) {
  if (
    company.status !== "connected" ||
    company.id !== attempt.connectionId ||
    company.realmId !== attempt.realmId ||
    company.environment !== attempt.environment
  )
    throw new GenericExportReviewRequired(
      "The approved QuickBooks connection changed. Restore its original connection and reconcile before exporting.",
    );
}

function matches(expected: unknown, actual: unknown): boolean {
  if (expected === "" && (actual === undefined || actual === null)) return true;
  if (expected === null || typeof expected !== "object")
    return expected === actual;
  if (Array.isArray(expected)) {
    const rows = Array.isArray(actual)
      ? actual.filter(
          (row) =>
            !(
              row &&
              typeof row === "object" &&
              row.DetailType === "SubTotalLineDetail"
            ),
        )
      : null;
    return (
      !!rows &&
      rows.length === expected.length &&
      expected.every((value, index) => matches(value, rows[index]))
    );
  }
  if (!actual || typeof actual !== "object")
    return Object.values(expected).every((value) => matches(value, undefined));
  return Object.entries(expected)
    .filter(([key]) => !["SyncToken", "sparse"].includes(key))
    .every(([key, value]) =>
      matches(value, (actual as Record<string, unknown>)[key]),
    );
}

type Provider = {
  request: (path: string, init?: RequestInit) => Promise<any>;
  query: (statement: string) => Promise<any>;
};
export async function reconcileGenericExport(
  attempt: GenericExportAttempt,
  provider: Provider,
  beforeSubmit: () => Promise<void>,
  confirm: (entity: any) => Promise<void>,
) {
  const entityName =
    attempt.entityType === "customer" ? "Customer" : "Estimate";
  let candidates: any[];
  const knownId = attempt.remoteId ?? attempt.document.Id;
  if (knownId) {
    const response = await provider.request(
      `/${attempt.entityType}/${encodeURIComponent(String(knownId))}`,
    );
    candidates = response[entityName] ? [response[entityName]] : [];
  } else {
    const field =
      attempt.entityType === "customer" ? "DisplayName" : "DocNumber";
    const value = String(attempt.document[field] ?? "")
      .replaceAll("\\", "\\\\")
      .replaceAll("'", "\\'");
    if (!value)
      throw new GenericExportReviewRequired(
        "The approved QuickBooks document has no reconciliation reference.",
      );
    const response = await provider.query(
      `select * from ${entityName} where ${field} = '${value}'`,
    );
    if (!response.QueryResponse)
      throw new GenericExportReviewRequired(
        "QuickBooks did not confirm the reconciliation lookup. No new document was submitted.",
      );
    candidates = response.QueryResponse[entityName] ?? [];
  }
  if (!Array.isArray(candidates) || candidates.length > 1)
    throw new GenericExportReviewRequired(
      "Multiple QuickBooks records match this approval. Reconcile them before continuing.",
    );
  const existing = candidates[0];
  if (existing && matches(attempt.document, existing)) {
    if (!/^\d{1,30}$/.test(String(existing.Id)))
      throw new GenericExportReviewRequired(
        "QuickBooks returned no verifiable record ID.",
      );
    await confirm(existing);
    return existing;
  }
  if (attempt.state !== "prepared")
    throw new GenericExportReviewRequired(
      "The earlier QuickBooks submission is unconfirmed. Review its original company and record before sending again; it was not resubmitted.",
    );
  if (existing && !attempt.document.Id)
    throw new GenericExportReviewRequired(
      "A different QuickBooks record already uses this reference. Reconcile it before creating another.",
    );
  if (
    existing &&
    attempt.document.Id &&
    String(existing.SyncToken) !== String(attempt.document.SyncToken)
  )
    throw new GenericExportReviewRequired(
      "The mapped QuickBooks record changed after approval. Reconcile it before updating.",
    );
  if (attempt.entityType === "estimate" && !attempt.document.Id) {
    const preferences = await provider.request("/preferences");
    if (preferences.Preferences?.SalesFormsPrefs?.CustomTxnNumbers !== true)
      throw new GenericExportReviewRequired(
        "Enable custom transaction numbers in this QuickBooks company before exporting an estimate, so its approved reconciliation reference is preserved.",
      );
  }
  await beforeSubmit(); // Commit the durable claim before the network write.
  let result: any;
  try {
    result = (
      await provider.request(
        `/${attempt.entityType}?requestid=${attempt.requestId}`,
        {
          method: "POST",
          body: JSON.stringify(attempt.document),
        },
      )
    )[entityName];
  } catch {
    throw new GenericExportReviewRequired(
      "QuickBooks did not confirm the submission. Review the original record before retrying; no automatic resubmission is allowed.",
    );
  }
  if (
    !/^\d{1,30}$/.test(String(result?.Id)) ||
    !matches(attempt.document, result)
  )
    throw new GenericExportReviewRequired(
      "QuickBooks accepted a request without confirming its exact approved document. Reconcile before continuing.",
    );
  await confirm(result);
  return result;
}
