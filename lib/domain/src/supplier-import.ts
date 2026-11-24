import { readCsv } from "./csv";

export const supplierImportMaxBytes = 1_048_576;
export const supplierImportMaxRows = 200;
export const supplierImportColumns = [
  "source_id",
  "name",
  "contact_name",
  "email",
  "phone",
  "address",
  "city",
  "state",
  "postal_code",
  "country",
  "notes",
] as const;
export interface SupplierContactData {
  name: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  notes: string;
}
export interface SupplierContact extends SupplierContactData {
  id: string;
  revision: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
export type SupplierImportData = SupplierContactData & { sourceId: string };
export interface SupplierImportRow {
  line: number;
  data: SupplierContactData & { sourceId: string };
  errors: string[];
  fileDuplicates: number[];
  nameDuplicates: number[];
  candidates: (SupplierContact & { reasons: ("name" | "email" | "phone")[] })[];
  legacyNames: string[];
  imported: { supplierId: string; batchId: string } | null;
}
export interface SupplierImportDecision {
  line: number;
  action: "create" | "link" | "skip";
  supplierId?: string;
  supplierRevision?: number;
  note: string;
  /** Server-created snapshot on saved reviews; never accepted from request input. */
  supplierSnapshot?: SupplierContact;
}
export interface SupplierImportBatch {
  id: string;
  sourceSystem: string;
  batchKey: string;
  fileName: string;
  sourceSha256: string;
  rows: SupplierImportRow[];
  status: "preview" | "reviewed" | "approved" | "committed";
  revision: number;
  previewFingerprint: string;
  reviewFingerprint: string | null;
  decisions: SupplierImportDecision[];
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
    supplierIds: string[];
  } | null;
}
export const supplierNameKey = (value: string) => value.trim().toLowerCase();
export const supplierPhoneKey = (value: string) => value.replace(/[^0-9]/g, "");
export function parseSupplierImportCsv(
  csv: string,
  delimiter: "," | "\t" = ",",
) {
  let bytes = 0;
  for (const character of csv) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff)
      throw new Error(
        "Use valid UTF-8 source text without unpaired surrogate characters.",
      );
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
  }
  if (!bytes || bytes > supplierImportMaxBytes || csv.includes("\0"))
    throw new Error("Choose supplier CSV up to 1 MiB without null bytes.");
  const [header, ...input] = readCsv(csv, delimiter),
    headers = header?.fields ?? [];
  if (
    headers.length < 2 ||
    headers.length > supplierImportColumns.length ||
    new Set(headers).size !== headers.length ||
    headers.some(
      (value) =>
        !supplierImportColumns.includes(
          value as (typeof supplierImportColumns)[number],
        ),
    ) ||
    !["source_id", "name"].every((value) => headers.includes(value))
  )
    throw new Error(
      "Use the version 1 supplier template. source_id and name are required; unsupported or duplicate columns are refused.",
    );
  if (!input.length || input.length > supplierImportMaxRows)
    throw new Error("Import 1–200 supplier contacts per batch.");
  const rows: SupplierImportRow[] = input.map(({ line, fields }) => {
    const value = (key: (typeof supplierImportColumns)[number]) =>
      fields[headers.indexOf(key)] ?? "";
    const errors: string[] = [];
    if (fields.length !== headers.length)
      errors.push("The field count does not match the header.");
    for (const [key, maximum, required] of [
      ["source_id", 160, true],
      ["name", 200, true],
      ["contact_name", 200, false],
      ["email", 320, false],
      ["phone", 80, false],
      ["address", 500, false],
      ["city", 100, false],
      ["state", 100, false],
      ["postal_code", 30, false],
      ["country", 100, false],
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
    if (value("email") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value("email")))
      errors.push(
        "Use one valid contact email address, or leave it blank. No email will be sent.",
      );
    if (
      value("notes").length > 5000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value("notes"))
    )
      errors.push("Use notes up to 5,000 characters without control codes.");
    return {
      line,
      data: {
        sourceId: value("source_id"),
        name: value("name"),
        contactName: value("contact_name"),
        email: value("email"),
        phone: value("phone"),
        address: value("address"),
        city: value("city"),
        state: value("state"),
        postalCode: value("postal_code"),
        country: value("country"),
        notes: value("notes"),
      },
      errors,
      fileDuplicates: [],
      nameDuplicates: [],
      candidates: [],
      legacyNames: [],
      imported: null,
    };
  });
  for (const row of rows) {
    row.fileDuplicates = rows
      .filter(
        (other) => other !== row && other.data.sourceId === row.data.sourceId,
      )
      .map((other) => other.line);
    row.nameDuplicates = rows
      .filter(
        (other) =>
          other !== row &&
          supplierNameKey(other.data.name) === supplierNameKey(row.data.name),
      )
      .map((other) => other.line);
  }
  return { headers, rows };
}
