import { readCsv } from "./csv";

/** Source parsing only. This module cannot create jobs or authorize cutover. */
export const activeJobImportMaxBytes = 1_048_576;
export const activeJobImportMaxRows = 200;
export const activeJobImportColumns = [
  "source_id",
  "source_job_number",
  "source_status",
  "source_customer_id",
  "source_customer_name",
  "source_site_id",
  "address",
  "city",
  "flooring_type",
  "scope_of_work",
  "square_feet",
  "source_created_at",
  "source_stage_at",
  "sold_at",
  "est_start_on",
  "est_completion_on",
  "committed_completion_on",
  "notes",
] as const;
export const activeJobSourceStages = [
  "New Lead",
  "Estimate Scheduled",
  "Estimate Completed",
  "Proposal Sent",
  "Approved",
  "Material Ordered",
  "Material Received",
  "Scheduled",
  "In Progress",
  "Final Walkthrough",
  "Completed",
  "Invoiced",
] as const;
export type ActiveJobSourceData = Record<
  (typeof activeJobImportColumns)[number],
  string
>;
export interface ActiveJobSourceRow {
  line: number;
  data: ActiveJobSourceData;
  errors: string[];
  warnings: string[];
  fileDuplicates: number[];
  recognizedStage: (typeof activeJobSourceStages)[number] | null;
  imported?: { jobId: string; batchId: string } | null;
}
export const activeJobEntryStages = activeJobSourceStages.slice(0, 7);
export interface ActiveJobImportDecision {
  line: number;
  action: "create" | "link" | "skip";
  customerId?: string;
  customerRevision?: number;
  siteId?: string | null;
  siteFingerprint?: string | null;
  jobId?: string;
  jobRevision?: number;
  entryStage?: string;
  flooringType?: string;
  stageMappingReason?: string;
  acceptSourceDates?: boolean;
  note: string;
  /** Server-only exact selected records. Request schemas reject these fields. */
  snapshot?: Record<string, unknown>;
}
export interface ActiveJobImportBatch {
  id: string;
  sourceSystem: string;
  batchKey: string;
  fileName: string;
  sourceSha256: string;
  rows: ActiveJobSourceRow[];
  status: "preview" | "reviewed" | "approved" | "committed";
  revision: number;
  previewFingerprint: string;
  reviewFingerprint: string | null;
  decisions: ActiveJobImportDecision[];
  reviewNote: string | null;
  approval: {
    id: string;
    fingerprint: string;
    approvedBy: string;
    approvedAt: string;
  } | null;
  result: {
    created: number;
    linked: number;
    skipped: number;
    jobIds: string[];
  } | null;
}
export interface JobMigrationCutover {
  revision: number;
  source: {
    recordId: string;
    batchId: string;
    sourceSystem: string;
    sourceId: string;
    sourceJobNumber: string;
    sourceStatus: string;
    sourceCreatedAt: string;
    sourceStageAt: string;
    soldAt: string;
    sourceDownloadUrl: string;
  };
  operational: { status: "pending" | "verified"; current: boolean };
  financial: {
    status: "unknown" | "context_reviewed";
    current: boolean;
    fullJobRevenueCents: number | null;
    fullJobLaborForecastCents: number | null;
    fullJobMaterialForecastCents: number | null;
    fullJobOtherForecastCents: number | null;
    evidenceDocumentIds: string[];
    note: string | null;
  };
  billing: {
    status: "unknown" | "reviewed";
    current: boolean;
    ceilingCents: number | null;
    consumedCents: number | null;
    remainingCents: number | null;
    evidenceDocumentIds: string[];
    note: string | null;
  };
  forecastReportsEligible: boolean;
  actualProfitReportsEligible: false;
  commissionReportsEligible: false;
  blockedActions: string[];
}
export type JobCutoverKind = "operational" | "financial_context" | "billing";
export type JobCutoverPayload =
  | {
      kind: "operational";
      targetStage: string;
      note: string;
      confirmRealReadiness: true;
    }
  | {
      kind: "financial_context";
      fullJobRevenueCents: number;
      fullJobLaborForecastCents: number;
      fullJobMaterialForecastCents: number;
      fullJobOtherForecastCents: number;
      evidenceDocumentIds: string[];
      note: string;
      confirmForecastOnly: true;
    }
  | {
      kind: "billing";
      worksGrossInvoiceCeilingAfterLegacyCents: number;
      evidenceDocumentIds: string[];
      note: string;
      confirmIncludesAllLegacyInvoices: true;
      confirmNoLegacyBalancesCreated: true;
    };
export interface JobCutoverReview {
  id: string;
  jobId: string;
  kind: JobCutoverKind;
  jobRevision: number;
  cutoverRevision: number;
  scopeFingerprint: string;
  sourceFingerprint: string;
  payload: JobCutoverPayload;
  fingerprint: string;
  reviewedBy: string;
  reviewedAt: string;
  approval: { id: string; approvedBy: string; approvedAt: string } | null;
  commit: { id: string; committedBy: string; committedAt: string } | null;
}
const calendar = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !value.startsWith("0000-") &&
  Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
  new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
function instant(value: string) {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  return (
    !!match &&
    calendar(match[1]) &&
    Number(match[2]) < 24 &&
    Number(match[3]) < 60 &&
    Number(match[4]) < 60 &&
    Number.isFinite(Date.parse(value))
  );
}
export function parseActiveJobCsv(csv: string, delimiter: "," | "\t" = ",") {
  let bytes = 0;
  for (const character of csv) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff)
      throw new Error(
        "Use valid UTF-8 source text without unpaired surrogate characters.",
      );
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
  }
  if (!bytes || bytes > activeJobImportMaxBytes || csv.includes("\0"))
    throw new Error("Choose active-job CSV up to 1 MiB without null bytes.");
  const [header, ...records] = readCsv(csv, delimiter, { trimFields: false }),
    headers = header?.fields.map((value) => value.trim()) ?? [];
  if (
    headers.length < 2 ||
    headers.length > activeJobImportColumns.length ||
    new Set(headers).size !== headers.length ||
    headers.some(
      (key) =>
        !activeJobImportColumns.includes(
          key as (typeof activeJobImportColumns)[number],
        ),
    ) ||
    !["source_id", "source_status"].every((key) => headers.includes(key))
  )
    throw new Error(
      "Use the active-job source template: source_id and source_status are required; financial, duplicate and unsupported columns are refused.",
    );
  if (!records.length || records.length > activeJobImportMaxRows)
    throw new Error("Import 1–200 active-job source rows per batch.");
  const rows: ActiveJobSourceRow[] = records.map(({ line, fields }) => {
    const data = Object.fromEntries(
      activeJobImportColumns.map((key) => [
        key,
        fields[headers.indexOf(key)] ?? "",
      ]),
    ) as ActiveJobSourceData;
    const errors: string[] = [],
      warnings: string[] = [];
    if (fields.length !== headers.length)
      errors.push("The field count does not match the header.");
    for (const key of activeJobImportColumns) {
      const value = data[key],
        maximum =
          key === "scope_of_work" || key === "notes"
            ? 5000
            : key === "address"
              ? 500
              : key === "source_id" || key.endsWith("_id")
                ? 160
                : 300;
      const invalidControls =
        key === "scope_of_work" || key === "notes"
          ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
          : /[\p{Cc}]/u.test(value);
      if (value.length > maximum || invalidControls)
        errors.push(
          `Correct ${key}; use up to ${maximum} plain-text characters.`,
        );
    }
    if (!data.source_id || data.source_id !== data.source_id.trim())
      errors.push(
        "Use an exact nonempty source_id without leading or trailing whitespace; IDs are never normalized or generated.",
      );
    if (!data.source_status.trim())
      errors.push("Retain the original nonempty source_status.");
    const recognizedStage = activeJobSourceStages.includes(
      data.source_status as (typeof activeJobSourceStages)[number],
    )
      ? (data.source_status as (typeof activeJobSourceStages)[number])
      : null;
    if (recognizedStage === "Completed" || recognizedStage === "Invoiced")
      errors.push(
        "Closed jobs belong in the read-only historical archive, not the active-job importer.",
      );
    else if (!recognizedStage)
      warnings.push(
        "The source status is unsupported; an explicit supported-stage decision and reason will be required.",
      );
    else if (
      ["Scheduled", "In Progress", "Final Walkthrough"].includes(
        recognizedStage,
      )
    )
      warnings.push(
        "This source status does not establish a real crew booking or completed work. Explicit operational cutover review is required.",
      );
    for (const key of [
      "est_start_on",
      "est_completion_on",
      "committed_completion_on",
    ] as const)
      if (data[key] && !calendar(data[key]))
        errors.push(
          `Use an exact valid YYYY-MM-DD ${key}, or leave it blank when unknown.`,
        );
    for (const key of [
      "source_created_at",
      "source_stage_at",
      "sold_at",
    ] as const)
      if (data[key]) {
        if (calendar(data[key]))
          warnings.push(
            `${key} is an exact source calendar date with unknown time. Preserve that precision; never infer midnight, time zone or a verified event timestamp.`,
          );
        else if (!instant(data[key]))
          errors.push(
            `Use a real calendar date or explicit-offset ISO timestamp for ${key}, or leave it blank. A local time without an offset is ambiguous.`,
          );
      }
    if (
      data.est_start_on &&
      data.est_completion_on &&
      calendar(data.est_start_on) &&
      calendar(data.est_completion_on) &&
      data.est_completion_on < data.est_start_on
    )
      errors.push(
        "The estimated completion date cannot precede the source start date.",
      );
    if (
      data.square_feet &&
      !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(data.square_feet)
    )
      errors.push(
        "Use a nonnegative square_feet decimal in square feet; no unit conversion is inferred.",
      );
    warnings.push(
      "Financial and operational cutover are unverified. This source row never authorizes balances, booking, stock or provider writes.",
    );
    return {
      line,
      data,
      errors,
      warnings,
      fileDuplicates: [],
      recognizedStage,
    };
  });
  for (const row of rows)
    row.fileDuplicates = rows
      .filter(
        (other) =>
          other.line !== row.line &&
          other.data.source_id === row.data.source_id,
      )
      .map((other) => other.line);
  return { headers, rows };
}
