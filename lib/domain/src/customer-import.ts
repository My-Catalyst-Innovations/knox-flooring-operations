import { readCsv } from "./csv";

export const customerImportMaxBytes = 200_000;
export const customerImportMaxRows = 200;
export const customerImportFields = [
  "sourceId",
  "name",
  "email",
  "phone",
  "notes",
  "address",
  "city",
  "state",
  "zip",
] as const;
export type CustomerImportField = (typeof customerImportFields)[number];
export type CustomerImportMapping = Partial<
  Record<CustomerImportField, string>
>;
export interface CustomerImportData {
  sourceId: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  address: string;
  city: string;
  state: string;
  zip: string;
}
export interface CustomerImportCandidate {
  id: string;
  name: string;
  email: string;
  phone: string;
  revision: number;
  updatedAt: string;
  mergedIntoId: string | null;
}
export interface CustomerImportRow {
  line: number;
  data: CustomerImportData;
  errors: string[];
  fileDuplicates: number[];
  candidates: CustomerImportCandidate[];
  imported: {
    customerId: string;
    effectiveCustomerId: string;
    batchId: string;
  } | null;
}
export interface CustomerImportDecision {
  line: number;
  action: "create" | "link" | "skip";
  customerId?: string;
  customerRevision?: number;
  note: string;
}
export interface CustomerImportBatch {
  id: string;
  sourceSystem: string;
  batchKey: string;
  fileName: string;
  sourceSha256: string;
  headers: string[];
  mapping: CustomerImportMapping;
  rows: CustomerImportRow[];
  status: "preview" | "reviewed" | "approved" | "committed";
  revision: number;
  previewFingerprint: string;
  reviewFingerprint: string | null;
  decisions: CustomerImportDecision[];
  reviewNote: string | null;
  approval: {
    id: string;
    fingerprint: string;
    approvedAt: string;
    approvedBy: string;
  } | null;
  result: {
    created: number;
    linked: number;
    skipped: number;
    customerIds: string[];
  } | null;
}
export const customerNameKey = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLowerCase();
export const customerPhoneKey = (value: string) => {
  const digits = value.replace(/\D/g, "");
  return /^1\d{10}$/.test(digits) ? digits.slice(1) : digits;
};

export function inspectCustomerCsv(
  csv: string,
  delimiter: "," | "\t" = ",",
): {
  headers: string[];
  rowCount: number;
  samples: string[][];
  records: { line: number; fields: string[] }[];
} {
  let bytes = 0;
  for (const point of csv) {
    const value = point.codePointAt(0)!;
    bytes += value < 0x80 ? 1 : value < 0x800 ? 2 : value < 0x10000 ? 3 : 4;
  }
  if (bytes > customerImportMaxBytes)
    throw new Error("Use customer CSV of 200 KB or less.");
  const records = readCsv(csv, delimiter);
  const [header, ...rows] = records;
  const headers = header?.fields ?? [];
  if (
    !headers.length ||
    headers.length > 64 ||
    headers.some((value) => !value || value.length > 120) ||
    new Set(headers).size !== headers.length
  )
    throw new Error(
      "Use 1–64 unique, nonempty column headings of at most 120 characters.",
    );
  if (!rows.length || rows.length > customerImportMaxRows)
    throw new Error("Import 1–200 customer rows per batch.");
  if (rows.some((row) => row.fields.length !== headers.length))
    throw new Error(
      "Every customer row must have the same number of columns as the header.",
    );
  return {
    headers,
    rowCount: rows.length,
    samples: rows.slice(0, 3).map((row) => row.fields),
    records: rows,
  };
}

export function mapCustomerCsv(
  csv: string,
  mapping: CustomerImportMapping,
  delimiter: "," | "\t" = ",",
) {
  const inspected = inspectCustomerCsv(csv, delimiter);
  if (!mapping.sourceId || !mapping.name)
    throw new Error(
      "Map the source customer ID and customer name columns before previewing.",
    );
  const selected = customerImportFields
    .map((field) => mapping[field])
    .filter((value): value is string => Boolean(value));
  if (
    selected.some((value) => !inspected.headers.includes(value)) ||
    new Set(selected).size !== selected.length
  )
    throw new Error(
      "Choose existing columns once each; no column may fill two fields.",
    );
  const rows: CustomerImportRow[] = inspected.records.map(
    ({ line, fields }) => {
      const data = Object.fromEntries(
        customerImportFields.map((field) => [
          field,
          mapping[field]
            ? fields[inspected.headers.indexOf(mapping[field]!)]
            : "",
        ]),
      ) as unknown as CustomerImportData;
      const errors: string[] = [];
      for (const [field, max] of [
        ["sourceId", 160],
        ["name", 200],
        ["email", 320],
        ["phone", 80],
        ["notes", 10000],
        ["address", 500],
        ["city", 100],
        ["state", 100],
        ["zip", 30],
      ] as const)
        if (
          data[field].length > max ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data[field])
        )
          errors.push(
            `Correct ${field}: maximum ${max} characters; no control characters.`,
          );
      if (!data.sourceId || !data.name)
        errors.push("A source customer ID and customer name are required.");
      if (/[\r\n\t]/.test(data.sourceId))
        errors.push(
          "Source customer IDs must not contain tabs or line breaks.",
        );
      if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
        errors.push("Correct the email address or skip this row.");
      if (!data.address && (data.city || data.state || data.zip))
        errors.push("An address is required when importing location fields.");
      return {
        line,
        data,
        errors,
        fileDuplicates: [],
        candidates: [],
        imported: null,
      };
    },
  );
  const counts = new Map<string, number>();
  for (const row of rows)
    counts.set(row.data.sourceId, (counts.get(row.data.sourceId) ?? 0) + 1);
  for (const row of rows)
    if (counts.get(row.data.sourceId)! > 1)
      row.errors.push(
        "This source customer ID occurs more than once in the file. Correct the file or explicitly skip all duplicate rows.",
      );
  for (const row of rows)
    row.fileDuplicates = rows
      .filter(
        (other) =>
          other !== row &&
          (customerNameKey(other.data.name) ===
            customerNameKey(row.data.name) ||
            Boolean(
              row.data.email &&
              row.data.email.toLowerCase() === other.data.email.toLowerCase(),
            ) ||
            Boolean(
              customerPhoneKey(row.data.phone) &&
              customerPhoneKey(row.data.phone) ===
                customerPhoneKey(other.data.phone),
            )),
      )
      .map((other) => other.line);
  return { headers: inspected.headers, rows };
}

export function customerImportMatches(
  data: CustomerImportData,
  candidate: CustomerImportCandidate,
) {
  return (
    customerNameKey(data.name) === customerNameKey(candidate.name) ||
    Boolean(
      data.email && data.email.toLowerCase() === candidate.email.toLowerCase(),
    ) ||
    Boolean(
      customerPhoneKey(data.phone) &&
      customerPhoneKey(data.phone) === customerPhoneKey(candidate.phone),
    )
  );
}
