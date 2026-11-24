import { readCsv } from "./csv";

export const legacyArchiveMaxBytes = 1_048_576;
export const legacyArchiveMaxRows = 200;
export const legacyArchiveTypes = [
  "job",
  "quote",
  "invoice",
  "purchase_order",
  "payment",
  "other",
] as const;
export type LegacyArchiveType = (typeof legacyArchiveTypes)[number];
export const legacyArchiveColumns = [
  "source_id",
  "type",
  "title",
  "reference",
  "party_name",
  "occurred_on",
  "status",
  "summary",
] as const;
export interface LegacyArchiveData {
  sourceId: string;
  recordType: LegacyArchiveType;
  title: string;
  reference: string;
  partyName: string;
  occurredOn: string | null;
  status: string;
  summary: string;
}
export interface LegacyArchiveRow {
  line: number;
  data: LegacyArchiveData;
  errors: string[];
  fileDuplicates: number[];
  existing: { id: string; recordSha256: string } | null;
}
export interface LegacyArchiveDecision {
  line: number;
  action: "archive" | "skip";
  note: string;
}
export const legacyArchiveIdentity = (
  data: Pick<LegacyArchiveData, "recordType" | "sourceId">,
) => JSON.stringify([data.recordType, data.sourceId]);
const byteLength = (value: string) => {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff)
      throw new Error(
        "Use valid UTF-8 source text without unpaired surrogate characters.",
      );
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
  }
  return bytes;
};
const calendarDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !value.startsWith("0000-") &&
  Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
  new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;

/** A fixed bounded contract, not an automatic active-record conversion. All IDs
 * remain text. The exact supplied UTF-8 CSV is retained separately by the API. */
export function parseLegacyArchiveCsv(
  csv: string,
  delimiter: "," | "\t" = ",",
) {
  if (!csv || byteLength(csv) > legacyArchiveMaxBytes || csv.includes("\0"))
    throw new Error("Choose a history CSV up to 1 MiB without null bytes.");
  const [header, ...input] = readCsv(csv, delimiter),
    headers = header?.fields ?? [];
  if (
    headers.length < 3 ||
    headers.length > legacyArchiveColumns.length ||
    new Set(headers).size !== headers.length ||
    headers.some(
      (value) =>
        !legacyArchiveColumns.includes(
          value as (typeof legacyArchiveColumns)[number],
        ),
    ) ||
    !["source_id", "type", "title"].every((value) => headers.includes(value))
  )
    throw new Error(
      "Use the version 1 history template: source_id, type and title are required; unsupported or duplicate columns are refused.",
    );
  if (!input.length || input.length > legacyArchiveMaxRows)
    throw new Error("Import 1–200 historical records per batch.");
  const rows: LegacyArchiveRow[] = input.map(({ line, fields }) => {
    const value = (key: (typeof legacyArchiveColumns)[number]) =>
      fields[headers.indexOf(key)] ?? "";
    const errors: string[] = [];
    if (fields.length !== headers.length)
      errors.push("The field count does not match the header.");
    for (const [key, maximum, required] of [
      ["source_id", 160, true],
      ["title", 300, true],
      ["reference", 200, false],
      ["party_name", 200, false],
      ["status", 100, false],
    ] as const) {
      const text = value(key);
      if (
        (required && !text) ||
        text.length > maximum ||
        /[\p{Cc}]/u.test(text)
      )
        errors.push(
          `Correct ${key}; use ${required ? "1–" : "up to "}${maximum} plain-text characters.`,
        );
    }
    const recordType = value("type");
    if (!legacyArchiveTypes.includes(recordType as LegacyArchiveType))
      errors.push(
        "Choose job, quote, invoice, purchase_order, payment or other for type.",
      );
    if (value("occurred_on") && !calendarDate(value("occurred_on")))
      errors.push(
        "Use a real YYYY-MM-DD historical date, or leave it blank when unknown.",
      );
    if (
      value("summary").length > 5000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value("summary"))
    )
      errors.push(
        "Use a summary up to 5,000 characters without control codes.",
      );
    return {
      line,
      data: {
        sourceId: value("source_id"),
        recordType: recordType as LegacyArchiveType,
        title: value("title"),
        reference: value("reference"),
        partyName: value("party_name"),
        occurredOn: value("occurred_on") || null,
        status: value("status"),
        summary: value("summary"),
      },
      errors,
      fileDuplicates: [],
      existing: null,
    };
  });
  const lines = new Map<string, number[]>();
  for (const row of rows) {
    const key = legacyArchiveIdentity(row.data);
    lines.set(key, [...(lines.get(key) ?? []), row.line]);
  }
  for (const row of rows)
    row.fileDuplicates = lines
      .get(legacyArchiveIdentity(row.data))!
      .filter((line) => line !== row.line);
  return { headers, rows };
}

export interface LegacyArchiveBatch {
  id: string;
  sourceSystem: string;
  batchKey: string;
  fileName: string;
  sourceSha256: string;
  rows: LegacyArchiveRow[];
  status: "preview" | "reviewed" | "approved" | "committed";
  revision: number;
  previewFingerprint: string;
  reviewFingerprint: string | null;
  decisions: LegacyArchiveDecision[];
  reviewNote: string | null;
  approval: {
    id: string;
    fingerprint: string;
    approvedBy: string;
    approvedAt: string;
  } | null;
  result: { archived: number; skipped: number; recordIds: string[] } | null;
}
export interface LegacyArchiveRecord extends LegacyArchiveData {
  id: string;
  batchId: string;
  approvalId: string;
  sourceSystem: string;
  sourceLine: number;
  recordSha256: string;
  createdAt: string;
}
