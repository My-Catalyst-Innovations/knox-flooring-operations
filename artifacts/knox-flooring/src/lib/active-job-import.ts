import {
  activeJobImportMaxBytes,
  type ActiveJobImportDecision,
  type JobCutoverReview,
  type JobMigrationCutover,
} from "@workspace/domain";

export interface ActiveJobChoices {
  customers: {
    id: string;
    name: string;
    revision: number;
    sites: {
      id: string;
      label: string;
      address: string;
      city: string;
      fingerprint: string;
    }[];
  }[];
  jobs: {
    id: string;
    jobNumber: string;
    customerId: string | null;
    siteId: string | null;
    revision: number;
    status: string;
  }[];
  hasMoreCustomers: boolean;
  hasMoreJobs: boolean;
  flooringTypes: string[];
  entryStages: string[];
}
export interface JobCutoverState {
  cutover: JobMigrationCutover | null;
  reviews: JobCutoverReview[];
  jobRevision: number;
  scopeFingerprint: string;
  evidenceDocuments: {
    id: string;
    name: string;
    sha256: string;
    size: number;
  }[];
  hasMoreEvidenceDocuments: boolean;
}
/** Do not echo server-only identity snapshots back into a review request. */
export function activeJobDecisionRequest(
  value: Partial<ActiveJobImportDecision>,
): ActiveJobImportDecision {
  const {
    line,
    action,
    customerId,
    customerRevision,
    siteId,
    siteFingerprint,
    jobId,
    jobRevision,
    entryStage,
    flooringType,
    stageMappingReason,
    acceptSourceDates,
    note,
  } = value;
  return {
    line: line!,
    action: action!,
    ...(customerId === undefined ? {} : { customerId }),
    ...(customerRevision === undefined ? {} : { customerRevision }),
    ...(siteId === undefined ? {} : { siteId }),
    ...(siteFingerprint === undefined ? {} : { siteFingerprint }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(jobRevision === undefined ? {} : { jobRevision }),
    ...(entryStage === undefined ? {} : { entryStage }),
    ...(flooringType === undefined ? {} : { flooringType }),
    ...(stageMappingReason === undefined ? {} : { stageMappingReason }),
    ...(acceptSourceDates === undefined ? {} : { acceptSourceDates }),
    note: note ?? "",
  };
}
export async function readActiveJobCsv(file: File) {
  if (!file.size || file.size > activeJobImportMaxBytes)
    throw new Error("Choose a CSV or TSV up to 1 MiB.");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await file.arrayBuffer(),
    );
  } catch {
    throw new Error(
      "Choose a readable UTF-8 CSV or TSV; its original bytes must be preserved.",
    );
  }
}
export function dollarsToCents(value: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value))
    throw new Error(
      "Enter a nonnegative dollar amount with at most two decimal places, including an explicit 0 when reviewed.",
    );
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("The reviewed amount is too large.");
  return Number(cents);
}

/** Only a known API rejection proves this transaction did not create a new
 * invoice. Network, server, timeout and successful-response parse failures do not. */
export function isDefinitiveInvoiceRejection(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "ApiError") return false;
  const failure = error as Error & {
    status?: unknown;
    data?: { details?: { code?: unknown } };
  };
  return (
    typeof failure.status === "number" &&
    failure.status >= 400 &&
    failure.status < 500 &&
    failure.status !== 408 &&
    failure.data?.details?.code !== "invoice_request_identity_conflict"
  );
}
